import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { check, hashPassword, nodeId, number, ok, page, pageBounds, publicOwner } from './data.mjs';

const runFile = promisify(execFile);

export function adminRoutes(api, store, accounts, files, shares, transfers) {
  const manager = (req) => accounts.session(req, { role: 'admin' });
  const superadmin = (req) => accounts.session(req, { role: 'superadmin' });
  const user = (id) => store.get('SELECT * FROM users WHERE id=?', nodeId(id));
  function managed(actor, id) {
    const target = user(id);
    check(target, 404, '账号不存在');
    check(actor.role === 'superadmin' || (target.created_by === actor.id && target.role === 'user'), 403, '无权管理此账号');
    return target;
  }
  function profile(body, actor, previous = null) {
    const name = typeof body.nickname === 'string' ? body.nickname.trim() : previous?.nickname;
    const role = body.role ?? previous?.role ?? 'user';
    check(name && name.length <= 64, 400, '请输入 1 至 64 个字符的昵称');
    check((actor.role === 'superadmin' ? ['superadmin', 'admin', 'user'] : ['user']).includes(role), 403, '无法分配此角色');
    const quota = number(body.spaceQuota ?? previous?.quota ?? 0, '配额', { max: 1024 ** 5 });
    return { name, role, quota };
  }

  api.get('/admin/user/list', (req, res) => {
    const actor = manager(req);
    const keyword = String(req.query.keyword ?? '').slice(0, 64).toLocaleLowerCase();
    const rows = (actor.role === 'superadmin' ? store.all('SELECT * FROM users WHERE id>0 ORDER BY id') : store.all("SELECT * FROM users WHERE created_by=? AND role='user' ORDER BY id", actor.id))
      .filter(({ username, nickname }) => `${username} ${nickname}`.toLocaleLowerCase().includes(keyword));
    const result = page(rows, req.query);
    result.list = result.list.map((row) => accounts.userInfo(row));
    ok(res, result);
  });
  api.post('/admin/user/add', (req, res) => {
    const actor = manager(req);
    const username = typeof req.body.username === 'string' ? req.body.username.trim().normalize('NFC') : '';
    check(/^[\p{L}\p{N}_][\p{L}\p{N}_.-]{0,63}$/u.test(username), 400, '账号可包含字母、数字、下划线、点和连字符');
    check(!store.get('SELECT id FROM users WHERE username=?', username), 409, '账号已存在');
    const { name, role, quota } = profile(req.body, actor);
    accounts.validatePassword(req.body.pwd);
    const result = store.run('INSERT INTO users(username,nickname,role,quota,password,created,created_by) VALUES (?,?,?,?,?,?,?)',
      username, name, role, quota, hashPassword(req.body.pwd), Date.now(), actor.id);
    store.audit(req, 'admin', '新增账号', username);
    ok(res, accounts.userInfo(user(Number(result.lastInsertRowid))));
  });
  api.put('/admin/user/edit', (req, res) => {
    const actor = manager(req);
    const target = managed(actor, req.body.userId);
    const { name, role, quota } = profile(req.body, actor, target);
    check(target.id !== actor.id || role === target.role, 409, '无法更改自己的角色', 40902);
    store.run('UPDATE users SET nickname=?,role=?,quota=? WHERE id=?', name, role, quota, target.id);
    store.audit(req, 'admin', '编辑账号', target.username);
    ok(res, accounts.userInfo(user(target.id)));
  });
  api.put('/admin/user/resetPwd', (req, res) => {
    const target = managed(manager(req), req.body.userId);
    accounts.validatePassword(req.body.newPwd);
    store.transaction(() => {
      store.run('UPDATE users SET password=?,attempts=0,lock_until=0 WHERE id=?', hashPassword(req.body.newPwd), target.id);
      store.run('DELETE FROM sessions WHERE user_id=?', target.id);
      store.audit(req, 'admin', '重置密码', target.username);
    });
    ok(res);
  });
  api.put('/admin/user/status', (req, res) => {
    const actor = manager(req);
    const target = managed(actor, req.body.userId);
    const enabled = req.body.status;
    check(typeof enabled === 'boolean', 400, '账号状态无效');
    check(target.id !== actor.id || enabled, 409, '无法禁用当前登录账号', 40902);
    store.transaction(() => {
      store.run('UPDATE users SET enabled=? WHERE id=?', Number(enabled), target.id);
      if (!enabled) {
        store.run('DELETE FROM sessions WHERE user_id=?', target.id);
        store.run('UPDATE shares SET cancelled=1,version=version+1 WHERE owner=? AND cancelled=0', target.id);
        store.run(`UPDATE tasks SET status='cancelled',updated=? WHERE (actor=? OR owner=?) AND status NOT IN ('success','cancelled')`, Date.now(), target.id, target.id);
      }
      store.audit(req, 'admin', enabled ? '启用账号' : '禁用账号', target.username);
    });
    ok(res, accounts.userInfo(user(target.id)));
  });

  const publicConfig = () => {
    const { instance, ...config } = store.config;
    return config;
  };
  api.get('/admin/config', (req, res) => { superadmin(req); ok(res, publicConfig()); });
  api.get('/admin/storage/info', (req, res) => {
    superadmin(req);
    ok(res, store.storageInfo(req.query.path));
  });
  api.get('/admin/storage/volumes', async (req, res) => {
    superadmin(req);
    if (process.platform !== 'win32') return ok(res, []);
    const { stdout } = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "[System.IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -in 'Fixed','Removable' -and $_.IsReady } | ForEach-Object { $_.Name }"],
    { windowsHide: true, timeout: 5000 });
    ok(res, stdout.split(/\r?\n/u).filter((path) => /^[a-z]:\\$/iu.test(path)).sort());
  });
  api.put('/admin/config/save', async (req, res) => {
    superadmin(req);
    const next = publicConfig();
    for (const [key, minimum, maximum] of [
      ['maxSingleFile', 1, 1024 ** 5], ['uploadSpeedLimit', 0, 1024 ** 4],
      ['downloadSpeedLimit', 0, 1024 ** 4], ['sessionTimeout', 1, 1440],
    ]) {
      if (Object.hasOwn(req.body, key)) next[key] = number(req.body[key], key === 'sessionTimeout' ? '会话超时' : '传输限制', { min: minimum, max: maximum });
      if (key.endsWith('SpeedLimit')) check(next[key] === 0 || next[key] >= 1024, 400, '传输限速最小为 1 KiB/s');
    }
    if (Object.hasOwn(req.body, 'passwordRule')) {
      check(['basic', 'strong'].includes(req.body.passwordRule), 400, '密码规则无效');
      next.passwordRule = req.body.passwordRule;
    }
    if (Object.hasOwn(req.body, 'defaultSharePassword')) {
      check(typeof req.body.defaultSharePassword === 'boolean', 400, '分享密码配置无效');
      next.defaultSharePassword = req.body.defaultSharePassword;
    }
    if (Object.hasOwn(req.body, 'storagePath')) {
      check(typeof req.body.storagePath === 'string' && req.body.storagePath.trim(), 400, '请输入挂载目录');
      next.storagePath = req.body.storagePath.trim();
    }
    if (Object.hasOwn(req.body, 'storageLimit')) next.storageLimit = number(req.body.storageLimit, '网盘容量上限');
    await store.saveConfig(next, transfers.busy);
    store.audit(req, 'admin', '保存系统设置', next.storagePath);
    ok(res, publicConfig());
  });

  api.get('/admin/share/list', (req, res) => {
    superadmin(req);
    ok(res, page(shares.shares().map((row) => shares.view(req, row)), req.query));
  });
  api.delete('/admin/share/forceCancel', (req, res) => {
    superadmin(req);
    shares.cancel(req, shares.get(req.body.shareId), true);
    ok(res);
  });
  api.get('/admin/share/folders', (req, res) => {
    const actor = manager(req);
    const rows = store.all(`SELECT n.*,u.username FROM nodes n JOIN users u ON u.id=n.owner WHERE n.kind='folder'
      AND n.shared=1 AND n.deleted IS NULL AND (?=1 OR u.created_by=? OR u.id=?) ORDER BY n.modified DESC`, Number(actor.role === 'superadmin'), actor.id, actor.id);
    ok(res, page(rows.filter((node) => files.ancestry(node.id).every(({ deleted }) => !deleted))
      .map((node) => ({ ...files.display(node, 'owner', true), username: node.username })), req.query));
  });

  function logFilter(query) {
    const parseTime = (value, fallback) => {
      if (!value) return fallback;
      const clock = /^\d{10,}$/u.test(String(value)) ? Number(value) : Date.parse(value);
      check(Number.isSafeInteger(clock), 400, '日志时间无效');
      return clock;
    };
    const start = parseTime(query.startTime, 0);
    const end = parseTime(query.endTime, Number.MAX_SAFE_INTEGER);
    check(start <= end, 400, '开始时间应早于结束时间');
    const type = query.type ?? '';
    check(['', 'login', 'file', 'admin'].includes(type), 400, '日志类型无效');
    const username = String(query.username ?? '').trim().slice(0, 64).toLocaleLowerCase();
    let where = 'time>=? AND time<=?';
    const params = [start, end];
    if (type) { where += ' AND type=?'; params.push(type); }
    if (username) {
      const matching = store.all(`SELECT DISTINCT username FROM audit WHERE ${where}`, ...params)
        .map((entry) => entry.username).filter((name) => name.toLocaleLowerCase().includes(username));
      where += ' AND username IN (SELECT value FROM json_each(?))';
      params.push(JSON.stringify(matching));
    }
    return { where, params };
  }

  const activity = (where = '1') => `SELECT username, CAST(strftime('%H',time/1000,'unixepoch','localtime') AS INTEGER) AS hour,
    sum(action IN ('上传','访客上传')) AS uploads,
    sum(CASE WHEN action IN ('上传','访客上传') THEN bytes ELSE 0 END) AS upload,
    sum(CASE WHEN action IN ('下载','批量下载') THEN bytes ELSE 0 END) AS download
    FROM audit WHERE time>=? AND type='file' AND action IN ('下载','批量下载','上传','访客上传') AND (${where}) GROUP BY username,hour`;

  function removeLogs(req, res, { where, params }) {
    const deleted = store.transaction(() => {
      const today = new Date().setHours(0, 0, 0, 0);
      store.run(`INSERT INTO audit_transfer_totals(day,username,hour,uploads,upload,download)
        SELECT ?, summary.* FROM (${activity(where)}) AS summary WHERE true
        ON CONFLICT(day,username,hour) DO UPDATE SET uploads=uploads+excluded.uploads,
        upload=upload+excluded.upload,download=download+excluded.download`, today, today, ...params);
      const result = store.run(`DELETE FROM audit WHERE ${where}`, ...params).changes;
      if (result) store.audit(req, 'admin', '清理系统日志', `删除 ${result} 条日志`);
      return result;
    });
    ok(res, { deleted });
  }

  api.get('/admin/log/list', (req, res) => {
    superadmin(req);
    const { where, params } = logFilter(req.query);
    const sql = `SELECT * FROM audit WHERE ${where} ORDER BY time DESC,id DESC`;
    if (req.query.page == null && req.query.size == null) {
      const list = store.all(sql, ...params);
      return ok(res, { total: list.length, list });
    }
    const { size, offset } = pageBounds(req.query);
    const { total } = store.get(`SELECT count(*) AS total FROM audit WHERE ${where}`, ...params);
    ok(res, { total, list: store.all(`${sql} LIMIT ? OFFSET ?`, ...params, size, offset) });
  });
  api.delete('/admin/log/delete', (req, res) => {
    superadmin(req);
    const list = req.body.logIds;
    check(Array.isArray(list) && list.length > 0 && list.length <= 500, 400, '请选择 1 到 500 条日志');
    const logIds = list.map((id) => number(id, '日志编号', { min: 1 }));
    removeLogs(req, res, { where: 'id IN (SELECT value FROM json_each(?))', params: [JSON.stringify(logIds)] });
  });
  api.delete('/admin/log/clear', (req, res) => {
    superadmin(req);
    removeLogs(req, res, logFilter(req.query));
  });
  api.get('/admin/log/export', (req, res) => {
    superadmin(req);
    const types = { login: '登录', file: '文件操作', admin: '管理员操作' };
    const cell = (value) => {
      const text = String(value);
      return `"${/^[\s]*[=+@-]|^[\t\r\n]/u.test(text) ? "'" : ''}${text.replaceAll('"', '""')}"`;
    };
    const { where, params } = logFilter(req.query);
    const rows = store.all(`SELECT * FROM audit WHERE ${where} ORDER BY time DESC,id DESC`, ...params)
      .map((row) => [new Date(row.time).toISOString(), row.ip, row.username, types[row.type], row.action, row.object, row.bytes]);
    rows.unshift(['时间', '内网 IP', '账号', '类别', '操作类型', '操作对象', '字节']);
    res.set('Content-Disposition', 'attachment; filename="lan-drive-audit.csv"').type('text/csv').send(`\ufeff${rows.map((row) => row.map(cell).join(',')).join('\r\n')}`);
  });

  api.get('/admin/dashboard/stat', (req, res) => {
    const actor = manager(req);
    const scope = actor.role === 'superadmin' ? null : actor.id;
    const accounts = store.all('SELECT id,username,nickname,quota FROM users WHERE id>0 AND (? IS NULL OR id=? OR created_by=?) ORDER BY id', scope, scope, scope);
    const distribution = accounts.map((row) => ({ id: row.id, name: row.nickname, username: row.username, bytes: store.used(row.id) }));
    const today = new Date().setHours(0, 0, 0, 0);
    const events = store.all(`${activity()} UNION ALL
      SELECT username,hour,uploads,upload,download FROM audit_transfer_totals WHERE day=?`, today, today);
    const users = new Set(accounts.map((entry) => entry.username));
    const trend = Array.from({ length: 24 }, (_, hour) => ({ hour, upload: 0, download: 0 }));
    let todayUploads = 0;
    for (const entry of events) {
      if (scope !== null && !users.has(entry.username)) continue;
      const point = trend[entry.hour];
      point.upload += entry.upload;
      point.download += entry.download;
      todayUploads += entry.uploads;
    }
    const disk = store.disk();
    const quota = accounts.reduce((sum, row) => sum + row.quota, 0);
    const publicStorage = scope === null ? store.used(publicOwner) : null;
    ok(res, { totalUsers: accounts.length, totalStorage: scope === null ? disk.capacity : quota, diskFree: scope === null ? disk.free : null,
      usedStorage: distribution.reduce((sum, row) => sum + row.bytes, publicStorage ?? 0), publicStorage, todayUploads, distribution, trend, diskFull: disk.full });
  });
}
