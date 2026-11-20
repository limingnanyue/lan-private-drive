import { pinned, unpin } from './offline.js';
import { openPreview } from './preview.js';
import { cancelShare, editMembers, editShare, permissionLabel, shareStatus, showLink } from './shares-ui.js';
import { badge, button, checkbox, confirm, copyText, date, dialog, el, empty, field, fileGlyph, fileLabel, formDialog, ico, iconButton, input, loading, menu, problem, report, request, roles, row, saveBlob, saveLink, select, size, table, tabs, title, toast, url } from './ui.js';

const kinds = { login: '登录日志', file: '文件操作', admin: '管理员操作' };
const taskStatus = { waiting: ['等待中', ''], preparing: ['正在打包', 'blue'], transferring: ['传输中', 'blue'], paused: ['已暂停', 'amber'], success: ['已完成', 'green'], failed: ['失败', 'red'], cancelled: ['已取消', ''] };
const transferTabs = [['upload', '上传中', 'upload'], ['download', '下载中', 'download'], ['upload-history', '上传记录', 'clock-history'], ['download-history', '下载记录', 'clock-history']];
const percentage = (used, total) => total ? Math.min(100, 100 * used / total) : 0;
const progress = (value, label) => el('progress', { value, max: 100, 'aria-label': label });
const box = (content, cls = '') => el('div', { class: `content-box ${cls}` }, content);
const action = (label, icon, fn, cls) => button(label, icon, () => Promise.resolve().then(fn).catch(report), cls);
const checkedSet = () => {
  const ids = new Set();
  return { ids, toggle: (id, checked) => checked ? ids.add(id) : ids.delete(id) };
};

export function transferPage(ctx, output) {
  const tab = transferTabs.some(([key]) => key === ctx.route.tab) ? ctx.route.tab : 'upload';
  const tabBar = tabs(transferTabs, tab, (next) => ctx.go('transfers', null, { tab: next }));
  if (tab.endsWith('-history')) return transferHistory(output, tabBar, tab.startsWith('upload') ? 'upload' : 'download');
  const type = tab;
  const items = el('div', { class: 'tasks' });
  function chooseSource(task) {
    const control = el('input', { type: 'file', hidden: true, onchange: () => {
      if (control.files[0]) ctx.queue.attach(task, control.files[0]).catch(report);
      control.remove();
    }, oncancel: () => control.remove() });
    document.body.append(control);
    control.click();
  }
  function draw() {
    const tasks = ctx.queue.list().filter((task) => task.type === type);
    items.replaceChildren(...(tasks.length ? tasks.map((task) => {
      const [status, tone] = taskStatus[task.status] ?? ['等待中', ''];
      const resume = ['paused', 'failed'].includes(task.status);
      const needsSource = task.type === 'upload' && task.local && !task.attached;
      const waiting = task.status === 'preparing';
      const remaining = task.speed ? Math.ceil((task.total - task.done) / task.speed) : null;
      const speed = task.speed ? `${size(task.speed)}/s` : '—';
      const eta = remaining == null ? '—' : remaining < 60 ? `${remaining} 秒` : `${Math.ceil(remaining / 60)} 分钟`;
      return el('article', { class: 'task-card' }, el('div', { class: 'task-top' }, fileLabel({ name: task.name, kind: 'file' }), badge(status, tone)),
        progress(percentage(task.done, task.total), '传输进度'),
        el('div', { class: 'task-bottom' }, el('div', { class: 'task-stats' }, el('span', {}, `${size(task.done)} / ${size(task.total)}`), el('span', {}, speed), el('span', {}, `剩余 ${eta}`)),
          el('div', { class: 'actions' }, needsSource ? button('重新选择源文件', 'file-earmark', () => chooseSource(task))
            : resume ? action('继续', 'play-fill', () => ctx.queue.change(task.id, 'resume'), 'soft')
              : action('暂停', 'pause-fill', () => ctx.queue.change(task.id, 'pause')),
          action('取消', 'x-lg', async () => { if (await confirm('取消传输任务', `任务“${task.name}”的传输断点将被清除。`, '取消任务', true)) await ctx.queue.change(task.id, 'cancel'); }, 'quiet'))),
        task.reason && el('p', { class: `task-reason ${task.status === 'failed' ? 'text-danger' : 'muted'}`, title: task.reason }, task.reason),
        !task.local && el('p', { class: 'task-reason muted' }, '请在发起任务的设备继续传输'), waiting && el('p', { class: 'task-reason muted' }, '文件正在打包，完成后自动开始下载。'));
    }) : [empty('暂无传输任务', '上传和下载任务会在此显示', null, 'arrow-left-right')]));
  }
  output.append(title('传输队列', iconButton('刷新队列', 'arrow-clockwise', () => ctx.queue.refresh().catch(report))),
    tabBar, items);
  ctx.taskUpdate = draw;
  draw();
  ctx.queue.refresh().catch(() => {});
}

function pagination(total, current, limit, change) {
  const pages = Math.max(1, Math.ceil(total / limit));
  return [el('span', { class: 'muted' }, `共 ${total} 条 · 第 ${current} / ${pages} 页`),
    iconButton('上一页', 'chevron-left', () => change(current - 1), '', { disabled: current <= 1 }),
    iconButton('下一页', 'chevron-right', () => change(current + 1), '', { disabled: current >= pages })];
}

