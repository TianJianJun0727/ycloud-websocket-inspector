import { buildFrameRecord } from './frame-utils.js';
import {
  clearStoredConnection,
  clearStoredFrames,
  FRAME_STORE_LIMITS,
  loadStoredCapture,
  persistConnections,
  persistFrameBatch,
  resetStoredCapture,
} from './frame-store.js';

const PORT_NAME = 'shared-worker-ws-inspector';
const { maxFrameCount: MAX_FRAME_COUNT } = FRAME_STORE_LIMITS;
const { maxFramesPerConnection: MAX_FRAMES_PER_CONNECTION } = FRAME_STORE_LIMITS;
const { maxTotalBytes: MAX_TOTAL_BYTES } = FRAME_STORE_LIMITS;
const FRAME_BATCH_SIZE = 64;
const FRAME_BATCH_INTERVAL_MS = 70;
const TARGET_SCAN_INTERVAL_MS = 1000;
const DETACH_GRACE_MS = 5000;
const TRANSIENT_DIAGNOSTIC_TTL_MS = 10000;

const uiPorts = new Set();
const attachedTargets = new Map();
const socketMaps = new Map();
const blockedTargetIds = new Set();
const pausedConnections = new Set();
const frameBuckets = new Map();
const frameOrder = [];
const retainedFrameIds = new Set();
const connectionRecords = new Map();
const diagnostics = [];

let nextFrameId = 1;
let totalFrameCount = 0;
let totalPayloadBytes = 0;
let pauseNewConnections = false;
let scanning = false;
let initialScanning = true;
let scanTimer = null;
let detachTimer = null;
let captureGeneration = 0;
let pendingFrames = [];
let pendingEvictedFrameIds = [];
let frameBatchTimer = null;
let persistenceQueue = Promise.resolve();
let frameOrderHead = 0;

const storeReady = hydrateStoredCapture();

function debuggerTarget(targetId) {
  return { targetId };
}

function pushDiagnostic(level, message, targetId = '', source = 'capture') {
  const timestamp = Date.now();
  diagnostics.unshift({
    id: crypto.randomUUID(),
    level,
    message,
    targetId,
    source,
    timestamp,
    expiresAt: source === 'storage' ? null : timestamp + TRANSIENT_DIAGNOSTIC_TTL_MS,
  });
  diagnostics.splice(50);
}

function removeDiagnostics(predicate) {
  let removed = false;
  for (let index = diagnostics.length - 1; index >= 0; index -= 1) {
    if (!predicate(diagnostics[index])) continue;
    diagnostics.splice(index, 1);
    removed = true;
  }
  return removed;
}

function queuePersistence(operation) {
  persistenceQueue = persistenceQueue.then(operation).catch((error) => {
    pushDiagnostic('error', error?.message || 'IndexedDB 写入失败', '', 'storage');
    broadcast();
  });
  return persistenceQueue;
}

function connectionRecord(targetId, requestId) {
  return connectionRecords.get(targetId + '::' + requestId);
}

function upsertConnectionRecord(targetId, requestId, updates = {}) {
  const target = attachedTargets.get(targetId);
  const socket = socketMaps.get(targetId)?.get(requestId);
  const key = targetId + '::' + requestId;
  const existing = connectionRecords.get(key);
  const current = existing || {
    key,
    targetId,
    requestId,
    targetTitle: target?.title || 'SharedWorker',
    targetUrl: target?.url || '',
    url: socket?.url || '',
    createdAt: socket?.createdAt || Date.now(),
    closedAt: null,
    status: socket?.status || 'connecting',
  };
  const next = {
    ...current,
    targetTitle: target?.title || current.targetTitle || 'SharedWorker',
    targetUrl: target?.url || current.targetUrl || '',
    url: socket?.url || current.url || '',
    createdAt: socket?.createdAt || current.createdAt || Date.now(),
    ...updates,
  };
  connectionRecords.set(key, next);
  const changed = !existing || Object.keys(next).some((name) => next[name] !== current[name]);
  if (changed) queuePersistence(() => persistConnections([next]));
  return next;
}

