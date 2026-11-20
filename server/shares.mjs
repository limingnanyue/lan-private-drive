import QRCode from 'qrcode';
import { check, day, digest, hashPassword, ids, matchesPassword, minute, nodeId, ok, page, publicOwner, token } from './data.mjs';

const periods = { '1h': 60 * minute, '1d': day, '7d': 7 * day, '30d': 30 * day };

export function shareRoutes(api, store, accounts, files, shareOrigin) {
  const get = (id) => store.get(`SELECT s.*,u.username FROM shares s JOIN users u ON u.id=s.owner WHERE s.id=?`, nodeId(id));
  const byOwner = (user, id) => {
    const share = get(id);
    check(share && share.owner === user.id, 404, '分享不存在或已取消', 40402);
    return share;
  };
  function state(row) {
    if (row.cancelled || !row.node_id || !store.get('SELECT enabled FROM users WHERE id=?', row.owner)?.enabled) return 'cancelled';
    if (row.expires !== null && row.expires <= Date.now()) return 'expired';
    return files.ancestry(row.node_id).some(({ deleted }) => deleted) ? 'unavailable' : 'active';
  }
  function view(req, row) {
    return { shareId: row.id, shareCode: row.code, fileId: row.node_id, ownerId: row.owner, username: row.username,
      name: row.name, kind: row.kind, permission: row.permission, expireTime: row.expires, hasPassword: Boolean(row.password),
      visits: row.visits, createdAt: row.created, status: state(row), url: `${shareOrigin(req)}/s/${row.code}` };
  }
  function shares(userId = null) {
    return store.all(`SELECT s.*,u.username FROM shares s JOIN users u ON u.id=s.owner
      WHERE (? IS NULL OR s.owner=?) AND s.cancelled=0 ORDER BY s.created DESC,s.id DESC`, userId, userId);
  }
  function configuration(body, node, existing) {
    const permission = body.permission ?? existing?.permission ?? 'download';
    check(['download', 'upload'].includes(permission), 400, '分享权限无效');
    check(permission !== 'upload' || (node.kind === 'folder' && node.shared), 400, '请先将该目录设为共享文件夹');
    let expires = existing?.expires ?? null;
    if (Object.hasOwn(body, 'expireTime')) {
      const term = body.expireTime;
      if (term === 'permanent' || term === null) expires = null;
      else if (typeof term === 'string' && Object.hasOwn(periods, term)) expires = Date.now() + periods[term];
      else {
        expires = typeof term === 'string' ? Date.parse(term) : term;
        check(Number.isSafeInteger(expires) && expires > Date.now(), 400, '分享有效期无效');
      }
    }
    let password = existing?.password ?? null;
    if (Object.hasOwn(body, 'password')) {
      check(typeof body.password === 'string' && body.password.length <= 128, 400, '访问密码最多 128 个字符');
      password = body.password ? hashPassword(body.password) : null;
    }
    check(!store.config.defaultSharePassword || password, 400, '系统设置要求分享链接使用访问密码');
    return { permission, expires, password };
  }

  api.get('/share/options', (req, res) => {
    accounts.session(req);
    ok(res, { defaultSharePassword: store.config.defaultSharePassword });
  });
  api.post('/share/create', (req, res) => {
    const actor = accounts.session(req);
    const node = files.owned(actor, req.body.fileId);
    check(node.owner !== publicOwner, 403, '公共网盘文件仅供登录用户使用');
    const { permission, expires, password } = configuration(req.body, node);
    const result = store.run('INSERT INTO shares(code,owner,node_id,name,kind,permission,expires,password,created) VALUES (?,?,?,?,?,?,?,?,?)',
      token().slice(0, 24), actor.id, node.id, node.name, node.kind, permission, expires, password, Date.now());
    store.audit(req, 'file', '生成分享链接', node.name);
    ok(res, view(req, get(Number(result.lastInsertRowid))));
  });
  api.put('/share/update', (req, res) => {
    const actor = accounts.session(req);
    const row = byOwner(actor, req.body.shareId);
    check(!row.cancelled && row.node_id, 404, '分享不存在或已取消', 40402);
    const { permission, expires, password } = configuration(req.body, files.live(row.node_id), row);
    store.run('UPDATE shares SET permission=?,expires=?,password=?,version=version+1 WHERE id=?', permission, expires, password, row.id);
    store.audit(req, 'file', '编辑分享', row.name);
    ok(res, view(req, get(row.id)));
  });
  api.get('/share/my', (req, res) => ok(res, page(shares(accounts.session(req).id).map((row) => view(req, row)), req.query)));
  api.get('/share/qr', async (req, res) => {
    const share = view(req, byOwner(accounts.session(req), req.query.shareId));
    ok(res, { url: share.url, qr: await QRCode.toDataURL(share.url, { width: 220, margin: 2, color: { dark: '#17345b', light: '#ffffff' } }) });
  });
  function cancel(req, row, admin = false) {
    check(row && !row.cancelled, 404, '分享不存在或已取消', 40402);
    store.transaction(() => {
      store.run('UPDATE shares SET cancelled=1,version=version+1 WHERE id=?', row.id);
      store.run(`UPDATE tasks SET status='cancelled',updated=? WHERE share_id=? AND status NOT IN ('success','cancelled')`, Date.now(), row.id);
      store.audit(req, admin ? 'admin' : 'file', admin ? '强制取消分享' : '取消分享', row.name);
    });
  }
  api.delete('/share/cancel', (req, res) => { cancel(req, byOwner(accounts.session(req), req.body.shareId)); ok(res); });

  function memberManager(actor, value) {
    const node = files.live(nodeId(value));
    check(node.owner !== publicOwner, 403, '公共网盘统一使用管理员权限');
    const user = store.get('SELECT username,created_by FROM users WHERE id=?', node.owner);
    check(node.owner === actor.id || (node.kind === 'folder' && node.shared &&
      (actor.role === 'superadmin' || (actor.role === 'admin' && user.created_by === actor.id))), 403, '无权管理此共享');
    return { node, user };
  }
  api.get('/share/members', (req, res) => {
    const { node } = memberManager(accounts.session(req), req.query.fileId);
    ok(res, store.all('SELECT u.id AS userId,u.username,u.nickname,g.permission FROM grants g JOIN users u ON u.id=g.user_id WHERE g.node_id=? ORDER BY u.username', node.id));
  });
  api.put('/share/members/save', (req, res) => {
    const { node } = memberManager(accounts.session(req), req.body.fileId);
    const { members } = req.body;
    check(Array.isArray(members) && members.length <= 500, 400, '成员列表无效');
    const grants = new Map();
    for (const member of members) {
      check(member && ['read', 'write'].includes(member.permission) && (member.permission !== 'write' || node.kind === 'folder'), 400, '成员权限无效');
      const username = typeof member.username === 'string' ? member.username.trim().slice(0, 64) : null;
      const user = username ? store.get('SELECT id,enabled FROM users WHERE username=?', username) : store.get('SELECT id,enabled FROM users WHERE id=?', nodeId(member.userId));
      check(user?.enabled && user.id !== node.owner, 400, username ? `成员 ${username} 不存在、已禁用或为分享者本人` : '成员不存在、已禁用或为分享者本人');
      grants.set(user.id, member.permission);
    }
    store.transaction(() => {
      store.run('UPDATE nodes SET shared=1 WHERE id=?', node.id);
      store.run('DELETE FROM grants WHERE node_id=?', node.id);
      for (const [userId, permission] of grants) store.run('INSERT INTO grants(node_id,user_id,permission) VALUES (?,?,?)', node.id, userId, permission);
      store.audit(req, node.owner === req.actor.id ? 'file' : 'admin', '设置共享成员权限', node.name);
    });
    ok(res, { shared: true });
  });
  api.get('/share/toMe', (req, res) => {
    const actor = accounts.session(req);
    const nodes = store.all(`SELECT n.*,u.username,g.permission FROM grants g JOIN nodes n ON n.id=g.node_id
      JOIN users u ON u.id=n.owner WHERE g.user_id=? AND u.enabled=1 AND n.deleted IS NULL`, actor.id)
      .filter((node) => files.ancestry(node.id).every((entry) => !entry.deleted));
    const result = page(files.sortRows(nodes, req.query), req.query);
    result.list = result.list.map((node) => ({ ...files.display(node, node.permission), username: node.username }));
    ok(res, result);
  });
  api.delete('/share/subscription', (req, res) => {
    const actor = accounts.session(req);
    const selection = ids(req.body.fileId);
    store.transaction(() => {
      for (const id of selection) store.run('DELETE FROM grants WHERE node_id=? AND user_id=?', id, actor.id);
    });
    ok(res);
  });

  function publicShare(code) {
    check(typeof code === 'string' && /^[\w-]{24}$/u.test(code), 404, '分享不存在或已取消', 40402);
    const row = store.get('SELECT * FROM shares WHERE code=?', code);
    check(row && state(row) === 'active', 404, row && state(row) === 'expired' ? '分享链接已过期' : '分享不存在或已取消', 40402);
    return row;
  }
  function issue(req, row) {
    const credential = token();
    store.transaction(() => {
      store.run('DELETE FROM visits WHERE seen<?', Date.now() - 45 * minute);
      store.run('INSERT INTO visits(key,share_id,version,ip,seen) VALUES (?,?,?,?,?)', digest(credential), row.id, row.version, req.peer, Date.now());
      store.run('UPDATE shares SET visits=visits+1 WHERE id=?', row.id);
    });
    return credential;
  }
  function guest(req, { open = false, upload = false } = {}) {
    const row = publicShare(req.query.shareCode ?? req.body?.shareCode);
    const raw = req.get('X-Share-Token') ?? req.query.ticket;
    if (!raw && open && !row.password) {
      return { share: row, ticket: issue(req, row) };
    }
    check(typeof raw === 'string' && raw.length === 43, 401, row.password ? '请输入分享访问密码' : '请重新打开分享链接', 40103);
    const key = digest(raw);
    const visit = store.get('SELECT * FROM visits WHERE key=?', key);
    const now = Date.now();
    check(visit?.share_id === row.id && visit.version === row.version && visit.ip === req.peer && visit.seen + 30 * minute > now, 401, '访问凭证已过期，请重新打开分享链接', 40103);
    const refresh = now - visit.seen >= 1000;
    if (refresh) store.run('UPDATE visits SET seen=? WHERE key=?', now, key);
    req.accessRecheckAt = Math.min(row.expires ?? Infinity, (refresh ? now : visit.seen) + 1000);
    if (upload) check(row.permission === 'upload' && files.live(row.node_id).shared, 403, '此分享不允许上传');
    return { share: row, key };
  }
  function inShare(share, id) {
    const node = files.live(nodeId(id));
    check(node.owner === share.owner && files.ancestry(node.id).some((entry) => entry.id === share.node_id), 403, '无权访问此文件');
    return node;
  }
  const attempts = new Map();
  api.post('/share/verify', (req, res) => {
    const row = publicShare(req.body.shareCode);
    if (row.password) {
      const now = Date.now();
      for (const [key, value] of attempts) if (value.until < now) attempts.delete(key);
      const key = `${req.peer}/${row.id}`;
      const value = attempts.get(key) ?? { total: 0, until: now + 5 * minute };
      check(value.total < 10, 429, '尝试次数过多，请 5 分钟后重试');
      if (!matchesPassword(req.body.password, row.password)) {
        value.total++;
        attempts.set(key, value);
        check(false, 401, '分享密码错误', 40103);
      }
      attempts.delete(key);
    }
    ok(res, { ticket: issue(req, row) });
  });
  api.get('/share/list', (req, res) => {
    const { share, ticket } = guest(req, { open: true });
    const root = files.live(share.node_id);
    const parentId = nodeId(req.query.parentId, true);
    const target = parentId ? inShare(share, parentId) : root;
    check(!parentId || target.kind === 'folder', 400, '目标不是文件夹');
    const nodes = target.kind === 'file' ? [target] : files.children(target.owner, target.id);
    const path = files.ancestry(target.id).map(({ id, name }) => ({ id, name }));
    ok(res, { ...page(files.sortRows(nodes, req.query).map((node) => files.display(node, 'read')), req.query),
      name: root.name, kind: root.kind, permission: share.permission, rootId: root.id, ticket,
      path: path.slice(path.findIndex(({ id }) => id === root.id)) });
  });

  return { get, view, shares, cancel, guest, inShare };
}