async function transferHistory(output, tabBar, type) {
  const results = el('div', {}, loading());
  const navigation = el('div', { class: 'pagination' });
  const selected = checkedSet();
  const label = type === 'upload' ? '上传记录' : '下载记录';
  let current = 1, total = 0, busy = false;
  const limit = 30;
  const refresh = iconButton('刷新记录', 'arrow-clockwise', () => load(current));
  const remove = action('删除选中', 'trash3', () => clean(false), 'danger-outline');
  const clear = action('清空记录', null, () => clean(true), 'danger-outline');
  output.append(title('传输队列', refresh), tabBar, el('div', { class: 'quick-actions' }, remove, clear), box([results, navigation]));

  function controls() {
    refresh.disabled = busy;
    remove.disabled = busy || !selected.ids.size;
    clear.disabled = busy || !total;
  }

  async function clean(all) {
    if (busy) return;
    const taskIds = [...selected.ids];
    const heading = all ? `清空${label}` : '删除选中记录';
    const target = all ? label : `${taskIds.length} 条选中记录`;
    busy = true;
    controls();
    try {
      if (!await confirm(heading, `清理${target}？文件和传输断点会保留。`, heading, true) || !output.isConnected) return;
      const { deleted } = await request('/task/history', { method: 'DELETE', query: { type }, body: all ? { clear: true } : { taskIds } });
      toast(`已清理 ${deleted} 条记录`);
      await load(all ? 1 : current);
    } finally { busy = false; controls(); }
  }

  async function load(page) {
    busy = true;
    selected.ids.clear();
    controls();
    navigation.replaceChildren();
    results.replaceChildren(loading());
    try {
      const data = await request('/task/history', { query: { type, page, size: limit } });
      total = data.total;
      current = Math.min(page, Math.max(1, Math.ceil(total / limit)));
      if (page !== current) return await load(current);
      const all = checkbox('选择本页记录', false, (event) => {
        choices.forEach((choice, index) => {
          choice.checked = event.target.checked;
          selected.toggle(data.list[index].id, choice.checked);
        });
        controls();
      });
      const choices = data.list.map((task) => checkbox(`选择 ${task.name}`, false, (event) => {
        selected.toggle(task.id, event.target.checked);
        all.checked = selected.ids.size === data.list.length;
        all.indeterminate = selected.ids.size > 0 && !all.checked;
        controls();
      }));
      results.replaceChildren(data.list.length ? table([all, '文件名', '大小', '状态', '更新时间', '备注'], data.list.map((task, index) => {
        const [status, tone] = taskStatus[task.status];
        return row(choices[index], fileLabel({ name: task.name, kind: 'file' }), size(task.total), badge(status, tone), date(task.updatedAt), task.reason || '—');
      }), 'selectable-table') : empty(`暂无${label}`, null, null, 'clock-history'));
      navigation.replaceChildren(...pagination(total, current, limit, (next) => { if (!busy) load(next); }));
    } catch (error) { total = 0; results.replaceChildren(problem(error, () => load(page))); }
    finally { busy = false; controls(); }
  }
  await load(1);
}

export async function recyclePage(ctx, output) {
  const canManagePublic = ctx.user.role !== 'user';
  const publicSpace = canManagePublic && ctx.route.tab === 'public';
  const query = publicSpace ? { space: 'public' } : undefined;
  const clearLabel = publicSpace ? '清空公共回收站' : '清空回收站';
  const list = el('div');
  const controls = el('div');
  let data;
  const selection = checkedSet();
  const selected = (node) => node ? [node.id] : [...selection.ids];
  async function handle(operation, node) {
    const ids = selected(node);
    if (operation !== 'clear' && !ids.length) return toast('请先选择文件', 'warning');
    const label = operation === 'clear' ? clearLabel : '永久删除';
    if (operation !== 'restore' && !await confirm(label, '永久删除后文件无法恢复。', label, true)) return;
    await request(`/recycle/${operation}`, { query, method: operation === 'restore' ? 'POST' : 'DELETE', body: operation === 'clear' ? {} : { fileId: ids } });
    toast(operation === 'restore' ? '文件已还原' : '已永久删除');
    ctx.syncUser().catch(() => {});
    await load();
  }
  function paint() {
    controls.replaceChildren(title('回收站', [action('还原选中', 'arrow-counterclockwise', () => handle('restore')),
      action('永久删除选中', 'trash3', () => handle('hardDelete'), 'text-danger'), action(clearLabel, null, () => handle('clear'), 'danger-outline')]));
    const all = checkbox('选择全部', selection.ids.size === data.length && data.length > 0, (event) => {
      selection.ids.clear();
      if (event.target.checked) for (const item of data) selection.ids.add(item.id);
      paint();
    });
    all.indeterminate = selection.ids.size > 0 && selection.ids.size < data.length;
    list.replaceChildren(data.length ? table([all, '文件名', '原始路径', '删除时间', '大小', '操作'], data.map((node) => row(
      checkbox(`选中 ${node.name}`, selection.ids.has(node.id), (event) => {
        selection.toggle(node.id, event.target.checked);
        all.checked = selection.ids.size === data.length;
        all.indeterminate = selection.ids.size > 0 && !all.checked;
      }), fileLabel(node), el('span', { class: 'dim' }, node.originalPath), date(node.deletedAt), size(node.size),
      el('div', { class: 'inline-actions' }, action('还原', null, () => handle('restore', node), 'link-btn'), action('永久删除', null, () => handle('hardDelete', node), 'link-btn text-danger')))))
      : empty('回收站为空', '删除的文件会暂存在这里', null, 'trash3'));
  }
  async function load() {
    list.replaceChildren(loading());
    try { data = (await request('/recycle/list', { query })).list; selection.ids.clear(); paint(); }
    catch (error) { list.replaceChildren(problem(error, load)); }
  }
  output.append(controls, canManagePublic && tabs([['personal', '个人回收站', 'person'], ['public', '公共回收站', 'hdd-network']], publicSpace ? 'public' : 'personal',
    (tab) => ctx.go('recycle', null, { tab: tab === 'public' ? tab : null })),
  el('p', { class: 'notice' }, ico('info-circle'), '回收站中的文件仍占用存储空间。永久删除后无法恢复。'), box(list));
  await load();
}

