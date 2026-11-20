import { pin } from './offline.js';
import { openPreview } from './preview.js';
import { editMembers, editShare } from './shares-ui.js';
import { badge, button, checkbox, confirm, conflict, date, dialog, el, empty, field, fileGlyph, fileLabel, formDialog, ico, iconButton, input, loading, menu, problem, report, request, select, size, table, title, toast, url } from './ui.js';

const names = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
const pageSize = 100;
const selectionLimit = 1000;
const sortChoices = [['name:asc', '文件名 · 升序'], ['name:desc', '文件名 · 降序'], ['modifiedAt:desc', '修改时间 · 降序'], ['modifiedAt:asc', '修改时间 · 升序'],
  ['size:desc', '大小 · 降序'], ['size:asc', '大小 · 升序'], ['createdAt:desc', '创建时间 · 降序'], ['createdAt:asc', '创建时间 · 升序']];
const publicScopes = { admin: '仅管理员', all: '所有登录用户', selected: '指定用户' };

async function editPublicPolicy(action, label) {
  const endpoint = `/fs/public/${action}-policy`;
  const { mode, userIds, users } = await request(endpoint);
  const selected = new Set(userIds);
  const accounts = users.map((user) => ({ ...user, search: `${user.username} ${user.name}`.normalize('NFC').toLocaleLowerCase() }));
  const count = el('p', { class: 'muted', role: 'status' });
  const list = el('div', { class: 'policy-user-list', role: 'group', 'aria-label': `可${label}的普通用户` });
  const search = input('userSearch', '', { type: 'search', maxlength: 64, placeholder: '输入账号或昵称', oninput: paintUsers });
  const picker = el('div', { class: 'form-stack', hidden: mode !== 'selected' }, field('筛选用户', search), count, list);
  const modes = action === 'upload' ? ['admin', 'all', 'selected'] : ['all', 'selected'];
  const scope = select('mode', modes.map((key) => [key, publicScopes[key]]), mode, { onchange: () => {
    picker.hidden = scope.value !== 'selected';
    if (!picker.hidden) paintUsers();
  } });

  function updateCount() {
    count.textContent = `已选 ${selected.size} 位用户`;
  }

  function paintUsers() {
    const keyword = search.value.trim().normalize('NFC').toLocaleLowerCase();
    const matches = keyword ? accounts.filter((user) => user.search.includes(keyword)) : accounts;
    list.replaceChildren(...matches.map(({ id, name, username, enabled }) => {
      const account = name === username ? username : `${name} · ${username}`;
      const control = checkbox(account, selected.has(id), (event) => {
        if (event.target.checked) selected.add(id);
        else selected.delete(id);
        updateCount();
      });
      return el('label', { class: 'check-line' }, control, el('span', {}, account), !enabled && el('small', { class: 'muted' }, '已停用'));
    }));
    if (!matches.length) list.append(el('p', { class: 'muted' }, accounts.length ? '没有匹配的用户' : '暂无普通用户'));
    updateCount();
  }

  if (!picker.hidden) paintUsers();
  return formDialog(`公共网盘${label}权限`, {
    primary: '保存权限',
    description: `此设置适用于整个公共网盘。管理员始终可以${label}。`,
    fields: [field(`${label}范围`, scope), picker],
    submit: (form) => request(endpoint, { method: 'PUT', body: {
      mode: form.get('mode'), userIds: scope.value === 'selected' ? [...selected] : [],
    } }),
  });
}

