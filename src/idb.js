// Minimal IndexedDB key/value store (directory handle, archive indexes, settings).
const DB = 'kabus22-web', STORE = 'kv';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
  });
}

export const idbGet = key => tx('readonly', s => s.get(key)).catch(() => undefined);
export const idbSet = (key, value) => tx('readwrite', s => s.put(value, key)).catch(() => undefined);
export const idbDel = key => tx('readwrite', s => s.delete(key)).catch(() => undefined);
