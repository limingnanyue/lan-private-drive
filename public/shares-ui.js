import { openPreview } from './preview.js';
import { badge, brand, button, confirm, conflict, copyText, dialog, el, empty, field, fileLabel, formDialog, ico, input, loading, problem, report, request, row, saveLink, select, size, table, toast, url } from './ui.js';

export const permissionLabel = (permission) => permission === 'upload' ? '查看、下载和上传' : '查看和下载';
export const shareStatus = (status) => ({ active: '有效', expired: '已过期', cancelled: '已取消', unavailable: '文件暂不可用' }[status] ?? '有效');

export async function editShare(node, current = null) {
  const option = await request('/share/options');
  const canUpload = current ? current.kind === 'folder' : node.kind === 'folder' && node.shared;
  const restrictions = [['download', '仅查看和下载'], ...(canUpload ? [['upload', '查看、下载和上传']] : [])];
  const periods = [['permanent', '永久有效'], ['1h', '1 小时'], ['1d', '1 天'], ['7d', '7 天'], ['30d', '30 天']];
  if (current) periods.unshift(['keep', '保留当前有效期']);
  const initialPassword = option.defaultSharePassword || Boolean(current?.hasPassword);
  const password = input('password', '', { type: 'password', maxlength: 128, autocomplete: 'new-password', placeholder: current?.hasPassword ? '留空保留原密码' : '设置访客访问密码' });
  const passwordField = field('访问密码', password);
  passwordField.hidden = !initialPassword;
  password.required = initialPassword && !current?.hasPassword;
  const toggle = el('input', { type: 'checkbox', name: 'passwordOn', checked: initialPassword, disabled: option.defaultSharePassword, onchange: () => {
    passwordField.hidden = !toggle.checked;
    password.required = toggle.checked && !current?.hasPassword;
  } });
  const result = await formDialog(current ? '编辑分享' : '生成分享链接', {
    wide: 'share-modal', primary: current ? '保存' : '生成链接', description: current?.name ?? node.name,
    fields: [field('分享权限', select('permission', restrictions, current?.permission)), field('有效期', select('expireTime', periods)),
      el('label', { class: 'check-line' }, toggle, '设置访问密码'), passwordField],
    submit: (form) => {
      const body = { permission: form.get('permission') };
      if (form.get('expireTime') !== 'keep') body.expireTime = form.get('expireTime');
      if (!toggle.checked || password.value || !current?.hasPassword) body.password = toggle.checked ? password.value : '';
      if (current) body.shareId = current.shareId;
      else body.fileId = node.id;
      return request(current ? '/share/update' : '/share/create', { method: current ? 'PUT' : 'POST', body });
    },
  });
  if (result && !current) await showLink(result);
  return result;
}

export async function showLink(share) {
  const qr = await request('/share/qr', { query: { shareId: share.shareId } });
  const modal = dialog('分享链接已生成', { wide: 'share-modal', body: el('div', { class: 'share-qr' },
    el('img', { src: qr.qr, alt: '在同一局域网扫码打开分享' }), field('分享链接', input('url', qr.url, { readonly: true, onclick: (event) => event.target.select() })),
    el('p', { class: 'muted' }, '同一局域网的设备可以扫码访问。')),
  footer: [button('关闭', null, () => modal.close()), button('复制链接', 'copy', () => copyText(qr.url), 'primary')] });
}

export async function editMembers(node) {
  const existing = await request('/share/members', { query: { fileId: node.id } });
  const lines = el('div', { class: 'member-list' });
  const permitted = node.kind === 'folder' ? [['read', '查看和下载'], ['write', '查看、下载和上传']] : [['read', '查看和下载']];
  function addLine(member = {}) {
    const account = input('member', member.username ?? '', { placeholder: '请输入账号', required: true, maxlength: 64, 'aria-label': '共享成员账号' });
    const permission = select('memberPermission', permitted, member.permission, { 'aria-label': '成员权限' });
    const line = el('div', { class: 'member-row' }, account, permission, iconButton('移除此成员', 'dash-circle', () => line.remove()));
    lines.append(line);
    return account;
  }
  for (const member of existing) addLine(member);
  return formDialog(node.kind === 'folder' && !node.shared ? '设为共享文件夹' : '成员权限', {
    wide: 'share-modal', description: node.name, primary: '保存权限',
    fields: [lines, button('添加成员', 'person-plus', () => addLine().focus()), el('p', { class: 'muted' }, node.kind === 'folder' ? '成员可从「共享给我的」打开目录。仅授权上传的成员可以写入新文件。' : '成员可从「共享给我的」查看和下载文件。')],
    submit: (form) => request('/share/members/save', { method: 'PUT', body: { fileId: node.id,
      members: form.getAll('member').map((username, index) => ({ username, permission: form.getAll('memberPermission')[index] })) } }),
  });
}