function serializeConnections() {
  return [...connectionRecords.values()].map((connection) => {
    const socket = socketMaps.get(connection.targetId)?.get(connection.requestId);
    const status = socket?.status || connection.status || 'closed';
    const isClosed = status === 'closed';
    return {
      ...connection,
      url: socket?.url || connection.url || '',
      createdAt: socket?.createdAt || connection.createdAt,
      closedAt: socket?.closedAt || connection.closedAt,
      status,
      capturePaused:
        !isClosed && pausedConnections.has(connection.targetId + '::' + connection.requestId),
      frameCount: frameBuckets.get(connection.key)?.length || 0,
    };
  });
}

function enforceFrameLimits(connectionKey) {
  const evictedFrameIds = [];
  const bucket = frameBuckets.get(connectionKey);
  while (bucket && bucket.length > MAX_FRAMES_PER_CONNECTION) {
    const oldest = bucket[0];
    const removed = removeFrameFromBucket(connectionKey, oldest.id);
    if (removed) evictedFrameIds.push(removed.id);
  }
  while (
    totalFrameCount > MAX_FRAME_COUNT ||
    (Number.isFinite(MAX_TOTAL_BYTES) && totalPayloadBytes > MAX_TOTAL_BYTES && totalFrameCount > 1)
  ) {
    let oldest = null;
    while (frameOrderHead < frameOrder.length && !oldest) {
      const candidate = frameOrder[frameOrderHead++];
      if (retainedFrameIds.has(candidate.id)) oldest = candidate;
    }
    if (!oldest) break;
    const removed = removeFrameFromBucket(oldest.key, oldest.id);
    if (removed) evictedFrameIds.push(removed.id);
  }
  if (frameOrderHead > 10000 && frameOrderHead > frameOrder.length / 2) {
    frameOrder.splice(0, frameOrderHead);
    frameOrderHead = 0;
  }
  return evictedFrameIds;
}

async function hydrateStoredCapture() {
  try {
    const stored = await loadStoredCapture();
    captureGeneration = stored.generation;
    for (const connection of stored.connections) {
      connectionRecords.set(connection.key, {
        ...connection,
        status: 'closed',
        closedAt: connection.closedAt || Date.now(),
      });
    }
    let maximumId = 0;
    const evictedFrameIds = [];
    for (const frame of stored.frames) {
      maximumId = Math.max(maximumId, frame.id);
      const key = frame.connectionKey || frameConnectionKey(frame);
      frame.connectionKey = key;
      const bucket = frameBuckets.get(key) || [];
      if (!frameBuckets.has(key)) frameBuckets.set(key, bucket);
      bucket.push(frame);
      frameOrder.push({ id: frame.id, key });
      retainedFrameIds.add(frame.id);
      totalFrameCount += 1;
      totalPayloadBytes += frame.retainedPayloadBytes ?? frame.payloadBytes ?? 0;
      evictedFrameIds.push(...enforceFrameLimits(key));
    }
    nextFrameId = maximumId + 1;
    if (evictedFrameIds.length > 0) {
      await persistFrameBatch({
        frames: [],
        evictedFrameIds,
        connections: [],
        generation: captureGeneration,
      });
    }
  } catch (error) {
    pushDiagnostic('error', error?.message || 'IndexedDB 初始化失败', '', 'storage');
  }
}

function serializeTargets() {
  return [...attachedTargets.values()].map((target) => ({
    ...target,
    sockets: [...(socketMaps.get(target.id)?.entries() || [])].map(([requestId, socket]) => ({
      requestId,
      ...socket,
      capturePaused: pausedConnections.has(target.id + '::' + requestId),
    })),
  }));
}

function serializeState(includeFrames = false) {
  return {
    type: 'state',
    generation: captureGeneration,
    scanning: initialScanning,
    ...(includeFrames ? { frameBuckets: Object.fromEntries(frameBuckets) } : {}),
    targets: serializeTargets(),
    connections: serializeConnections(),
    diagnostics,
    limits: {
      maxFrameCount: MAX_FRAME_COUNT,
      maxFramesPerConnection: MAX_FRAMES_PER_CONNECTION,
      maxTotalBytes: MAX_TOTAL_BYTES,
    },
  };
}

function broadcast(message = serializeState(false)) {
  for (const port of uiPorts) {
    try {
      port.postMessage(message);
    } catch {
      uiPorts.delete(port);
    }
  }
}

function frameConnectionKey(frame) {
  return frame.targetId + '::' + frame.requestId;
}