export async function mySharesPage(ctx, output) {
  const results = el('div');
  const selected = checkedSet();
  let items = [];
  const count = el('span', { class: 'muted' });
  async function reload() {
    results.replaceChildren(loading());
    try { items = (await request('/share/my')).list; selected.ids.clear(); paint(); }
    catch (error) { results.replaceChildren(problem(error, reload)); }
  }
  async function bulkCancel() {
    if (!selected.ids.size) return toast('请先选中分享', 'warning');
    if (!await confirm('取消选中的分享', `这 ${selected.ids.size} 个链接会立即失效。`, '取消分享', true)) return;
    for (const shareId of selected.ids) await request('/share/cancel', { method: 'DELETE', body: { shareId } });
    toast('分享已取消');
    await reload();
  }
  function paint() {
    count.textContent = selected.ids.size ? `已选 ${selected.ids.size} 项` : `共 ${items.length} 项`;
    const all = checkbox('选择所有分享', selected.ids.size === items.length && items.length > 0, (event) => {
      selected.ids.clear();
      if (event.target.checked) for (const item of items) selected.ids.add(item.shareId);
      paint();
    });
    all.indeterminate = selected.ids.size > 0 && selected.ids.size < items.length;
    results.replaceChildren(items.length ? table([all, '分享名称', '类型', '权限', '有效期', '密码', '访问次数', '操作'], items.map((item) => row(
      checkbox(`选中 ${item.name}`, selected.ids.has(item.shareId), (event) => {
        selected.toggle(item.shareId, event.target.checked);
        count.textContent = selected.ids.size ? `已选 ${selected.ids.size} 项` : `共 ${items.length} 项`;
        all.checked = selected.ids.size === items.length;
        all.indeterminate = selected.ids.size > 0 && !all.checked;
      }), fileLabel(item), item.kind === 'folder' ? '文件夹' : '文件', permissionLabel(item.permission),
      el('div', { class: 'stack-xs' }, item.expireTime ? date(item.expireTime) : '永久有效', item.status !== 'active' && badge(shareStatus(item.status), 'amber')),
      item.hasPassword ? badge('已设置', 'blue') : '—', item.visits, iconButton(`管理分享 · ${item.name}`, 'three-dots', (event) => menu([
        ['编辑分享', 'pencil', async () => { if (await editShare(null, item)) { toast('分享已更新'); await reload(); } }],
        ['复制链接', 'copy', () => copyText(item.url)], ['查看二维码', 'qr-code', () => showLink(item)],
        ['取消分享', 'link-45deg', async () => { if (await cancelShare(item)) await reload(); }, true],
      ], { anchor: event.currentTarget }), '', { 'aria-haspopup': 'menu' })))) : empty('暂无分享链接', '在文件的更多菜单中生成分享链接', null, 'link-45deg'));
  }
  output.append(title('我共享的', [count, action('取消选中的分享', 'link-45deg', bulkCancel), iconButton('刷新', 'arrow-clockwise', reload)]), box(results));
  await reload();
}

function connectionSettings() {
  const content = el('div', { class: 'connection-details' });
  async function load() {
    content.replaceChildren(loading());
    try {
      const { address, port } = await request('/server/info');
      content.replaceChildren(el('dl', { class: 'setting-facts' },
        el('div', {}, el('dt', {}, '网盘地址'), el('dd', { class: 'mono' }, address)),
        el('div', {}, el('dt', {}, '网盘端口'), el('dd', { class: 'mono' }, port))),
      el('div', {}, action('复制地址', 'copy', () => copyText(address))));
    } catch (error) {
      content.replaceChildren(el('p', { class: 'form-error' }, error.message), el('div', {}, action('重新读取', 'arrow-clockwise', load)));
    }
  }
  load();
  return el('section', { class: 'settings-card content-box' }, el('h2', {}, '网盘连接'), content);
}

