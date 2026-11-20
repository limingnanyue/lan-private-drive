import { filePage } from './files.js';
import { cacheIdentity, clearPins, locallyCachedUser, setupOffline } from './offline.js';
import { guestPage } from './shares-ui.js';
import { transferQueue } from './transfer.js';
import { badge, brand, button, checkbox, el, field, ico, iconButton, input, menu, problem, report, request, roles, size, toast } from './ui.js';
import { adminPage, mySharesPage, offlinePage, recyclePage, settingsPage, transferPage } from './views.js';

const root = document.querySelector('#app');
const sections = [
  ['files', '我的文件', 'folder2'], ['public', '公共网盘', 'hdd-network'], ['received', '共享给我的', 'people'], ['shares', '我共享的', 'link-45deg'],
  ['transfers', '传输队列', 'arrow-left-right'], ['recycle', '回收站', 'trash3'], ['settings', '个人设置', 'gear'],
  ['admin', '管理员后台', 'speedometer2'],
];
const extra = ['offline', '离线文件', 'cloud-download'];
const views = { files: filePage, public: filePage, received: filePage, shares: mySharesPage, transfers: transferPage, recycle: recyclePage, settings: settingsPage, admin: adminPage, offline: offlinePage };
const activeStatuses = new Set(['waiting', 'preparing', 'transferring']);

function parse() {
  const [base, query] = location.hash.slice(1).split('?');
  const [page, id] = base.split('/');
  const params = new URLSearchParams(query);
  return { page: Object.hasOwn(views, page) ? page : 'files', id: Number(id) || null, owner: Number(params.get('owner')) || null,
    root: Number(params.get('root')) || null, tab: params.get('tab') };
}