function removeFrameFromBucket(key, frameId) {
  const bucket = frameBuckets.get(key);
  if (!bucket) return null;
  const index = bucket.findIndex((frame) => frame.id === frameId);
  if (index < 0) return null;
  const [removed] = bucket.splice(index, 1);
  if (!removed) return null;
  totalFrameCount -= 1;
  totalPayloadBytes -= removed.retainedPayloadBytes ?? removed.payloadBytes ?? 0;
  retainedFrameIds.delete(removed.id);
  if (bucket.length === 0) frameBuckets.delete(key);
  return removed;
}

function clearConnectionFrames(key) {
  const bucket = frameBuckets.get(key);
  if (!bucket) return [];
  const removedIds = bucket.map((frame) => frame.id);
  for (const frame of bucket) {
    totalPayloadBytes -= frame.retainedPayloadBytes ?? frame.payloadBytes ?? 0;
    retainedFrameIds.delete(frame.id);
  }
  totalFrameCount -= bucket.length;
  frameBuckets.delete(key);
  return removedIds;
}

async function resetCaptureSession() {
  if (frameBatchTimer) clearTimeout(frameBatchTimer);
  frameBatchTimer = null;
  pendingFrames = [];
  pendingEvictedFrameIds = [];
  frameBuckets.clear();
  frameOrder.length = 0;
  retainedFrameIds.clear();
  frameOrderHead = 0;
  nextFrameId = 1;
  totalFrameCount = 0;
  totalPayloadBytes = 0;
  connectionRecords.clear();
  diagnostics.length = 0;
  pausedConnections.clear();
  pauseNewConnections = false;
  captureGeneration += 1;

  const resetAt = Date.now();
  const activeRecords = [];
  for (const [targetId, sockets] of socketMaps) {
    const target = attachedTargets.get(targetId);
    for (const [requestId, socket] of sockets) {
      if (socket.status === 'closed') continue;
      socket.createdAt = resetAt;
      socket.closedAt = null;
      const record = {
        key: targetId + '::' + requestId,
        targetId,
        requestId,
        targetTitle: target?.title || 'SharedWorker',
        targetUrl: target?.url || '',
        url: socket.url || '',
        createdAt: resetAt,
        closedAt: null,
        status: socket.status || 'connecting',
      };
      connectionRecords.set(record.key, record);
      activeRecords.push(record);
    }
  }

  await resetStoredCapture(captureGeneration);
  await persistConnections(activeRecords);
}

function flushFrameBatch() {
  if (frameBatchTimer) {
    clearTimeout(frameBatchTimer);
    frameBatchTimer = null;
  }
  if (pendingFrames.length === 0 && pendingEvictedFrameIds.length === 0) return;
  const frames = pendingFrames;
  const evictedFrameIds = pendingEvictedFrameIds;
  const message = {
    type: 'frame-batch',
    frames,
    evictedFrameIds,
    generation: captureGeneration,
    limits: {
      maxFrameCount: MAX_FRAME_COUNT,
      maxFramesPerConnection: MAX_FRAMES_PER_CONNECTION,
      maxTotalBytes: MAX_TOTAL_BYTES,
    },
  };
  pendingFrames = [];
  pendingEvictedFrameIds = [];
  queuePersistence(async () => {
    await persistFrameBatch({
      frames,
      evictedFrameIds,
      connections: [],
      generation: captureGeneration,
    });
    broadcast(message);
  });
}

function queueFrameBroadcast(record, evictedFrameIds) {
  pendingFrames.push(record);
  pendingEvictedFrameIds.push(...evictedFrameIds);
  if (pendingFrames.length >= FRAME_BATCH_SIZE) {
    flushFrameBatch();
  } else if (!frameBatchTimer) {
    frameBatchTimer = setTimeout(flushFrameBatch, FRAME_BATCH_INTERVAL_MS);
  }
}

function appendFrame(record) {
  record.generation = captureGeneration;
  const connectionKey = frameConnectionKey(record);
  record.connectionKey = connectionKey;
  const bucket = frameBuckets.get(connectionKey) || [];
  if (!frameBuckets.has(connectionKey)) frameBuckets.set(connectionKey, bucket);
  bucket.push(record);
  frameOrder.push({ id: record.id, key: connectionKey });
  retainedFrameIds.add(record.id);
  totalFrameCount += 1;
  totalPayloadBytes += record.retainedPayloadBytes ?? record.payloadBytes;

  const evictedFrameIds = enforceFrameLimits(connectionKey);
  queueFrameBroadcast(record, evictedFrameIds);
}

