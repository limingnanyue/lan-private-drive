import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statfsSync, statSync, unlinkSync } from 'node:fs';
import { cp, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const minute = 60_000;
export const day = 1440 * minute;
export const terminal = new Set(['success', 'cancelled']);
export const publicOwner = 0;

export class DriveError extends Error {
  constructor(status, message, code = status * 100 + 1, details = null) {
    super(message);
    Object.assign(this, { status, code, details });
  }
}

export const check = (condition, status, message, code, details) => {
  if (!condition) throw new DriveError(status, message, code, details);
};
export const ok = (res, data = null, msg = '操作成功') => res.json({ code: 0, msg, data });
export const digest = (value) => createHash('sha256').update(value).digest('hex');
export const token = () => randomBytes(32).toString('base64url');

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return `${salt}:${scryptSync(password, salt, 32).toString('hex')}`;
}

export function matchesPassword(password, stored) {
  if (typeof password !== 'string' || password.length > 256 || !stored) return false;
  const actual = hashPassword(password, stored.split(':')[0]);
  return timingSafeEqual(Buffer.from(actual), Buffer.from(stored));
}

export function fileName(value) {
  check(typeof value === 'string', 400, '请输入名称');
  const name = value.trimStart().normalize('NFC');
  check(name && Buffer.byteLength(name) <= 220 && !/[\\/:*?"<>|\x00-\x1f\x7f]/u.test(name) && !/[. ]$/u.test(name)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name), 400, '名称不能为空、过长或包含特殊字符');
  return name;
}

export function number(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value;
  check(Number.isSafeInteger(parsed) && parsed >= min && parsed <= max, 400, `${label}无效`);
  return parsed;
}

export function nodeId(value, root = false) {
  if (root && (value === '' || value === 0 || value === '0' || value == null)) return null;
  return number(value, '文件编号', { min: 1 });
}

export function ids(value) {
  const input = Array.isArray(value) ? value : [value];
  check(input.length > 0 && input.length <= 1000, 400, '请选择 1 到 1000 个条目');
  return [...new Set(input.map((id) => nodeId(id)))];
}

export function pageBounds(query) {
  const size = number(query.size ?? 50, '每页条数', { min: 1, max: 500 });
  const current = number(query.page ?? 1, '页码', { min: 1, max: 10_000_000 });
  return { size, offset: (current - 1) * size };
}

export function page(rows, query) {
  if (query.page == null && query.size == null) return { total: rows.length, list: rows };
  const { size, offset } = pageBounds(query);
  return { total: rows.length, list: rows.slice(offset, offset + size) };
}

export const defaults = {
  storageLimit: 0, maxSingleFile: 2 * 1024 ** 3, uploadSpeedLimit: 0, downloadSpeedLimit: 0,
  sessionTimeout: 30, passwordRule: 'basic', defaultSharePassword: false,
};

function diskSpace(path) {
  const stat = statfsSync(path);
  return { capacity: stat.blocks * stat.bsize, free: stat.bavail * stat.bsize };
}

function inspectStoragePath(value) {
  check(typeof value === 'string' && isAbsolute(value) && !/^[/\\]{2}/u.test(value) && !/[\x00-\x1f]/u.test(value)
    && (process.platform !== 'win32' || /^[a-z]:[\\/]/iu.test(value)),
    400, '请输入服务器本地磁盘的绝对路径');
  const requested = resolve(value);
  let ancestor = requested;
  try {
    let stat = statSync(ancestor, { throwIfNoEntry: false });
    while (!stat) {
      const parent = dirname(ancestor);
      check(parent !== ancestor, 400, '所选磁盘不存在或服务无法访问');
      ancestor = parent;
      stat = statSync(ancestor, { throwIfNoEntry: false });
    }
    check(stat.isDirectory(), 400, '请选择服务器上的目录');
    const checkedPath = realpathSync(ancestor);
    return { storagePath: join(checkedPath, relative(ancestor, requested)), checkedPath, ...diskSpace(checkedPath) };
  } catch (error) {
    if (['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'EINVAL'].includes(error.code)) throw new DriveError(400, '所选目录或磁盘不可访问');
    throw error;
  }
}

function outsideDirectory(base, target) {
  const path = relative(base, target);
  return path === '..' || path.startsWith('..' + sep) || isAbsolute(path);
}

export function openStore(directory, initialPassword) {
  const location = resolve(directory);
  mkdirSync(location, { recursive: true });
  const db = new DatabaseSync(join(location, 'drive.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE COLLATE NOCASE NOT NULL, nickname TEXT NOT NULL,
      role TEXT NOT NULL, quota INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, password TEXT NOT NULL,
      created INTEGER NOT NULL, created_by INTEGER REFERENCES users(id), attempts INTEGER NOT NULL DEFAULT 0,
      lock_until INTEGER NOT NULL DEFAULT 0, preference TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS sessions (
      key TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), seen INTEGER NOT NULL, expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, owner INTEGER NOT NULL REFERENCES users(id), parent INTEGER REFERENCES nodes(id) ON DELETE CASCADE,
      name TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0, blob TEXT, created INTEGER NOT NULL,
      modified INTEGER NOT NULL, deleted INTEGER, restore_parent INTEGER, original TEXT, shared INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS active_names ON nodes(owner, coalesce(parent, 0), name COLLATE NOCASE) WHERE deleted IS NULL;
    CREATE INDEX IF NOT EXISTS node_children ON nodes(parent, deleted);
    CREATE INDEX IF NOT EXISTS node_owner_parent ON nodes(owner, parent) WHERE deleted IS NULL;
    CREATE INDEX IF NOT EXISTS node_blob ON nodes(blob);
    CREATE TABLE IF NOT EXISTS grants (
      node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id),
      permission TEXT NOT NULL, PRIMARY KEY(node_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS grants_recipient ON grants(user_id);
    CREATE TABLE IF NOT EXISTS shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL, owner INTEGER NOT NULL REFERENCES users(id),
      node_id INTEGER REFERENCES nodes(id) ON DELETE SET NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
      permission TEXT NOT NULL, expires INTEGER, password TEXT, visits INTEGER NOT NULL DEFAULT 0, cancelled INTEGER NOT NULL DEFAULT 0,
      created INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS shares_owner ON shares(owner);
    CREATE TABLE IF NOT EXISTS visits (
      key TEXT PRIMARY KEY, share_id INTEGER NOT NULL REFERENCES shares(id), version INTEGER NOT NULL, ip TEXT NOT NULL, seen INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, actor INTEGER REFERENCES users(id), owner INTEGER NOT NULL REFERENCES users(id), share_id INTEGER REFERENCES shares(id),
      visitor TEXT, type TEXT NOT NULL, name TEXT NOT NULL, total INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'waiting', reason TEXT, parent_id INTEGER, file_id INTEGER, source TEXT, object TEXT,
      client_key TEXT, device TEXT, conflict TEXT, delivered INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, updated INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tasks_actor ON tasks(actor, type, updated);
    CREATE INDEX IF NOT EXISTS tasks_owner ON tasks(owner, type, status);
    CREATE INDEX IF NOT EXISTS tasks_active_uploads ON tasks(owner) WHERE type='upload' AND status NOT IN ('success','cancelled');
    CREATE INDEX IF NOT EXISTS tasks_actor_active ON tasks(actor, created DESC, id) WHERE status NOT IN ('success','cancelled');
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, time INTEGER NOT NULL, ip TEXT NOT NULL, username TEXT NOT NULL,
      type TEXT NOT NULL, action TEXT NOT NULL, object TEXT NOT NULL, bytes INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS audit_time ON audit(time);
    CREATE INDEX IF NOT EXISTS audit_type_time ON audit(type,time);
    CREATE TABLE IF NOT EXISTS audit_transfer_totals (
      day INTEGER NOT NULL, username TEXT NOT NULL, hour INTEGER NOT NULL,
      uploads INTEGER NOT NULL, upload INTEGER NOT NULL, download INTEGER NOT NULL, PRIMARY KEY(day, username, hour)
    );
    CREATE TEMP TABLE node_revision (value INTEGER NOT NULL, bytes INTEGER NOT NULL);
    INSERT INTO node_revision SELECT 0, coalesce(sum(size),0) FROM nodes;
    CREATE TEMP TRIGGER node_inserted AFTER INSERT ON main.nodes BEGIN UPDATE node_revision SET value=value+1, bytes=bytes+new.size; END;
    CREATE TEMP TRIGGER node_updated AFTER UPDATE ON main.nodes BEGIN UPDATE node_revision SET value=value+1, bytes=bytes+new.size-old.size; END;
    CREATE TEMP TRIGGER node_deleted AFTER DELETE ON main.nodes BEGIN UPDATE node_revision SET value=value+1, bytes=bytes-old.size; END;
  `);
  if (!db.prepare('PRAGMA table_info(tasks)').all().some(({ name }) => name === 'history_hidden')) {
    db.exec('ALTER TABLE tasks ADD COLUMN history_hidden INTEGER NOT NULL DEFAULT 0');
  }
  db.exec(`CREATE INDEX IF NOT EXISTS tasks_visible_history ON tasks(actor, type, updated DESC, id)
    WHERE history_hidden=0 AND status IN ('success','cancelled','failed');
    DROP INDEX IF EXISTS tasks_actor_history;`);
  const statements = new Map();
  function prepare(sql) {
    if (statements.has(sql)) return statements.get(sql);
    const statement = db.prepare(sql);
    if (statements.size < 256) statements.set(sql, statement);
    return statement;
  }
  const get = (sql, ...params) => prepare(sql).get(...params);
  const all = (sql, ...params) => prepare(sql).all(...params);
  const run = (sql, ...params) => prepare(sql).run(...params);
  const revision = db.prepare('SELECT total_changes() AS value');
  const nodeRevision = db.prepare('SELECT value FROM node_revision');
  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  const saved = get('SELECT value FROM settings WHERE key=?', 'config');
  const instance = saved ? JSON.parse(saved.value).instance : randomUUID();
  let config = { ...defaults, storagePath: join(location, 'storage'), ...(saved && JSON.parse(saved.value)), instance };
  const namespace = `lan-drive-${instance}`;
  let moving = false;
  let diskFull = false;
  let diskCheck = 0;
  let diskResult;
  const storage = (configPath = config.storagePath) => join(configPath, namespace);
  const file = (id, kind = 'objects') => join(storage(), kind, id);
  const available = () => check(!moving, 503, '正在迁移存储，请稍后重试');
  const writeConfig = (next) => {
    run('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', 'config', JSON.stringify(next));
    config = next;
  };
  for (const subfolder of ['objects', 'packages']) mkdirSync(join(storage(), subfolder), { recursive: true });
  if (!saved) writeConfig(config);

  if (!get('SELECT id FROM users WHERE id<>? LIMIT 1', publicOwner)) {
    const firstRun = join(location, 'initial-admin.txt');
    const override = initialPassword || (existsSync(firstRun) ? readFileSync(firstRun, 'utf8').trim() : undefined);
    check(override === undefined || (typeof override === 'string' && override.length >= 8 && override.length <= 256),
      400, '自定义初始管理员密码需为 8 至 256 个字符');
    const password = override ?? 'admin';
    run('INSERT INTO users(username,nickname,role,password,created) VALUES (?,?,?,?,?)', 'admin', '系统管理员', 'superadmin', hashPassword(password), Date.now());
  }
  const publicRootId = transaction(() => {
    const root = get('SELECT id FROM nodes WHERE owner=? AND parent IS NULL AND deleted IS NULL', publicOwner);
    if (root) return root.id;
    const now = Date.now();
    run("INSERT OR IGNORE INTO users(id,username,nickname,role,password,enabled,created) VALUES (?,'@public-drive','公共网盘','user','',0,?)", publicOwner, now);
    return Number(run("INSERT INTO nodes(owner,name,kind,created,modified) VALUES (?,'公共网盘','folder',?,?)", publicOwner, now, now).lastInsertRowid);
  });
  run(`UPDATE tasks SET status='paused', updated=? WHERE status IN ('transferring','preparing')`, Date.now());

  function disk(force = false) {
    if (force || !diskResult || Date.now() >= diskCheck) {
      diskResult = diskSpace(storage());
      if (diskResult.free >= 1024 * 1024) diskFull = false;
      diskCheck = Date.now() + 5000;
    }
    return { ...diskResult, full: diskFull || diskResult.free === 0 };
  }

  const used = (owner) => get('SELECT coalesce(sum(size),0) AS bytes FROM nodes WHERE owner=?', owner).bytes;
  const uploadRemaining = () => get("SELECT coalesce(sum(total-done),0) AS bytes FROM tasks WHERE type='upload' AND status NOT IN ('success','cancelled')").bytes;
  function storageUsage(except = '') {
    const used = get('SELECT bytes FROM node_revision').bytes;
    const reserved = get("SELECT coalesce(sum(total),0) AS bytes FROM tasks WHERE type='upload' AND status NOT IN ('success','cancelled') AND id<>?", except).bytes;
    return { used, reserved };
  }
  function storageInfo(path = config.storagePath) {
    const info = inspectStoragePath(path);
    const { used, reserved } = storageUsage();
    const limit = config.storageLimit;
    let uploadAvailable = null;
    if (path === config.storagePath || !relative(config.storagePath, info.storagePath)) {
      const remaining = limit ? limit - used - reserved : Infinity;
      uploadAvailable = Math.max(0, Math.min(remaining, info.free - uploadRemaining()));
    }
    return { ...info, used, reserved, limit, uploadAvailable };
  }
  function quota(owner, incoming = 0, except = '') {
    if (config.storageLimit) {
      const { used, reserved } = storageUsage(except);
      check(used + reserved + incoming <= config.storageLimit, 507, '网盘存储容量不足，请联系管理员', 50702);
    }
    if (owner === publicOwner) return;
    const user = get('SELECT quota,enabled FROM users WHERE id=?', owner);
    check(user?.enabled, 403, '存储空间所属账号已禁用');
    if (!user.quota) return;
    const reserved = get(`SELECT coalesce(sum(total),0) AS bytes FROM tasks
      WHERE owner=? AND type='upload' AND status NOT IN ('success','cancelled') AND id<>?`, owner, except).bytes;
    check(used(owner) + reserved + incoming <= user.quota, 507, '存储空间不足', 50701);
  }

  function audit(req, type, action, object = '', bytes = 0, username = req.actor?.username ?? '访客') {
    run('INSERT INTO audit(time,ip,username,type,action,object,bytes) VALUES (?,?,?,?,?,?,?)',
      Date.now(), req.peer ?? '', username, type, action, String(object).slice(0, 1200), bytes);
  }

  function removeObject(id, kind) {
    try { unlinkSync(file(id, kind)); }
    catch (error) { if (error.code !== 'ENOENT' && error.code !== 'EBUSY' && error.code !== 'EPERM') console.error('清理存储对象失败', error); }
  }

  function collectObjects() {
    const referenced = new Set(all(`SELECT blob AS id FROM nodes WHERE blob IS NOT NULL
      UNION SELECT id FROM tasks WHERE type='upload' AND status NOT IN ('success','cancelled')`).map(({ id }) => id));
    for (const id of readdirSync(join(storage(), 'objects'))) {
      if (/^[a-f0-9-]{36}$/u.test(id) && !referenced.has(id)) removeObject(id);
    }
    const packages = new Set(all(`SELECT id FROM tasks WHERE type='download' AND object='zip' AND status NOT IN ('cancelled','success')`).map(({ id }) => id));
    for (const id of readdirSync(join(storage(), 'packages'))) {
      if (/^[a-f0-9-]{36}(?:\.part)?$/u.test(id) && !packages.has(id)) removeObject(id, 'packages');
    }
  }
  collectObjects();

  async function saveConfig(next, isBusy) {
    available();
    const changingPath = next.storagePath !== config.storagePath;
    if (changingPath) check(!isBusy(), 409, '有传输正在读写磁盘，请暂停任务后再迁移', 40902);
    const inspection = changingPath ? inspectStoragePath(next.storagePath) : null;
    if (next.storageLimit && (changingPath || next.storageLimit !== config.storageLimit)) {
      check(next.storageLimit <= (inspection ?? disk(true)).capacity, 400, '网盘容量上限不能超过所选磁盘的总容量');
      const { used, reserved } = storageUsage();
      check(next.storageLimit >= used + reserved, 409, '网盘容量上限不能低于当前占用和上传预留之和');
    }
    if (!changingPath) {
      writeConfig({ ...next, instance });
      return;
    }
    const oldTree = realpathSync(storage());
    const requested = inspection.storagePath;
    check(outsideDirectory(oldTree, requested), 400, '挂载目录不能位于现有存储目录内');
    mkdirSync(requested, { recursive: true });
    const destination = realpathSync(requested);
    const target = storage(destination);
    if (target === oldTree) return writeConfig({ ...next, instance, storagePath: destination });
    check(outsideDirectory(oldTree, target) && outsideDirectory(target, oldTree) && !existsSync(target), 400, '挂载目录与已有存储重叠');
    const staging = `${target}.moving-${randomUUID()}`;
    moving = true;
    let copied = false;
    try {
      await cp(oldTree, staging, { recursive: true, errorOnExist: true, force: false });
      await rename(staging, target);
      copied = true;
      writeConfig({ ...next, instance, storagePath: destination });
      diskFull = false;
      diskCheck = 0;
      await rm(oldTree, { recursive: true, force: true }).catch((error) => console.error('清理旧存储目录失败', error));
    } catch (error) {
      await rm(copied ? target : staging, { recursive: true, force: true }).catch(() => {});
      if (error.code === 'ENOSPC' || error.code === 'EDQUOT') throw new DriveError(507, '目标磁盘剩余空间不足，无法迁移存储');
      throw error;
    } finally { moving = false; }
  }

  return {
    get, all, run, transaction, file, disk, storageInfo, used, quota, uploadRemaining, audit, available, removeObject, collectObjects, saveConfig,
    publicRootId, nodeRevision: () => nodeRevision.get().value,
    revision: () => revision.get().value,
    markDiskFull: () => { diskFull = true; diskCheck = Date.now() + 5000; },
    get config() { return config; }, close: () => db.close(),
  };
}
