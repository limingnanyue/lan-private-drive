import { extname } from 'node:path';
import { check, fileName, ids, nodeId, ok, page, publicOwner } from './data.mjs';

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
const sorts = { name: 'name', size: 'size', modified: 'modified', created: 'created', modifiedTime: 'modified', createTime: 'created', modifiedAt: 'modified', createdAt: 'created' };
const sortField = (query) => Object.hasOwn(sorts, query.sortField) ? sorts[query.sortField] : 'name';
const searchTerm = (query) => String(query.keyword ?? '').slice(0, 220).toLocaleLowerCase();
const managesPublic = (actor) => actor?.role === 'admin' || actor?.role === 'superadmin';

const imageTypes = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };
const textTypes = new Set(['.txt', '.md', '.json', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.scss', '.html', '.xml', '.py', '.java', '.cs', '.go', '.rs', '.rb', '.php', '.sql', '.sh', '.ps1', '.yaml', '.yml', '.toml', '.ini', '.log', '.csv', '.svg']);
export function format(name) {
  const extension = extname(name).toLowerCase();
  if (imageTypes[extension]) return { preview: 'image', mime: imageTypes[extension], extension };
  if (extension === '.mp4') return { preview: 'video', mime: 'video/mp4', extension };
  if (extension === '.pdf') return { preview: 'pdf', mime: 'application/pdf', extension };
  if (textTypes.has(extension)) return { preview: 'text', mime: 'text/plain; charset=utf-8', extension };
  return { preview: null, mime: 'application/octet-stream', extension };
}

export function fileRoutes(api, store, accounts) {
  const availablePublicUsers = () => store.all("SELECT id,username,nickname AS name,enabled FROM users WHERE id>0 AND role='user' ORDER BY username");

  function publicPolicy(action, label, defaultMode) {
    const endpoint = `/fs/public/${action}-policy`;
    const key = `public-${action}-users`;
    const saved = store.get('SELECT value FROM settings WHERE key=?', key);
    const savedUsers = saved && JSON.parse(saved.value);
    let mode = saved ? (savedUsers === null ? 'all' : 'selected') : defaultMode;
    let allowed = new Set(savedUsers ?? []);

    api.get(endpoint, (req, res) => {
      accounts.session(req, { role: 'admin' });
      const users = availablePublicUsers();
      const userIds = users.filter(({ id }) => allowed.has(id)).map(({ id }) => id);
      ok(res, { mode, userIds, users });
    });
    api.put(endpoint, (req, res) => {
      accounts.session(req, { role: 'admin' });
      const { mode: next } = req.body;
      check(next === 'all' || next === 'selected' || next === defaultMode, 400, `请选择公共网盘的${label}范围`);
      let userIds = [];
      if (next === 'selected') {
        check(Array.isArray(req.body.userIds) && req.body.userIds.length > 0, 400, '请至少选择一位用户');
        userIds = ids(req.body.userIds);
        const eligible = new Set(availablePublicUsers().map(({ id }) => id));
        check(userIds.every((id) => eligible.has(id)), 400, '部分用户已变更，请刷新列表后重试');
      }
      store.transaction(() => {
        if (next === defaultMode) store.run('DELETE FROM settings WHERE key=?', key);
        else store.run('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
          key, JSON.stringify(next === 'all' ? null : userIds));
        const summary = { all: '所有登录用户', admin: '仅管理员', selected: `指定 ${userIds.length} 位用户` };
        store.audit(req, 'admin', `修改公共网盘${label}权限`, summary[next]);
      });
      mode = next;
      allowed = new Set(userIds);
      ok(res, { mode, userIds });
    });
    return { mode: () => mode, allows: (actor) => mode === 'all' || managesPublic(actor) || allowed.has(actor.id) };
  }

  const downloads = publicPolicy('download', '下载', 'all');
  const uploads = publicPolicy('upload', '上传', 'admin');

  const getNode = (id) => store.get('SELECT * FROM nodes WHERE id=?', id);
  const child = (owner, parent, name) => store.get('SELECT * FROM nodes WHERE owner=? AND parent IS ? AND name=? COLLATE NOCASE AND deleted IS NULL', owner, parent, name);
  const children = (owner, parent) => store.all('SELECT * FROM nodes WHERE owner=? AND parent IS ? AND deleted IS NULL', owner, parent);
  const ancestry = (id) => store.all(`WITH RECURSIVE trail(id,parent,name,deleted,depth) AS (
    SELECT id,parent,name,deleted,0 FROM nodes WHERE id=? UNION ALL
    SELECT n.id,n.parent,n.name,n.deleted,t.depth+1 FROM nodes n JOIN trail t ON n.id=t.parent
    WHERE t.depth<160) SELECT * FROM trail ORDER BY depth DESC`, id);
  const tree = (id) => store.all(`WITH RECURSIVE tree AS (
    SELECT *,0 AS depth FROM nodes WHERE id=? UNION ALL
    SELECT n.*,tree.depth+1 FROM nodes n JOIN tree ON n.parent=tree.id WHERE n.deleted IS NULL
    ) SELECT * FROM tree ORDER BY depth,id`, id);
  function live(id) {
    const node = getNode(id);
    const trail = node ? ancestry(id) : [];
    check(node && trail[0]?.parent === null && trail.every((entry) => !entry.deleted), 404, '文件不存在', 40401);
    return node;
  }
  function access(actor, node) {
    if (node.owner === publicOwner) return managesPublic(actor) ? 'owner' : 'read';
    if (node.owner === actor.id) return 'owner';
    if (!store.get('SELECT enabled FROM users WHERE id=?', node.owner)?.enabled && actor.role !== 'superadmin') return null;
    const grants = store.all(`WITH RECURSIVE trail(id,parent) AS (SELECT id,parent FROM nodes WHERE id=? UNION ALL
      SELECT n.id,n.parent FROM nodes n JOIN trail t ON n.id=t.parent)
      SELECT g.permission FROM grants g JOIN trail ON g.node_id=trail.id WHERE g.user_id=?`, node.id, actor.id);
    if (grants.some(({ permission }) => permission === 'write')) return 'write';
    if (grants.length || actor.role === 'superadmin') return 'read';
    return null;
  }
  function readable(actor, id) {
    const node = live(nodeId(id));
    check(access(actor, node), 403, '无权访问此文件');
    return node;
  }
  function requirePublicDownload(actor) {
    check(downloads.allows(actor), 403, '你没有公共网盘下载权限，请联系管理员', 40302);
  }
  function downloadable(actor, id) {
    const node = readable(actor, id);
    if (node.owner === publicOwner) requirePublicDownload(actor);
    return node;
  }
  function owned(actor, id) {
    const node = live(nodeId(id));
    check(node.owner === actor.id || (node.owner === publicOwner && managesPublic(actor)), 403, '无权管理此文件');
    check(node.id !== store.publicRootId, 403, '公共网盘根目录不能更改');
    return node;
  }
  function writable(actor, id, { upload = false } = {}) {
    const parentId = nodeId(id, true);
    if (parentId === null) return { owner: actor.id, parent: null };
    const node = live(parentId);
    check(node.kind === 'folder', 403, '无权写入此目录');
    if (upload && node.owner === publicOwner) check(uploads.allows(actor), 403, '你没有公共网盘上传权限，请联系管理员', 40303);
    else check(['write', 'owner'].includes(access(actor, node)), 403, '无权写入此目录');
    return { owner: node.owner, parent: parentId };
  }
  function display(node, permission, trail = false) {
    return {
      id: node.id, ownerId: node.owner, parentId: node.parent, name: node.name, kind: node.kind, size: node.size,
      createdAt: node.created, modifiedAt: node.modified, shared: Boolean(node.shared), permission,
      preview: node.kind === 'file' ? format(node.name).preview : null,
      ...(trail ? { path: ancestry(node.id).map(({ id, name }) => ({ id, name })) } : {}),
    };
  }
  function directory(owner, parent, name) {
    check(!parent || ancestry(parent).length < 100, 400, '文件夹嵌套超过 100 层');
    const now = Date.now();
    const created = store.run('INSERT INTO nodes(owner,parent,name,kind,created,modified) VALUES (?,?,?,?,?,?)', owner, parent, name, 'folder', now, now);
    touch(parent);
    return getNode(Number(created.lastInsertRowid));
  }
  function touch(id) {
    if (id != null) store.run('UPDATE nodes SET modified=? WHERE id=?', Date.now(), id);
  }
  function softDelete(node) {
    const original = `/${ancestry(node.id).map(({ name }) => name).join('/')}`;
    store.run('UPDATE nodes SET parent=NULL,deleted=?,restore_parent=?,original=? WHERE id=?', Date.now(), node.parent, original, node.id);
    touch(node.parent);
  }
  function distinctNames(owner, parent, name, kind) {
    const extension = kind === 'file' ? extname(name) : '';
    const base = extension ? name.slice(0, -extension.length) : name;
    for (let index = 2; index < 100_000; index++) {
      const suffix = ` (${index})${extension}`;
      const points = [...base];
      while (Buffer.byteLength(points.join('') + suffix) > 220 && points.length) points.pop();
      const alternative = `${points.join('')}${suffix}`;
      if (!child(owner, parent, alternative)) return alternative;
    }
    check(false, 409, '自动重命名失败，请更换名称');
  }
  function acceptConflict(value) {
    const strategy = value ?? null;
    check(strategy === null || ['overwrite', 'rename', 'skip'].includes(strategy), 400, '无效的冲突处理方式');
    return strategy;
  }
  function newName(owner, parent, name, kind, strategy, { actor, apply = true } = {}) {
    const existing = child(owner, parent, name);
    if (!existing) return name;
    const canOverwrite = owner !== publicOwner || managesPublic(actor);
    const details = canOverwrite ? { name } : { name, canOverwrite };
    check(strategy, 409, `当前目录已存在同名${existing.kind === 'folder' ? '文件夹' : '文件'}`, 40901, details);
    if (strategy === 'skip') return null;
    if (strategy === 'rename') return distinctNames(owner, parent, name, kind);
    check(canOverwrite, 403, '只有管理员可以覆盖公共网盘中的已有条目', 40304);
    if (apply) softDelete(existing);
    return name;
  }

  function normalized(selection) {
    const selected = new Set(selection.map(({ id }) => id));
    return selection.filter(({ id }) => !ancestry(id).some((ancestor) => ancestor.id !== id && selected.has(ancestor.id)));
  }
  function sortRows(rows, query, alreadySorted = false) {
    const field = sortField(query);
    const direction = query.sortOrder === 'desc' ? -1 : 1;
    const keyword = searchTerm(query);
    const matching = keyword ? rows.filter((row) => (row.searchName ??= row.name.toLocaleLowerCase()).includes(keyword)) : rows;
    if (alreadySorted) return matching;
    return matching.sort((left, right) =>
      Number(right.kind === 'folder') - Number(left.kind === 'folder') || direction * (field === 'name'
        ? collator.compare(left.name, right.name) : left[field] - right[field] || collator.compare(left.name, right.name)) || left.id - right.id);
  }

  const directoryCache = new Map();
  let cachedRevision;
  function directoryRows(owner, parent, query) {
    const revision = store.nodeRevision();
    // shortcut: 文件变更会清空目录缓存，混合读写负载升高时再按目录失效。
    if (revision !== cachedRevision) {
      directoryCache.clear();
      cachedRevision = revision;
    }
    const key = `${owner}:${parent}`;
    let entry = directoryCache.get(key);
    if (!entry) {
      const rows = store.all(`SELECT id,owner,parent,name,kind,size,created,modified,shared FROM nodes
        WHERE owner=? AND parent IS ? AND deleted IS NULL`, owner, parent);
      entry = { rows, order: null };
      if (rows.length <= 20_000) {
        if (directoryCache.size === 4) directoryCache.delete(directoryCache.keys().next().value);
        directoryCache.set(key, entry);
      }
    }
    const order = `${sortField(query)}:${query.sortOrder === 'desc'}`;
    if (searchTerm(query)) return sortRows(entry.rows, query, entry.order === order);
    if (entry.order !== order) {
      sortRows(entry.rows, query);
      entry.order = order;
    }
    return entry.rows;
  }

  api.get('/fs/list', (req, res) => {
    const actor = accounts.session(req);
    const publicSpace = req.query.space === 'public';
    const parent = nodeId(req.query.parentId, true) ?? (publicSpace ? store.publicRootId : null);
    const node = parent ? readable(actor, parent) : null;
    check(!publicSpace || node?.owner === publicOwner, 404, '公共目录不存在');
    check(!node || node.kind === 'folder', 400, '目标不是文件夹');
    const owner = node?.owner ?? (req.query.ownerId === undefined ? actor.id : nodeId(req.query.ownerId));
    check(node || owner === actor.id || actor.role === 'superadmin', 403, '无权打开此账户的根目录');
    const permission = node ? access(actor, node) : owner === actor.id ? 'owner' : 'read';
    const rows = directoryRows(owner, parent, req.query);
    const folder = node && display(node, permission, true);
    if (folder && owner !== publicOwner && owner !== actor.id && actor.role !== 'superadmin') {
      folder.path = folder.path.filter((entry) => access(actor, { id: entry.id, owner }));
      if (folder.path.length === 1) folder.parentId = null;
    }
    const result = page(rows, req.query);
    ok(res, { total: result.total, list: result.list.map((item) => display(item, permission)), folder, permission,
      ...(owner === publicOwner ? { canDownload: downloads.allows(actor), downloadMode: downloads.mode(),
        canUpload: uploads.allows(actor), uploadMode: uploads.mode() } : {}) });
  });

  api.get('/fs/targets', (req, res) => {
    const actor = accounts.session(req);
    const parent = nodeId(req.query.parentId, true);
    const target = writable(actor, parent);
    const own = children(target.owner, parent).filter(({ kind }) => kind === 'folder');
    if (!parent) {
      for (const node of store.all(`SELECT n.* FROM nodes n JOIN grants g ON n.id=g.node_id
        JOIN users u ON u.id=n.owner WHERE g.user_id=? AND g.permission='write' AND n.kind='folder' AND u.enabled=1`, actor.id)) {
        if (ancestry(node.id).every((entry) => !entry.deleted)) own.push(node);
      }
    }
    const targets = sortRows(own, {}).map((node) => display(node, access(actor, node)));
    if (!parent && managesPublic(actor)) targets.push({ ...display(getNode(store.publicRootId), 'owner'), publicRoot: true });
    ok(res, targets);
  });

  api.post('/fs/mkdir', (req, res) => {
    const actor = accounts.session(req);
    store.available();
    const { owner, parent } = writable(actor, req.body.parentId, { upload: true });
    const name = fileName(req.body.name);
    check(!child(owner, parent, name), 409, '当前目录已存在同名文件或文件夹');
    const node = directory(owner, parent, name);
    store.audit(req, 'file', '新建文件夹', name);
    ok(res, display(node, access(actor, node)));
  });

  api.put('/fs/rename', (req, res) => {
    const node = owned(accounts.session(req), req.body.fileId);
    store.available();
    const name = fileName(req.body.name);
    const existing = child(node.owner, node.parent, name);
    check(!existing || existing.id === node.id, 409, '当前目录已存在同名文件或文件夹');
    store.run('UPDATE nodes SET name=?,modified=? WHERE id=?', name, Date.now(), node.id);
    store.audit(req, 'file', '重命名', `${node.name} → ${name}`);
    ok(res, display(getNode(node.id), 'owner'));
  });

  function relocate(req, res, mode) {
    const actor = accounts.session(req);
    store.available();
    const selection = normalized(ids(req.body.fileId).map((id) => mode === 'move' ? owned(actor, id) : downloadable(actor, id)));
    const { owner, parent } = writable(actor, req.body.targetParentId);
    const strategy = acceptConflict(req.body.conflict);
    const ancestors = parent ? ancestry(parent) : [];
    for (const node of selection) {
      check(node.owner !== owner || node.parent !== parent, 400, '请选择其他目标目录');
      check(!ancestors.some(({ id }) => id === node.id), 400, '不能选择该文件夹或其子文件夹');
    }
    const result = store.transaction(() => {
      let changed = 0;
      for (const node of selection) {
        const name = newName(owner, parent, node.name, node.kind, strategy, { actor });
        if (name === null) continue;
        const nodes = tree(node.id);
        check(ancestors.length + nodes.at(-1).depth <= 99, 400, '目标路径太深');
        if (mode === 'move' && owner === node.owner) {
          store.run('UPDATE nodes SET parent=?,name=?,modified=? WHERE id=?', parent, name, Date.now(), node.id);
        } else {
          store.quota(owner, nodes.reduce((sum, item) => sum + item.size, 0));
          const mapping = new Map();
          for (const item of nodes) {
            const now = Date.now();
            const root = item.id === node.id;
            const record = store.run('INSERT INTO nodes(owner,parent,name,kind,size,blob,created,modified) VALUES (?,?,?,?,?,?,?,?)',
              owner, root ? parent : mapping.get(item.parent), root ? name : item.name, item.kind, item.size, item.blob, now, item.modified);
            mapping.set(item.id, Number(record.lastInsertRowid));
          }
          if (mode === 'move') softDelete(node);
        }
        changed++;
        touch(node.parent);
        store.audit(req, 'file', mode === 'move' ? '移动' : '复制', name);
      }
      touch(parent);
      return { changed, skipped: selection.length - changed };
    });
    ok(res, result);
  }
  api.post('/fs/move', (req, res) => relocate(req, res, 'move'));
  api.post('/fs/copy', (req, res) => relocate(req, res, 'copy'));

  api.delete('/fs/delete', (req, res) => {
    const actor = accounts.session(req);
    store.available();
    const selection = normalized(ids(req.body.fileId).map((id) => owned(actor, id)));
    store.transaction(() => {
      for (const node of selection) {
        softDelete(node);
        store.audit(req, 'file', '移到回收站', node.name);
      }
    });
    ok(res, { changed: selection.length });
  });

  function recycleOwner(req) {
    if (req.query.space !== 'public') return accounts.session(req).id;
    accounts.session(req, { role: 'admin' });
    return publicOwner;
  }
  function recycled(owner, selection) {
    if (!selection) return store.all('SELECT * FROM nodes WHERE owner=? AND deleted IS NOT NULL ORDER BY deleted DESC,id DESC', owner);
    return ids(selection).map((id) => {
      const node = getNode(id);
      check(node?.deleted, 404, '回收站条目不存在');
      check(node.owner === owner, 403, '无权访问此回收站条目');
      return node;
    });
  }
  api.get('/recycle/list', (req, res) => {
    const result = page(recycled(recycleOwner(req)), req.query);
    result.list = result.list.map((node) => ({ ...display(node, 'owner'), originalPath: node.original, deletedAt: node.deleted,
      size: node.kind === 'file' ? node.size : tree(node.id).reduce((sum, entry) => sum + entry.size, 0) }));
    ok(res, result);
  });
  api.post('/recycle/restore', (req, res) => {
    const owner = recycleOwner(req);
    store.available();
    const selection = recycled(owner, req.body.fileId ?? []);
    selection.sort((left, right) => left.original.length - right.original.length);
    const restored = store.transaction(() => selection.map((node) => {
      let parent = node.restore_parent;
      if (parent) {
        const trail = ancestry(parent);
        if (!trail.length || trail.some((entry) => entry.deleted)) parent = null;
      }
      if (owner === publicOwner) parent ??= store.publicRootId;
      const name = newName(owner, parent, node.name, node.kind, 'rename');
      store.run('UPDATE nodes SET name=?,parent=?,deleted=NULL,restore_parent=NULL,original=NULL,modified=? WHERE id=?', name, parent, Date.now(), node.id);
      store.audit(req, 'file', '还原', node.original);
      touch(parent);
      return display(getNode(node.id), 'owner');
    }));
    ok(res, restored);
  });

  function erase(req, res, all = false) {
    const owner = recycleOwner(req);
    store.available();
    const selection = recycled(owner, all ? null : req.body.fileId ?? []);
    const objects = new Set();
    store.transaction(() => {
      for (const node of selection) {
        for (const item of tree(node.id)) if (item.blob) objects.add(item.blob);
        store.run('DELETE FROM nodes WHERE id=?', node.id);
        store.audit(req, 'file', '永久删除', node.original);
      }
    });
    for (const blob of objects) if (!store.get('SELECT id FROM nodes WHERE blob=? LIMIT 1', blob)) store.removeObject(blob);
    ok(res, { changed: selection.length });
  }
  api.delete('/recycle/hardDelete', (req, res) => erase(req, res));
  api.delete('/recycle/clear', (req, res) => erase(req, res, true));

  return { getNode, live, readable, downloadable, canDownloadPublic: downloads.allows, requirePublicDownload, owned, writable, access, display,
    child, children, directory, tree, ancestry, touch, newName, acceptConflict, sortRows };
}
