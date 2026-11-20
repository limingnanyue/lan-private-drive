import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';

const password = 'Drive!123456';
const root = new URL('../server/index.mjs', import.meta.url);

test('全新服务以 admin 登录，修改后重启仍使用新密码', async (suite) => {
  const { createDrive } = await import(root);
  const dataDir = mkdtempSync(join(tmpdir(), 'lan-drive-first-run-'));
  let drive, origin;
  suite.after(async () => {
    await drive?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  async function listen() {
    drive = createDrive({ dataDir });
    drive.server.listen(0, '127.0.0.1');
    await once(drive.server, 'listening');
    origin = `http://127.0.0.1:${drive.server.address().port}/api/v1/auth`;
  }
  const post = (path, body, token) => fetch(origin + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body),
  });
  const login = (password) => post('/login', { username: 'admin', password });
  await listen();
  const response = await login('admin');
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(existsSync(join(dataDir, 'initial-admin.txt')), false);
  assert.equal((await post('/password/update', { oldPwd: 'admin', newPwd: 'admin' }, data.token)).status, 400);
  assert.equal((await post('/password/update', { oldPwd: 'admin', newPwd: password }, data.token)).status, 200);
  await drive.close();
  await listen();
  assert.equal((await login('admin')).status, 401);
  assert.equal((await login(password)).status, 200);
});

