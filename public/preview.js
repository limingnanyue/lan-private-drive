import { button, dialog, el, iconButton, ico, request, saveBlob, toast, url } from './ui.js';

const languages = { md: 'markdown', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', yml: 'yaml', html: 'xml', svg: 'xml', sh: 'bash', ps1: 'powershell', h: 'c', cs: 'csharp', rs: 'rust', rb: 'ruby' };
let highlighting;
function highlighter() {
  highlighting ??= new Promise((resolve, reject) => {
    const script = el('script', { src: '/vendor/highlight/highlight.min.js', onload: () => resolve(globalThis.hljs), onerror: reject });
    document.head.append(script, el('link', { rel: 'stylesheet', href: '/vendor/highlight/styles/github.min.css' }));
  });
  return highlighting;
}

export function openPreview(node, { autoplay = false, guest, download } = {}) {
  const query = guest ? { fileId: node.id, shareCode: guest.code, ticket: guest.ticket } : { fileId: node.id };
  const path = guest ? '/share/preview' : '/fs/preview';
  const address = node.blob ? URL.createObjectURL(node.blob) : url(path, query);
  const canvas = el('div', { class: `preview-canvas preview-${node.preview ?? 'unknown'}` });
  const toolbar = el('div', { class: 'actions preview-tools' });
  let pdf;
  let ended = false;
  const controller = new AbortController();
  const save = () => node.blob ? saveBlob(node.blob, node.name) : download?.(node);
  const modal = dialog(node.name, {
    wide: 'fullscreen', body: canvas, footer: [toolbar, button('下载', 'download', save, 'primary'), button('关闭', null, () => modal.close())],
    onClose: () => {
      ended = true;
      controller.abort();
      pdf?.destroy().catch(() => {});
      if (node.blob) URL.revokeObjectURL(address);
    },
  });

  function failed(message) {
    if (!ended) canvas.replaceChildren(el('div', { class: 'preview-message', role: 'alert' }, ico('exclamation-circle'), message));
  }
  async function loadFile(range) {
    if (node.blob) return node.blob;
    const result = await request(path, { query, raw: true, guest: Boolean(guest), signal: controller.signal, headers: range ? { Range: range } : {} });
    return result.blob();
  }

  if (node.preview === 'image') {
    const image = el('img', { src: address, alt: node.name, onerror: () => failed('图片无法加载，文件可能已被删除') });
    let scale = 1;
    let rotation = 0;
    const label = el('span', { class: 'preview-value' }, '100%');
    function adjust(by, angle = 0) {
      scale = Math.min(4, Math.max(0.25, scale + by));
      rotation += angle;
      image.style.transform = `rotate(${rotation}deg) scale(${scale})`;
      label.textContent = `${Math.round(scale * 100)}%`;
    }
    toolbar.append(iconButton('缩小', 'zoom-out', () => adjust(-0.25)), label, iconButton('放大', 'zoom-in', () => adjust(0.25)), iconButton('旋转', 'arrow-clockwise', () => adjust(0, 90)));
    canvas.append(image);
  } else if (node.preview === 'video') {
    const video = el('video', { src: address, controls: true, autoplay, playsinline: true, preload: 'metadata', onerror: () => failed('视频无法播放，文件可能已被删除或编码不受支持') });
    canvas.append(video);
    if (autoplay) video.play().catch(() => {});
  } else if (node.preview === 'pdf') {
    const paper = el('canvas', { class: 'pdf-page' });
    const label = el('span', { class: 'preview-value' }, '正在加载');
    let current = 1;
    let scale = 1;
    let rendering;
    let pageVersion = 0;
    async function render() {
      if (!pdf || ended) return;
      const tick = ++pageVersion;
      rendering?.cancel();
      const page = await pdf.getPage(current);
      if (ended || tick !== pageVersion) return;
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(1.2, (canvas.clientWidth - 36) / base.width) * scale });
      const dpi = Math.min(devicePixelRatio || 1, 2);
      paper.width = Math.ceil(viewport.width * dpi);
      paper.height = Math.ceil(viewport.height * dpi);
      paper.style.width = `${viewport.width}px`;
      paper.style.height = `${viewport.height}px`;
      label.textContent = `${current} / ${pdf.numPages} · ${Math.round(100 * scale)}%`;
      rendering = page.render({ canvasContext: paper.getContext('2d'), viewport, transform: [dpi, 0, 0, dpi, 0, 0] });
      try { await rendering.promise; }
      catch (error) { if (error.name !== 'RenderingCancelledException') failed('此 PDF 页面无法渲染'); }
    }
    const navigate = (delta) => { if (pdf) { current = Math.max(1, Math.min(pdf.numPages, current + delta)); render().catch(() => failed('无法打开该页')); } };
    const zoom = (delta) => { scale = Math.max(0.5, Math.min(3, scale + delta)); render().catch(() => failed('无法缩放页面')); };
    toolbar.append(iconButton('上一页', 'chevron-left', () => navigate(-1)), label, iconButton('下一页', 'chevron-right', () => navigate(1)), iconButton('缩小', 'zoom-out', () => zoom(-0.25)), iconButton('放大', 'zoom-in', () => zoom(0.25)));
    canvas.append(paper);
    (async () => {
      const library = await import('/vendor/pdf/build/pdf.mjs');
      library.GlobalWorkerOptions.workerSrc = '/vendor/pdf/build/pdf.worker.mjs';
      const documentTask = library.getDocument({ url: address, isEvalSupported: false, cMapUrl: '/vendor/pdf/cmaps/', cMapPacked: true, standardFontDataUrl: '/vendor/pdf/fonts/' });
      pdf = await documentTask.promise;
      if (ended) return pdf.destroy();
      return render();
    })().catch(() => failed('PDF 无法打开，文件可能已被删除、损坏或加密'));
  } else if (node.preview === 'text') {
    const code = el('code', {}, '正在读取文本…');
    canvas.append(el('pre', {}, code));
    (async () => {
      const limit = 2 * 1024 * 1024;
      const blob = node.size > limit ? (node.blob ? node.blob.slice(0, limit) : await loadFile(`bytes=0-${limit - 1}`)) : await loadFile();
      const text = await blob.text();
      if (ended) return;
      const extension = node.name.split('.').at(-1).toLowerCase();
      const language = languages[extension] ?? extension;
      code.textContent = text || '此文件为空';
      if (node.size > limit) toast('已预览前 2 MB，可下载查看完整文件', 'warning');
      const hljs = await highlighter().catch(() => null);
      if (hljs?.getLanguage(language) && text.length <= 500_000 && !ended) {
        code.className = `language-${language}`;
        hljs.highlightElement(code);
      }
    })().catch((error) => failed(error.message));
  } else {
    canvas.append(el('div', { class: 'preview-message' }, ico('file-earmark-arrow-down'), '此格式仅支持下载'));
  }
}