async function safeDetach(targetId) {
  try {
    await chrome.debugger.detach(debuggerTarget(targetId));
  } catch {
    // Target may already be gone.
  }
}

function removeTarget(targetId) {
  const sockets = socketMaps.get(targetId);
  const closedAt = Date.now();
  for (const requestId of sockets?.keys() || []) {
    const record = connectionRecord(targetId, requestId);
    if (record?.status !== 'closed') {
      upsertConnectionRecord(targetId, requestId, { status: 'closed', closedAt });
    }
  }
  attachedTargets.delete(targetId);
  socketMaps.delete(targetId);
  for (const key of pausedConnections) {
    if (key.startsWith(targetId + '::')) pausedConnections.delete(key);
  }
}

async function discoverExistingWebSockets(debuggee) {
  const objectGroup = 'shared-worker-ws-inspector-discovery';
  try {
    const prototypeResult = await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
      expression: 'WebSocket.prototype',
      objectGroup,
    });
    const prototypeObjectId = prototypeResult?.result?.objectId;
    if (!prototypeObjectId) return [];

    const instancesResult = await chrome.debugger.sendCommand(debuggee, 'Runtime.queryObjects', {
      prototypeObjectId,
      objectGroup,
    });
    const instancesObjectId = instancesResult?.objects?.objectId;
    if (!instancesObjectId) return [];

    const valuesResult = await chrome.debugger.sendCommand(debuggee, 'Runtime.callFunctionOn', {
      objectId: instancesObjectId,
      functionDeclaration:
        'function () { return this.map(function (socket) { return { url: socket.url, readyState: socket.readyState, protocol: socket.protocol }; }); }',
      returnByValue: true,
    });
    return Array.isArray(valuesResult?.result?.value) ? valuesResult.result.value : [];
  } catch {
    return [];
  } finally {
    try {
      await chrome.debugger.sendCommand(debuggee, 'Runtime.releaseObjectGroup', {
        objectGroup,
      });
    } catch {
      // The target may have disappeared during discovery.
    }
  }
}

function assignDiscoveredSocketUrl(targetId, requestId) {
  const target = attachedTargets.get(targetId);
  const sockets = socketMaps.get(targetId);
  const socket = sockets?.get(requestId);
  if (!target || !sockets || !socket || socket.url) return;

  const unknownSockets = [...sockets.values()].filter((item) => !item.url);
  const knownUrls = new Set([...sockets.values()].map((item) => item.url).filter(Boolean));
  const candidates = (target.discoveredSockets || []).filter(
    (item) => item.url && item.readyState <= 1 && !knownUrls.has(item.url),
  );
  if (unknownSockets.length === 1 && candidates.length === 1) {
    socket.url = candidates[0].url;
    socket.urlSource = 'runtime';
  }
}

async function inspectCandidate(target) {
  if (
    attachedTargets.has(target.id) ||
    blockedTargetIds.has(target.id) ||
    target.url?.startsWith(chrome.runtime.getURL(''))
  ) {
    return;
  }

  if (target.attached) {
    blockedTargetIds.add(target.id);
    pushDiagnostic('warning', '目标已被其他 DevTools 或调试器占用', target.id);
    return;
  }

  const debuggee = debuggerTarget(target.id);
  try {
    await chrome.debugger.attach(debuggee, '1.3');
    await chrome.debugger.sendCommand(debuggee, 'Runtime.enable');
    const result = await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
      expression:
        "(() => ({ scopeName: self.constructor && self.constructor.name || '', href: self.location && self.location.href || '' }))()",
      returnByValue: true,
    });
    const scope = result?.result?.value;

    if (scope?.scopeName !== 'SharedWorkerGlobalScope') {
      blockedTargetIds.add(target.id);
      await safeDetach(target.id);
      return;
    }

    await chrome.debugger.sendCommand(debuggee, 'Network.enable');
    const targetRecord = {
      id: target.id,
      type: target.type,
      title: target.title || 'SharedWorker',
      url: scope.href || target.url || '',
      attachedAt: Date.now(),
      discoveredSockets: [],
    };
    attachedTargets.set(target.id, targetRecord);
    socketMaps.set(target.id, new Map());
    targetRecord.discoveredSockets = await discoverExistingWebSockets(debuggee);
    removeDiagnostics(
      (diagnostic) =>
        diagnostic.level === 'error' &&
        diagnostic.source === 'capture' &&
        diagnostic.targetId === target.id,
    );
    pushDiagnostic('info', '已连接 SharedWorker 调试目标', target.id);
    broadcast();
  } catch (error) {
    blockedTargetIds.add(target.id);
    await safeDetach(target.id);
    pushDiagnostic('error', error?.message || '连接 SharedWorker 失败', target.id);
    broadcast();
  }
}

function withTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('扫描 SharedWorker 超时')), timeoutMs),
    ),
  ]);
}

async function scanTargets() {
  if (scanning || uiPorts.size === 0) return;
  scanning = true;
  broadcast();
  try {
    const targets = await chrome.debugger.getTargets();
    removeDiagnostics(
      (diagnostic) =>
        diagnostic.level === 'error' &&
        diagnostic.source === 'capture' &&
        diagnostic.targetId === '',
    );
    const liveIds = new Set(targets.map((target) => target.id));
    for (const targetId of [...blockedTargetIds]) {
      if (!liveIds.has(targetId)) blockedTargetIds.delete(targetId);
    }
    for (const targetId of [...attachedTargets.keys()]) {
      if (!liveIds.has(targetId)) removeTarget(targetId);
    }

    const candidates = targets.filter((target) =>
      ['worker', 'shared_worker', 'other'].includes(target.type),
    );
    const results = await Promise.allSettled(
      candidates.map((target) => withTimeout(inspectCandidate(target), 3000)),
    );
    if (results.some((result) => result.status === 'rejected')) {
      pushDiagnostic('warning', '部分 SharedWorker 目标扫描超时');
    }
  } catch (error) {
    pushDiagnostic('error', error?.message || '扫描调试目标失败');
  } finally {
    scanning = false;
    initialScanning = false;
    broadcast();
  }
}

function startScanning() {
  if (detachTimer) {
    clearTimeout(detachTimer);
    detachTimer = null;
  }
  if (!scanTimer) {
    initialScanning = true;
    scanTimer = setInterval(scanTargets, TARGET_SCAN_INTERVAL_MS);
  }
  scanTargets();
}

