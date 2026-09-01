import { buildFrameRecord } from './frame-utils.js';

const PORT_NAME = 'shared-worker-ws-inspector';
const MAX_FRAME_COUNT = 20000;
const MAX_FRAMES_PER_CONNECTION = 5000;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const FRAME_BATCH_SIZE = 64;
const FRAME_BATCH_INTERVAL_MS = 70;
const TARGET_SCAN_INTERVAL_MS = 1000;
const DETACH_GRACE_MS = 5000;

const uiPorts = new Set();
const attachedTargets = new Map();
const socketMaps = new Map();
const blockedTargetIds = new Set();
const pausedConnections = new Set();
const frameBuckets = new Map();
const frameOrder = [];
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

function debuggerTarget(targetId) {
  return { targetId };
}

function pushDiagnostic(level, message, targetId = '') {
  diagnostics.unshift({
    id: crypto.randomUUID(),
    level,
    message,
    targetId,
    timestamp: Date.now(),
  });
  diagnostics.splice(50);
}

function serializeTargets() {
  return [...attachedTargets.values()].map((target) => ({
    ...target,
    sockets: [...(socketMaps.get(target.id)?.entries() || [])].map(([requestId, socket]) => {
      const isIdle = Date.now() - (socket.lastMessageAt || 0) > 1500;
      return {
        requestId,
        ...socket,
        capturePaused: pausedConnections.has(target.id + '::' + requestId),
        messagesPerSecond: isIdle ? 0 : socket.messagesPerSecond || socket.rateCount || 0,
      };
    }),
  }));
}

function serializeState(includeFrames = true) {
  return {
    type: 'state',
    generation: captureGeneration,
    scanning: initialScanning,
    ...(includeFrames ? { frameBuckets: Object.fromEntries(frameBuckets) } : {}),
    targets: serializeTargets(),
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
  if (bucket.length === 0) frameBuckets.delete(key);
  return removed;
}

function removeFrameOrderEntry(key, frameId) {
  const index = frameOrder.findIndex((entry) => entry.key === key && entry.id === frameId);
  if (index >= 0) frameOrder.splice(index, 1);
}

function clearConnectionFrames(key) {
  const bucket = frameBuckets.get(key);
  if (!bucket) return [];
  const removedIds = bucket.map((frame) => frame.id);
  for (const frame of bucket) {
    totalPayloadBytes -= frame.retainedPayloadBytes ?? frame.payloadBytes ?? 0;
  }
  totalFrameCount -= bucket.length;
  frameBuckets.delete(key);
  for (let index = frameOrder.length - 1; index >= 0; index -= 1) {
    if (frameOrder[index].key === key) frameOrder.splice(index, 1);
  }
  return removedIds;
}

function flushFrameBatch() {
  if (frameBatchTimer) {
    clearTimeout(frameBatchTimer);
    frameBatchTimer = null;
  }
  if (pendingFrames.length === 0 && pendingEvictedFrameIds.length === 0) return;
  const message = {
    type: 'frame-batch',
    frames: pendingFrames,
    evictedFrameIds: pendingEvictedFrameIds,
    generation: captureGeneration,
    limits: {
      maxFrameCount: MAX_FRAME_COUNT,
      maxFramesPerConnection: MAX_FRAMES_PER_CONNECTION,
      maxTotalBytes: MAX_TOTAL_BYTES,
    },
  };
  pendingFrames = [];
  pendingEvictedFrameIds = [];
  broadcast(message);
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
  const bucket = frameBuckets.get(connectionKey) || [];
  if (!frameBuckets.has(connectionKey)) frameBuckets.set(connectionKey, bucket);
  bucket.push(record);
  frameOrder.push({ id: record.id, key: connectionKey });
  totalFrameCount += 1;
  totalPayloadBytes += record.retainedPayloadBytes ?? record.payloadBytes;

  const evictedFrameIds = [];
  while (bucket.length > MAX_FRAMES_PER_CONNECTION) {
    const oldest = bucket[0];
    const removed = removeFrameFromBucket(connectionKey, oldest.id);
    removeFrameOrderEntry(connectionKey, oldest.id);
    if (removed) evictedFrameIds.push(removed.id);
  }

  while (
    totalFrameCount > MAX_FRAME_COUNT ||
    (totalPayloadBytes > MAX_TOTAL_BYTES && totalFrameCount > 1)
  ) {
    const oldest = frameOrder.shift();
    if (!oldest) break;
    const removed = removeFrameFromBucket(oldest.key, oldest.id);
    if (removed) evictedFrameIds.push(removed.id);
  }
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
    pushDiagnostic('info', '已连接 SharedWorker 调试目标', target.id);
    broadcast();
  } catch (error) {
    blockedTargetIds.add(target.id);
    await safeDetach(target.id);
    pushDiagnostic('error', error?.message || '连接 SharedWorker 失败', target.id);
    broadcast();
  }
}

