export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class') node.className = value;
    else if (key === 'checked' || key === 'indeterminate') node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat(Infinity).filter((child) => child != null && child !== false));
  return node;
}

export const ico = (name, extra = '') => el('i', { class: `bi bi-${name} ${extra}`.trim(), 'aria-hidden': 'true' });
export const button = (label, icon, action, cls = '', attrs = {}) => el('button', { type: 'button', class: `btn ${cls}`.trim(), onclick: action, ...attrs }, icon && ico(icon), label);
export const iconButton = (label, icon, action, cls = '', attrs = {}) => button('', icon, action, `icon-btn ${cls}`, { title: label, 'aria-label': label, ...attrs });
export const brand = (text = '内网私有网盘') => el('div', { class: 'brand' }, el('span', { class: 'brand-mark' }, ico('cloud-fill'), ico('arrow-up-short', 'brand-arrow')), el('span', {}, text));
export const badge = (text, tone = '') => el('span', { class: `badge ${tone}` }, text);
export const field = (label, control, hint) => el('label', { class: 'field' }, el('span', { class: 'field-label' }, label), control, hint && el('small', {}, hint));
export const input = (name, value = '', attrs = {}) => el('input', { name, value, class: 'input', ...attrs });
export function select(name, options, value, attrs = {}) {
  const element = el('select', { class: 'input select', name, ...attrs }, options.map(([key, label]) => el('option', { value: key }, label)));
  element.value = value ?? options[0]?.[0] ?? '';
  return element;
}
export const checkbox = (label, checked, change) => el('input', { type: 'checkbox', 'aria-label': label, checked, onchange: change });
export const roles = { user: '普通用户', admin: '普通管理员', superadmin: '超级管理员' };
const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', hour12: false });
export const date = (value) => value ? dateFormat.format(value) : '—';
export const size = (value) => {
  if (value == null) return '—';
  const suffix = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const unit = Math.min(suffix.length - 1, Math.floor(Math.log(Math.max(value, 1)) / Math.log(1024)));
  return `${(value / 1024 ** unit).toLocaleString('zh-CN', { maximumFractionDigits: unit > 0 ? 1 : 0 })} ${suffix[unit]}`;
};

export function url(path, params = {}) {
  const result = new URL(`/api/v1${path}`, location.origin);
  for (const [key, value] of Object.entries(params)) if (value != null && value !== '') result.searchParams.set(key, value);
  return result.pathname + result.search;
}

export class ApiError extends Error {
  constructor(message, status = 0, code = 0, details = null) {
    super(message);
    Object.assign(this, { status, code, details });
  }
}

export async function request(path, { method = 'GET', body, query, headers = {}, signal, raw = false, guest = false } = {}) {
  if (body != null && !(body instanceof FormData)) {
    body = JSON.stringify(body);
    headers = { ...headers, 'Content-Type': 'application/json' };
  }
  let response;
  try { response = await fetch(url(path, query), { method, body, headers, signal, cache: 'no-store' }); }
  catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new ApiError('连接不到内网网盘服务');
  }
  if (response.ok && raw) return response;
  const result = await response.json().catch(() => null);
  if (response.ok && result?.code === 0) return result.data;
  if (response.status === 401 && !guest && path !== '/auth/login') window.dispatchEvent(new Event('drive:expired'));
  throw new ApiError(result?.msg ?? `请求失败（${response.status}）`, response.status, result?.code, result?.data);
}

export function toast(message, tone = 'success') {
  const item = el('div', { class: `toast ${tone}`, role: 'status' }, ico(tone === 'error' ? 'exclamation-circle' : tone === 'warning' ? 'exclamation-triangle' : 'check-circle'), el('span', {}, message));
  item.append(iconButton('关闭通知', 'x', () => item.remove()));
  document.querySelector('#toasts').append(item);
  setTimeout(() => item.remove(), 6000);
}
export const report = (error) => { if (error?.name !== 'AbortError') toast(error?.message ?? '操作失败', 'error'); };
export const loading = () => el('div', { class: 'skeleton', role: 'status', 'aria-label': '加载中' }, ...Array.from({ length: 4 }, () => el('span')));
export const empty = (title, hint, action, icon = 'folder2-open') => el('div', { class: 'empty' },
  el('div', { class: 'empty-graphic', 'aria-hidden': 'true' }, el('span', { class: 'empty-orbit' }), el('span', { class: 'empty-icon' }, ico(icon)), el('span', { class: 'empty-spark' }, ico('plus'))),
  el('h2', {}, title), hint && el('p', {}, hint), action);
export const problem = (error, retry) => empty(error.message, null, retry && button('重试', 'arrow-clockwise', retry), 'exclamation-circle');
export const title = (heading, actions, detail) => el('div', { class: 'section-title' }, el('div', {}, el('h1', {}, heading), detail && el('p', {}, detail)), actions && el('div', { class: 'actions' }, actions));
export const tabs = (items, active, change) => el('div', { class: 'tabs', role: 'navigation' }, items.map(([key, label, icon]) => button(label, icon, () => change(key), key === active ? 'active' : '', { 'aria-current': key === active ? 'page' : undefined })));

export function table(headers, rows, extra = '') {
  return el('div', { class: `table-scroll ${extra}` }, el('table', {}, el('thead', {}, el('tr', {}, headers.map((header) => el('th', { scope: 'col' }, header)))), el('tbody', {}, rows)));
}
export const row = (...cells) => el('tr', {}, cells.map((cell) => el('td', {}, cell)));