export async function settingsPage(ctx, output) {
  const tab = ['password', 'preferences'].includes(ctx.route.tab) ? ctx.route.tab : 'profile';
  output.append(title('个人设置'), tabs([['profile', '个人信息', 'person'], ['password', '修改密码', 'key'], ['preferences', '偏好设置', 'sliders']], tab, (next) => ctx.go('settings', null, { tab: next })));
  const area = el('div', { class: 'settings-card content-box' }, loading());
  output.append(tab === 'profile' ? el('div', { class: 'settings-layout' }, area, connectionSettings()) : area);
  try {
    const account = await ctx.syncUser();
    if (tab === 'profile') {
      area.replaceChildren(el('h2', {}, '账号信息'), field('账号', input('username', account.username, { readonly: true })),
        field('角色', input('role', roles[account.role], { readonly: true })),
        el('div', { class: 'storage-field' }, el('div', { class: 'split' }, el('strong', {}, '存储空间'), el('span', { class: 'mono' }, `${size(account.spaceUsed)} / ${account.spaceQuota ? size(account.spaceQuota) : '不限'}`)),
          progress(percentage(account.spaceUsed, account.spaceQuota), '已用存储空间')),
        el('a', { href: '/client/windows', class: 'btn desktop-download', download: 'LanDrive.exe' }, ico('windows'), '下载 Windows 客户端'));
    } else if (tab === 'password') {
      const oldPwd = input('oldPwd', '', { type: 'password', required: true, autocomplete: 'current-password' });
      const newPwd = input('newPwd', '', { type: 'password', required: true, minlength: 8, autocomplete: 'new-password' });
      const repeat = input('repeat', '', { type: 'password', required: true, autocomplete: 'new-password' });
      const submit = button('保存密码', null, null, 'primary', { type: 'submit' });
      const message = el('p', { class: 'form-error', role: 'alert', hidden: true });
      const form = el('form', { class: 'form-stack', onsubmit: async (event) => {
        event.preventDefault();
        message.hidden = true;
        submit.disabled = true;
        try {
          if (repeat.value !== newPwd.value) throw new Error('两次输入的新密码不一致');
          await request('/auth/password/update', { method: 'POST', body: { oldPwd: oldPwd.value, newPwd: newPwd.value } });
          form.reset(); toast('密码已修改');
        } catch (error) { message.textContent = error.message; message.hidden = false; }
        finally { submit.disabled = false; }
      } }, field('旧密码', oldPwd), field('新密码', newPwd), field('确认新密码', repeat), message, el('div', {}, submit));
      area.replaceChildren(el('h2', {}, '修改密码'), form);
    } else {
      const { preference } = account;
      const viewInput = select('view', [['list', '列表视图'], ['grid', '网格视图']], preference.view);
      const autoplay = checkbox('预览时自动播放视频', preference.autoplay, () => {});
      const notifications = checkbox('传输消息通知', preference.notifications, () => {});
      area.replaceChildren(el('h2', {}, '显示与通知'), field('默认文件视图', viewInput),
        el('label', { class: 'check-line' }, autoplay, '预览时自动播放视频'), el('label', { class: 'check-line' }, notifications, '传输消息通知'),
        action('保存偏好', null, async () => {
          await request('/user/preference/save', { method: 'PUT', body: { view: viewInput.value, autoplay: autoplay.checked, notifications: notifications.checked } });
          ctx.view = viewInput.value;
          await ctx.syncUser();
          toast('偏好已保存');
        }, 'primary'));
    }
  } catch (error) { area.replaceChildren(problem(error, () => ctx.render())); }
}

export async function offlinePage(ctx, output) {
  const container = el('div', {}, loading());
  output.append(title('离线文件'), box(container));
  try {
    const items = await pinned(ctx.user.id);
    container.replaceChildren(items.length ? table(['文件名', '大小', '缓存时间', '操作'], items.map((item) => row(
      fileLabel(item, () => openPreview(item)), size(item.size), date(item.cachedAt), el('div', { class: 'inline-actions' },
        button('下载', 'download', () => saveBlob(item.blob, item.name), 'link-btn'), action('移除副本', 'trash3', async () => { await unpin(ctx.user.id, item.id); toast('已移除离线副本'); ctx.render(); }, 'link-btn')))))
      : empty('暂无离线文件', ctx.offline ? '已保存到此浏览器的文件会显示在这里' : '在文件的更多菜单中保存离线副本', null, 'cloud-download'));
  } catch (error) { container.replaceChildren(problem(error, () => ctx.render())); }
}

const adminItems = [['dashboard', '仪表盘', 'speedometer2'], ['users', '用户管理', 'people'], ['admin-shares', '共享管理', 'diagram-3'], ['system', '系统设置', 'gear'], ['logs', '系统日志', 'journal-text']];

function storageChart(distribution, usedStorage) {
  const colors = ['#2563eb', '#14a092', '#f1a33b', '#8460d7', '#2e91cc', '#e66e77', '#438645'];
  let sum = 0;
  const visible = distribution.filter(({ bytes }) => bytes > 0).sort((left, right) => right.bytes - left.bytes);
  const pieces = visible.map(({ bytes }, index) => {
    const start = sum;
    sum += bytes / usedStorage * 100;
    return `${colors[index % colors.length]} ${start}% ${sum}%`;
  });
  return el('div', { class: 'chart-panel content-box' }, el('h2', {}, '存储占用分布'), el('div', { class: 'distribution' },
    el('div', { class: 'donut', style: pieces.length ? `background: conic-gradient(${pieces.join(',')})` : '', role: 'img', 'aria-label': `已用空间 ${size(usedStorage)}` },
      el('div', {}, el('strong', {}, size(usedStorage)), el('span', {}, '已用空间'))),
    el('div', { class: 'chart-legend' }, visible.length ? visible.map((entry, index) => el('div', {}, el('span', { class: 'dot', style: `background:${colors[index % colors.length]}` }), el('span', { title: entry.username }, entry.name), el('strong', {}, size(entry.bytes))))
      : el('p', { class: 'muted' }, '暂无存储占用'))));
}