async function scanTargets() {
  if (scanning || uiPorts.size === 0) return;
  scanning = true;
  broadcast();
  try {
    const targets = await chrome.debugger.getTargets();
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
    await Promise.all(candidates.map(inspectCandidate));
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
    await Promise.all([...attachedTargets.keys()].map(safeDetach));
    attachedTargets.clear();
    socketMaps.clear();
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
      lastMessageAt: null,
      messagesPerSecond: 0,
      rateCount: 0,
      rateWindowStartedAt: Date.now(),
    });
    if (pauseNewConnections) pausedConnections.add(targetId + '::' + params.requestId);
    broadcast();
    return;
  }

  if (method === 'Network.webSocketHandshakeResponseReceived') {
    const socket = sockets?.get(params.requestId);
    if (socket) socket.status = 'open';
    broadcast();
    return;
  }

  if (method === 'Network.webSocketClosed') {
    const socket = sockets?.get(params.requestId);
    if (socket) {
      socket.closedAt = Date.now();
      socket.status = 'closed';
      socket.messagesPerSecond = 0;
      socket.rateCount = 0;
    }
    broadcast();
    return;
  }

  if (method === 'Network.webSocketFrameError') {
    pushDiagnostic('error', params.errorMessage || 'WebSocket frame error', targetId);
    broadcast();
    return;
  }

  if (!['Network.webSocketFrameReceived', 'Network.webSocketFrameSent'].includes(method)) {
    return;
  }

  const direction = method === 'Network.webSocketFrameReceived' ? 'received' : 'sent';
  let socket = sockets?.get(params.requestId);
  if (!socket && sockets) {
    socket = {
      url: '',
      createdAt: null,
      closedAt: null,
      status: 'open',
      lastMessageAt: null,
      messagesPerSecond: 0,
      rateCount: 0,
      rateWindowStartedAt: Date.now(),
    };
    sockets.set(params.requestId, socket);
    if (pauseNewConnections) pausedConnections.add(targetId + '::' + params.requestId);
    assignDiscoveredSocketUrl(targetId, params.requestId);
  }
  if (socket) {
    const now = Date.now();
    const windowDuration = now - socket.rateWindowStartedAt;
    if (windowDuration >= 1000) {
      socket.messagesPerSecond = Math.round((socket.rateCount * 1000) / windowDuration);
      socket.rateCount = 1;
      socket.rateWindowStartedAt = now;
    } else {
      socket.rateCount += 1;
    }
    socket.lastMessageAt = now;
    socket.status = 'open';
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
  flushFrameBatch();
  uiPorts.add(port);
  startScanning();
  port.postMessage(serializeState());

  port.onMessage.addListener((message) => {
    if (message?.type === 'clear') {
      if (frameBatchTimer) clearTimeout(frameBatchTimer);
      frameBatchTimer = null;
      pendingFrames = [];
      pendingEvictedFrameIds = [];
      frameBuckets.clear();
      frameOrder.length = 0;
      totalFrameCount = 0;
      totalPayloadBytes = 0;
      captureGeneration += 1;
      broadcast({ type: 'cleared', generation: captureGeneration });
    } else if (message?.type === 'clear-connection') {
      flushFrameBatch();
      const key = message.targetId + '::' + message.requestId;
      const evictedFrameIds = clearConnectionFrames(key);
      broadcast({
        type: 'connection-cleared',
        connectionKey: key,
        evictedFrameIds,
        generation: captureGeneration,
      });
    } else if (message?.type === 'set-connection-paused') {
      flushFrameBatch();
      const key = message.targetId + '::' + message.requestId;
      if (message.paused) pausedConnections.add(key);
      else pausedConnections.delete(key);
      broadcast();
    } else if (message?.type === 'set-all-connections-paused') {
      flushFrameBatch();
      pauseNewConnections = Boolean(message.paused);
      pausedConnections.clear();
      if (pauseNewConnections) {
        for (const [targetId, sockets] of socketMaps) {
          for (const requestId of sockets.keys()) {
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