export function dialog(heading, { wide = '', body, footer, onClose } = {}) {
  const headingId = `dialog-${Math.random().toString(36).slice(2)}`;
  const content = el('div', { class: 'modal-body' }, body);
  const controls = el('div', { class: 'modal-foot' }, footer);
  const box = el('dialog', { class: `modal ${wide}`.trim(), 'aria-labelledby': headingId },
    el('div', { class: 'modal-head' }, el('h2', { id: headingId }, heading), iconButton('关闭', 'x-lg', () => box.close())), content, controls);
  box.addEventListener('close', () => { box.remove(); onClose?.(); }, { once: true });
  document.body.append(box);
  box.showModal();
  return { box, content, controls, close: () => box.close() };
}

export function formDialog(heading, { fields, submit, primary = '确定', wide, danger = false, description } = {}) {
  return new Promise((resolve) => {
    let complete = false;
    const errorText = el('p', { class: 'form-error', role: 'alert', hidden: true });
    const formId = `form-${Math.random().toString(36).slice(2)}`;
    const submitButton = button(primary, null, null, danger ? 'danger' : 'primary', { type: 'submit', form: formId });
    const form = el('form', { id: formId, class: 'form-stack', onsubmit: async (event) => {
      event.preventDefault();
      submitButton.disabled = true;
      errorText.hidden = true;
      try {
        const result = await submit?.(new FormData(form), form);
        complete = true;
        resolve(result ?? true);
        modal.close();
      } catch (error) { errorText.textContent = error.message; errorText.hidden = false; }
      finally { submitButton.disabled = false; }
    } }, description && el('p', { class: 'muted' }, description), fields, errorText);
    const modal = dialog(heading, { wide, body: form, footer: [button('取消', null, () => modal.close()), submitButton], onClose: () => { if (!complete) resolve(null); } });
    form.querySelector('input:not([type=checkbox]), select')?.focus();
  });
}

export const confirm = (heading, description, primary = '确定', danger = false) => formDialog(heading, { description, primary, danger });

export function conflict(name, canOverwrite = true) {
  return new Promise((resolve) => {
    let chosen;
    const pick = (strategy) => () => { chosen = strategy; modal.close(); };
    const detail = canOverwrite ? '覆盖会将原条目移入回收站。' : '可以重命名新文件后上传。';
    const modal = dialog('处理同名冲突', {
      body: el('p', {}, `目标目录已存在“${name}”。${detail}`),
      footer: [button('跳过', null, pick('skip')), canOverwrite && button('覆盖', null, pick('overwrite')), button('重命名', null, pick('rename'), 'primary')],
      onClose: () => resolve(chosen),
    });
  });
}

let closeMenu;
export function menu(items, { anchor, x, y } = {}) {
  closeMenu?.();
  const rect = anchor?.getBoundingClientRect();
  const popup = el('div', { class: 'menu', role: 'menu' });
  const close = () => {
    popup.remove();
    document.removeEventListener('pointerdown', outside, true);
    window.removeEventListener('resize', close);
    document.removeEventListener('keydown', keydown, true);
    closeMenu = undefined;
  };
  const outside = (event) => { if (!popup.contains(event.target) && event.target !== anchor) close(); };
  const keydown = (event) => { if (event.key === 'Escape') { close(); anchor?.focus(); } };
  popup.append(...items.filter(Boolean).map(([label, icon, action, destructive]) => button(label, icon, () => {
    close();
    Promise.resolve().then(action).catch(report);
  }, destructive ? 'text-danger' : '', { role: 'menuitem' })));
  document.body.append(popup);
  popup.style.left = `${Math.max(8, Math.min(x ?? rect?.left ?? 8, innerWidth - popup.offsetWidth - 8))}px`;
  popup.style.top = `${Math.max(8, Math.min(y ?? rect?.bottom ?? 8, innerHeight - popup.offsetHeight - 8))}px`;
  document.addEventListener('pointerdown', outside, true);
  window.addEventListener('resize', close);
  document.addEventListener('keydown', keydown, true);
  closeMenu = close;
  popup.firstElementChild?.focus();
}

export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else {
      const selected = input('copy', text, { readonly: true, class: 'clipboard-copy' });
      (document.querySelector('dialog[open]:last-of-type') ?? document.body).append(selected);
      selected.select();
      const copied = document.execCommand('copy');
      selected.remove();
      if (!copied) throw new Error('copy');
    }
    toast('链接已复制');
  } catch {
    const link = input('link', text, { readonly: true });
    dialog('复制分享链接', { body: link });
    link.select();
  }
}

export function saveLink(href, name) {
  const link = el('a', { href, download: name ?? '', hidden: true });
  document.body.append(link);
  link.click();
  link.remove();
}

export function saveBlob(blob, name) {
  const address = URL.createObjectURL(blob);
  saveLink(address, name);
  setTimeout(() => URL.revokeObjectURL(address), 60_000);
}

export function fileGlyph(node) {
  const kind = node.kind === 'folder' ? 'folder' : node.preview ?? 'file';
  return el('span', { class: `file-glyph ${kind}` }, ico({ folder: 'folder-fill', image: 'file-earmark-image', video: 'file-earmark-play', pdf: 'file-earmark-pdf', text: 'file-earmark-text', file: 'file-earmark' }[kind]));
}

export const fileLabel = (node, action) => el('span', { class: 'file-label' }, fileGlyph(node),
  action ? button(node.name, null, action, 'file-name', { title: node.name }) : el('span', { class: 'file-name', title: node.name }, node.name));