async function destination(selection, current, mode) {
  return new Promise((resolve) => {
    const selected = new Set(selection.filter((item) => item.kind === 'folder').map((item) => item.id));
    const tree = el('div', { class: 'directory-tree' });
    const footer = el('span', { class: 'tree-selection' }, '请选择目标位置');
    const accept = button(mode === 'move' ? '移动至此' : '复制至此', null, () => { result = { targetParentId }; modal.close(); }, 'primary', { disabled: true });
    let targetParentId, result;
    let active;
    const modal = dialog(mode === 'move' ? '选择移动到的位置' : '选择复制到的位置', { wide: 'tree-modal', body: [footer, tree],
      footer: [button('取消', null, () => modal.close()), accept], onClose: () => resolve(result) });
    function branch(node, children) {
      const inner = el('div', { class: 'tree-children', hidden: true });
      const allowed = !selected.has(node.id);
      let loaded = false;
      const expand = iconButton('展开目录', 'chevron-right', async () => {
        inner.hidden = !inner.hidden;
        expand.title = inner.hidden ? '展开目录' : '收起目录';
        expand.firstElementChild.className = `bi bi-chevron-${inner.hidden ? 'right' : 'down'}`;
        if (!inner.hidden && !loaded) {
          inner.replaceChildren(loading());
          try {
            const result = children ?? await request('/fs/targets', { query: { parentId: node.id } });
            inner.replaceChildren(...result.map((child) => branch(child)));
            if (!result.length) inner.append(el('span', { class: 'muted tree-empty' }, '没有子目录'));
            loaded = true;
          } catch (error) { inner.replaceChildren(el('span', { class: 'form-error' }, error.message)); }
        }
      }, 'tree-expand', { disabled: !allowed });
      const choose = button(node.name, node.id ? 'folder-fill' : 'hdd', () => {
        active?.classList.remove('selected');
        active = choose;
        choose.classList.add('selected');
        targetParentId = node.id;
        footer.textContent = `目标位置 · ${node.name}`;
        accept.disabled = false;
      }, 'tree-target', { disabled: !allowed || current === node.id });
      if (node.id === null) queueMicrotask(() => expand.click());
      return el('div', { class: 'tree-node' }, el('div', { class: 'tree-row' }, expand, choose), inner);
    }
    async function loadTargets() {
      tree.replaceChildren(loading());
      try {
        const targets = await request('/fs/targets');
        const publicRoot = targets.find((item) => item.publicRoot);
        tree.replaceChildren(branch({ id: null, name: '我的文件 · 根目录' }, targets.filter((item) => !item.publicRoot)));
        if (publicRoot) tree.append(branch(publicRoot));
      } catch (error) { tree.replaceChildren(problem(error, loadTargets)); }
    }
    loadTargets();
  });
}

async function readDrop(transfer) {
  const roots = Array.from(transfer.items ?? []).filter((item) => item.kind === 'file').map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
  if (!roots.length) return { files: [...transfer.files].map((file) => ({ file, parents: [] })), emptyFolders: [] };
  const files = [];
  const emptyFolders = [];
  async function scan(entry, parents) {
    if (entry.isFile) return new Promise((resolve, reject) => entry.file((file) => { files.push({ file, parents }); resolve(); }, reject));
    if (!entry.isDirectory) return;
    const next = [...parents, entry.name];
    const reader = entry.createReader();
    let hasEntries = false;
    while (true) {
      const group = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      if (!group.length) break;
      hasEntries = true;
      for (const child of group) await scan(child, next);
    }
    if (!hasEntries) emptyFolders.push(next);
  }
  for (const entry of roots) await scan(entry, []);
  return { files, emptyFolders };
}