function trafficChart(trend) {
  const maximum = Math.max(1, ...trend.flatMap(({ upload, download }) => [upload, download]));
  const text = el('p', { class: 'chart-readout muted', 'aria-live': 'polite' }, '选择时段查看流量');
  return el('div', { class: 'chart-panel content-box' }, el('h2', {}, '今日传输流量'), el('div', { class: 'chart-key' }, el('span', {}, el('i'), '上传'), el('span', {}, el('i'), '下载')),
    el('div', { class: 'traffic' }, trend.map(({ hour, upload, download }) => {
      const at = `${String(hour).padStart(2, '0')}:00`;
      const label = `${at} · 上传 ${size(upload)} · 下载 ${size(download)}`;
      return el('button', { type: 'button', class: 'traffic-hour', title: label, 'aria-label': label, onfocus: () => { text.textContent = label; }, onpointerenter: () => { text.textContent = label; }, onclick: () => { text.textContent = label; } },
        el('i', { style: `height:${Math.max(2, 100 * upload / maximum)}%` }), el('i', { style: `height:${Math.max(2, 100 * download / maximum)}%` }));
    })), el('div', { class: 'time-labels' }, '00:00', el('span', {}, '06:00'), el('span', {}, '12:00'), el('span', {}, '18:00'), el('span', {}, '23:00')), text);
}

async function dashboard(ctx, output) {
  const data = await request('/admin/dashboard/stat');
  const distribution = data.publicStorage ? [...data.distribution, { name: '公共网盘', bytes: data.publicStorage }] : data.distribution;
  const cards = [['总用户数', data.totalUsers, 'people', 'blue'], ['总存储空间', data.totalStorage ? size(data.totalStorage) : '不限', 'hdd', 'teal'],
    ['已占用空间', size(data.usedStorage), 'pie-chart', 'amber'], ['今日上传', data.todayUploads, 'cloud-upload', 'violet']];
  if (data.diskFull) output.append(el('p', { class: 'notice danger-note' }, '服务节点磁盘已满'));
  output.append(
    el('div', { class: 'stats-grid' }, cards.map(([label, value, icon, color]) => el('section', { class: 'stat-card' }, el('span', { class: `stat-icon ${color}` }, ico(icon)), el('span', {}, label), el('strong', {}, value)))),
    el('div', { class: 'charts-grid' }, storageChart(distribution, data.usedStorage), trafficChart(data.trend)),
    el('div', { class: 'quick-actions' }, adminItems.slice(1).filter(([key]) => ctx.user.role === 'superadmin' || ['users', 'admin-shares'].includes(key))
      .map(([key, label, icon]) => button(label, icon, () => ctx.go('admin', null, { tab: key })))));
}

async function users(ctx, output) {
  const result = el('div');
  const search = input('username', '', { type: 'search', placeholder: '搜索账号或昵称', 'aria-label': '搜索账号或昵称' });
  const canAssign = Object.entries(roles).filter(([key]) => ctx.user.role === 'superadmin' || key === 'user');
  let query = '';
  function userForm(current) {
    return formDialog(current ? '编辑用户' : '新增用户', { wide: 'tree-modal', primary: current ? '保存' : '创建用户',
      fields: [!current && field('用户名', input('username', '', { required: true, maxlength: 64, autocomplete: 'off' })), field('昵称', input('nickname', current?.nickname ?? '', { required: true, maxlength: 64 })),
        !current && field('初始密码', input('pwd', '', { type: 'password', required: true, minlength: 8, autocomplete: 'new-password' })),
        field('角色', select('role', canAssign, current?.role ?? 'user', { disabled: current?.id === ctx.user.id })),
        field('存储配额（MB）', input('quota', current?.spaceQuota ? current.spaceQuota / 1024 ** 2 : '0', { type: 'number', min: 0, step: 'any', required: true }), '填 0 表示不限配额')],
      submit: (form) => request(current ? '/admin/user/edit' : '/admin/user/add', { method: current ? 'PUT' : 'POST', body: {
        userId: current?.id, username: form.get('username'), nickname: form.get('nickname'), pwd: form.get('pwd'), role: form.get('role') ?? current?.role, spaceQuota: Math.round(Number(form.get('quota')) * 1024 ** 2),
      } }),
    });
  }
  async function load() {
    result.replaceChildren(loading());
    try {
      const { list } = await request('/admin/user/list', { query: { keyword: query } });
      result.replaceChildren(list.length ? table(['用户名', '昵称', '角色', '存储配额', '已用空间', '账号状态', '创建时间', '操作'], list.map((user) => row(
        el('strong', {}, user.username), user.nickname, roles[user.role], user.spaceQuota ? size(user.spaceQuota) : '不限', size(user.spaceUsed),
        badge(user.status ? '启用' : '禁用', user.status ? 'green' : 'red'), date(user.createdAt), iconButton(`管理用户 · ${user.username}`, 'three-dots', (event) => menu([
          ['编辑', 'pencil', async () => { if (await userForm(user)) { toast('用户已更新'); await load(); } }],
          ['重置密码', 'key', async () => {
            const saved = await formDialog('重置密码', { description: `重置 ${user.username} 的密码会结束该账号的现有登录会话。`, primary: '重置密码',
              fields: field('新密码', input('newPwd', '', { type: 'password', required: true, minlength: 8, autocomplete: 'new-password' })),
              submit: (form) => request('/admin/user/resetPwd', { method: 'PUT', body: { userId: user.id, newPwd: form.get('newPwd') } }) });
            if (saved) toast('密码已重置');
          }],
          user.id !== ctx.user.id && [user.status ? '禁用账号' : '启用账号', user.status ? 'person-dash' : 'person-check', async () => {
            if (user.status && !await confirm('禁用账号', `禁用 ${user.username} 会结束登录会话并取消此账号创建的分享。`, '禁用账号', true)) return;
            await request('/admin/user/status', { method: 'PUT', body: { userId: user.id, status: !user.status } });
            toast('账号状态已更新'); await load();
          }, user.status],
          ctx.user.role === 'superadmin' && ['浏览用户文件', 'folder2-open', () => ctx.go('files', null, { owner: user.id })],
        ], { anchor: event.currentTarget }), '', { 'aria-haspopup': 'menu' })))) : empty('没有匹配的用户', null, null, 'people'));
    } catch (error) { result.replaceChildren(problem(error, load)); }
  }
  output.append(el('form', { class: 'filter-bar', onsubmit: (event) => { event.preventDefault(); query = search.value; load(); } }, search,
    button('搜索', 'search', null, '', { type: 'submit' }), el('span', { class: 'spacer' }), action('新增用户', 'person-plus', async () => {
      if (await userForm()) { toast('账号已创建'); await load(); }
    }, 'primary')), box(result));
  await load();
}

