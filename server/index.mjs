import express from 'express';
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ipaddr from 'ipaddr.js';
import { WebSocketServer } from 'ws';
import { accountRoutes } from './accounts.mjs';
import { adminRoutes } from './admin.mjs';
import { check, DriveError, ok, openStore } from './data.mjs';
import { fileRoutes } from './files.mjs';
import { shareRoutes } from './shares.mjs';
import { transferRoutes } from './transfers.mjs';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const physicalScopes = new Set(['private', 'uniqueLocal', 'linkLocal', 'carrierGradeNat']);
const interfaces = () => Object.values(networkInterfaces()).flat().filter((item) => item.cidr && !item.internal && physicalScopes.has(ipaddr.process(item.address).range()));
const isLocal = (address) => ipaddr.isValid(address) && ipaddr.process(address).range() === 'loopback';

function lockDirectory(location) {
  mkdirSync(location, { recursive: true });
  const path = join(location, 'drive.lock');
  let fd;
  try { fd = openSync(path, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(readFileSync(path, 'utf8').trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('另一个网盘进程正在启动，或数据目录锁损坏');
    try { process.kill(pid, 0); }
    catch (probe) {
      if (probe.code !== 'ESRCH') throw probe;
      unlinkSync(path);
      return lockDirectory(location);
    }
    throw new Error('数据目录已由另一个网盘进程使用');
  }
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
  return () => unlinkSync(path);
}

export function createDrive({ dataDir = join(project, 'data'), initialPassword, tls, hostnames = [], shareHost, releaseDir = join(project, 'release') } = {}) {
  const release = lockDirectory(resolve(dataDir));
  let store;
  try { store = openStore(dataDir, initialPassword); }
  catch (error) { release(); throw error; }
  const app = express();
  const api = express.Router();
  const aliases = new Set(['localhost', hostname().toLowerCase(), ...hostnames.map((name) => name.toLowerCase())]);
  const server = tls ? httpsServer(tls, app) : httpServer(app);
  server.requestTimeout = 0;

  function verifyNetwork(req) {
    const address = req.socket.remoteAddress;
    check(address && ipaddr.isValid(address), 403, '本系统仅限同一局域网访问');
    const peer = ipaddr.process(address);
    let peers;
    if (peer.range() !== 'loopback') {
      check(physicalScopes.has(peer.range()), 403, '本系统仅限同一局域网访问');
      const local = ipaddr.process(req.socket.localAddress).toString();
      peers = interfaces();
      check(peers.some((nic) => {
        const [ip, prefix] = ipaddr.parseCIDR(nic.cidr);
        return local === ip.toString() && peer.kind() === ip.kind() && peer.match(ip, prefix);
      }), 403, '本系统仅限同一局域网访问');
    }
    req.peer = peer.toString();
    const protocol = tls ? 'https' : 'http';
    const host = req.headers.host ?? '';
    check(/^(?:\[[a-f0-9:]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/iu.test(host), 403, '访问地址无效');
    let parsed;
    try { parsed = new URL(`${protocol}://${host}`); }
    catch { throw new DriveError(403, '访问地址无效'); }
    const plainHost = parsed.hostname.replace(/^\[|\]$/gu, '');
    if (!aliases.has(plainHost) && !isLocal(plainHost)) {
      check(ipaddr.isValid(plainHost), 403, '请使用服务器的局域网地址访问');
      const hostAddress = ipaddr.process(plainHost).toString();
      check((peers ?? interfaces()).some((nic) => ipaddr.process(nic.address).toString() === hostAddress), 403, '请使用服务器的局域网地址访问');
    }
    req.driveOrigin = parsed.origin;
    if (req.headers.origin) check(req.headers.origin === parsed.origin, 403, '不允许跨站请求');
  }

  function localOrigin(req, endpoint = server.address()) {
    const url = new URL(req.driveOrigin);
    if (!tls && !isLocal(endpoint.address) && (url.hostname === 'localhost' || isLocal(url.hostname.replace(/^\[|\]$/gu, '')))) {
      const address = interfaces().find((nic) => nic.family === 'IPv4'
        && (endpoint.address === '0.0.0.0' || endpoint.address === '::' || endpoint.address === nic.address))?.address;
      if (address) url.hostname = address;
    }
    return url;
  }
  const shareOrigin = (req) => shareHost || localOrigin(req).origin;

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    verifyNetwork(req);
    res.set({
      'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store', 'Cross-Origin-Resource-Policy': 'same-origin',
      'Content-Security-Policy': `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' ${req.driveOrigin.replace(/^http/u, 'ws')}; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
    });
    next();
  });
  app.use('/api/v1', express.json({ limit: '128kb' }), (req, res, next) => { req.body ??= {}; next(); }, api);
  const accounts = accountRoutes(api, store);
  const installer = join(releaseDir, 'LanDrive.exe');
  const manifest = join(releaseDir, 'windows.json');
  function windowsRelease() {
    check(existsSync(manifest), 404, '客户端更新包尚未发布');
    let meta;
    try { meta = JSON.parse(readFileSync(manifest, 'utf8')); }
    catch { throw new DriveError(503, '客户端更新包暂不可用'); }
    check(typeof meta?.version === 'string' && /^\d{1,6}\.\d{1,6}\.\d{1,6}$/u.test(meta.version)
      && typeof meta.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(meta.sha256)
      && Number.isSafeInteger(meta.size) && meta.size > 0, 503, '客户端更新包暂不可用');
    const expected = `LanDrive-${meta.version}-${meta.sha256.slice(0, 12)}.exe`;
    check(meta.artifact === undefined || meta.artifact === expected, 503, '客户端更新包暂不可用');
    const path = meta.artifact === undefined ? installer : join(releaseDir, expected);
    const artifact = statSync(path, { throwIfNoEntry: false });
    check(artifact?.isFile() && artifact.size === meta.size, 503, '客户端更新包暂不可用');
    return { path, metadata: { version: meta.version, size: meta.size, sha256: meta.sha256 } };
  }
  api.get('/client/windows/release', (req, res) => {
    accounts.session(req);
    ok(res, windowsRelease().metadata);
  });
  api.get('/server/info', (req, res) => {
    accounts.session(req);
    const endpoint = server.address();
    const url = localOrigin(req, endpoint);
    url.port = endpoint.port;
    ok(res, { address: url.origin, port: endpoint.port });
  });
  const files = fileRoutes(api, store, accounts);
  const shares = shareRoutes(api, store, accounts, files, shareOrigin);
  const transfers = transferRoutes(api, store, accounts, files, shares);
  adminRoutes(api, store, accounts, files, shares, transfers);
  api.use((req, res) => { throw new DriveError(404, '接口不存在'); });

  const modules = join(project, 'node_modules');
  const statics = { fallthrough: true, index: false, redirect: false, cacheControl: false, dotfiles: 'deny' };
  for (const [route, dir] of Object.entries({
    '/vendor/icons': 'bootstrap-icons/font', '/vendor/barlow': '@fontsource/barlow/files',
    '/vendor/pdf/build': 'pdfjs-dist/build', '/vendor/pdf/cmaps': 'pdfjs-dist/cmaps', '/vendor/pdf/fonts': 'pdfjs-dist/standard_fonts',
    '/vendor/highlight': '@highlightjs/cdn-assets',
  })) app.use(route, express.static(join(modules, dir), statics));
  app.get('/client/windows', (req, res) => {
    accounts.session(req);
    if (req.query.version !== undefined || existsSync(manifest)) {
      const { path, metadata } = windowsRelease();
      check(req.query.version === undefined || req.query.version === metadata.version, 409, '客户端版本已更新，请重新检查');
      return res.download(path, `LanDrive-${metadata.version}.exe`);
    }
    check(existsSync(installer), 404, '客户端安装包尚未生成');
    res.download(installer, 'LanDrive.exe');
  });
  app.use(express.static(join(project, 'public'), statics));
  app.get(['/', '/s/:code'], (req, res) => res.sendFile(join(project, 'public', 'index.html')));
  app.use((req, res) => res.status(404).type('text').send('页面不存在'));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (res.destroyed) return;
    if (error.code === 'ENOSPC' || error.code === 'EDQUOT') {
      store.markDiskFull();
      error = new DriveError(507, '服务节点磁盘已满，请联系管理员', 50001);
    }
    if (error.type === 'entity.parse.failed') error = new DriveError(400, '请求数据格式错误');
    if (error.type === 'entity.too.large') error = new DriveError(413, '请求数据过大');
    if (['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR'].includes(error.code)) error = new DriveError(500, '存储路径不可用或服务器没有访问权限', 50002);
    if (!(error instanceof DriveError)) {
      console.error('网盘请求异常', error);
      error = new DriveError(500, '存储异常，请查看服务端日志', 50002);
    }
    res.status(error.status).json({ code: error.code, msg: error.message, data: error.details });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  const deliver = (socket, value) => { if (socket.readyState === 1 && socket.bufferedAmount < 1024 * 1024) socket.send(JSON.stringify(value)); };
  function valid(socket) {
    try { return accounts.session(socket.request, { touch: false }).id === socket.actor; }
    catch { socket.close(4401, 'Session expired'); return false; }
  }
  const onTask = (actor, task) => {
    for (const socket of wss.clients) if (socket.actor === actor && valid(socket)) deliver(socket, { type: 'task', task });
  };
  transfers.listeners.add(onTask);
  server.on('upgrade', (req, socket, head) => {
    try {
      verifyNetwork(req);
      const active = req.url === '/ws/task?active=1';
      check(active || req.url === '/ws/task', 404, '接口不存在');
      const actor = accounts.session(req, { touch: false });
      wss.handleUpgrade(req, socket, head, (connection) => {
        connection.actor = actor.id;
        connection.request = req;
        connection.alive = true;
        connection.on('pong', () => { connection.alive = true; });
        connection.on('error', () => {});
        deliver(connection, { type: 'snapshot', list: transfers.list(actor.id, null, active).list });
      });
    } catch (error) { socket.end(`HTTP/1.1 ${error.status ?? 403} Rejected\r\nConnection: close\r\n\r\n`); }
  });
  const heartbeat = setInterval(() => {
    for (const connection of wss.clients) {
      if (!connection.alive) { connection.terminate(); continue; }
      if (valid(connection) && connection.readyState === 1) { connection.alive = false; connection.ping(); }
    }
  }, 25_000).unref();
  const cleanup = setInterval(() => {
    try {
      store.available();
      transfers.expire();
      store.run('DELETE FROM audit_transfer_totals WHERE day<?', new Date().setHours(0, 0, 0, 0));
    }
    catch (error) { if (error.status !== 503) console.error('清理传输失败', error); }
  }, 15 * 60_000).unref();

  let closing;
  function close() {
    closing ??= (async () => {
      clearInterval(heartbeat);
      clearInterval(cleanup);
      for (const socket of wss.clients) socket.terminate();
      await new Promise((done) => server.close(done));
      await transfers.drain();
      store.close();
      release();
    })();
    return closing;
  }
  return { server, store, close };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { env } = process;
  const dataDir = resolve(env.LAN_DRIVE_DATA || join(project, 'data'));
  const tls = env.LAN_DRIVE_KEY && env.LAN_DRIVE_CERT && { key: readFileSync(env.LAN_DRIVE_KEY), cert: readFileSync(env.LAN_DRIVE_CERT) };
  const port = Number(env.LAN_DRIVE_PORT || 8080);
  const hostnames = (env.LAN_DRIVE_HOSTNAMES ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  const drive = createDrive({ dataDir, initialPassword: env.LAN_DRIVE_ADMIN_PASSWORD, tls, hostnames, shareHost: env.LAN_DRIVE_SHARE_ORIGIN });
  const host = env.LAN_DRIVE_BIND || '0.0.0.0';
  drive.server.on('error', async (error) => {
    console.error('网盘启动失败', error.message);
    await drive.close();
    process.exitCode = 1;
  });
  drive.server.listen(port, host, () => {
    const protocol = tls ? 'https' : 'http';
    const endpoint = drive.server.address();
    const addresses = host === '0.0.0.0' ? ['127.0.0.1', ...interfaces().filter((item) => item.family === 'IPv4').map((item) => item.address)] : [host];
    for (const address of addresses) console.log(`${protocol}://${address.includes(':') ? `[${address}]` : address}:${endpoint.port}`);
    const credential = join(dataDir, 'initial-admin.txt');
    if (existsSync(credential)) console.log(`初始管理员 admin 的密码文件 ${credential}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { drive.close().catch(console.error); });
}
