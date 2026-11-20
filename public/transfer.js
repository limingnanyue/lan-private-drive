import { addPart, clearParts, parts } from './offline.js';
import { conflict, report, request, saveBlob, toast } from './ui.js';

const completed = new Set(['success', 'cancelled']);
const canRun = new Set(['waiting', 'transferring']);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function transferQueue(onChange, onFileUploaded) {
  const key = 'lan-drive-device';
  const fresh = () => [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  let device = fresh();
  try { device = localStorage.getItem(key) || device; localStorage.setItem(key, device); } catch {}
  const tasks = new Map();
  const sources = new Map();
  const running = new Map();
  const blocked = new Set();
  const interrupted = new Set();
  const samples = new Map();
  let user;
  let socket;
  let reconnect;
  let flushing = false;
  let generation = 0;

  function changed() {
    onChange();
    queueMicrotask(pump);
  }

  function write(task, notify = true) {
    if (!task?.id || !user) return;
    const previous = tasks.get(task.id);
    if (previous?.updatedAt > task.updatedAt) return;
    if (previous && task.done > previous.done) {
      const now = performance.now();
      const sample = samples.get(task.id);
      const speed = (task.done - previous.done) * 1000 / Math.max(250, now - (sample?.time ?? now - 1000));
      samples.set(task.id, { time: now, speed: sample?.speed ? (sample.speed * 0.35 + speed * 0.65) : speed });
    }
    tasks.set(task.id, task);
    if (notify) changed();
  }

  async function refresh(passive = false) {
    if (!user) return;
    const tick = generation;
    const { list } = await request('/task/list', { query: { active: 1, passive: passive ? 1 : null } });
    if (tick !== generation) return;
    for (const task of list) write(task, false);
    changed();
  }

  function wire() {
    if (!user || socket) return;
    const current = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/task?active=1`);
    socket = current;
    current.onmessage = (event) => {
      if (socket !== current) return;
      const payload = JSON.parse(event.data);
      if (payload.type === 'snapshot') {
        const ids = new Set(payload.list.map((task) => task.id));
        for (const id of tasks.keys()) if (!ids.has(id) && !interrupted.has(id)) tasks.delete(id);
        for (const task of payload.list) write(task, false);
        changed();
      } else if (payload.type === 'task') write(payload.task);
    };
    current.onopen = () => restoreNetwork();
    current.onclose = (event) => {
      if (socket !== current) return;
      socket = null;
      if (event.code === 4401) window.dispatchEvent(new Event('drive:expired'));
      else if (user) reconnect = setTimeout(() => {
        refresh(true).then(restoreNetwork).catch(() => {});
        wire();
      }, 2500);
    };
  }

  async function restoreNetwork() {
    if (flushing || !user || !navigator.onLine) return;
    flushing = true;
    try {
      for (const id of [...interrupted]) {
        const task = tasks.get(id);
        if (!task || completed.has(task.status)) { interrupted.delete(id); continue; }
        await change(id, 'resume');
        interrupted.delete(id);
      }
    } catch {} finally { flushing = false; pump(); }
  }

  window.addEventListener('offline', () => {
    for (const [id, operation] of running) {
      interrupted.add(id);
      operation.abort();
      const task = tasks.get(id);
      if (task) write({ ...task, status: 'paused', reason: '局域网连接中断，等待恢复' });
    }
  });
  window.addEventListener('online', () => { if (user) { wire(); restoreNetwork(); } });

  function start(account) {
    stop();
    user = account;
    wire();
    refresh(true).catch(() => {});
  }
  function stop() {
    generation++;
    user = null;
    clearTimeout(reconnect);
    const oldSocket = socket;
    socket = null;
    if (oldSocket?.readyState === WebSocket.CONNECTING) oldSocket.onopen = () => oldSocket.close();
    else oldSocket?.close();
    for (const operation of running.values()) operation.abort();
    for (const collection of [tasks, sources, running, blocked, interrupted, samples]) collection.clear();
  }

  async function enqueueUploads(entries, parentId) {
    for (const { file, parents } of entries) {
      const body = { name: file.name, total: file.size, parentId, parents, device, clientKey: JSON.stringify([file.name, file.size, file.lastModified, parents]) };
      try {
        let task;
        try { task = await request('/task/upload/start', { method: 'POST', body }); }
        catch (error) {
          if (error.code !== 40901 || !error.details?.name) throw error;
          body.conflict = await conflict(file.name, error.details.canOverwrite);
          if (!body.conflict) continue;
          task = await request('/task/upload/start', { method: 'POST', body });
        }
        if (task.skipped) continue;
        sources.set(task.id, file);
        write(task);
        if (!canRun.has(task.status)) await change(task.id, 'resume');
      } catch (error) { report(error); if ([40303, 50001, 50701, 50702].includes(error.code) || error.status === 401) break; }
    }
  }

  async function enqueueDownload(selection) {
    const task = await request('/task/download/start', { method: 'POST', body: { fileId: selection.map(({ id }) => id), device } });
    write(task);
    toast('下载已加入传输队列');
  }

  function sendPart(task, file, offset, signal) {
    const form = new FormData();
    form.set('taskId', task.id);
    form.set('offset', offset);
    form.set('file', file.slice(offset, offset + task.chunkSize), 'chunk.dat');
    return request('/fs/upload', { method: 'POST', body: form, signal });
  }

  async function upload(task, signal) {
    const file = sources.get(task.id);
    let current = task;
    while (current.done < current.total) {
      current = await sendPart(current, file, current.done, signal);
      write(current);
    }
    const body = { fileKey: current.id };
    let result;
    try { result = await request('/fs/upload/merge', { method: 'POST', body, signal }); }
    catch (error) {
      if (error.code !== 40901) throw error;
      body.conflict = await conflict(current.name, error.details?.canOverwrite);
      if (!body.conflict || signal.aborted) return;
      result = await request('/fs/upload/merge', { method: 'POST', body, signal });
    }
    sources.delete(task.id);
    write(result.task);
    if (result.file) {
      if (user?.preference?.notifications) toast(`上传完成 · ${result.file.name}`);
      onFileUploaded(task.parentId);
    }
  }

  async function download(task, signal) {
    const account = user.id;
    const blobs = await parts(account, task.id);
    let offset = blobs.reduce((sum, blob) => sum + blob.size, 0);
    async function acknowledge(done) {
      let latest;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { latest = await request('/task/progress', { method: 'PUT', body: { taskId: task.id, done }, signal }); break; }
        catch (error) { if (error.code !== 40902 || attempt === 2) throw error; await delay(150); }
      }
      write(latest);
    }
    if (offset > task.total) { await clearParts(account, task.id); blobs.length = 0; offset = 0; }
    if (offset > task.done) await acknowledge(offset);
    while (offset < task.total || (task.total === 0 && !blobs.length)) {
      const end = Math.min(task.total, offset + task.chunkSize) - 1;
      const response = await request('/task/download/data', { raw: true, query: { taskId: task.id }, signal,
        headers: task.total ? { Range: `bytes=${offset}-${end}` } : {} });
      let blob;
      try { blob = await response.blob(); }
      catch (error) { if (error.name === 'AbortError') throw error; throw Object.assign(new Error('下载连接已中断'), { status: 0 }); }
      if (blob.size !== Math.max(0, end - offset + 1)) throw new Error('下载分片大小异常，文件可能已变更');
      await addPart(account, task.id, offset, blob);
      blobs.push(blob);
      offset += blob.size;
      await acknowledge(offset);
    }
    saveBlob(new Blob(blobs, { type: 'application/octet-stream' }), task.name);
    await clearParts(account, task.id);
    if (user?.preference?.notifications) toast(`下载完成 · ${task.name}`);
  }

  function pump() {
    if (!user || !navigator.onLine || flushing) return;
    for (const type of ['upload', 'download']) {
      if ([...running.keys()].some((id) => tasks.get(id)?.type === type)) continue;
      const task = [...tasks.values()].filter((entry) => entry.type === type && entry.device === device && canRun.has(entry.status)
        && !blocked.has(entry.id) && !interrupted.has(entry.id) && (type === 'download' || sources.has(entry.id))).sort((left, right) => left.createdAt - right.createdAt)[0];
      if (!task) continue;
      const operation = new AbortController();
      const tick = generation;
      running.set(task.id, operation);
      const run = type === 'upload' ? upload : download;
      run(task, operation.signal).catch(async (error) => {
        if (tick !== generation || operation.signal.aborted || error.name === 'AbortError' || error.status === 401) return;
        if (error.status === 0 || !navigator.onLine) {
          interrupted.add(task.id);
          write({ ...tasks.get(task.id), status: 'paused', reason: error.message });
          setTimeout(restoreNetwork, 3000);
          return;
        }
        if (error.code === 40902 && tasks.get(task.id)?.status === 'paused') return;
        blocked.add(task.id);
        try { write(await request('/task/fail', { method: 'PUT', body: { taskId: task.id, reason: error.message } })); }
        catch { write({ ...tasks.get(task.id), status: 'failed', reason: error.message }); }
        report(error);
      }).finally(() => { if (tick === generation) { running.delete(task.id); onChange(); pump(); } });
    }
  }

  async function change(id, action) {
    const task = tasks.get(id);
    if (!task || !user) return;
    if (action !== 'resume') { blocked.add(id); running.get(id)?.abort(); interrupted.delete(id); }
    else blocked.delete(id);
    const updated = await request(`/task/${action}`, { method: action === 'cancel' ? 'DELETE' : 'PUT', body: { taskId: id } });
    write(updated);
    if (action === 'cancel') {
      sources.delete(id);
      if (task.type === 'download') await clearParts(user.id, id);
    }
  }

  async function attach(task, file) {
    if (file.size !== task.total) throw new Error('选择的文件大小与原上传文件不同');
    if (task.device !== device) throw new Error('请回到发起任务的设备继续传输');
    blocked.add(task.id);
    try {
      await change(task.id, 'resume');
      if (task.done) {
        const check = new FormData();
        check.set('taskId', task.id);
        check.set('offset', '0');
        check.set('file', file.slice(0, Math.min(task.done, task.chunkSize)), 'chunk.dat');
        await request('/fs/upload', { method: 'POST', body: check });
      }
      sources.set(task.id, file);
    } catch (error) { await change(task.id, 'pause').catch(() => {}); throw error; }
    finally { blocked.delete(task.id); pump(); }
  }

  function list() {
    return [...tasks.values()].filter((task) => !completed.has(task.status)).map((task) => ({ ...task,
      local: task.device === device, attached: sources.has(task.id), speed: task.status === 'transferring' ? samples.get(task.id)?.speed ?? 0 : 0,
    })).sort((left, right) => right.createdAt - left.createdAt);
  }
  return { start, stop, refresh, enqueueUploads, enqueueDownload, change, attach, list };
}