export async function filePage(ctx, output) {
  const { route, user, queue } = ctx;
  const { id, owner, root, page } = route;
  const received = page === 'received';
  const publicSpace = page === 'public';
  const sharedRoot = received && !id;
  const otherOwner = !publicSpace && owner && owner !== user.id;
  const selected = new Map();
  const marks = new Map();
  let info;
  let current = 1;
  let keyword = '';
  let sort = ctx.sort ?? 'name:asc';
  let view = ctx.view ?? user.preference.view;
  let activeRequest;
  let searchTimer;
  let refreshTimer;
  let busy = false;
  const previews = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries, observer) => {
    for (const { isIntersecting, target } of entries) {
      if (!isIntersecting) continue;
      target.src = target.dataset.preview;
      observer.unobserve(target);
    }
  }, { rootMargin: '120px' }) : null;

  const body = el('div', { class: 'file-body' });
  const selection = el('div', { class: 'selection-bar', hidden: true });
  const tooling = el('div', { class: 'file-toolbar' });
  const pagination = el('nav', { class: 'pagination file-pagination', 'aria-label': '目录分页', hidden: true });
  const heading = el('div');
  const surface = el('section', { class: 'file-surface' }, tooling, selection, pagination, body);
  output.append(heading, surface);
  body.replaceChildren(loading());
  const uploadInput = el('input', { type: 'file', multiple: true, hidden: true, 'aria-label': '选择上传文件', onchange: handlePicked });
  const folderInput = el('input', { type: 'file', multiple: true, hidden: true, webkitdirectory: true, 'aria-label': '选择上传文件夹', onchange: handlePicked });
  output.append(uploadInput, folderInput);
  const go = (folderId, anchor = root) => ctx.go(page, folderId, { owner, root: anchor });

  const directoryId = () => info?.folder?.id ?? id;
  const canWrite = () => !sharedRoot && !otherOwner && (info?.canUpload ?? ['owner', 'write'].includes(info?.permission));
  const canDownload = () => info?.canDownload !== false;
  const canOpen = (item) => item.kind === 'folder' || canDownload();
  const noSpace = () => ctx.user.diskFull || (!publicSpace && !received && info?.folder?.ownerId !== 0 && ctx.user.spaceQuota > 0 && ctx.user.spaceUsed >= ctx.user.spaceQuota);
  const selectedItems = () => [...selected.values()];
  const owns = (item) => item.permission === 'owner' && !received;
  const canShare = (item) => owns(item) && item.ownerId === user.id;
  const download = (nodes) => queue.enqueueDownload(nodes).catch(report);
  function open(item) {
    if (item.kind === 'folder') go(item.id, sharedRoot ? item.id : root);
    else if (canDownload()) openPreview(item, { autoplay: ctx.user.preference.autoplay, download: (node) => download([node]) });
  }

  function handlePicked(event) {
    const files = [...event.target.files].map((file) => ({ file, parents: (file.webkitRelativePath || '').split('/').slice(0, -1) }));
    event.target.value = '';
    uploads(files);
  }
  async function uploads(items, emptyFolders = []) {
    if (!canWrite() || busy) return;
    if (noSpace()) { toast(ctx.user.diskFull ? '服务节点磁盘已满，请联系管理员' : '存储空间不足', 'warning'); return; }
    busy = true;
    try {
      for (const parts of emptyFolders) {
        let parentId = directoryId();
        for (const name of parts) {
          try { parentId = (await request('/fs/mkdir', { method: 'POST', body: { parentId, name } })).id; }
          catch (error) {
            if (error.code !== 40901) throw error;
            const data = await request('/fs/list', { query: { parentId, keyword: name.normalize('NFC') } });
            const match = data.list.find((item) => item.kind === 'folder' && names.compare(item.name, name) === 0);
            if (!match) throw error;
            parentId = match.id;
          }
        }
      }
      await queue.enqueueUploads(items, directoryId());
      if (emptyFolders.length || items.some(({ parents }) => parents.length)) await load();
    } catch (error) { report(error); }
    finally { busy = false; }
  }

  surface.addEventListener('dragover', (event) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = canWrite() && !noSpace() ? 'copy' : 'none';
    if (canWrite() && !noSpace()) surface.classList.add('drop-active');
  });
  surface.addEventListener('dragleave', (event) => { if (!surface.contains(event.relatedTarget)) surface.classList.remove('drop-active'); });
  surface.addEventListener('drop', async (event) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    surface.classList.remove('drop-active');
    if (!canWrite()) return;
    try { const entries = await readDrop(event.dataTransfer); await uploads(entries.files, entries.emptyFolders); }
    catch (error) { report(error); }
  });

  async function nameDialog(node) {
    const rename = Boolean(node);
    const result = await formDialog(rename ? '重命名' : '新建文件夹', {
      fields: field(rename ? '名称' : '文件夹名称', input('name', node?.name ?? '', { required: true, maxlength: 220, autocomplete: 'off', placeholder: '输入文件夹名称' })),
      submit: (form) => request(rename ? '/fs/rename' : '/fs/mkdir', { method: rename ? 'PUT' : 'POST', body: rename ? { fileId: node.id, name: form.get('name') } : { parentId: directoryId(), name: form.get('name') } }),
    });
    if (result) { toast(rename ? '重命名成功' : '文件夹已创建'); await load(); }
  }

  async function relocate(items, mode) {
    const destinationInfo = await destination(items, (received || otherOwner) && !id ? undefined : directoryId(), mode);
    if (!destinationInfo) return;
    const body = { ...destinationInfo, fileId: items.map(({ id: key }) => key) };
    const send = () => request(`/fs/${mode}`, { method: 'POST', body });
    let result;
    try { result = await send(); }
    catch (error) {
      if (error.code !== 40901 || !error.details?.name) throw error;
      body.conflict = await conflict(error.details.name);
      if (!body.conflict) return;
      result = await send();
    }
    toast(`${mode === 'move' ? '已移动' : '已复制'} ${result.changed} 项${result.skipped ? `，跳过 ${result.skipped} 项` : ''}`);
    selected.clear();
    await load();
  }

  async function remove(items, unsubscribe = false) {
    const count = items.length;
    if (!await confirm(unsubscribe ? '取消共享订阅' : '移入回收站', unsubscribe ? `将从你的共享列表移除 ${count} 项。` : `将 ${count} 项移入回收站，可以在回收站还原。`, unsubscribe ? '取消订阅' : '移入回收站', true)) return;
    await request(unsubscribe ? '/share/subscription' : '/fs/delete', { method: 'DELETE', body: { fileId: items.map(({ id: key }) => key) } });
    toast(unsubscribe ? '已取消订阅' : '已移入回收站');
    for (const item of items) selected.delete(item.id);
    await load();
  }

  function menuItems(node) {
    return [[node.kind === 'folder' ? '打开' : '在线预览', node.kind === 'folder' ? 'folder2-open' : 'eye', () => open(node)],
      canDownload() && ['下载', 'download', () => download([node])],
      owns(node) && ['重命名', 'pencil', () => nameDialog(node)],
      owns(node) && ['移动', 'folder-symlink', () => relocate([node], 'move')],
      !received && canDownload() && ['复制', 'copy', () => relocate([node], 'copy')],
      canShare(node) && ['生成分享链接', 'link-45deg', () => editShare(node)],
      canShare(node) && [node.kind === 'file' ? '共享给账号' : node.shared ? '权限设置' : '设为共享文件夹', 'people', async () => { if (await editMembers(node)) { toast('共享权限已保存'); await load(); } }],
      node.kind === 'file' && canDownload() && ['保存离线副本', 'cloud-download', async () => { await pin(user.id, node); toast('已保存离线副本'); }],
      sharedRoot && ['取消订阅', 'link-45deg', () => remove([node], true), true],
      owns(node) && ['删除', 'trash3', () => remove([node]), true]];
  }

  const openMenu = (node, event) => {
    if (!canOpen(node)) return;
    event.preventDefault();
    menu(menuItems(node), event.type === 'contextmenu' ? { x: event.clientX, y: event.clientY } : { anchor: event.currentTarget });
  };
  const more = (node) => canOpen(node) && iconButton(`更多操作 · ${node.name}`, 'three-dots', (event) => openMenu(node, event), 'more-btn', { 'aria-haspopup': 'menu' });

  function thumb(node, large = false) {
    const type = node.preview;
    if (!canDownload() || (type !== 'image' && type !== 'video')) return large ? fileGlyph(node) : el('span', { class: 'muted' }, '—');
    const address = url('/fs/preview', { fileId: node.id });
    const fallback = (event) => event.currentTarget.replaceWith(fileGlyph(node));
    if (type === 'image') return el('img', { class: 'thumbnail', src: address, alt: node.name, loading: 'lazy', decoding: 'async', onerror: fallback });
    const source = `${address}#t=0.05`;
    const video = el('video', { class: 'thumbnail', muted: true, playsinline: true, preload: 'metadata', 'aria-hidden': 'true', onerror: fallback,
      ...(previews ? { 'data-preview': source } : { src: source }) });
    return video;
  }

  function selectionUI() {
    const items = selectedItems();
    selection.hidden = !items.length;
    if (selection.hidden) {
      if (selection.firstChild) selection.replaceChildren();
      return;
    }
    const owned = items.every(owns);
    selection.replaceChildren(el('strong', {}, `已选择 ${items.length} 项`), el('div', { class: 'actions' },
      button('下载', 'download', () => download(items)),
      owned && button('移动', 'folder-symlink', () => relocate(items, 'move').catch(report)),
      !received && button('复制', 'copy', () => relocate(items, 'copy').catch(report)),
      owned && button('删除', 'trash3', () => remove(items).catch(report), 'text-danger'),
      sharedRoot && button('取消订阅', 'link-45deg', () => remove(items, true).catch(report)),
      button('取消选中', 'x', () => { selected.clear(); syncSelection(); }, 'quiet')));
  }

  function syncSelection() {
    let count = 0;
    for (const [id, mark] of marks) {
      const checked = selected.has(id);
      mark.checked = checked;
      mark.closest('tr,article')?.classList.toggle('selected', checked);
      count += Number(checked);
    }
    const checkAll = body.querySelector('.check-all');
    if (checkAll) {
      checkAll.checked = count === marks.size;
      checkAll.indeterminate = count > 0 && !checkAll.checked;
    }
    selectionUI();
  }

  function marked(node) {
    if (!canDownload()) return;
    const control = checkbox(`选中 ${node.name}`, selected.has(node.id), (event) => {
      if (!event.target.checked) selected.delete(node.id);
      else if (selected.size < selectionLimit) selected.set(node.id, node);
      else toast(`一次最多选择 ${selectionLimit} 项`, 'warning');
      syncSelection();
    });
    marks.set(node.id, control);
    return control;
  }

  function paintList() {
    previews?.disconnect();
    marks.clear();
    const rows = info.list;
    if (!rows.length) {
      const uploadButton = !keyword && canWrite() && !noSpace() && button('选择上传文件', 'upload', () => uploadInput.click(), 'primary');
      const main = keyword ? '找不到匹配的文件' : sharedRoot ? '暂无收到的共享' : publicSpace && !id ? '公共网盘为空' : '当前文件夹为空';
      const help = keyword ? `没有名称包含“${keyword}”的条目` : canWrite() ? '拖拽文件或文件夹到此处上传' : null;
      body.replaceChildren(empty(main, help, uploadButton, publicSpace ? 'hdd-network' : undefined));
      selectionUI();
      return;
    }
    const checkAll = canDownload() && checkbox('选择本页文件', false, (event) => {
      let limitReached = false;
      for (const node of rows) {
        if (!event.target.checked) selected.delete(node.id);
        else if (selected.has(node.id) || selected.size < selectionLimit) selected.set(node.id, node);
        else limitReached = true;
      }
      if (limitReached) toast(`一次最多选择 ${selectionLimit} 项`, 'warning');
      syncSelection();
    });
    if (checkAll) checkAll.className = 'check-all';
    if (view === 'grid') {
      body.replaceChildren(el('div', { class: 'grid-meta' }, checkAll, `本页 ${rows.length} 项`), el('div', { class: 'file-grid' }, rows.map((node) => el('article', {
        class: `file-card ${selected.has(node.id) ? 'selected' : ''}`, oncontextmenu: (event) => openMenu(node, event),
      }, el('div', { class: 'tile-thumb' }, canOpen(node) && button('', null, () => open(node), 'tile-open', { 'aria-label': `打开 ${node.name}` }), thumb(node, true),
      canDownload() && el('div', { class: 'tile-check' }, marked(node)),
      canOpen(node) && el('div', { class: 'tile-actions' }, canDownload() && iconButton('下载', 'download', () => download([node])), more(node))),
      canOpen(node) ? button(node.name, null, () => open(node), 'tile-name', { title: node.name })
        : el('span', { class: 'tile-name', title: node.name }, node.name),
      el('div', { class: 'tile-meta' }, node.kind === 'folder' ? '文件夹' : size(node.size))))));
    } else {
      const headers = [checkAll, '文件名', '缩略图', '大小', '修改时间', '操作'];
      const lines = rows.map((node) => el('tr', { class: selected.has(node.id) ? 'selected' : '', oncontextmenu: (event) => openMenu(node, event) },
        el('td', { class: 'check-cell' }, marked(node)), el('td', { class: 'name-cell' }, fileLabel(node, canOpen(node) && (() => open(node))),
          (sharedRoot && node.username) && el('small', { class: 'row-note' }, `由 ${node.username} 共享`)),
        el('td', {}, thumb(node)), el('td', { class: 'mono' }, node.kind === 'folder' ? '—' : size(node.size)),
        el('td', { class: 'dim mono' }, date(node.modifiedAt)), el('td', {}, more(node))));
      body.replaceChildren(table(headers, lines, 'file-table'));
    }
    if (previews) for (const video of body.querySelectorAll('video[data-preview]')) previews.observe(video);
    syncSelection();
  }

  const search = el('div', { class: 'search-box' }, ico('search'), input('keyword', '', { type: 'search', placeholder: '搜索当前目录', maxlength: 220, 'aria-label': '搜索当前目录', oninput: (event) => {
    keyword = event.target.value.trim();
    selected.clear();
    syncSelection();
    activeRequest?.abort();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => load({ page: 1 }), 180);
  } }));

  async function configurePolicy(event, action) {
    const control = event.currentTarget;
    const label = action === 'upload' ? '上传' : '下载';
    control.disabled = true;
    try {
      if (await editPublicPolicy(action, label)) {
        toast(`公共网盘${label}权限已保存`);
        await load();
      }
    } catch (error) { report(error); }
    finally { control.disabled = false; }
  }

  function paintHeader() {
    const homeName = publicSpace ? '公共网盘' : received ? '共享给我的' : otherOwner ? '用户文件' : '我的文件';
    const path = info.folder?.path.slice(publicSpace ? 1 : 0) ?? [];
    const from = root ? Math.max(0, path.findIndex((item) => item.id === root)) : 0;
    const crumbParts = [{ id: null, name: homeName }, ...path.slice(from)];
    const previous = crumbParts.at(-2);
    const crumb = el('div', { class: 'breadcrumbs', 'aria-label': '当前路径' }, crumbParts.map((part, index) => [index > 0 && ico('chevron-right'),
      index === crumbParts.length - 1 ? el('span', { class: 'crumb current', title: part.name, 'aria-current': 'page' }, part.name)
        : button(part.name, null, () => go(part.id, part.id ? root : null), 'crumb', { title: part.name })]));
    const changeView = (mode) => { ctx.view = view = mode; paintHeader(); paintList(); };
    const viewSwitch = el('div', { class: 'switch-group', 'aria-label': '文件视图' }, iconButton('列表视图', 'list-ul', () => changeView('list'), view === 'list' ? 'active' : '', { 'aria-pressed': String(view === 'list') }),
      iconButton('网格视图', 'grid', () => changeView('grid'), view === 'grid' ? 'active' : '', { 'aria-pressed': String(view === 'grid') }));
    const sortBy = select('sort', sortChoices, sort, { 'aria-label': '文件排序', onchange: (event) => { ctx.sort = sort = event.target.value; load({ page: 1 }); } });
    const fileButtons = canWrite() ? [button('新建文件夹', 'folder-plus', () => nameDialog().catch(report)),
      button('上传文件', 'upload', () => uploadInput.click(), 'primary', { disabled: noSpace(), title: noSpace() ? '存储空间不足' : '上传文件' }),
      button('上传文件夹', 'folder-symlink', () => folderInput.click(), '', { disabled: noSpace() })] : [];
    const publicManager = publicSpace && info.permission === 'owner';
    const downloadDetail = canDownload() ? `下载范围 · ${publicScopes[info.downloadMode ?? 'all']}` : '预览和下载需管理员授权';
    const uploadDetail = canWrite() ? `上传范围 · ${publicScopes[info.uploadMode ?? 'admin']}` : '上传需管理员授权';
    heading.replaceChildren(title(homeName, [fileButtons,
      publicManager && button('下载权限', 'shield-lock', (event) => configurePolicy(event, 'download')),
      publicManager && info.uploadMode && button('上传权限', 'shield-plus', (event) => configurePolicy(event, 'upload')),
      sharedRoot && button('取消共享订阅', 'link-45deg', () => selected.size ? remove(selectedItems(), true).catch(report) : toast('请先选择要取消的订阅', 'warning')),
      iconButton('刷新', 'arrow-clockwise', () => load({ manual: true }))], publicSpace && `${downloadDetail}　/　${uploadDetail}`));
    tooling.replaceChildren(el('div', { class: 'breadcrumb-area' }, iconButton('返回上一级', 'arrow-left', () => go(previous?.id, previous?.id ? root : null), '', { disabled: !previous }), crumb),
      el('div', { class: 'file-filters' }, search, viewSwitch, sortBy));
  }

  function paintPagination(lastPage) {
    pagination.hidden = lastPage <= 1;
    if (pagination.hidden) return;
    pagination.replaceChildren(el('span', { class: 'muted', 'aria-live': 'polite' }, `第 ${current} / ${lastPage} 页 · 共 ${info.total} 项`),
      el('div', { class: 'actions' }, iconButton('上一页', 'chevron-left', () => load({ page: current - 1 }), '', { disabled: current === 1 }),
        iconButton('下一页', 'chevron-right', () => load({ page: current + 1 }), '', { disabled: current === lastPage })));
  }

  async function load({ page = current, manual = false } = {}) {
    if (!output.isConnected) return;
    clearTimeout(searchTimer);
    activeRequest?.abort();
    const controller = new AbortController();
    activeRequest = controller;
    previews?.disconnect();
    marks.clear();
    pagination.hidden = true;
    body.setAttribute('aria-busy', 'true');
    body.replaceChildren(loading());
    try {
      const [sortField, sortOrder] = sort.split(':');
      const result = await request(sharedRoot ? '/share/toMe' : '/fs/list', {
        query: { parentId: id, ownerId: owner, space: publicSpace ? 'public' : undefined, page, size: pageSize, keyword, sortField, sortOrder }, signal: controller.signal,
      });
      if (manual) await ctx.syncUser();
      if (controller.signal.aborted || !output.isConnected) return;
      if (publicSpace && result.folder?.ownerId !== 0) throw new Error('当前网盘服务尚不支持公共网盘');
      const lastPage = Math.max(1, Math.ceil(result.total / pageSize));
      if (page > lastPage) return load({ page: lastPage });
      const updateHeader = !info || manual || info.permission !== result.permission
        || info.canDownload !== result.canDownload || info.downloadMode !== result.downloadMode
        || info.canUpload !== result.canUpload || info.uploadMode !== result.uploadMode;
      info = result;
      if (!canDownload()) selected.clear();
      current = page;
      if (updateHeader) paintHeader();
      paintList();
      paintPagination(lastPage);
      ctx.fileUpdate = (parent) => {
        if (!output.isConnected || (parent ?? null) !== directoryId() || refreshTimer) return;
        refreshTimer = setTimeout(() => { refreshTimer = undefined; load(); }, 250);
      };
    } catch (error) {
      if (!controller.signal.aborted) body.replaceChildren(problem(error, () => load({ page })));
    } finally {
      if (activeRequest === controller) { activeRequest = undefined; body.removeAttribute('aria-busy'); }
    }
  }
  await load();
}