async function adminShares(ctx, output) {
  const advanced = ctx.user.role === 'superadmin';
  const links = advanced && ctx.route.root !== 1;
  const results = el('div', {}, loading());
  if (advanced) output.append(tabs([['links', '全部链接', 'link-45deg'], ['folders', '共享文件夹', 'folder']], links ? 'links' : 'folders',
    (mode) => ctx.go('admin', null, { tab: 'admin-shares', root: mode === 'folders' ? 1 : null })));
  output.append(box(results));
  async function load() {
    try {
      const { list } = await request(links ? '/admin/share/list' : '/admin/share/folders');
      results.replaceChildren(list.length ? links ? table(['分享人', '分享名称', '权限', '有效期', '访问次数', '创建时间', '操作'], list.map((share) => row(
        share.username, fileLabel(share), permissionLabel(share.permission), share.expireTime ? date(share.expireTime) : '永久有效', share.visits, date(share.createdAt),
        el('div', { class: 'inline-actions' }, button('查看', null, () => dialog('分享详情', { body: el('div', { class: 'form-stack' },
          field('分享名称', input('share', share.name, { readonly: true })), field('分享状态', input('status', shareStatus(share.status), { readonly: true })),
          field('分享链接', input('url', share.url, { readonly: true })), button('复制链接', 'copy', () => copyText(share.url))) }), 'link-btn'),
        action('强制取消', null, async () => { if (await cancelShare(share, true)) await load(); }, 'link-btn text-danger')))))
        : table(['文件夹', '所属账号', '位置', '修改时间', '操作'], list.map((node) => row(fileLabel(node), node.username,
          `/${node.path.map(({ name }) => name).join('/')}`, date(node.modifiedAt), action('成员权限', 'people', async () => {
            if (await editMembers(node)) toast('共享权限已保存');
          }, 'link-btn')))) : empty(links ? '暂无分享链接' : '暂无共享文件夹', null, null, 'diagram-3'));
    } catch (error) { results.replaceChildren(problem(error, load)); }
  }
  await load();
}