async function sendGuestFile(link, parentId, file) {
  const post = (body, query) => request('/share/upload', { method: 'POST', body, query, guest: true, headers: { 'X-Share-Token': link.ticket } });
  const body = { action: 'start', shareCode: link.code, parentId, name: file.name, total: file.size };
  let job;
  try {
    try { job = await post(body); }
    catch (error) {
      if (error.code !== 40901) throw error;
      body.conflict = await conflict(file.name);
      if (!body.conflict) return;
      job = await post(body);
    }
    if (job.skipped) return;
    while (job.done < job.total) {
      const form = new FormData();
      form.set('taskId', job.id);
      form.set('offset', job.done);
      form.set('file', file.slice(job.done, job.done + job.chunkSize), 'chunk.dat');
      job = await post(form, { shareCode: link.code });
    }
    const merge = { action: 'merge', shareCode: link.code, fileKey: job.id };
    try { await post(merge); }
    catch (error) {
      if (error.code !== 40901) throw error;
      merge.conflict = await conflict(file.name);
      if (!merge.conflict) throw new Error('上传已取消');
      await post(merge);
    }
  } catch (error) {
    if (job?.id) await post({ action: 'cancel', shareCode: link.code, taskId: job.id }).catch(() => {});
    throw error;
  }
}

export function guestPage(root) {
  const link = { code: location.pathname.split('/')[2], ticket: null };
  const heading = el('h1', {}, '分享文件');
  const main = el('section', { class: 'guest-main' });
  const banner = el('header', { class: 'guest-header' }, brand());
  root.replaceChildren(el('div', { class: 'guest-page' }, banner, main,
    el('footer', { class: 'guest-footer' }, ico('shield-check'), '分享仅限同一局域网内访问')));
  const params = (id) => ({ fileId: id, shareCode: link.code, ticket: link.ticket });
  const download = async (node) => {
    try {
      if (node.kind === 'file') await request('/share/download', { method: 'HEAD', raw: true, guest: true, query: params(node.id) });
      saveLink(url('/share/download', params(node.id)), node.kind === 'folder' ? `${node.name}.zip` : node.name);
    } catch (error) { report(error); }
  };
  let current;

  async function load(parentId) {
    main.replaceChildren(loading());
    try {
      const data = await request('/share/list', { guest: true, query: { shareCode: link.code, parentId }, headers: link.ticket ? { 'X-Share-Token': link.ticket } : {} });
      if (data.ticket) link.ticket = data.ticket;
      current = parentId ?? data.rootId;
      show(data);
    } catch (error) {
      if (error.code === 40103) unlock();
      else main.replaceChildren(problem(error, error.status === 0 && (() => load(parentId))));
    }
  }

  function show(data) {
    heading.textContent = data.name;
    const uploadInput = el('input', { type: 'file', hidden: true, multiple: true, onchange: async () => {
      const files = [...uploadInput.files];
      if (!files.length) return;
      uploadButton.disabled = true;
      try {
        for (let index = 0; index < files.length; index++) {
          uploadButton.textContent = `正在上传 ${index + 1} / ${files.length}`;
          await sendGuestFile(link, current, files[index]);
        }
        toast('上传任务已完成');
      } catch (error) { report(error); }
      finally { await load(current); }
    } });
    const uploadButton = button('上传文件', 'upload', () => uploadInput.click(), 'primary');
    const breadcrumbs = data.path.map((part, index) => [index > 0 && ico('chevron-right'), button(part.name, null, () => load(part.id), 'crumb')]);
    const open = (node) => node.kind === 'folder' ? load(node.id) : openPreview(node, { guest: link, download });
    main.replaceChildren(el('div', { class: 'guest-title' }, el('div', { class: 'guest-type' }, ico('link-45deg'), '局域网分享'), heading, badge(permissionLabel(data.permission), 'blue')),
      el('div', { class: 'guest-table' }, el('div', { class: 'file-toolbar' },
        el('div', { class: 'breadcrumbs' }, data.kind === 'folder' ? breadcrumbs : '分享内容'), data.permission === 'upload' && uploadButton, uploadInput),
      data.list.length ? table(['文件名', '大小', '操作'], data.list.map((node) => row(fileLabel(node, () => open(node)), node.kind === 'folder' ? '—' : size(node.size),
        button('下载', 'download', () => download(node))))) : empty('当前文件夹暂无文件', data.permission === 'upload' ? '可以上传文件到此文件夹' : null)));
  }

  function unlock() {
    link.ticket = null;
    main.replaceChildren(empty('分享需要访问密码', '请输入分享者提供的密码', button('输入密码', 'key', prompt, 'primary'), 'lock'));
    prompt();
  }
  async function prompt() {
    const result = await formDialog('输入分享密码', { fields: field('访问密码', input('password', '', { required: true, type: 'password', maxlength: 128, autocomplete: 'off' })), primary: '打开分享',
      submit: (form) => request('/share/verify', { method: 'POST', guest: true, body: { shareCode: link.code, password: form.get('password') } }) });
    if (result) { link.ticket = result.ticket; await load(); }
  }
  load();
}

export async function cancelShare(share, admin = false) {
  if (!await confirm(admin ? '强制取消分享' : '取消分享', `“${share.name}”的链接会立即失效。`, '取消分享', true)) return false;
  await request(admin ? '/admin/share/forceCancel' : '/share/cancel', { method: 'DELETE', body: { shareId: share.shareId } });
  toast('分享已取消');
  return true;
}