function scheduleDetach() {
  if (uiPorts.size > 0 || detachTimer) return;
  detachTimer = setTimeout(async () => {
    detachTimer = null;
    if (uiPorts.size > 0) return;
    clearInterval(scanTimer);
    scanTimer = null;
    flushFrameBatch();
    await persistenceQueue;
    await Promise.all([...attachedTargets.keys()].map(safeDetach));
    for (const targetId of [...attachedTargets.keys()]) removeTarget(targetId);
    await persistenceQueue;
    pausedConnections.clear();
    pauseNewConnections = false;
  }, DETACH_GRACE_MS);
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const targetId = source.targetId;
  const target = attachedTargets.get(targetId);
  if (!target) return;
  const sockets = socketMaps.get(targetId);

  if (method === 'Network.webSocketCreated') {
    sockets?.set(params.requestId, {
      url: params.url || '',
      createdAt: Date.now(),
      closedAt: null,
      status: 'connecting',
    });
    if (pauseNewConnections) pausedConnections.add(targetId + '::' + params.requestId);
    upsertConnectionRecord(targetId, params.requestId, {
      url: params.url || '',
      createdAt: Date.now(),
      closedAt: null,
      status: 'connecting',
    });
    broadcast();
    return;
  }

  if (method === 'Network.webSocketHandshakeResponseReceived') {
    const socket = sockets?.get(params.requestId);
    if (socket) socket.status = 'open';
    upsertConnectionRecord(targetId, params.requestId, { status: 'open', closedAt: null });
    broadcast();
    return;
  }

  if (method === 'Network.webSocketClosed') {
    const socket = sockets?.get(params.requestId);
    if (socket) {
      socket.closedAt = Date.now();
      socket.status = 'closed';
    }
    pausedConnections.delete(targetId + '::' + params.requestId);
    upsertConnectionRecord(targetId, params.requestId, {
      status: 'closed',
      closedAt: socket?.closedAt || Date.now(),
    });
    broadcast();
    return;
  }

  if (method === 'Network.webSocketFrameError') {
    pushDiagnostic('error', params.errorMessage || 'WebSocket frame error', targetId, 'websocket');
    broadcast();
    return;
  }

  if (!['Network.webSocketFrameReceived', 'Network.webSocketFrameSent'].includes(method)) {
    return;
  }

  const direction = method === 'Network.webSocketFrameReceived' ? 'received' : 'sent';
  removeDiagnostics(
    (diagnostic) =>
      diagnostic.level === 'error' &&
      diagnostic.source === 'websocket' &&
      diagnostic.targetId === targetId,
  );
  let socket = sockets?.get(params.requestId);
  if (!socket && sockets) {
    socket = {
      url: '',
      createdAt: null,
      closedAt: null,
      status: 'open',
    };
    sockets.set(params.requestId, socket);
    if (pauseNewConnections) pausedConnections.add(targetId + '::' + params.requestId);
    assignDiscoveredSocketUrl(targetId, params.requestId);
    upsertConnectionRecord(targetId, params.requestId, {
      createdAt: Date.now(),
      closedAt: null,
      status: 'open',
    });
  }
  if (socket) {
    socket.status = 'open';
    upsertConnectionRecord(targetId, params.requestId, { status: 'open', closedAt: null });
  }
  const connectionKey = targetId + '::' + params.requestId;
  if (pausedConnections.has(connectionKey)) return;
  appendFrame(
    buildFrameRecord({
      id: nextFrameId++,
      direction,
      params,
      socketUrl: socket?.url,
      targetId,
      targetUrl: target.url,
    }),
  );
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (!attachedTargets.has(source.targetId)) return;
  removeTarget(source.targetId);
  pushDiagnostic('warning', '调试目标已断开: ' + reason, source.targetId);
  broadcast();
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  if (detachTimer) {
    clearTimeout(detachTimer);
    detachTimer = null;
  }
  let disconnected = false;
  void (async () => {
    await storeReady;
    flushFrameBatch();
    await persistenceQueue;
    try {
      await resetCaptureSession();
    } catch (error) {
      pushDiagnostic('error', error?.message || 'IndexedDB 重置失败', '', 'storage');
    }
    if (disconnected) return;
    uiPorts.add(port);
    startScanning();
    port.postMessage(serializeState());
  })();

  port.onMessage.addListener((message) => {
    if (message?.type === 'clear') {
      if (frameBatchTimer) clearTimeout(frameBatchTimer);
      frameBatchTimer = null;
      pendingFrames = [];
      pendingEvictedFrameIds = [];
      frameBuckets.clear();
      frameOrder.length = 0;
      retainedFrameIds.clear();
      frameOrderHead = 0;
      totalFrameCount = 0;
      totalPayloadBytes = 0;
      captureGeneration += 1;
      queuePersistence(async () => {
        await clearStoredFrames(captureGeneration);
        broadcast({ type: 'cleared', generation: captureGeneration });
      });
    } else if (message?.type === 'clear-connection') {
      flushFrameBatch();
      const key = message.targetId + '::' + message.requestId;
      const evictedFrameIds = clearConnectionFrames(key);
      queuePersistence(async () => {
        await clearStoredConnection(key, captureGeneration);
        broadcast({
          type: 'connection-cleared',
          connectionKey: key,
          evictedFrameIds,
          generation: captureGeneration,
        });
      });
    } else if (message?.type === 'set-connection-paused') {
      flushFrameBatch();
      const key = message.targetId + '::' + message.requestId;
      const connection = connectionRecords.get(key);
      if (connection?.status === 'closed') return;
      if (message.paused) pausedConnections.add(key);
      else pausedConnections.delete(key);
      broadcast();
    } else if (message?.type === 'set-all-connections-paused') {
      flushFrameBatch();
      pauseNewConnections = Boolean(message.paused);
      pausedConnections.clear();
      if (pauseNewConnections) {
        for (const [targetId, sockets] of socketMaps) {
          for (const [requestId, socket] of sockets) {
            if (socket.status === 'closed') continue;
            pausedConnections.add(targetId + '::' + requestId);
          }
        }
      }
      broadcast();
    } else if (message?.type === 'rescan') {
      blockedTargetIds.clear();
      scanTargets();
    }
  });

  port.onDisconnect.addListener(() => {
    disconnected = true;
    uiPorts.delete(port);
    scheduleDetach();
  });
});

chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('inspector.html');
  const existingTabs = await chrome.tabs.query({ url });
  if (existingTabs[0]?.id) {
    await chrome.tabs.update(existingTabs[0].id, { active: true });
    if (existingTabs[0].windowId) {
      await chrome.windows.update(existingTabs[0].windowId, { focused: true });
    }
    return;
  }
  await chrome.tabs.create({ url });
});
