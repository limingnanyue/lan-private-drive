import { check, day, digest, hashPassword, matchesPassword, minute, ok, token } from './data.mjs';

const defaultPreference = { view: 'list', autoplay: false, notifications: true };
const levels = { user: 1, admin: 2, superadmin: 3 };

export function accountRoutes(api, store) {
  const dummyPassword = hashPassword(token());
  const cookie = 'lan_drive';
  const roleCheck = (actor, role) => check(levels[actor.role] >= levels[role], 403, '权限不足');
  const preference = (user) => ({ ...defaultPreference, ...JSON.parse(user.preference) });
  function userInfo(user, withDisk = false) {
    return {
      id: user.id, username: user.username, name: user.nickname, nickname: user.nickname, role: user.role,
      spaceQuota: user.quota, spaceUsed: store.used(user.id), status: Boolean(user.enabled), createdAt: user.created,
      createdBy: user.created_by, preference: preference(user), ...(withDisk ? { diskFull: store.disk().full } : {}),
    };
  }

  function session(req, { touch = true, role = 'user' } = {}) {
    const header = req.headers.authorization ?? '';
    const raw = /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(header)?.[1]
      ?? new RegExp(`(?:^|;\\s*)${cookie}=([A-Za-z0-9_-]{43})(?:;|$)`, 'u').exec(req.headers.cookie ?? '')?.[1];
    check(raw, 401, '请先登录');
    const key = digest(raw);
    const now = Date.now();
    const row = store.get('SELECT * FROM sessions WHERE key=?', key);
    const user = row && store.get('SELECT * FROM users WHERE id=?', row.user_id);
    check(row && user?.enabled && row.expires > now && row.seen + store.config.sessionTimeout * minute > now, 401, '登录已过期，请重新登录');
    roleCheck(user, role);
    const refresh = touch && now - row.seen >= 1000;
    if (refresh) store.run('UPDATE sessions SET seen=? WHERE key=?', now, key);
    const seen = refresh ? now : row.seen;
    req.accessRecheckAt = Math.min(row.expires, seen + store.config.sessionTimeout * minute, touch ? seen + 1000 : Infinity);
    req.actor = user;
    req.sessionKey = key;
    return user;
  }

  function setCookie(req, res, value, maxAge) {
    const options = { httpOnly: true, sameSite: 'strict', path: '/', secure: Boolean(req.socket.encrypted) };
    if (maxAge === 0) res.clearCookie(cookie, options);
    else res.cookie(cookie, value, { ...options, ...(maxAge ? { maxAge } : {}) });
  }

  function validatePassword(value) {
    check(typeof value === 'string' && value.length >= 8 && value.length <= 256, 400, '密码需为 8 至 256 个字符');
    if (store.config.passwordRule === 'strong') check(value.length >= 12 && /[a-z]/iu.test(value) && /\d/u.test(value) && /[^\p{L}\p{N}\s]/u.test(value), 400, '强密码至少 12 个字符，包含字母、数字和符号');
  }

  const peerAttempts = new Map();
  api.post('/auth/login', (req, res) => {
    const { username, password, remember } = req.body;
    check(typeof username === 'string' && username.trim().length > 0 && username.length <= 64 && typeof password === 'string' && password.length > 0 && password.length <= 256, 400, '请输入账号和密码');
    const now = Date.now();
    for (const [ip, count] of peerAttempts) if (count.until < now) peerAttempts.delete(ip);
    const attempts = peerAttempts.get(req.peer) ?? { until: now + minute, total: 0 };
    check(attempts.total < 45, 429, '登录尝试过多，请稍后重试');
    const user = store.get('SELECT * FROM users WHERE username=? AND id>0', username.trim());
    if (!user || !user.enabled || user.lock_until > now || !matchesPassword(password, user.password)) {
      attempts.total++;
      peerAttempts.set(req.peer, attempts);
      if (!user) matchesPassword(password, dummyPassword);
      let message = !user ? '账号不存在' : !user.enabled ? '当前账号被管理员禁用' : '密码错误';
      let locked = user?.lock_until > now;
      if (user?.enabled && !locked) {
        const count = user.lock_until ? 1 : user.attempts + 1;
        locked = count >= 5;
        store.run('UPDATE users SET attempts=?,lock_until=? WHERE id=?', count, locked ? now + 10 * minute : 0, user.id);
      }
      if (locked) message = '密码错误次数过多，账号已锁定 10 分钟';
      store.audit(req, 'login', locked ? '登录锁定' : '登录失败', message, 0, user?.username ?? username.trim());
      check(false, locked ? 423 : 401, message, user && !user.enabled ? 40102 : undefined);
    }
    const value = token();
    const maxAge = remember === true ? 7 * day : undefined;
    store.transaction(() => {
      store.run('UPDATE users SET attempts=0,lock_until=0 WHERE id=?', user.id);
      store.run('DELETE FROM sessions WHERE expires<=? OR seen<=?', now, now - store.config.sessionTimeout * minute);
      store.run('INSERT INTO sessions(key,user_id,seen,expires) VALUES (?,?,?,?)', digest(value), user.id, now, now + (maxAge ?? day));
      store.audit(req, 'login', '登录成功', '', 0, user.username);
    });
    setCookie(req, res, value, maxAge);
    ok(res, { token: value, userInfo: userInfo(user, true) });
  });

  api.post('/auth/logout', (req, res) => {
    try { session(req, { touch: false }); } catch (error) { if (error.status !== 401) throw error; }
    if (req.sessionKey) {
      store.run('DELETE FROM sessions WHERE key=?', req.sessionKey);
      store.audit(req, 'login', '退出登录');
    }
    setCookie(req, res, '', 0);
    ok(res);
  });

  api.get('/auth/user/info', (req, res) => ok(res, userInfo(session(req), true)));
  api.post('/auth/password/update', (req, res) => {
    const user = session(req);
    const { oldPwd, newPwd } = req.body;
    check(matchesPassword(oldPwd, user.password), 400, '旧密码错误');
    validatePassword(newPwd);
    store.transaction(() => {
      store.run('UPDATE users SET password=? WHERE id=?', hashPassword(newPwd), user.id);
      store.run('DELETE FROM sessions WHERE user_id=? AND key<>?', user.id, req.sessionKey);
      store.audit(req, 'login', '修改密码');
    });
    ok(res);
  });

  api.get('/user/preference', (req, res) => ok(res, preference(session(req))));
  api.put('/user/preference/save', (req, res) => {
    const user = session(req);
    const { view, autoplay, notifications } = req.body;
    check(['list', 'grid'].includes(view) && typeof autoplay === 'boolean' && typeof notifications === 'boolean', 400, '偏好设置无效');
    const values = { view, autoplay, notifications };
    store.run('UPDATE users SET preference=? WHERE id=?', JSON.stringify(values), user.id);
    ok(res, values);
  });

  return { session, userInfo, validatePassword };
}
