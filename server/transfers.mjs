import { randomUUID } from 'node:crypto';
import { closeSync, createReadStream, createWriteStream, existsSync, fstatSync, fsyncSync, ftruncateSync, openSync, readSync, statSync, writeSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { finished, pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import archiver from 'archiver';
import Busboy from 'busboy';
import { check, day, digest, DriveError, fileName, ids, minute, number, ok, pageBounds, publicOwner, terminal } from './data.mjs';
import { format } from './files.mjs';

const chunkLimit = 8 * 1024 ** 2;
const transferStates = new Set(['waiting', 'paused', 'transferring', 'failed', 'preparing']);
const fileId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const visibleHistory = "actor=? AND type=? AND history_hidden=0 AND status IN ('success','cancelled','failed')";

function rangeOf(header, total, res) {
  if (!header) return { start: 0, end: total - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header);
  const start = match?.[1] === '' ? Math.max(0, total - Number(match?.[2])) : Number(match?.[1]);
  const end = match?.[1] === '' || match?.[2] === '' ? total - 1 : Math.min(total - 1, Number(match?.[2]));
  if (!match || !Number.isSafeInteger(start) || start >= total || start > end) {
    res.set('Content-Range', `bytes */${total}`);
    throw new DriveError(416, '无效的文件字节范围');
  }
  return { start, end, partial: true };
}

const disposition = (mode, name) => `${mode}; filename="download${format(name).extension.replace(/[^.\w]/gu, '').slice(0, 10)}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}`;

export function transferRoutes(api, store, accounts, files, shares) {
  const get = (id) => store.get('SELECT * FROM tasks WHERE id=?', id);
  const listeners = new Set();
  const jobs = new Map();
  let readers = 0;
  const slots = { upload: 0, download: 0 };
  function view(row) {
    const rate = store.config[`${row.type}SpeedLimit`];
    return { id: row.id, type: row.type, name: row.name, status: row.status, total: row.total, done: row.done,
      reason: row.reason, device: row.device, parentId: row.parent_id, fileId: row.file_id, createdAt: row.created, updatedAt: row.updated,
      chunkSize: rate ? Math.min(chunkLimit, Math.max(4096, rate * 4)) : chunkLimit };
  }
  function publish(row) {
    if (row?.actor != null) for (const listen of listeners) listen(row.actor, view(row));
    return row;
  }
  function list(id, type = null, active = false, query = {}) {
    const status = active ? "status NOT IN ('success','cancelled')" : "status<>'cancelled'";
    const where = `actor=? AND ${status}${type ? ' AND type=?' : ''}`;
    const params = type ? [id, type] : [id];
    if (query.page == null && query.size == null) {
      const list = store.all(`SELECT * FROM tasks WHERE ${where} ORDER BY created DESC,id`, ...params).map(view);
      return { total: list.length, list };
    }
    const { size, offset } = pageBounds(query);
    const { total } = store.get(`SELECT count(*) AS total FROM tasks WHERE ${where}`, ...params);
    const list = store.all(`SELECT * FROM tasks WHERE ${where} ORDER BY created DESC,id LIMIT ? OFFSET ?`, ...params, size, offset).map(view);
    return { total, list };
  }
  function update(id, status, reason = null) {
    store.run('UPDATE tasks SET history_hidden=CASE WHEN status<>? THEN 0 ELSE history_hidden END,status=?,reason=?,updated=? WHERE id=?',
      status, status, reason, Date.now(), id);
    return publish(get(id));
  }
  function owned(id, actor, guest) {
    check(typeof id === 'string' && fileId.test(id), 400, '任务编号无效');
    const row = get(id);
    check(row && (guest ? row.share_id === guest.share.id && row.visitor === guest.key : row.actor === actor.id), 404, '传输任务不存在');
    return row;
  }
  function speedLimit(type) { return store.config[`${type}SpeedLimit`]; }

  function throttle(type, byteLength, rate, signal) {
    const now = Date.now();
    const next = Math.max(now, slots[type]) + Math.ceil(byteLength * 1000 / rate);
    slots[type] = next;
    return sleep(next - now, undefined, { signal });
  }

  function* blocks(buffer, type) {
    const rate = speedLimit(type);
    if (!rate) { slots[type] = 0; yield buffer; return; }
    const blockSize = Math.max(1024, Math.floor(rate / 4));
    for (let offset = 0; offset < buffer.length; offset += blockSize) {
      yield buffer.subarray(offset, offset + blockSize);
    }
  }

  function authorizedRead(req, verify) {
    let validatedRevision = -1;
    return () => {
      const revision = store.revision();
      if (validatedRevision === revision && Date.now() < req.accessRecheckAt) return true;
      if (!verify()) return false;
      validatedRevision = store.revision();
      return true;
    };
  }

  function storageError(error) {
    if (['ENOSPC', 'EDQUOT'].includes(error.code)) {
      store.markDiskFull();
      return new DriveError(507, '服务节点磁盘已满，请联系管理员', 50001);
    }
    return error;
  }

  async function multipart(req) {
    check(req.is('multipart/form-data'), 400, '请用 multipart/form-data 发送文件分片');
    check(!req.headers['content-length'] || Number(req.headers['content-length']) <= chunkLimit + 32 * 1024, 413, '上传分片过大');
    const controller = new AbortController();
    return new Promise((resolve, reject) => {
      let parser;
      try { parser = Busboy({ headers: req.headers, defParamCharset: 'utf8', limits: { files: 1, fields: 12, parts: 14, fileSize: chunkLimit + 1, fieldSize: 4096 } }); }
      catch { reject(new DriveError(400, '上传分片格式错误')); return; }
      const fields = Object.create(null);
      let reading;
      let filename;
      const parts = [];
      let invalid = false;
      const abort = () => {
        controller.abort();
        parser.destroy();
        reject(new DriveError(400, '上传连接中断'));
      };
      req.once('aborted', abort);
      for (const event of ['filesLimit', 'fieldsLimit', 'partsLimit']) parser.on(event, () => { invalid = true; });
      parser.on('field', (name, value, info) => { if (info.valueTruncated) invalid = true; fields[name] = value; });
      parser.on('file', (name, stream, info) => {
        if (name !== 'file') invalid = true;
        filename = info.filename;
        reading = (async () => {
          for await (const buffer of stream) {
            for (const piece of blocks(buffer, 'upload')) {
              const rate = speedLimit('upload');
              if (rate) await throttle('upload', piece.length, rate, controller.signal);
            }
            parts.push(buffer);
          }
          if (stream.truncated) invalid = true;
          return Buffer.concat(parts);
        })();
        reading.catch(reject);
      });
      parser.on('error', () => reject(new DriveError(400, '上传分片格式错误')));
      parser.on('close', async () => {
        const bytes = await reading?.catch(() => null);
        req.removeListener('aborted', abort);
        if (invalid || !bytes || bytes.length > chunkLimit) reject(new DriveError(413, '上传分片无效或过大'));
        else resolve({ fields, bytes, filename });
      });
      req.pipe(parser);
    });
  }

  function uploadTarget(req, parentId, guest) {
    if (!guest) return files.writable(req.actor, parentId, { upload: true });
    const node = shares.inShare(guest.share, parentId || guest.share.node_id);
    check(node.kind === 'folder', 400, '请选择上传目录');
    return { owner: node.owner, parent: node.id };
  }
  function startUpload(req, guest = null, body = req.body) {
    store.available();
    const size = number(body.total, '文件大小');
    check(size <= store.config.maxSingleFile, 413, '超过单文件上传大小限制');
    const originalName = fileName(body.name ?? body.fileName);
    const target = uploadTarget(req, body.parentId, guest);
    const relative = body.parents ?? [];
    check(Array.isArray(relative) && relative.length <= 99, 400, '批量上传路径无效');
    const folders = relative.map(fileName);
    const strategy = files.acceptConflict(body.conflict);
    const clientKey = typeof body.clientKey === 'string' ? body.clientKey.slice(0, 600) : null;
    const device = typeof body.device === 'string' ? body.device.slice(0, 100) : null;
    const actor = guest ? null : req.actor.id;
    let createdObject;
    try {
      const row = store.transaction(() => {
        let parent = target.parent;
        for (const name of folders) {
          const node = files.child(target.owner, parent, name) ?? files.directory(target.owner, parent, name);
          check(node.kind === 'folder', 409, `上传路径中的“${name}”已存在同名文件`);
          parent = node.id;
        }
        if (clientKey) {
          const existing = store.get(`SELECT * FROM tasks WHERE type='upload' AND actor IS ? AND visitor IS ? AND owner=? AND parent_id IS ?
            AND name=? AND total=? AND client_key=? AND status NOT IN ('success','cancelled') ORDER BY created DESC LIMIT 1`,
          actor, guest?.key ?? null, target.owner, parent, originalName, size, clientKey);
          if (existing) return existing;
        }
        const name = files.newName(target.owner, parent, originalName, 'file', strategy, { actor: req.actor, apply: false });
        if (name === null) return null;
        store.quota(target.owner, size);
        const disk = store.disk(true);
        check(!disk.full && disk.free >= size + store.uploadRemaining(), 507, '服务节点磁盘空间不足，请联系管理员', 50001);
        const id = randomUUID();
        closeSync(openSync(store.file(id), 'wx', 0o600));
        createdObject = id;
        const now = Date.now();
        store.run(`INSERT INTO tasks(id,actor,owner,share_id,visitor,type,name,total,parent_id,client_key,device,conflict,created,updated)
          VALUES (?,?,?,?,?,'upload',?,?,?,?,?,?,?,?)`, id, actor, target.owner, guest?.share.id ?? null, guest?.key ?? null,
        name, size, parent, clientKey, device, strategy, now, now);
        return get(id);
      });
      return row ? view(publish(row)) : { skipped: true };
    } catch (error) {
      if (createdObject) store.removeObject(createdObject);
      throw storageError(error);
    }
  }

  function writableJob(req, row, guest) {
    const target = uploadTarget(req, row.parent_id, guest);
    check(target.owner === row.owner, 403, '目标目录权限已变更');
  }

  function indexedChunk(req, fields, bytes, filename) {
    const count = number(fields.totalChunk, '总分片数', { min: 1 });
    const index = number(fields.chunkIndex, '分片序号', { max: count - 1 });
    let key = fields.fileKey ?? fields.taskId;
    if (!key) {
      check(index === 0, 400, '请从第 0 个分片开始上传');
      const total = count === 1 ? bytes.length : number(fields.totalSize, '文件总字节数', { min: 1 });
      check(count === 1 || (bytes.length > 0 && Math.ceil(total / bytes.length) === count), 400, '分片数量与文件总大小不符');
      const job = startUpload(req, null, { name: fields.fileName ?? filename, parentId: fields.parentId, total, conflict: fields.conflict });
      if (job.skipped) return job;
      key = job.id;
      store.run('UPDATE tasks SET source=? WHERE id=?', JSON.stringify({ block: bytes.length, count }), key);
    }
    const row = owned(key, req.actor);
    const layout = row.type === 'upload' && row.source ? JSON.parse(row.source) : null;
    check(layout?.count === count, 400, '分片数量与初始任务不符');
    const offset = index * layout.block;
    check(bytes.length === Math.min(layout.block, row.total - offset), 400, '分片大小与初始任务不符');
    return { ...(bytes.length ? receive(req, { ...fields, taskId: key, offset }, bytes) : view(row)), fileKey: key };
  }
  function receive(req, fields, bytes, guest = null) {
    store.available();
    const row = owned(fields.taskId ?? fields.fileKey, req.actor, guest);
    check(row.type === 'upload' && row.status !== 'cancelled', 409, '上传任务已经取消');
    if (row.status === 'success') return view(row);
    check(row.status !== 'paused', 409, '上传任务已暂停', 40902);
    const offset = number(fields.offset, '分片起点');
    check(bytes.length && offset + bytes.length <= row.total, 400, '分片超出文件大小');
    check(!fields.sha256 || digest(bytes) === fields.sha256, 422, '分片校验失败，文件可能已损坏');
    writableJob(req, row, guest);
    check(offset <= row.done, 409, '分片位置不匹配，请从上次断点继续', 40902, { done: row.done });
    let fd;
    try {
      fd = openSync(store.file(row.id), 'r+');
      const persisted = fstatSync(fd).size;
      check(persisted >= row.done, 422, '服务端分片丢失或损坏');
      if (offset < row.done) {
        check(offset + bytes.length <= row.done, 409, '分片与已保存的数据部分重叠', 40902, { done: row.done });
        const saved = Buffer.alloc(bytes.length);
        readSync(fd, saved, 0, saved.length, offset);
        check(saved.equals(bytes), 422, '上传的分片与已保存数据不一致');
        return view(row);
      }
      if (persisted > row.done) ftruncateSync(fd, row.done);
      let written = 0;
      while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written, offset + written);
      fsyncSync(fd);
      store.run(`UPDATE tasks SET done=?,status='transferring',reason=NULL,updated=? WHERE id=?`, offset + bytes.length, Date.now(), row.id);
      return view(publish(get(row.id)));
    } catch (error) {
      const failure = storageError(error);
      if (!(failure instanceof DriveError) || failure.status >= 422) update(row.id, 'failed', failure instanceof DriveError ? failure.message : '写入存储失败');
      throw failure;
    } finally { if (fd !== undefined) closeSync(fd); }
  }

  function finishUpload(req, guest = null) {
    store.available();
    const row = owned(req.body.fileKey ?? req.body.taskId, req.actor, guest);
    check(row.type === 'upload' && row.status !== 'cancelled', 409, '上传任务已经取消');
    if (row.status === 'success') {
      const node = files.getNode(row.file_id);
      return { task: view(row), file: node && files.display(node, guest ? 'read' : files.access(req.actor, node)) };
    }
    check(row.status !== 'paused' || req.body.conflict, 409, '上传任务已暂停', 40902);
    check(row.done === row.total && statSync(store.file(row.id)).size === row.total, 422, '文件分片不完整或已损坏');
    check(row.total <= store.config.maxSingleFile, 413, '超过单文件上传大小限制');
    if (req.body.fileName !== undefined) check(req.body.fileName === row.name, 400, '文件名称与传输任务不一致');
    writableJob(req, row, guest);
    let node;
    try {
      node = store.transaction(() => {
        store.quota(row.owner, row.total, row.id);
        const strategy = files.acceptConflict(req.body.conflict ?? row.conflict);
        const name = files.newName(row.owner, row.parent_id, row.name, 'file', strategy, { actor: req.actor });
        if (name === null) {
          store.run(`UPDATE tasks SET status='cancelled',history_hidden=0,updated=? WHERE id=?`, Date.now(), row.id);
          return null;
        }
        const now = Date.now();
        const result = store.run('INSERT INTO nodes(owner,parent,name,kind,size,blob,created,modified) VALUES (?,?,?,\'file\',?,?,?,?)',
          row.owner, row.parent_id, name, row.total, row.id, now, now);
        const id = Number(result.lastInsertRowid);
        store.run(`UPDATE tasks SET status='success',history_hidden=0,reason=NULL,name=?,file_id=?,updated=? WHERE id=?`, name, id, now, row.id);
        files.touch(row.parent_id);
        store.audit(req, 'file', guest ? '访客上传' : '上传', name, row.total);
        return files.getNode(id);
      });
    } catch (error) {
      if (error.code === 40901) update(row.id, 'paused', error.message);
      throw error;
    }
    if (!node) store.removeObject(row.id);
    return { task: view(publish(get(row.id))), file: node && files.display(node, guest ? 'read' : files.access(req.actor, node)), skipped: !node };
  }

  async function send(req, res, location, name, mime, { mode = 'attachment', keep = () => true, onComplete } = {}) {
    store.available();
    const stats = statSync(location, { throwIfNoEntry: false });
    check(stats?.isFile(), 404, '文件不存在', 40401);
    const total = stats.size;
    const { start, end, partial } = rangeOf(req.get('Range'), total, res);
    const length = Math.max(0, end - start + 1);
    res.status(partial ? 206 : 200).set({ 'Content-Type': mime, 'Content-Disposition': disposition(mode, name),
      'Accept-Ranges': 'bytes', 'Content-Length': String(length) });
    if (partial) res.set('Content-Range', `bytes ${start}-${end}/${total}`);
    if (req.method === 'HEAD' || !length) {
      res.end();
      if (req.method !== 'HEAD') onComplete?.(start, end, length);
      return;
    }
    const controller = new AbortController();
    const abort = () => { if (!res.writableFinished) controller.abort(); };
    res.once('close', abort);
    readers++;
    const verify = authorizedRead(req, keep);
    const stream = createReadStream(location, { start, end, highWaterMark: 256 * 1024 });
    let remaining = length;
    let lastPiece;
    try {
      await pipeline(stream, async function* (buffers) {
        for await (const buffer of buffers) {
          for (const piece of blocks(buffer, 'download')) {
            check(verify(), 409, '传输已暂停或权限已变更');
            const rate = speedLimit('download');
            if (rate) {
              await throttle('download', piece.length, rate, controller.signal);
              check(verify(), 409, '传输已暂停或权限已变更');
            }
            remaining -= piece.length;
            if (remaining === 0) lastPiece = piece;
            else yield piece;
          }
        }
      }, res, { signal: controller.signal, end: false });
      check(lastPiece && verify(), 409, '传输已中断或权限已变更');
      const completion = finished(res, { cleanup: true });
      // 将最后一段数据和响应结束一起发送，避免客户端先确认断点。
      res.end(lastPiece);
      await completion;
      onComplete?.(start, end, length);
    } catch (error) {
      res.destroy();
      if (!controller.signal.aborted && !(error instanceof DriveError) && error.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.error('文件读取失败', error);
    } finally { readers--; res.removeListener('close', abort); }
  }

  function sendFile(req, res, node, preview = false, keep) {
    check(node.kind === 'file', 400, '该条目是文件夹');
    const { mime, preview: available } = format(node.name);
    check(!preview || available, 415, '此格式仅支持下载');
    return send(req, res, store.file(node.blob), node.name, preview ? mime : 'application/octet-stream', {
      mode: preview ? 'inline' : 'attachment', keep,
      onComplete: preview ? undefined : (start, end, length) => store.audit(req, 'file', '下载', node.name, length),
    });
  }
  function membersFor(roots) {
    const unique = new Set();
    const entries = [];
    for (const root of roots) {
      let archiveName = root.name;
      for (let index = 2; unique.has(archiveName.toLowerCase()); index++) archiveName = `${index}-${root.name}`;
      unique.add(archiveName.toLowerCase());
      const names = new Map([[root.id, archiveName]]);
      for (const node of files.tree(root.id)) {
        const name = names.get(node.id) ?? `${names.get(node.parent)}/${node.name}`;
        names.set(node.id, name);
        entries.push({ id: node.id, name, blob: node.blob, modified: node.modified });
      }
    }
    return entries;
  }
  const signature = (entries) => digest(JSON.stringify(entries.map(({ id, name, blob }) => [id, name, blob])));
  const archiveChecks = new Map();
  function archiveMatches(id, roots, expected) {
    const revision = store.nodeRevision();
    const cached = archiveChecks.get(id);
    if (cached?.revision === revision) return cached.snapshot === expected;
    const snapshot = signature(membersFor(roots));
    archiveChecks.delete(id);
    if (archiveChecks.size === 64) archiveChecks.delete(archiveChecks.keys().next().value);
    archiveChecks.set(id, { revision, snapshot });
    return snapshot === expected;
  }
  async function zipTo(path, entries) {
    const zip = archiver('zip', { store: true });
    const sink = createWriteStream(path, { flags: 'wx', mode: 0o600 });
    zip.on('warning', (error) => zip.destroy(error));
    const completion = pipeline(zip, sink);
    for (const entry of entries) {
      if (entry.blob) zip.file(store.file(entry.blob), { name: entry.name, date: new Date(entry.modified), mode: 0o644 });
      else zip.append(Buffer.alloc(0), { name: `${entry.name}/`, type: 'directory', date: new Date(entry.modified), mode: 0o755 });
    }
    await Promise.all([zip.finalize(), completion]);
  }
  const zipName = (nodes) => nodes.length === 1 ? `${nodes[0].name}.zip` : '内网网盘批量下载.zip';
  function prepare(row, actor) {
    if (jobs.has(row.id)) return jobs.get(row.id);
    const launch = async () => {
      try {
        store.available();
        const source = JSON.parse(row.source);
        const entries = membersFor(source.ids.map((id) => files.downloadable(actor, id)));
        const snapshot = signature(entries);
        store.removeObject(`${row.id}.part`, 'packages');
        store.removeObject(row.id, 'packages');
        await zipTo(store.file(`${row.id}.part`, 'packages'), entries);
        const current = get(row.id);
        if (!current || current.status === 'cancelled') { store.removeObject(`${row.id}.part`, 'packages'); return; }
        await rename(store.file(`${row.id}.part`, 'packages'), store.file(row.id, 'packages'));
        const updated = get(row.id);
        if (updated.status === 'cancelled') { store.removeObject(row.id, 'packages'); return; }
        const size = statSync(store.file(row.id, 'packages')).size;
        store.run('UPDATE tasks SET source=?,total=?,done=0,delivered=0 WHERE id=?', JSON.stringify({ ...source, snapshot }), size, row.id);
        update(row.id, updated.status === 'paused' ? 'paused' : 'waiting');
      } catch (error) {
        store.removeObject(`${row.id}.part`, 'packages');
        if (get(row.id)?.status !== 'cancelled') {
          const failure = storageError(error);
          update(row.id, 'failed', failure instanceof DriveError ? failure.message : '打包失败，文件可能已被删除或磁盘已满');
        }
      }
    };
    const job = launch().finally(() => jobs.delete(row.id));
    jobs.set(row.id, job);
    return job;
  }
  function newDownload(req) {
    store.available();
    const actor = req.actor;
    const selection = ids(req.body.fileId);
    const nodes = selection.map((id) => files.downloadable(actor, id));
    const node = nodes.length === 1 && nodes[0].kind === 'file' ? nodes[0] : null;
    const id = randomUUID();
    const now = Date.now();
    const device = typeof req.body.device === 'string' ? req.body.device.slice(0, 100) : null;
    store.run(`INSERT INTO tasks(id,actor,owner,type,name,total,status,source,object,file_id,device,created,updated) VALUES (?,?,?,'download',?,?,?,?,?,?,?,?,?)`,
      id, actor.id, actor.id, node?.name ?? zipName(nodes), node?.size ?? 0, node ? 'waiting' : 'preparing',
      JSON.stringify({ ids: selection, hasPublic: nodes.some(({ owner }) => owner === publicOwner) }), node?.blob ?? 'zip', node?.id ?? null, device, now, now);
    const row = publish(get(id));
    if (!node) prepare(row, actor);
    return view(row);
  }

  function checkTaskDownload(row, actor) {
    if (files.canDownloadPublic(actor)) return;
    const source = JSON.parse(row.source);
    const hasPublic = source.hasPublic ?? source.ids.some((id) => files.getNode(id)?.owner === publicOwner);
    if (hasPublic) files.requirePublicDownload(actor);
  }

  function stillAllowed(req, nodeId, guest = false) {
    return () => {
      try {
        if (guest) shares.inShare(shares.guest(req).share, nodeId);
        else files.downloadable(accounts.session(req, { touch: false }), nodeId);
        return true;
      } catch { return false; }
    };
  }

  async function batch(req, res, selection, read) {
    store.available();
    const nodes = selection.map(read);
    const name = zipName(nodes);
    const revision = store.nodeRevision();
    const entries = membersFor(nodes);
    const snapshot = signature(entries);
    const id = randomUUID();
    const path = store.file(id, 'packages');
    readers++;
    try {
      await zipTo(path, entries);
      const matchesArchive = () => {
        const current = selection.map(read);
        return revision === store.nodeRevision() || archiveMatches(id, current, snapshot);
      };
      check(matchesArchive(), 409, '文件内容已变更，请重新打包');
      await send(req, res, path, name, 'application/zip', {
        keep: () => {
          try { return matchesArchive(); } catch { return false; }
        },
        onComplete: (start, end, length) => store.audit(req, 'file', '批量下载', name, length),
      });
    } catch (error) { throw storageError(error); }
    finally { store.removeObject(id, 'packages'); readers--; }
  }

  api.get('/fs/preview', (req, res) => {
    const node = files.downloadable(accounts.session(req), req.query.fileId);
    return sendFile(req, res, node, true, stillAllowed(req, node.id));
  });
  api.get('/fs/download', (req, res) => {
    const actor = accounts.session(req);
    const node = files.downloadable(actor, req.query.fileId);
    if (node.kind === 'folder') return batch(req, res, [node.id], (id) => files.downloadable(accounts.session(req), id));
    return sendFile(req, res, node, false, stillAllowed(req, node.id));
  });
  api.post('/fs/download/batch', (req, res) => {
    accounts.session(req);
    return batch(req, res, ids(req.body.fileId), (id) => files.downloadable(accounts.session(req), id));
  });
  api.get('/share/preview', (req, res) => {
    const node = shares.inShare(shares.guest(req).share, req.query.fileId);
    return sendFile(req, res, node, true, stillAllowed(req, node.id, true));
  });
  api.get('/share/download', (req, res) => {
    const node = shares.inShare(shares.guest(req).share, req.query.fileId);
    if (node.kind === 'folder') return batch(req, res, [node.id], (id) => shares.inShare(shares.guest(req).share, id));
    return sendFile(req, res, node, false, stillAllowed(req, node.id, true));
  });

  api.post('/task/upload/start', (req, res) => { accounts.session(req); ok(res, startUpload(req)); });
  api.post('/fs/upload', async (req, res) => {
    accounts.session(req);
    const { fields, bytes, filename } = await multipart(req);
    accounts.session(req);
    ok(res, fields.offset === undefined && fields.chunkIndex !== undefined ? indexedChunk(req, fields, bytes, filename) : receive(req, fields, bytes));
  });
  api.post('/fs/upload/merge', (req, res) => { accounts.session(req); ok(res, finishUpload(req)); });
  api.post('/share/upload', async (req, res) => {
    const guest = shares.guest(req, { upload: true });
    if (req.is('multipart/form-data')) {
      const { fields, bytes } = await multipart(req);
      ok(res, receive(req, fields, bytes, shares.guest(req, { upload: true })));
    } else if (req.body.action === 'start') ok(res, startUpload(req, guest));
    else if (req.body.action === 'merge') ok(res, finishUpload(req, guest));
    else if (req.body.action === 'cancel') {
      const row = owned(req.body.taskId, null, guest);
      if (!terminal.has(row.status)) { update(row.id, 'cancelled'); store.removeObject(row.id); }
      ok(res);
    } else check(false, 400, '未知的访客上传操作');
  });
  api.post('/task/download/start', (req, res) => { accounts.session(req); ok(res, newDownload(req)); });
  api.get('/task/download/data', (req, res) => {
    const actor = accounts.session(req);
    const row = owned(req.query.taskId, actor);
    check(row.type === 'download' && ['waiting', 'transferring'].includes(row.status), 409, '下载尚未就绪、已暂停或已取消', 40902);
    const source = JSON.parse(row.source);
    const zipped = row.object === 'zip';
    function matchesSource(user) {
      const read = (id) => files.downloadable(user, id);
      if (zipped) return archiveMatches(row.id, source.ids.map(read), source.snapshot);
      return read(row.file_id).blob === row.object;
    }
    check(matchesSource(actor), 409, '文件内容已变更，请重新发起下载', 40903);
    if (row.status !== 'transferring') update(row.id, 'transferring');
    return send(req, res, store.file(zipped ? row.id : row.object, zipped ? 'packages' : 'objects'), row.name,
      zipped ? 'application/zip' : 'application/octet-stream', {
        keep: () => {
          if (get(row.id)?.status !== 'transferring') return false;
          try { return matchesSource(accounts.session(req, { touch: false })); } catch { return false; }
        },
        onComplete: (start, end) => {
          store.run("UPDATE tasks SET delivered=? WHERE id=? AND status<>'cancelled' AND delivered>=? AND delivered<?", end + 1, row.id, start, end + 1);
        },
      });
  });
  api.put('/task/progress', (req, res) => {
    const actor = accounts.session(req);
    const row = owned(req.body.taskId, actor);
    check(row.type === 'download' && row.status !== 'cancelled', 409, '下载任务已取消');
    if (row.status === 'success') return ok(res, view(row));
    checkTaskDownload(row, actor);
    const done = number(req.body.done, '续传位置', { max: row.total });
    check(done <= row.delivered, 409, '下载尚未到达指定断点', 40902);
    if (done > row.done || row.total === 0) {
      const status = done === row.total ? 'success' : row.status === 'paused' ? 'paused' : 'transferring';
      check(row.status !== 'preparing', 409, '文件还在打包', 40902);
      store.transaction(() => {
        store.run('UPDATE tasks SET done=?, status=?,history_hidden=0,reason=NULL,updated=? WHERE id=?', done, status, Date.now(), row.id);
        if (status === 'success') store.audit(req, 'file', row.object === 'zip' ? '批量下载' : '下载', row.name, row.total);
      });
      if (status === 'success' && row.object === 'zip') store.removeObject(row.id, 'packages');
    }
    return ok(res, view(publish(get(row.id))));
  });
  api.get('/task/list', (req, res) => {
    const actor = accounts.session(req, { touch: req.query.passive !== '1' });
    const type = req.query.type;
    check(type === undefined || ['upload', 'download'].includes(type), 400, '未知的任务类型');
    ok(res, list(actor.id, type, req.query.active === '1', req.query));
  });
  api.get('/task/info', (req, res) => {
    const actor = accounts.session(req, { touch: req.query.passive !== '1' });
    ok(res, view(owned(req.query.taskId, actor)));
  });
  api.get('/task/history', (req, res) => {
    const actor = accounts.session(req);
    const type = req.query.type;
    check(['upload', 'download'].includes(type), 400, '请选择记录类型');
    const { size, offset } = pageBounds(req.query);
    const { total } = store.get(`SELECT count(*) AS total FROM tasks WHERE ${visibleHistory}`, actor.id, type);
    const list = store.all(`SELECT * FROM tasks WHERE ${visibleHistory} ORDER BY updated DESC,id LIMIT ? OFFSET ?`, actor.id, type, size, offset).map(view);
    ok(res, { total, list });
  });
  api.delete('/task/history', (req, res) => {
    const actor = accounts.session(req);
    const type = req.query.type;
    check(['upload', 'download'].includes(type), 400, '请选择记录类型');
    const { taskIds, clear } = req.body;
    if (clear === true && !Object.hasOwn(req.body, 'taskIds')) {
      return ok(res, { deleted: store.run(`UPDATE tasks SET history_hidden=1 WHERE ${visibleHistory}`, actor.id, type).changes });
    }
    check(clear === undefined && Array.isArray(taskIds) && taskIds.length > 0 && taskIds.length <= 500
      && taskIds.every((id) => typeof id === 'string' && fileId.test(id)), 400, '请选择 1 到 500 条有效记录');
    const { changes } = store.run(`UPDATE tasks SET history_hidden=1 WHERE ${visibleHistory} AND id IN (SELECT value FROM json_each(?))`,
      actor.id, type, JSON.stringify(taskIds));
    ok(res, { deleted: changes });
  });
  for (const action of ['pause', 'resume', 'fail', 'cancel']) {
    api[action === 'cancel' ? 'delete' : 'put'](`/task/${action}`, (req, res) => {
      const actor = accounts.session(req);
      const row = owned(req.body.taskId, actor);
      if (!transferStates.has(row.status)) return ok(res, view(row));
      let updated;
      if (action === 'pause') updated = update(row.id, 'paused');
      if (action === 'fail') {
        const reason = typeof req.body.reason === 'string' ? req.body.reason.slice(0, 300) : '网络断开';
        updated = update(row.id, 'failed', reason);
        store.audit(req, 'file', row.type === 'upload' ? '上传失败' : '下载失败', `${row.name} · ${reason}`);
      }
      if (action === 'resume') {
        store.available();
        if (row.type === 'upload') writableJob(req, row);
        else checkTaskDownload(row, actor);
        if (row.object === 'zip' && !existsSync(store.file(row.id, 'packages'))) {
          updated = update(row.id, 'preparing');
          prepare(updated, actor);
        } else updated = update(row.id, 'waiting');
      }
      if (action === 'cancel') {
        updated = update(row.id, 'cancelled');
        if (row.type === 'upload') store.removeObject(row.id);
        if (row.object === 'zip') store.removeObject(row.id, 'packages');
      }
      return ok(res, view(updated));
    });
  }

  function expire() {
    const now = Date.now();
    for (const row of store.all(`SELECT * FROM tasks WHERE status NOT IN ('success','cancelled') AND updated<? AND (visitor IS NOT NULL OR updated<?)`, now - 90 * minute, now - 7 * day)) update(row.id, 'cancelled', '任务已过期');
    store.run(`DELETE FROM tasks WHERE status IN ('success','cancelled') AND updated<?`, now - 30 * day);
    if (!readers && !jobs.size) store.collectObjects();
  }

  return { list, listeners, expire, busy: () => Boolean(readers || jobs.size), drain: () => Promise.allSettled(jobs.values()) };
}
