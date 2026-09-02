export const FRAME_STORE_LIMITS = {
  maxFrameCount: 10000000,
  maxFramesPerConnection: 1000000,
  maxTotalBytes: null,
};

const DATABASE_NAME = 'ycloud-websocket-inspector';
const DATABASE_VERSION = 1;
const FRAME_STORE = 'frames';
const CONNECTION_STORE = 'connections';
const META_STORE = 'meta';

let databasePromise;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error || new Error('IndexedDB transaction aborted'));
    transaction.onerror = () =>
      reject(transaction.error || new Error('IndexedDB transaction failed'));
  });
}

function openFrameDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(FRAME_STORE)) {
        const frames = database.createObjectStore(FRAME_STORE, { keyPath: 'id' });
        frames.createIndex('connectionKey', 'connectionKey', { unique: false });
      }
      if (!database.objectStoreNames.contains(CONNECTION_STORE)) {
        database.createObjectStore(CONNECTION_STORE, { keyPath: 'key' });
      }
      if (!database.objectStoreNames.contains(META_STORE)) {
        database.createObjectStore(META_STORE, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Unable to open IndexedDB'));
  });
  return databasePromise;
}

export async function loadStoredCapture() {
  const database = await openFrameDatabase();
  const transaction = database.transaction([FRAME_STORE, CONNECTION_STORE, META_STORE], 'readonly');
  const framesRequest = transaction.objectStore(FRAME_STORE).getAll();
  const connectionsRequest = transaction.objectStore(CONNECTION_STORE).getAll();
  const generationRequest = transaction.objectStore(META_STORE).get('generation');
  const [frames, connections, generationRecord] = await Promise.all([
    requestResult(framesRequest),
    requestResult(connectionsRequest),
    requestResult(generationRequest),
    transactionDone(transaction),
  ]);
  return {
    frames: frames.sort((left, right) => left.id - right.id),
    connections,
    generation: Number(generationRecord?.value) || 0,
  };
}

export async function persistFrameBatch({ frames, evictedFrameIds, connections, generation }) {
  if (
    frames.length === 0 &&
    evictedFrameIds.length === 0 &&
    connections.length === 0 &&
    !Number.isFinite(generation)
  ) {
    return;
  }
  const database = await openFrameDatabase();
  const transaction = database.transaction(
    [FRAME_STORE, CONNECTION_STORE, META_STORE],
    'readwrite',
  );
  const frameStore = transaction.objectStore(FRAME_STORE);
  for (const frame of frames) frameStore.put(frame);
  for (const frameId of new Set(evictedFrameIds)) frameStore.delete(frameId);
  const connectionStore = transaction.objectStore(CONNECTION_STORE);
  for (const connection of connections) connectionStore.put(connection);
  if (Number.isFinite(generation)) {
    transaction.objectStore(META_STORE).put({ key: 'generation', value: generation });
  }
  await transactionDone(transaction);
}

export async function persistConnections(connections) {
  if (connections.length === 0) return;
  const database = await openFrameDatabase();
  const transaction = database.transaction(CONNECTION_STORE, 'readwrite');
  const store = transaction.objectStore(CONNECTION_STORE);
  for (const connection of connections) store.put(connection);
  await transactionDone(transaction);
}

export async function clearStoredConnection(connectionKey, generation) {
  const database = await openFrameDatabase();
  const transaction = database.transaction([FRAME_STORE, META_STORE], 'readwrite');
  const completed = transactionDone(transaction);
  const frameStore = transaction.objectStore(FRAME_STORE);
  const index = frameStore.index('connectionKey');
  await new Promise((resolve, reject) => {
    const request = index.openKeyCursor(IDBKeyRange.only(connectionKey));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      frameStore.delete(cursor.primaryKey);
      cursor.continue();
    };
    request.onerror = () => reject(request.error || new Error('Unable to clear connection'));
  });
  transaction.objectStore(META_STORE).put({ key: 'generation', value: generation });
  await completed;
}

export async function clearStoredFrames(generation) {
  const database = await openFrameDatabase();
  const transaction = database.transaction([FRAME_STORE, META_STORE], 'readwrite');
  transaction.objectStore(FRAME_STORE).clear();
  transaction.objectStore(META_STORE).put({ key: 'generation', value: generation });
  await transactionDone(transaction);
}

export async function resetStoredCapture(generation) {
  const database = await openFrameDatabase();
  const transaction = database.transaction(
    [FRAME_STORE, CONNECTION_STORE, META_STORE],
    'readwrite',
  );
  transaction.objectStore(FRAME_STORE).clear();
  transaction.objectStore(CONNECTION_STORE).clear();
  transaction.objectStore(META_STORE).put({ key: 'generation', value: generation });
  await transactionDone(transaction);
}
