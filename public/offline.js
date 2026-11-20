import { request, url } from './ui.js';

let opening;
function database() {
  opening ??= new Promise((resolve, reject) => {
    const start = indexedDB.open('lan-drive-v1', 1);
    start.onupgradeneeded = () => {
      start.result.createObjectStore('pinned');
      start.result.createObjectStore('segments');
    };
    start.onsuccess = () => resolve(start.result);
    start.onerror = () => { opening = null; reject(new Error('浏览器无法使用本地文件存储')); };
  });
  return opening;
}

async function operate(name, mode, action) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(name, mode);
    const operation = action(transaction.objectStore(name));
    transaction.oncomplete = () => resolve(operation?.result);
    transaction.onabort = () => reject(new Error(transaction.error?.name === 'QuotaExceededError' ? '浏览器本地存储空间不足' : '本地文件存储失败'));
  });
}

const pinRange = (owner) => IDBKeyRange.bound([owner, 0], [owner, Number.MAX_SAFE_INTEGER]);
const partRange = (owner, task) => IDBKeyRange.bound([owner, task, 0], [owner, task, Number.MAX_SAFE_INTEGER]);

export const pinned = (owner) => operate('pinned', 'readonly', (store) => store.getAll(pinRange(owner)));
export const unpin = (owner, fileId) => operate('pinned', 'readwrite', (store) => store.delete([owner, fileId]));
export const clearPins = (owner) => operate('pinned', 'readwrite', (store) => store.delete(pinRange(owner)));
export const parts = (owner, task) => operate('segments', 'readonly', (store) => store.getAll(partRange(owner, task)));
export const addPart = (owner, task, offset, blob) => operate('segments', 'readwrite', (store) => store.put(blob, [owner, task, offset]));
export const clearParts = (owner, task) => operate('segments', 'readwrite', (store) => store.delete(partRange(owner, task)));

export async function pin(owner, node) {
  const response = await request(node.preview ? '/fs/preview' : '/fs/download', { query: { fileId: node.id }, raw: true });
  const blob = await response.blob();
  await operate('pinned', 'readwrite', (store) => store.put({ ...node, blob, cachedAt: Date.now() }, [owner, node.id]));
}

export const locallyCachedUser = () => {
  try { return JSON.parse(localStorage.getItem('lan-drive-last-user')); } catch { return null; }
};
export const cacheIdentity = (user) => {
  try {
    if (user) localStorage.setItem('lan-drive-last-user', JSON.stringify({ id: user.id, name: user.name, username: user.username, preference: user.preference }));
    else localStorage.removeItem('lan-drive-last-user');
  } catch {}
};

export function setupOffline() {
  if (navigator.serviceWorker) navigator.serviceWorker.register('/sw.js').catch(() => {});
}

export function localSource(node) {
  return node.blob ? URL.createObjectURL(node.blob) : url('/fs/preview', { fileId: node.id });
}