async function systemConfig(ctx, output) {
  const configTab = ({ 1: 'transfer', 2: 'security' })[ctx.route.root] ?? 'storage';
  output.append(tabs([['storage', '存储配置', 'hdd'], ['transfer', '传输配置', 'arrow-left-right'], ['security', '安全配置', 'shield-check']], configTab,
    (tab) => ctx.go('admin', null, { tab: 'system', root: { storage: null, transfer: 1, security: 2 }[tab] })));
  const current = await request('/admin/config');
  const storage = input('storagePath', current.storagePath, { required: true, autocomplete: 'off', spellcheck: 'false' });
  const limit = input('storageLimit', (current.storageLimit ?? 0) / 1024 ** 3, { type: 'number', min: 0, step: 'any', required: true });
  const volume = select('volume', [['', '选择磁盘']], '', { hidden: true, 'aria-label': '选择服务器磁盘' });
  const max = input('max', current.maxSingleFile / 1024 ** 2, { type: 'number', min: 0.000001, step: 'any', required: true });
  const up = input('up', current.uploadSpeedLimit / 1024, { type: 'number', min: 0, step: 'any', required: true });
  const down = input('down', current.downloadSpeedLimit / 1024, { type: 'number', min: 0, step: 'any', required: true });
  const timeout = input('timeout', current.sessionTimeout, { type: 'number', min: 1, max: 1440, step: 1, required: true });
  const password = checkbox('开启分享访问密码', current.defaultSharePassword, () => {});
  const rule = select('passwordRule', [['basic', '基础 · 至少 8 个字符'], ['strong', '强 · 至少 12 个字符，含字母、数字和符号']], current.passwordRule);
  const diskStatus = el('div', { class: 'disk-inspection', role: 'status' });
  let probeTimer, activeProbe;
  async function detectDisk() {
    clearTimeout(probeTimer);
    activeProbe?.abort();
    if (!output.isConnected) return;
    limit.removeAttribute('max');
    const path = storage.value.trim();
    if (!path) {
      diskStatus.replaceChildren(el('p', { class: 'form-error' }, '请输入服务器上的存储目录'));
      return;
    }
    const controller = new AbortController();
    activeProbe = controller;
    diskStatus.textContent = '正在检测所选磁盘…';
    try {
      const data = await request('/admin/storage/info', { query: { path }, signal: controller.signal });
      if (controller.signal.aborted || !output.isConnected) return;
      limit.max = String(data.capacity / 1024 ** 3);
      const metrics = [['磁盘总容量', data.capacity], ['磁盘剩余空间', data.free], ['网盘已用', data.used], ['上传预留', data.reserved]];
      diskStatus.replaceChildren(el('dl', { class: 'setting-facts disk-facts' }, metrics.map(([label, bytes]) =>
        el('div', {}, el('dt', {}, label), el('dd', { class: 'mono' }, size(bytes))))),
      progress(percentage(data.capacity - data.free, data.capacity), '磁盘空间使用率'));
      if (data.uploadAvailable != null) diskStatus.append(el('p', { class: 'setting-hint' }, '当前可用上传空间 ', el('strong', { class: 'mono' }, size(data.uploadAvailable))));
      if (data.checkedPath !== data.storagePath) diskStatus.append(el('p', { class: 'setting-hint' }, `保存时会创建新目录。当前检测位置为 ${data.checkedPath}。`));
    } catch (error) {
      if (!controller.signal.aborted) diskStatus.replaceChildren(el('p', { class: 'form-error' }, error.message));
    }
  }
  if (configTab === 'storage') storage.addEventListener('input', () => {
    activeProbe?.abort();
    clearTimeout(probeTimer);
    volume.value = '';
    limit.removeAttribute('max');
    diskStatus.textContent = '正在检测所选磁盘…';
    probeTimer = setTimeout(detectDisk, 340);
  });
  volume.addEventListener('change', () => {
    if (!volume.value) return;
    storage.value = volume.value;
    detectDisk();
  });
  const fields = configTab === 'storage' ? [
    el('div', { class: 'storage-location' },
      el('div', { class: 'storage-path-row' }, field('存储挂载目录', storage),
        el('div', { class: 'storage-path-actions' }, volume, button('检测磁盘', 'hdd', detectDisk))),
      el('p', { class: 'setting-hint' }, '选择服务器磁盘或填写目录的绝对路径。保存新路径时会迁移网盘文件。')),
    diskStatus,
    el('div', { class: 'storage-limits' }, field('网盘容量上限（GB）', limit), field('单文件上传上限（MB）', max)),
    el('p', { class: 'setting-hint' }, '网盘容量包含个人文件、公共文件、回收站和上传预留。填 0 时由磁盘剩余空间决定。'),
  ]
    : configTab === 'transfer' ? [field('全局上传限速（KiB/s）', up, '0 表示不限速'), field('全局下载限速（KiB/s）', down, '0 表示不限速')]
      : [el('label', { class: 'check-line' }, password, '要求新建和编辑的分享设置访问密码'), field('密码强度规则', rule), field('无操作会话超时（分钟）', timeout)];
  const save = button('保存设置', null, null, 'primary', { type: 'submit' });
  const message = el('p', { class: 'form-error', role: 'alert', hidden: true });
  const form = el('form', { class: `settings-card content-box form-stack${configTab === 'storage' ? ' storage-config' : ''}`, onsubmit: async (event) => {
    event.preventDefault();
    if (save.disabled) return;
    message.hidden = true;
    save.disabled = true;
    const body = configTab === 'storage' ? { storagePath: storage.value.trim(), storageLimit: Math.round(Number(limit.value) * 1024 ** 3), maxSingleFile: Math.round(Number(max.value) * 1024 ** 2) }
      : configTab === 'transfer' ? { uploadSpeedLimit: Math.round(Number(up.value) * 1024), downloadSpeedLimit: Math.round(Number(down.value) * 1024) }
        : { defaultSharePassword: password.checked, passwordRule: rule.value, sessionTimeout: Number(timeout.value) };
    try {
      const moving = body.storagePath && body.storagePath !== current.storagePath;
      if (moving && !await confirm('迁移存储', '迁移期间会暂停文件读写，所需时间取决于文件量。', '开始迁移')) return;
      save.textContent = moving ? '正在迁移…' : '正在保存…';
      const updated = await request('/admin/config/save', { method: 'PUT', body });
      Object.assign(current, updated);
      if (configTab === 'storage' && storage.value.trim() === body.storagePath) {
        storage.value = updated.storagePath;
        await detectDisk();
      }
      toast('系统设置已保存');
    } catch (error) { message.textContent = error.message; message.hidden = false; }
    finally { save.textContent = '保存设置'; save.disabled = false; }
  } }, el('h2', {}, { storage: '存储位置与容量', transfer: '传输配置', security: '安全配置' }[configTab]), fields, message, el('div', {}, save));
  output.append(configTab === 'storage' ? el('div', { class: 'settings-layout' }, form, connectionSettings()) : form);
  if (configTab === 'storage') {
    const loadVolumes = request('/admin/storage/volumes').then((paths) => {
      if (!output.isConnected || !paths.length) return;
      volume.append(...paths.map((path) => el('option', { value: path }, path)));
      volume.hidden = false;
    }).catch(() => {});
    await Promise.all([detectDisk(), loadVolumes]);
  }
}