function app() {
  let shell, main, sidebar, navigation, storage, account, net, bubble;
  let initialized = false;
  const queue = transferQueue(() => {
    paintTaskCount();
    ctx.taskUpdate?.();
  }, (parentId) => {
    ctx.syncUser().catch(() => {});
    ctx.fileUpdate?.(parentId);
  });
  const ctx = { queue, user: null, offline: false, route: parse(), go, render, syncUser };

  function go(page, id, params = {}) {
    if (ctx.offline && page !== 'offline') return;
    const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value != null));
    const locationHash = `${page}${id ? `/${id}` : ''}${query.size ? `?${query}` : ''}`;
    if (location.hash.slice(1) === locationHash) render();
    else location.hash = locationHash;
  }

  function login(message = '') {
    queue.stop();
    ctx.user = null;
    initialized = false;
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
    const username = input('username', '', { id: 'username', autocomplete: 'username', placeholder: '请输入账号', required: true, maxlength: 64 });
    const password = input('password', '', { id: 'password', autocomplete: 'current-password', type: 'password', placeholder: '请输入密码', required: true, maxlength: 256 });
    const label = iconButton('显示密码', 'eye', () => {
      const show = password.type === 'password';
      password.type = show ? 'text' : 'password';
      const text = show ? '隐藏密码' : '显示密码';
      label.setAttribute('aria-label', text); label.title = text;
      label.firstElementChild.className = `bi bi-eye${show ? '-slash' : ''}`;
      password.focus();
    }, 'password-toggle');
    const remember = checkbox('记住我（7 天）', false, () => {});
    const submit = button('登录', 'arrow-right', null, 'primary login-submit', { type: 'submit', id: 'login-submit' });
    const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: !message }, message);
    const form = el('form', { class: 'form-stack login-form', onsubmit: async (event) => {
      event.preventDefault();
      errorBox.hidden = true;
      submit.disabled = true;
      submit.textContent = '正在登录…';
      try {
        const data = await request('/auth/login', { method: 'POST', body: { username: username.value, password: password.value, remember: remember.checked } });
        const oldUser = locallyCachedUser();
        if (oldUser && oldUser.id !== data.userInfo.id) clearPins(oldUser.id).catch(() => {});
        if (parse().page !== 'public') history.replaceState(null, '', '#files');
        enter(data.userInfo);
      } catch (error) { errorBox.textContent = error.message; errorBox.hidden = false; }
      finally { submit.disabled = false; submit.replaceChildren('登录', ico('arrow-right')); }
    } }, field('账号', username), field('密码', el('span', { class: 'password-field' }, password, label)),
    el('label', { class: 'check-line' }, remember, '记住我（7 天）'), submit, errorBox);
    root.replaceChildren(el('main', { class: 'login-page' }, el('div', { class: 'login-panel' },
      el('div', { class: 'login-title' }, brand(''), el('h1', {}, '局域网私有网盘')), form,
      el('footer', { class: 'login-footer' }, ico('shield-lock'), '本系统仅限同一局域网内访问'))));
    document.title = '登录 · 局域网私有网盘';
  }

  function bindShell() {
    navigation = el('nav', { class: 'side-nav', 'aria-label': '主导航' });
    storage = el('div', { class: 'side-storage' });
    account = el('div', { class: 'side-account' });
    const closeSidebar = () => { shell.classList.remove('nav-open'); mobileMenu.setAttribute('aria-expanded', 'false'); };
    const mobileMenu = iconButton('打开导航', 'list', () => {
      const open = shell.classList.toggle('nav-open');
      mobileMenu.setAttribute('aria-expanded', String(open));
      if (open) navigation.querySelector('button')?.focus();
    }, 'mobile-menu', { 'aria-expanded': 'false' });
    sidebar = el('aside', { class: 'sidebar' }, el('div', { class: 'sidebar-head' }, brand(), iconButton('关闭导航', 'x-lg', closeSidebar, 'mobile-menu')),
      navigation, el('div', { class: 'side-foot' }, storage, account));
    net = el('span', { class: 'network' });
    main = el('main', { id: 'main-content', class: 'workspace-content', tabindex: '-1' });
    bubble = button('', 'arrow-left-right', () => go('transfers'), 'task-bubble', { title: '打开传输队列', 'aria-label': '打开传输队列' });
    const header = el('header', { class: 'workspace-top' }, el('div', { class: 'node-address' }, mobileMenu, ico('hdd-network'), el('span', {}, location.host)), net);
    shell = el('div', { class: 'app-shell' }, sidebar, el('button', { type: 'button', class: 'sidebar-scrim', 'aria-label': '关闭导航', onclick: closeSidebar }),
      el('div', { class: 'workspace' }, header, main), bubble);
    shell.addEventListener('keydown', (event) => { if (event.key === 'Escape' && shell.classList.contains('nav-open')) { closeSidebar(); mobileMenu.focus(); } });
    root.replaceChildren(shell);
    initialized = true;
    paintAccount();
    paintNetwork();
  }

  function paintAccount() {
    const user = ctx.user;
    if (!initialized || !user) return;
    const used = user.spaceUsed ?? 0;
    storage.replaceChildren(el('div', { class: 'split' }, el('span', {}, '存储空间'), ico('hdd')),
      el('progress', { max: 100, value: user.spaceQuota ? Math.min(100, used * 100 / user.spaceQuota) : 0, 'aria-label': '存储空间占用' }),
      el('div', { class: 'storage-values' }, el('strong', {}, size(used)), el('span', {}, user.spaceQuota ? `/ ${size(user.spaceQuota)}` : ' / 不限配额')));
    const open = (event) => menu([['个人设置', 'gear', () => go('settings')], ['退出登录', 'box-arrow-right', logout, true]].slice(ctx.offline ? 1 : 0), { anchor: event.currentTarget });
    account.replaceChildren(el('button', { type: 'button', class: 'account-trigger', onclick: open, 'aria-haspopup': 'menu', 'aria-label': `账号菜单 · ${user.name}` },
      el('span', { class: 'avatar' }, [...user.name][0]?.toUpperCase() ?? '用'), el('span', { class: 'account-name' }, el('strong', {}, user.name), el('small', {}, roles[user.role] ?? user.username)), ico('chevron-expand')));
    storage.hidden = ctx.offline;
  }

  function paintNetwork() {
    if (!initialized) return;
    const offline = ctx.offline || !navigator.onLine;
    net.classList.toggle('offline', offline);
    net.replaceChildren(el('span', { class: 'net-dot' }), offline ? '离线模式' : '局域网已连接');
  }

  function paintTaskCount() {
    if (!initialized) return;
    const count = queue.list().filter((task) => activeStatuses.has(task.status)).length;
    bubble.hidden = ctx.offline;
    bubble.replaceChildren(ico('arrow-left-right'), count > 0 && el('span', { class: 'task-count' }, count > 99 ? '99+' : count) || '');
    bubble.title = count ? `传输任务 · ${count} 项正在处理` : '传输任务';
    bubble.setAttribute('aria-label', bubble.title);
  }

  async function syncUser() {
    const user = await request('/auth/user/info');
    if (ctx.user?.id === user.id) {
      ctx.user = user;
      cacheIdentity(user);
      paintAccount();
    }
    return user;
  }

  async function logout() {
    const id = ctx.user?.id;
    if (!ctx.offline) await request('/auth/logout', { method: 'POST' });
    cacheIdentity(null);
    if (id) await clearPins(id).catch(() => {});
    history.replaceState(null, '', '/');
    login();
  }

  function render() {
    if (!ctx.user || !initialized) return;
    const route = ctx.offline ? { page: 'offline' } : parse();
    if (route.page === 'admin' && ctx.user.role === 'user') route.page = 'files';
    ctx.route = route;
    ctx.taskUpdate = null;
    ctx.fileUpdate = null;
    shell.classList.remove('nav-open');
    shell.querySelector('.workspace-top .mobile-menu').setAttribute('aria-expanded', 'false');
    const visible = ctx.offline ? [extra] : [...sections.filter(([key]) => key !== 'admin' || ctx.user.role !== 'user'), extra];
    navigation.replaceChildren(...visible.map(([key, label, icon]) => button(label, icon, () => go(key), `nav-item ${route.page === key ? 'active' : ''}${key === 'offline' ? ' offline-nav' : ''}`, {
      'aria-current': route.page === key ? 'page' : undefined,
    })));
    const outlet = el('div', { class: `page ${route.page}-page` });
    main.replaceChildren(ctx.user.diskFull && route.page !== 'admin' ? el('p', { class: 'notice danger-note' }, ico('exclamation-circle'), '存储磁盘空间不足，请联系管理员') : '', outlet);
    document.title = `${visible.find(([key]) => key === route.page)?.[1] ?? '我的文件'} · 局域网私有网盘`;
    Promise.resolve(views[route.page](ctx, outlet)).catch((error) => outlet.replaceChildren(problem(error, render)));
    paintTaskCount();
  }

  function enter(user, offline = false) {
    ctx.user = user;
    ctx.offline = offline;
    ctx.view = user.preference?.view ?? 'list';
    if (!offline) cacheIdentity(user);
    bindShell();
    if (!offline) queue.start(user);
    render();
  }

  async function boot() {
    try { enter(await request('/auth/user/info')); }
    catch (error) {
      const cached = locallyCachedUser();
      if (error.status === 0 && cached) enter(cached, true);
      else {
        if (error.status === 401) cacheIdentity(null);
        login(error.status === 401 ? '' : error.message);
      }
    }
  }
  window.addEventListener('hashchange', render);
  window.addEventListener('offline', paintNetwork);
  window.addEventListener('online', () => { paintNetwork(); if (ctx.offline) boot(); });
  window.addEventListener('drive:expired', () => {
    if (!ctx.user || ctx.offline) return;
    cacheIdentity(null);
    login('登录已过期，请重新登录');
  });
  boot();
  setupOffline();
}

if (location.pathname.startsWith('/s/')) guestPage(root);
else app();
