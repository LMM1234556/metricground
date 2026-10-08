const DB_NAME = "metricground-workspace";
const STORE_NAME = "sessions";
const ACTIVE_KEY = "active";

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法打开浏览器工作区存储"));
  });
}

async function transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const request = action(tx.objectStore(STORE_NAME));
      let result: T;
      request.onsuccess = () => { result = request.result; };
      request.onerror = () => reject(request.error ?? new Error("浏览器工作区存储操作失败"));
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error ?? new Error("浏览器工作区事务失败"));
      tx.onabort = () => reject(tx.error ?? new Error("浏览器工作区事务已中止"));
    });
  } finally {
    db.close();
  }
}

export function loadWorkspaceSession<T>() {
  return transaction<T | undefined>("readonly", (store) => store.get(ACTIVE_KEY));
}

export function saveWorkspaceSession<T>(snapshot: T) {
  return transaction<IDBValidKey>("readwrite", (store) => store.put(snapshot, ACTIVE_KEY)).then(() => undefined);
}

export function clearWorkspaceSession() {
  return transaction<undefined>("readwrite", (store) => store.delete(ACTIVE_KEY)).then(() => undefined);
}