async function logs(output) {
  const type = select('type', [['', '全部日志'], ...Object.entries(kinds)], '');
  const username = input('username', '', { type: 'search', placeholder: '搜索账号', 'aria-label': '搜索账号' });
  const start = input('start', '', { type: 'datetime-local' });
  const end = input('end', '', { type: 'datetime-local' });
  const queryForm = el('form', { class: 'filter-bar log-filters', onsubmit: (event) => {
    event.preventDefault();
    if (deleting) return;
    filters = { username: username.value.trim(), type: type.value, startTime: start.value ? +new Date(start.value) : null,
      endTime: end.value ? +new Date(end.value) : null };
    load(1);
  } },
    field('开始时间', start), field('结束时间', end), field('日志类型', type), field('账号', username),
    button('筛选', 'search', null, 'primary', { type: 'submit' }));
  const selected = new Set();
  const remove = action('删除选中', 'trash3', () => clean(true), 'danger-outline');
  const clear = action('清理全部日志', null, () => clean(false), 'danger-outline');
  const exportCsv = button('导出 CSV', 'download', () => saveLink(url('/admin/log/export', filters), 'lan-drive-audit.csv'));
  const actions = el('div', { class: 'quick-actions' }, remove, clear, exportCsv);
  const results = el('div');
  const navigation = el('div', { class: 'pagination' });
  let current = 1, total = 0, sequence = 0;
  let filters = {};
  let reading = false, deleting = false;
  const limit = 30;
  output.append(queryForm, actions, box([results, navigation]));

  const filtered = () => Object.values(filters).some((value) => value != null && value !== '');
  function controls() {
    remove.disabled = reading || deleting || !selected.size;
    clear.disabled = reading || deleting || !total;
    clear.textContent = filtered() ? '清理筛选结果' : '清理全部日志';
    exportCsv.disabled = reading || deleting;
  }

  async function clean(onlySelected) {
    if (reading || deleting || !total) return;
    const logIds = [...selected];
    if (onlySelected && !logIds.length) return;
    const label = onlySelected ? '删除选中日志' : clear.textContent;
    const count = onlySelected ? logIds.length : total;
    deleting = true;
    controls();
    try {
      if (!await confirm(label, `将永久删除 ${count} 条${!onlySelected && filtered() ? '符合当前筛选条件的' : ''}日志。此操作会留下一条管理员记录。`, label, true)
        || !output.isConnected) return;
      const result = await request(`/admin/log/${onlySelected ? 'delete' : 'clear'}`, { method: 'DELETE',
        query: onlySelected ? undefined : filters, body: onlySelected ? { logIds } : {} });
      toast(`已删除 ${result.deleted} 条日志`);
      await load(onlySelected ? current : 1);
    } finally { deleting = false; controls(); }
  }

  async function load(page) {
    const requestId = ++sequence;
    reading = true;
    selected.clear();
    controls();
    navigation.replaceChildren();
    results.replaceChildren(loading());
    try {
      const data = await request('/admin/log/list', { query: { ...filters, page, size: limit } });
      if (requestId !== sequence) return;
      total = data.total;
      current = Math.min(page, Math.max(1, Math.ceil(total / limit)));
      if (page !== current) return await load(current);
      const all = checkbox('选择本页日志', false, (event) => {
        selected.clear();
        data.list.forEach(({ id }, index) => {
          choices[index].checked = event.target.checked;
          if (event.target.checked) selected.add(id);
        });
        controls();
      });
      const choices = data.list.map((entry) => checkbox(`选择日志 ${entry.id}`, false, (event) => {
        if (event.target.checked) selected.add(entry.id);
        else selected.delete(entry.id);
        all.checked = selected.size === data.list.length;
        all.indeterminate = selected.size > 0 && !all.checked;
        controls();
      }));
      results.replaceChildren(data.list.length ? table([all, '时间', '内网 IP', '账号', '操作类型', '操作对象'], data.list.map((entry, index) =>
        row(choices[index], date(entry.time), el('span', { class: 'mono' }, entry.ip), entry.username,
          el('div', { class: 'split log-action' }, badge(kinds[entry.type], entry.type === 'admin' ? 'amber' : 'blue'), entry.action), entry.object || '—')), 'selectable-table')
        : empty('暂无匹配日志', null, null, 'journal-text'));
      navigation.replaceChildren(...pagination(total, current, limit, (next) => { if (!deleting) load(next); }));
    } catch (error) {
      if (requestId === sequence) { total = 0; results.replaceChildren(problem(error, () => load(page))); }
    } finally {
      if (requestId === sequence) { reading = false; controls(); }
    }
  }
  await load(1);
}

export async function adminPage(ctx, output) {
  const available = adminItems.filter(([key]) => ctx.user.role === 'superadmin' || !['system', 'logs'].includes(key));
  const active = available.some(([key]) => key === ctx.route.tab) ? ctx.route.tab : 'dashboard';
  output.append(title('管理员后台'), tabs(available, active, (tab) => ctx.go('admin', null, { tab })));
  const area = el('div', { class: 'admin-area' }, loading());
  output.append(area);
  try {
    area.replaceChildren();
    if (active === 'dashboard') await dashboard(ctx, area);
    else if (active === 'users') await users(ctx, area);
    else if (active === 'admin-shares') await adminShares(ctx, area);
    else if (active === 'system') await systemConfig(ctx, area);
    else await logs(area);
  } catch (error) { area.replaceChildren(problem(error, () => ctx.render())); }
}
