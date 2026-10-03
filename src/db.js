// 完了した対戦の履歴を、端末のIndexedDBにローカル保存する。
// アキネーターバトルのsrc/db.jsと同じ仕組み。

const DB_NAME = 'umigame-soup-db';
const DB_VERSION = 1;
const GAMES_STORE = 'games';

let dbPromise;

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Transaction aborted'));
  });
}

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(GAMES_STORE)) {
        const games = db.createObjectStore(GAMES_STORE, { keyPath: 'id' });
        games.createIndex('endedAt', 'endedAt');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

export async function listGames() {
  const db = await openDb();
  const tx = db.transaction(GAMES_STORE, 'readonly');
  const rows = await requestToPromise(tx.objectStore(GAMES_STORE).getAll());
  return rows.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
}

export async function putGame(game) {
  const db = await openDb();
  const tx = db.transaction(GAMES_STORE, 'readwrite');
  tx.objectStore(GAMES_STORE).put(game);
  await transactionDone(tx);
}

export async function deleteGame(id) {
  const db = await openDb();
  const tx = db.transaction(GAMES_STORE, 'readwrite');
  tx.objectStore(GAMES_STORE).delete(id);
  await transactionDone(tx);
}