test('局域网私有网盘 V1.0', async (suite) => {
  assert.ok(existsSync(root), '服务入口尚未实现');
  const { createDrive } = await import(root);
  const workspace = mkdtempSync(join(tmpdir(), 'lan-drive-check-'));
  const releaseDir = join(workspace, 'release');
  const installer = Buffer.from('LanDrive release fixture');
  const manifest = { version: '1.2.3', size: installer.length, sha256: createHash('sha256').update(installer).digest('hex') };
  mkdirSync(releaseDir);
  writeFileSync(join(releaseDir, 'LanDrive.exe'), installer);
  writeFileSync(join(releaseDir, 'windows.json'), JSON.stringify(manifest));
  let drive, origin;
  async function listen(shareHost) {
    drive = createDrive({ dataDir: join(workspace, 'data'), initialPassword: password, shareHost, releaseDir });
    drive.server.listen(0, '127.0.0.1');
    await once(drive.server, 'listening');
    origin = `http://127.0.0.1:${drive.server.address().port}`;
  }
  await listen();
  suite.after(async () => {
    await drive.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  function request(path, { token, method = 'GET', body, range, ticket, headers: extra } = {}) {
    const queryHeaders = { ...extra };
    if (token) queryHeaders.Authorization = `Bearer ${token}`;
    if (ticket) queryHeaders['X-Share-Token'] = ticket;
    if (range) queryHeaders.Range = range;
    if (body && !(body instanceof FormData)) {
      queryHeaders['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    return fetch(`${origin}/api/v1${path}`, { method, headers: queryHeaders, body });
  }

  async function json(path, options, status = 200) {
    const response = await request(path, options);
    const result = await response.json();
    assert.equal(response.status, status, `${path} ${JSON.stringify(result)}`);
    if (status === 200) assert.equal(result.code, 0);
    return result.data;
  }

  const post = (path, body, token, status) => json(path, { method: 'POST', body, token }, status);
  const put = (path, body, token, status) => json(path, { method: 'PUT', body, token }, status);
  const del = (path, body, token, status) => json(path, { method: 'DELETE', body, token }, status);
  const login = (username, pwd = password, remember = false, status = 200) => post('/auth/login', { username, password: pwd, remember }, undefined, status);
  const admin = (await login('admin')).token;
  const addUser = (username, role = 'user', spaceQuota = 0, token = admin) => post('/admin/user/add', { username, nickname: username, pwd: password, role, spaceQuota }, token);
  const folder = (name, token, parentId = null) => post('/fs/mkdir', { name, parentId }, token);
  const chunk = (taskId, offset, content, token, status) => {
    const body = new FormData();
    body.set('taskId', taskId);
    body.set('offset', offset);
    body.set('file', new Blob([content]), 'chunk.dat');
    return json('/fs/upload', { method: 'POST', body, token }, status);
  };
  const startUpload = (name, total, token, extra = {}) => post('/task/upload/start', { name, total, ...extra }, token);
  const merge = (taskId, token, conflict, status) => post('/fs/upload/merge', { fileKey: taskId, conflict }, token, status);
  const upload = async (name, content, token, extra) => {
    const job = await startUpload(name, Buffer.byteLength(content), token, extra);
    if (content.length) await chunk(job.id, 0, content, token);
    return (await merge(job.id, token)).file;
  };
  const download = (id, token, range) => request(`/fs/download?fileId=${id}`, { token, range });

  let alice, bob, manager, aliceId, bobId, directory, file;

  await suite.test('账号隔离、管理员权限和登录锁定', async () => {
    aliceId = (await addUser('alice')).id;
    bobId = (await addUser('bob')).id;
    await addUser('manager', 'admin');
    await addUser('locked');
    alice = (await login('alice')).token;
    bob = (await login('bob')).token;
    manager = (await login('manager')).token;
    await addUser('staff', 'user', 0, manager);
    const managedUsers = (await json('/admin/user/list', { token: manager })).list;
    assert.deepEqual(managedUsers.map((user) => user.username), ['staff']);
    await put('/admin/user/edit', { userId: managedUsers[0].id, role: 'admin' }, admin);
    await put('/admin/user/resetPwd', { userId: managedUsers[0].id, newPwd: password }, manager, 403);
    await put('/admin/user/status', { userId: bobId, status: false }, manager, 403);
    await json('/admin/config', { token: manager }, 403);
    await json('/admin/user/list', { token: alice }, 403);
    await json('/auth/user/info', {}, 401);
    for (let attempt = 0; attempt < 5; attempt++) await login('locked', '错误密码', false, attempt === 4 ? 423 : 401);
    await login('locked', password, false, 423);
    const loginResponse = await request('/auth/login', { method: 'POST', body: { username: 'alice', password, remember: true } });
    assert.match(loginResponse.headers.get('set-cookie'), /Max-Age=604800/);
    await loginResponse.text();
    const refusedOrigin = await request('/fs/mkdir', { token: alice, method: 'POST', body: { name: '禁止跨站提交' }, headers: { Origin: 'http://outside.invalid' } });
    assert.equal(refusedOrigin.status, 403);
    await refusedOrigin.text();
  });

  await suite.test('上传断点跨服务重启保留，下载返回有效 Range', async () => {
    directory = await folder('项目资料', alice);
    await post('/fs/mkdir', { name: '项目资料' }, alice, 409);
    await post('/fs/mkdir', { name: 'a/b' }, alice, 400);
    const job = await startUpload('计划.txt', 11, alice, { parentId: directory.id });
    assert.equal((await chunk(job.id, 0, 'hello ', alice)).done, 6);
    assert.equal((await chunk(job.id, 0, 'hello ', alice)).done, 6);
    await put('/task/pause', { taskId: job.id }, alice);
    await drive.close();
    await listen();
    assert.equal((await json('/task/list?type=upload', { token: alice })).list[0].done, 6);
    await put('/task/resume', { taskId: job.id }, alice);
    await chunk(job.id, 6, 'world', alice);
    file = (await merge(job.id, alice)).file;
    assert.equal((await merge(job.id, alice)).file.id, file.id);
    const response = await download(file.id, alice, 'bytes=6-10');
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), 'bytes 6-10/11');
    assert.equal(await response.text(), 'world');
    const missingRange = await download(file.id, alice, 'bytes=20-');
    assert.equal(missingRange.status, 416);
    await missingRange.text();
    assert.deepEqual((await json('/fs/list', { token: bob })).list, []);
    await json(`/fs/list?parentId=${directory.id}`, { token: bob }, 403);
    const denied = await download(file.id, bob);
    assert.equal(denied.status, 403);
    await denied.text();
    assert.equal((await json(`/fs/list?ownerId=${aliceId}`, { token: admin })).list[0].id, directory.id);
  });

  await suite.test('批量操作处理冲突并保留回收记录', async () => {
    const copyTo = await folder('归档', alice);
    await upload('计划.txt', 'old', alice, { parentId: copyTo.id });
    await post('/fs/copy', { fileId: [file.id], targetParentId: copyTo.id }, alice, 409);
    await post('/fs/copy', { fileId: [file.id], targetParentId: copyTo.id, conflict: 'rename' }, alice);
    const list = await json(`/fs/list?parentId=${copyTo.id}&sortField=name&sortOrder=asc`, { token: alice });
    assert.deepEqual(new Set(list.list.map((item) => item.name)), new Set(['计划 (2).txt', '计划.txt']));
    await post('/fs/move', { fileId: [directory.id], targetParentId: directory.id }, alice, 400);
    await del('/fs/delete', { fileId: [file.id] }, alice);
    await del('/fs/delete', { fileId: [directory.id] }, alice);
    const recycled = await json('/recycle/list', { token: alice });
    assert.equal(recycled.list.find((item) => item.id === file.id).originalPath, '/项目资料/计划.txt');
    await post('/recycle/restore', { fileId: [file.id] }, alice);
    assert.equal((await json('/fs/list?keyword=计划', { token: alice })).list[0].id, file.id);
    await del('/recycle/hardDelete', { fileId: [directory.id] }, alice);
    assert.equal((await json('/recycle/list', { token: alice })).total, 0);
  });

  await suite.test('账户授权、访客密码、目录边界、过期和撤销生效', async () => {
    const parent = await folder('不公开的上级目录', alice);
    directory = await folder('项目共享', alice, parent.id);
    const child = await upload('文档.txt', '只给成员', alice, { parentId: directory.id });
    await put('/share/members/save', { fileId: directory.id, members: [{ userId: bobId, permission: 'read' }] }, alice);
    assert.equal((await json('/share/toMe', { token: bob })).list[0].id, directory.id);
    assert.deepEqual((await json(`/fs/list?parentId=${directory.id}`, { token: bob })).folder.path.map(({ name }) => name), ['项目共享']);
    assert.equal(await (await download(child.id, bob)).text(), '只给成员');
    await del('/fs/delete', { fileId: [child.id] }, bob, 403);
    const share = await post('/share/create', { fileId: directory.id, permission: 'upload', expireTime: '1h', password: '访客密码' }, alice);
    const code = share.shareCode;
    await json(`/share/list?shareCode=${code}`, {}, 401);
    await post('/share/verify', { shareCode: code, password: '其他密码' }, undefined, 401);
    const { ticket } = await post('/share/verify', { shareCode: code, password: '访客密码' });
    assert.equal((await json(`/share/list?shareCode=${code}`, { ticket })).list[0].id, child.id);
    const outside = await request(`/share/download?shareCode=${code}&fileId=${file.id}`, { ticket });
    assert.equal(outside.status, 403);
    await outside.text();
    const guest = await json('/share/upload', { method: 'POST', ticket, body: { action: 'start', shareCode: code, name: '访客.txt', total: 2 } });
    const uploadBody = new FormData();
    uploadBody.set('taskId', guest.id);
    uploadBody.set('offset', '0');
    uploadBody.set('file', new Blob(['hi']), 'part');
    await json(`/share/upload?shareCode=${code}`, { method: 'POST', ticket, body: uploadBody });
    await json('/share/upload', { method: 'POST', ticket, body: { action: 'merge', shareCode: code, fileKey: guest.id } });
    assert.equal((await json(`/share/list?shareCode=${code}`, { ticket })).list.length, 2);
    await del('/share/subscription', { fileId: directory.id }, bob);
    assert.equal((await json('/share/toMe', { token: bob })).total, 0);
    const qr = await json(`/share/qr?shareId=${share.shareId}`, { token: alice });
    assert.match(qr.qr, /^data:image\/png;base64,/);
    drive.store.run('UPDATE shares SET expires=? WHERE id=?', Date.now() - 1, share.shareId);
    await json(`/share/list?shareCode=${code}`, { ticket }, 404);
    await put('/share/update', { shareId: share.shareId, permission: 'download', expireTime: 'permanent' }, alice);
    await del('/share/cancel', { shareId: share.shareId }, alice);
    await json(`/share/list?shareCode=${code}`, { ticket }, 404);
  });

  await suite.test('回收站计入配额，永久删除释放独占对象', async () => {
    const target = await addUser('quota', 'user', 4);
    const token = (await login('quota')).token;
    const limited = await upload('四字节.txt', '1234', token);
    const blob = drive.store.get('SELECT blob FROM nodes WHERE id=?', limited.id).blob;
    const stored = drive.store.file(blob);
    assert.equal(statSync(stored).size, 4);
    await del('/fs/delete', { fileId: [limited.id] }, token);
    await post('/task/upload/start', { name: '多余.txt', total: 1 }, token, 507);
    assert.equal((await json('/auth/user/info', { token })).spaceUsed, 4);
    await del('/recycle/clear', {}, token);
    assert.equal(existsSync(stored), false);
    assert.equal((await json('/auth/user/info', { token })).spaceUsed, 0);
    const current = await upload('空文件.txt', '', token);
    assert.equal((await download(current.id, token)).headers.get('content-length'), '0');
    const share = await post('/share/create', { fileId: current.id, permission: 'download' }, token);
    await put('/admin/user/status', { userId: target.id, status: false }, admin);
    await json('/auth/user/info', { token }, 401);
    await json(`/share/list?shareCode=${share.shareCode}`, {}, 404);
  });

  await suite.test('任务实时推送、下载暂停续传和批量 ZIP', async () => {
    const socket = new WebSocket(`${origin.replace('http', 'ws')}/ws/task`, { headers: { Authorization: `Bearer ${alice}` } });
    const [initial] = await once(socket, 'message');
    assert.equal(JSON.parse(initial).type, 'snapshot');
    const pushed = once(socket, 'message');
    const job = await post('/task/download/start', { fileId: [file.id] }, alice);
    const [event] = await pushed;
    assert.equal(JSON.parse(event).task.id, job.id);
    const first = await request(`/task/download/data?taskId=${job.id}`, { token: alice, range: 'bytes=0-5' });
    assert.equal(await first.text(), 'hello ');
    await put('/task/progress', { taskId: job.id, done: 6 }, alice);
    assert.equal((await put('/task/pause', { taskId: job.id }, alice)).status, 'paused');
    const paused = await request(`/task/download/data?taskId=${job.id}`, { token: alice, range: 'bytes=6-' });
    assert.equal(paused.status, 409);
    await paused.text();
    await put('/task/resume', { taskId: job.id }, alice);
    assert.equal(await (await request(`/task/download/data?taskId=${job.id}`, { token: alice, range: 'bytes=6-' })).text(), 'world');
    assert.equal((await put('/task/progress', { taskId: job.id, done: 11 }, alice)).status, 'success');
    const zip = await request('/fs/download/batch', { token: alice, method: 'POST', body: { fileId: [directory.id, file.id] } });
    assert.equal(zip.status, 200);
    const bytes = Buffer.from(await zip.arrayBuffer());
    assert.equal(bytes.readUInt32LE(), 0x04034b50);
    assert.ok(bytes.includes(Buffer.from('项目共享/文档.txt')));
    socket.close();
  });

  await suite.test('分片收齐后可立即确认下载断点', async () => {
    const task = await post('/task/download/start', { fileId: [file.id] }, alice);
    await put('/task/progress', { taskId: task.id, done: 6 }, alice, 409);
    drive.server.prependOnceListener('request', (req, res) => {
      const end = res.end.bind(res);
      res.end = (...args) => {
        setTimeout(() => { if (!res.destroyed) end(...args); }, 250);
        return res;
      };
    });
    const response = await request(`/task/download/data?taskId=${task.id}`, {
      token: alice, range: 'bytes=0-5', headers: { Connection: 'close' },
    });
    assert.equal(await response.text(), 'hello ');
    assert.equal((await put('/task/progress', { taskId: task.id, done: 6 }, alice)).done, 6);
    await del('/task/cancel', { taskId: task.id }, alice);
  });

  await suite.test('配置迁移、速率、密码规则、偏好和可导出审计', async () => {
    const storagePath = join(workspace, 'other-disk');
    const config = await put('/admin/config/save', { storagePath, maxSingleFile: 16, uploadSpeedLimit: 65536, downloadSpeedLimit: 65536, passwordRule: 'strong', sessionTimeout: 15, defaultSharePassword: true }, admin);
    assert.equal(config.storagePath, storagePath);
    assert.ok(drive.store.file(drive.store.get('SELECT blob FROM nodes WHERE id=?', file.id).blob).startsWith(storagePath));
    await post('/task/upload/start', { name: '超出单文件.txt', total: 17 }, alice, 413);
    const share = await post('/share/create', { fileId: file.id, permission: 'download' }, alice, 400);
    assert.equal(share, null);
    await post('/auth/password/update', { oldPwd: password, newPwd: 'justletters' }, alice, 400);
    await put('/user/preference/save', { view: 'grid', autoplay: true, notifications: false }, alice);
    assert.deepEqual(await json('/user/preference', { token: alice }), { view: 'grid', autoplay: true, notifications: false });
    assert.equal(await (await download(file.id, alice)).text(), 'hello world');
    const stat = await json('/admin/dashboard/stat', { token: admin });
    assert.ok(stat.todayUploads > 0);
    assert.equal(stat.trend.length, 24);
    assert.ok((await json('/admin/log/list?username=alice&type=file', { token: admin })).total > 0);
    const csv = await request('/admin/log/export?username=alice', { token: admin });
    assert.match(await csv.text(), /alice/);
    assert.ok(readFileSync(join(workspace, 'data', 'drive.sqlite')).subarray(0, 6).equals(Buffer.from('SQLite')));
  });

  await suite.test('传输记录按方向分页，队列和任务详情遵循账号权限', async () => {
    const active = await startUpload('记录测试等待.txt', 5, alice);
    const cancelled = await startUpload('记录测试取消.txt', 5, alice);
    await del('/task/cancel', { taskId: cancelled.id }, alice);
    const failure = await startUpload('记录测试失败.txt', 5, alice);
    await put('/task/fail', { taskId: failure.id, reason: '网络断开' }, alice);
    const uploads = await json('/task/history?type=upload&page=1&size=1', { token: alice });
    assert.ok(uploads.total >= 3);
    assert.equal(uploads.list.length, 1);
    const all = (await json('/task/history?type=upload', { token: alice })).list;
    assert.ok(all.some(({ id, status }) => id === cancelled.id && status === 'cancelled'));
    assert.ok(all.some(({ id, reason }) => id === failure.id && reason === '网络断开'));
    assert.ok(!all.some(({ id }) => id === active.id));
    assert.ok((await json('/task/history?type=download', { token: alice })).list.some(({ status }) => status === 'success'));
    assert.ok(!(await json('/task/history?type=upload', { token: bob })).list.some(({ id }) => id === cancelled.id));
    const queue = (await json('/task/list?active=1', { token: alice })).list;
    assert.ok(queue.some(({ id }) => id === active.id));
    assert.ok(queue.every(({ status }) => !['success', 'cancelled'].includes(status)));
    assert.equal((await json(`/task/info?taskId=${active.id}`, { token: alice })).id, active.id);
    await json(`/task/info?taskId=${active.id}`, { token: bob }, 404);
    await del('/task/cancel', { taskId: active.id }, alice);
    await del('/task/cancel', { taskId: failure.id }, alice);
  });

  await suite.test('清理传输记录只隐藏当前账号对应类型的记录，失败任务仍能续传', async () => {
    const uploads = '/task/history?type=upload';
    const downloads = '/task/history?type=download';
    const failed = await startUpload('保留断点.txt', 4, alice);
    await chunk(failed.id, 0, 'ab', alice);
    await put('/task/fail', { taskId: failed.id, reason: '断开' }, alice);
    const waiting = await startUpload('仍在排队.txt', 3, alice);
    const other = await startUpload('其他用户记录.txt', 0, bob);
    const otherFile = (await merge(other.id, bob)).file;
    const downloadCount = (await json(downloads, { token: alice })).total;
    assert.equal((await del(uploads, { taskIds: [failed.id, waiting.id, other.id] }, alice)).deleted, 1);
    assert.ok(!(await json(uploads, { token: alice })).list.some(({ id }) => id === failed.id));
    assert.ok((await json(uploads, { token: bob })).list.some(({ id }) => id === other.id));
    assert.equal((await del(downloads, { taskIds: [failed.id] }, alice)).deleted, 0);
    assert.equal((await del(uploads, { clear: true, taskIds: [failed.id] }, alice, 400)), null);
    assert.equal((await put('/task/resume', { taskId: failed.id }, alice)).done, 2);
    await chunk(failed.id, 2, 'cd', alice);
    const finished = (await merge(failed.id, alice)).file;
    assert.ok((await json(uploads, { token: alice })).list.some(({ id }) => id === failed.id));
    assert.ok((await del(uploads, { clear: true }, alice)).deleted > 0);
    assert.equal((await del(uploads, { clear: true }, alice)).deleted, 0);
    assert.equal((await json(uploads, { token: alice })).total, 0);
    assert.equal((await json(downloads, { token: alice })).total, downloadCount);
    assert.equal((await json(`/task/info?taskId=${waiting.id}`, { token: alice })).status, 'waiting');
    assert.equal(await (await download(finished.id, alice)).text(), 'abcd');
    await del('/task/cancel', { taskId: waiting.id }, alice);
    await del('/fs/delete', { fileId: finished.id }, alice);
    await del('/recycle/hardDelete', { fileId: finished.id }, alice);
    await del('/fs/delete', { fileId: otherFile.id }, bob);
    await del('/recycle/hardDelete', { fileId: otherFile.id }, bob);
  });

  await suite.test('客户端版本接口和下载提供同一版本文件', async () => {
    await json('/client/windows/release', {}, 401);
    assert.deepEqual(await json('/client/windows/release', { token: alice }), manifest);
    const asset = (version) => fetch(`${origin}/client/windows?version=${version}`, { headers: { Authorization: `Bearer ${alice}` } });
    assert.equal((await asset('0.0.1')).status, 409);
    const response = await asset(manifest.version);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), installer);
    const nextInstaller = Buffer.from('LanDrive newer release fixture');
    const nextRelease = { version: '1.2.4', size: nextInstaller.length, sha256: createHash('sha256').update(nextInstaller).digest('hex') };
    const artifact = `LanDrive-${nextRelease.version}-${nextRelease.sha256.slice(0, 12)}.exe`;
    writeFileSync(join(releaseDir, artifact), nextInstaller);
    assert.equal((await asset(nextRelease.version)).status, 409);
    writeFileSync(join(releaseDir, 'windows.json'), JSON.stringify({ ...nextRelease, artifact }));
    assert.deepEqual(await json('/client/windows/release', { token: alice }), nextRelease);
    assert.equal((await asset(manifest.version)).status, 409);
    assert.deepEqual(Buffer.from(await (await asset(nextRelease.version)).arrayBuffer()), nextInstaller);
    const direct = await fetch(`${origin}/client/windows`, { headers: { Authorization: `Bearer ${alice}` } });
    assert.deepEqual(Buffer.from(await direct.arrayBuffer()), nextInstaller);
    writeFileSync(join(releaseDir, 'windows.json'), JSON.stringify({ ...nextRelease, artifact: '../outside.exe' }));
    await json('/client/windows/release', { token: alice }, 503);
    writeFileSync(join(releaseDir, 'windows.json'), JSON.stringify(manifest));
  });

  await suite.test('超级管理员可删除选中日志和清理筛选结果，传输统计与文件保留', async () => {
    const filter = '/admin/log/list?type=file&username=ALICE';
    const sample = await upload('日志清理验证.txt', 'logs', alice);
    const before = await json('/admin/dashboard/stat', { token: admin });
    const logs = await json(`${filter}&page=1&size=1`, { token: admin });
    assert.ok(logs.total > 1);
    assert.equal(logs.list[0].object, sample.name);
    const selection = { logIds: [logs.list[0].id, logs.list[0].id] };
    await del('/admin/log/delete', selection, manager, 403);
    await del('/admin/log/clear?type=file', {}, alice, 403);
    await del('/admin/log/clear?type=unknown', {}, admin, 400);
    assert.equal((await del('/admin/log/delete', selection, admin)).deleted, 1);
    assert.equal((await json(filter, { token: admin })).total, logs.total - 1);
    assert.equal((await del('/admin/log/clear?type=file&username=ALI', {}, admin)).deleted, logs.total - 1);
    assert.equal((await json(filter, { token: admin })).total, 0);
    assert.ok((await json('/admin/log/list?type=login', { token: admin })).total > 0);
    const after = await json('/admin/dashboard/stat', { token: admin });
    assert.equal(after.todayUploads, before.todayUploads);
    assert.deepEqual(after.trend, before.trend);
    assert.equal(await (await download(sample.id, alice)).text(), 'logs');
    assert.ok((await json('/admin/log/list?type=admin', { token: admin })).list.some(({ action }) => action === '清理系统日志'));
    await del('/fs/delete', { fileId: sample.id }, alice);
    await del('/recycle/hardDelete', { fileId: sample.id }, alice);
  });

  await suite.test('设置可读取监听端口和目标磁盘，网盘上限计入回收站及上传预留', async () => {
    const config = '/admin/config/save';
    const storage = '/admin/storage/info';
    const volumes = '/admin/storage/volumes';
    const selectedPath = join(workspace, '待创建目录', '文件存储');
    const inspect = (path) => storage + '?' + new URLSearchParams({ path });
    await json('/server/info', {}, 401);
    assert.deepEqual(await json('/server/info', { token: alice }), { address: origin, port: Number(new URL(origin).port) });
    await json(storage, { token: manager }, 403);
    await json(volumes, { token: manager }, 403);
    if (process.platform === 'win32') {
      const roots = await json(volumes, { token: admin });
      const volume = parse(realpathSync(workspace)).root;
      assert.ok(roots.includes(volume));
      assert.ok((await json(inspect(volume), { token: admin })).capacity > 0);
      await json(inspect('\\仅相对于当前磁盘的目录'), { token: admin }, 400);
    }
    await json(inspect('relative/path'), { token: admin }, 400);
    await json(inspect(join(workspace, 'data', 'drive.sqlite')), { token: admin }, 400);

    const before = await json(inspect(selectedPath), { token: admin });
    const disk = statfsSync(workspace);
    assert.equal(before.storagePath, join(realpathSync(workspace), '待创建目录', '文件存储'));
    assert.equal(before.checkedPath, realpathSync(workspace));
    assert.equal(before.capacity, disk.blocks * disk.bsize);
    assert.ok(before.free > 0 && before.free <= before.capacity);
    assert.equal(before.limit, 0);
    assert.equal(before.uploadAvailable, null);
    assert.equal(existsSync(selectedPath), false);
    await put(config, { storagePath: selectedPath, storageLimit: before.capacity + 1 }, admin, 400);
    assert.equal(existsSync(selectedPath), false);

    const limit = before.used + before.reserved + 5;
    assert.equal((await put(config, { storageLimit: limit }, admin)).storageLimit, limit);
    const capacityFolder = await folder('容量占用', alice);
    const pending = await startUpload('容量占用.txt', 4, alice, { parentId: capacityFolder.id });
    const withUpload = await json(storage, { token: admin });
    assert.equal(withUpload.reserved, before.reserved + 4);
    assert.equal(withUpload.uploadAvailable, 1);
    const publicRoot = (await json('/fs/list?space=public', { token: manager })).folder.id;
    const extra = { parentId: publicRoot, name: '公共区容量.txt', total: 2 };
    await post('/task/upload/start', extra, manager, 507);
    await post('/fs/copy', { fileId: file.id, targetParentId: publicRoot }, admin, 507);
    await put(config, { storageLimit: limit - 2 }, admin, 409);
    await chunk(pending.id, 0, '1234', alice);
    await merge(pending.id, alice);
    assert.equal((await json(storage, { token: admin })).used, before.used + 4);
    await del('/fs/delete', { fileId: capacityFolder.id }, alice);
    await post('/task/upload/start', extra, manager, 507);
    await del('/recycle/hardDelete', { fileId: capacityFolder.id }, alice);
    assert.equal((await upload(extra.name, '12345', manager, { parentId: publicRoot })).size, 5);

    await drive.close();
    await listen('http://drive.lan:9999');
    assert.deepEqual(await json('/server/info', { token: alice }), { address: origin, port: Number(new URL(origin).port) });
    assert.equal((await json('/admin/config', { token: admin })).storageLimit, limit);
    await post('/task/upload/start', { name: '额外占用.txt', total: 1 }, alice, 507);
    assert.equal((await put(config, { storageLimit: 0 }, admin)).storageLimit, 0);
  });

  await suite.test('全局限速持续生效并完整收发分片', async () => {
    await put('/admin/config/save', { maxSingleFile: 1024 * 1024, uploadSpeedLimit: 64 * 1024, downloadSpeedLimit: 64 * 1024 }, admin);
    const bytes = Buffer.alloc(32 * 1024, 65);
    const job = await startUpload('限速测试.bin', bytes.length, alice);
    assert.ok(job.chunkSize <= 512 * 1024, '分片大小随限速调整');
    const started = performance.now();
    const progress = await chunk(job.id, 0, bytes, alice);
    assert.equal(progress.done, bytes.length);
    assert.ok(performance.now() - started > 390, '上传限速');
    const { file: limited } = await merge(job.id, alice);
    const reading = performance.now();
    const downloaded = Buffer.from(await (await download(limited.id, alice)).arrayBuffer());
    assert.deepEqual(downloaded, bytes);
    assert.ok(performance.now() - reading > 390, '下载限速');
  });

  await suite.test('配套接口可用 multipart 分片序号上传和合并', async () => {
    const fragment = (index, text, key) => {
      const body = new FormData();
      body.set('file', new Blob([text]), '配套接口.txt');
      body.set('totalChunk', '2');
      body.set('totalSize', '5');
      body.set('chunkIndex', index);
      if (key) body.set('fileKey', key);
      return json('/fs/upload', { token: alice, method: 'POST', body });
    };
    const first = await fragment(0, 'abc');
    assert.ok(first.fileKey);
    assert.equal((await fragment(1, 'de', first.fileKey)).done, 5);
    const result = await post('/fs/upload/merge', { fileKey: first.fileKey, fileName: '配套接口.txt' }, alice);
    assert.equal(result.file.name, '配套接口.txt');
    assert.equal(await (await download(result.file.id, alice)).text(), 'abcde');
  });

  await suite.test('不限速的大分片可重试，合并后的 Range 内容准确', async () => {
    await put('/admin/config/save', { maxSingleFile: 16 * 1024 ** 2, uploadSpeedLimit: 0, downloadSpeedLimit: 0 }, admin);
    const block = Buffer.alloc(8 * 1024 ** 2, 14);
    const task = await startUpload('大分片.bin', block.length + 2, alice);
    assert.equal(task.chunkSize, block.length);
    assert.equal((await chunk(task.id, 0, block, alice)).done, block.length);
    assert.equal((await chunk(task.id, 0, block, alice)).done, block.length);
    await chunk(task.id, block.length, 'OK', alice);
    const { file: result } = await merge(task.id, alice);
    const partial = await download(result.id, alice, `bytes=${block.length - 1}-`);
    assert.deepEqual(Buffer.from(await partial.arrayBuffer()), Buffer.from([14, 79, 75]));
  });

  await suite.test('公共网盘对登录用户开放，由管理员发布、整理和恢复', async () => {
    const publicListing = '/fs/list?space=public';
    const publicRecycle = (action) => `/recycle/${action}?space=public`;
    await json(publicListing, {}, 401);
    const publicRoot = (await json(publicListing, { token: alice })).folder?.id;
    assert.ok(publicRoot, '应自动创建独立的公共根目录');
    assert.equal((await json(publicListing, { token: alice })).permission, 'read');
    assert.equal((await json(publicListing, { token: manager })).permission, 'owner');
    const publicTarget = { parentId: publicRoot };
    const privateFolder = await folder('管理员内部目录', manager);
    const privateFile = await upload('发布说明.txt', '公开版本', manager, { parentId: privateFolder.id });
    await json(`${publicListing}&parentId=${privateFolder.id}`, { token: manager }, 404);
    await json(`/fs/list?parentId=${privateFolder.id}`, { token: alice }, 403);
    assert.ok(!(await json('/fs/list', { token: admin })).list.some(({ id }) => id === publicRoot));
    assert.ok((await json('/fs/targets', { token: manager })).some(({ id }) => id === publicRoot));
    assert.ok(!(await json('/fs/targets', { token: alice })).some(({ id }) => id === publicRoot));

    await post('/fs/mkdir', { name: '禁止创建', ...publicTarget }, alice, 403);
    await post('/task/upload/start', { name: '禁止上传.bin', total: 1, ...publicTarget }, alice, 403);
    const published = await folder('公共资料', manager, publicRoot);
    await post('/fs/copy', { fileId: privateFile.id, targetParentId: published.id }, manager);
    const contents = `${publicListing}&parentId=${published.id}&size=1`;
    const publicFile = (await json(contents, { token: bob })).list[0];
    assert.equal(publicFile.name, privateFile.name);
    assert.equal(await (await download(publicFile.id, bob)).text(), '公开版本');
    const downloadTask = await post('/task/download/start', { fileId: [publicFile.id] }, bob);
    const part = await request(`/task/download/data?taskId=${downloadTask.id}`, { token: bob, range: `bytes=0-${publicFile.size - 1}` });
    assert.equal(await part.text(), '公开版本');
    assert.equal((await put('/task/progress', { taskId: downloadTask.id, done: publicFile.size }, bob)).status, 'success');
    assert.equal((await download(privateFile.id, bob)).status, 403);
    assert.equal((await download(publicFile.id)).status, 401);
    await put('/fs/rename', { fileId: publicFile.id, name: '禁止重命名.txt' }, alice, 403);
    await del('/fs/delete', { fileId: publicFile.id }, alice, 403);
    await post('/fs/copy', { fileId: publicFile.id, targetParentId: publicRoot }, alice, 403);
    await post('/fs/copy', { fileId: publicFile.id, targetParentId: null }, alice);
    assert.ok((await json('/fs/list', { token: alice })).list.some(({ name }) => name === publicFile.name));
    await post('/share/create', { fileId: publicFile.id, permission: 'download', password: '访问密码' }, manager, 403);
    await put('/share/members/save', { fileId: published.id, members: [{ userId: aliceId, permission: 'write' }] }, manager, 403);
    await del('/fs/delete', { fileId: publicRoot }, admin, 403);

    const direct = await upload('公开上传.txt', '公共内容', manager, publicTarget);
    assert.equal(await (await download(direct.id, alice)).text(), '公共内容');
    await put('/fs/rename', { fileId: publicFile.id, name: '更名后的说明.txt' }, admin);
    assert.equal((await json(contents, { token: bob })).list[0].name, '更名后的说明.txt');
    assert.equal((await json(`${contents}&keyword=发布说明`, { token: bob })).total, 0);
    await del('/fs/delete', { fileId: publicFile.id }, admin);
    assert.equal((await json(contents, { token: bob })).total, 0);
    await json(publicRecycle('list'), { token: alice }, 403);
    assert.ok(!(await json('/recycle/list', { token: manager })).list.some(({ id }) => id === publicFile.id));
    assert.ok((await json(publicRecycle('list'), { token: manager })).list.some(({ id }) => id === publicFile.id));
    await post(publicRecycle('restore'), { fileId: publicFile.id }, manager);
    assert.equal((await json(contents, { token: alice })).list[0].id, publicFile.id);
    await del('/fs/delete', { fileId: publicFile.id }, manager);
    await del('/fs/delete', { fileId: published.id }, manager);
    await post(publicRecycle('restore'), { fileId: publicFile.id }, admin);
    assert.ok((await json(publicListing, { token: bob })).list.some(({ id }) => id === publicFile.id));

    const users = (await json('/admin/user/list', { token: admin })).list;
    assert.ok(users.every(({ id }) => id > 0));
    const dashboard = await json('/admin/dashboard/stat', { token: admin });
    assert.equal(dashboard.totalUsers, users.length);
    assert.ok(dashboard.publicStorage >= direct.size + publicFile.size);
    await drive.close();
    await listen();
    const reopened = await json(publicListing, { token: bob });
    assert.equal(reopened.folder.id, publicRoot);
    assert.equal(await (await download(direct.id, bob)).text(), '公共内容');
  });

  await suite.test('公共下载范围控制所有文件内容入口，并能撤销现有下载', async () => {
    const policy = '/fs/public/download-policy';
    const scope = '/fs/list?space=public';
    const settings = await json(policy, { token: manager });
    assert.equal(settings.mode, 'all');
    assert.ok(settings.users.some(({ id, username }) => id === aliceId && username === 'alice'));
    await json(policy, { token: alice }, 403);
    await put(policy, { mode: 'all' }, alice, 403);
    await put(policy, { mode: 'selected', userIds: [999999] }, manager, 400);
    await put(policy, { mode: 'selected', userIds: [] }, manager, 400);

    const rootId = (await json(scope, { token: alice })).folder.id;
    const collection = await folder('下载权限测试', manager, rootId);
    const content = 'c'.repeat(192 * 1024);
    const document = await upload('下载权限说明.txt', content, manager, { parentId: collection.id });
    const task = await post('/task/download/start', { fileId: document.id }, bob);
    const part = await request(`/task/download/data?taskId=${task.id}`, { token: bob, range: 'bytes=0-4095' });
    assert.equal(await part.text(), content.slice(0, 4096));
    // 模拟已经由旧版本创建的任务。
    drive.store.run('UPDATE tasks SET source=? WHERE id=?', JSON.stringify({ ids: [document.id] }), task.id);
    await put('/admin/config/save', { downloadSpeedLimit: 128 * 1024 }, admin);
    const inFlight = await download(document.id, bob);
    assert.equal(inFlight.status, 200);
    const reader = inFlight.body.getReader();
    const first = await reader.read();
    assert.ok(first.value.length > 0 && first.value.length < document.size);
    const restricted = await put(policy, { mode: 'selected', userIds: [aliceId, aliceId] }, manager);
    assert.deepEqual(restricted.userIds, [aliceId]);
    let received = first.value.length;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        received += next.value.length;
      }
    } catch (error) { assert.equal(error.name, 'TypeError'); }
    assert.ok(received < document.size);
    await put('/admin/config/save', { downloadSpeedLimit: 0 }, admin);

    const listing = await json(`${scope}&parentId=${collection.id}`, { token: bob });
    assert.equal(listing.canDownload, false);
    assert.equal(listing.list[0].id, document.id);
    assert.equal((await json(scope, { token: alice })).canDownload, true);
    for (const path of [`/fs/download?fileId=${document.id}`, `/fs/preview?fileId=${document.id}`, `/fs/download?fileId=${collection.id}`, `/task/download/data?taskId=${task.id}`]) {
      await json(path, { token: bob, range: 'bytes=0-31' }, 403);
    }
    await post('/fs/download/batch', { fileId: [collection.id] }, bob, 403);
    await post('/task/download/start', { fileId: collection.id }, bob, 403);
    await post('/fs/copy', { fileId: collection.id }, bob, 403);
    await put('/task/progress', { taskId: task.id, done: 4096 }, bob, 403);
    await put('/task/pause', { taskId: task.id }, bob);
    await put('/task/resume', { taskId: task.id }, bob, 403);
    assert.equal(await (await download(document.id, alice, 'bytes=0-31')).text(), content.slice(0, 32));
    assert.equal(await (await download(document.id, manager, 'bytes=0-31')).text(), content.slice(0, 32));
    await drive.close();
    await listen();
    assert.equal((await json(scope, { token: bob })).canDownload, false);
    assert.deepEqual((await json(policy, { token: admin })).userIds, [aliceId]);
    await put(policy, { mode: 'all' }, admin);
    assert.equal((await json(scope, { token: bob })).canDownload, true);
    assert.equal((await put('/task/resume', { taskId: task.id }, bob)).status, 'waiting');
    const resumed = await request(`/task/download/data?taskId=${task.id}`, { token: bob, range: 'bytes=4096-4127' });
    assert.equal(await resumed.text(), content.slice(4096, 4128));
    await del('/task/cancel', { taskId: task.id }, bob);
  });

  await suite.test('公共网盘可独立设置上传范围，撤权后分片和合并受限', async () => {
    const policy = '/fs/public/upload-policy';
    const downloadPolicy = '/fs/public/download-policy';
    const scope = '/fs/list?space=public';
    assert.equal((await json(policy, { token: manager })).mode, 'admin');
    await json(policy, { token: alice }, 403);
    await put(policy, { mode: 'all' }, alice, 403);
    await put(policy, { mode: 'selected', userIds: [] }, manager, 400);
    await put(policy, { mode: 'selected', userIds: [999999] }, manager, 400);
    const root = await json(scope, { token: bob });
    assert.equal(root.canUpload, false);
    assert.equal(root.uploadMode, 'admin');
    assert.equal((await json(scope, { token: manager })).canUpload, true);

    await put(downloadPolicy, { mode: 'selected', userIds: [bobId] }, manager);
    const selected = await put(policy, { mode: 'selected', userIds: [aliceId, aliceId] }, manager);
    assert.deepEqual(selected.userIds, [aliceId]);
    assert.equal((await json(scope, { token: bob })).canUpload, false);
    await post('/fs/mkdir', { name: '未经授权的新建', parentId: root.folder.id }, bob, 403);
    await post('/task/upload/start', { name: '未经授权的上传.txt', total: 1, parentId: root.folder.id }, bob, 403);

    const target = await folder('公共网盘上传测试', alice, root.folder.id);
    const listing = await json(scope + '&parentId=' + target.id, { token: alice });
    assert.equal(listing.canUpload, true);
    assert.equal(listing.canDownload, false);
    assert.equal(listing.permission, 'read');
    const original = await upload('发布说明.txt', '原版', manager, { parentId: target.id });
    const conflict = { parentId: target.id, name: original.name, total: 1 };
    assert.equal((await post('/task/upload/start', conflict, alice, 409)).canOverwrite, false);
    await post('/task/upload/start', { ...conflict, conflict: 'overwrite' }, alice, 403);
    const renamed = await upload(original.name, '新版', alice, { parentId: target.id, conflict: 'rename' });
    assert.equal(renamed.name, '发布说明 (2).txt');
    assert.equal(await (await download(original.id, manager)).text(), '原版');
    await put('/fs/rename', { fileId: original.id, name: '改名.txt' }, alice, 403);
    await del('/fs/delete', { fileId: renamed.id }, alice, 403);

    const pending = await startUpload('待续传.txt', 6, alice, { parentId: target.id, parents: ['子目录'] });
    assert.equal((await chunk(pending.id, 0, 'abc', alice)).done, 3);
    const ready = await startUpload('待合并.txt', 1, alice, { parentId: target.id });
    await chunk(ready.id, 0, 'x', alice);
    const later = await upload(ready.name, '原版', manager, { parentId: target.id });
    const indexed = new FormData();
    indexed.set('parentId', target.id);
    indexed.set('chunkIndex', '0');
    indexed.set('totalChunk', '1');
    indexed.set('file', new Blob(['索引分片']), '编号分片.txt');

    await put(policy, { mode: 'admin' }, manager);
    await chunk(pending.id, 3, 'def', alice, 403);
    await merge(ready.id, alice, undefined, 403);
    await json('/fs/upload', { method: 'POST', body: indexed, token: bob }, 403);
    await put('/task/pause', { taskId: pending.id }, alice);
    await put('/task/resume', { taskId: pending.id }, alice, 403);

    await put(policy, { mode: 'selected', userIds: [aliceId] }, manager);
    await drive.close();
    await listen();
    assert.deepEqual((await json(policy, { token: manager })).userIds, [aliceId]);
    assert.equal((await json(scope, { token: bob })).canUpload, false);
    await put(policy, { mode: 'all' }, admin);
    assert.equal((await json(scope, { token: bob })).uploadMode, 'all');
    assert.equal((await json(scope, { token: bob })).canUpload, true);
    assert.equal((await put('/task/resume', { taskId: pending.id }, alice)).done, 3);
    await chunk(pending.id, 3, 'def', alice);
    const resumed = (await merge(pending.id, alice)).file;
    assert.equal(await (await download(resumed.id, manager)).text(), 'abcdef');
    await merge(ready.id, alice, 'overwrite', 403);
    assert.equal((await merge(ready.id, alice, 'rename')).file.name, '待合并 (2).txt');
    assert.equal(await (await download(later.id, manager)).text(), '原版');
    const compat = await json('/fs/upload', { method: 'POST', body: indexed, token: bob });
    assert.equal((await merge(compat.fileKey, bob)).file.name, '编号分片.txt');
    await put(policy, { mode: 'admin' }, manager);
    await put(downloadPolicy, { mode: 'all' }, manager);
  });

  await suite.test('队列 ZIP 在权限撤销或目录变更后停止发送旧归档', async () => {
    const publicRoot = (await json('/fs/list?space=public', { token: bob })).folder.id;
    const collection = await folder('归档快照测试', manager, publicRoot);
    const document = await upload('原名称.txt', '归档内容', manager, { parentId: collection.id });
    let task = await post('/task/download/start', { fileId: collection.id }, bob);
    for (let attempt = 0; task.status === 'preparing' && attempt < 100; attempt++) {
      await delay(20);
      task = (await json('/task/list?type=download&passive=1', { token: bob })).list.find(({ id }) => id === task.id);
    }
    assert.equal(task.status, 'waiting');
    const address = `/task/download/data?taskId=${task.id}`;
    const first = await request(address, { token: bob, range: 'bytes=0-31' });
    assert.equal(Buffer.from(await first.arrayBuffer()).readUInt32LE(), 0x04034b50);
    await put('/fs/public/download-policy', { mode: 'selected', userIds: [aliceId] }, manager);
    await json(address, { token: bob, range: 'bytes=32-63' }, 403);
    await put('/fs/public/download-policy', { mode: 'all' }, manager);
    await put('/fs/rename', { fileId: document.id, name: '修改后的名称.txt' }, manager);
    await json(address, { token: bob, range: 'bytes=32-63' }, 409);
    await del('/task/cancel', { taskId: task.id }, bob);
  });

  await suite.test('限速下载过程中撤销分享会终止剩余传输', async () => {
    await put('/admin/config/save', { downloadSpeedLimit: 128 * 1024 }, admin);
    const bytes = Buffer.alloc(96 * 1024, 6);
    const node = await upload('撤销传输.bin', bytes, alice);
    const share = await post('/share/create', { fileId: node.id, password: '访客密码', permission: 'download' }, alice);
    const { ticket } = await post('/share/verify', { shareCode: share.shareCode, password: '访客密码' });
    const response = await request(`/share/download?shareCode=${share.shareCode}&fileId=${node.id}`, { ticket });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.ok(first.value.length < bytes.length);
    await del('/share/cancel', { shareId: share.shareId }, alice);
    let received = first.value.length;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        received += part.value.length;
      }
    } catch (error) { assert.equal(error.name, 'TypeError'); }
    assert.ok(received < bytes.length);
  });
});
