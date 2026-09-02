import {
    clearStoredConnection,
    clearStoredFrames,
    FRAME_STORE_LIMITS,
    loadStoredCapture,
    persistConnections,
    persistFrameBatch,
    resetStoredCapture,
} from '../lib/frame-store.ts';
import { buildFrameRecord } from '../lib/frame-utils.ts';
import type {
    CaptureDiagnostic,
    CaptureTarget,
    ConnectionRecord,
    DiscoveredSocket,
    FrameRecord,
    InspectorCommand,
    InspectorMessage,
    SimulationAction,
    SocketRecord,
} from '../types/capture';

interface RuntimeRemoteObject {
    description?: string;
    objectId?: string;
    value?: unknown;
}

interface DebuggerCommandResultMap {
    'Runtime.enable': object;
    'Runtime.evaluate': { result?: RuntimeRemoteObject };
    'Runtime.queryObjects': { objects?: RuntimeRemoteObject };
    'Runtime.callFunctionOn': { result?: RuntimeRemoteObject };
    'Runtime.releaseObjectGroup': object;
    'Network.enable': object;
}

interface DebuggerEventParams {
    requestId: string;
    url?: string;
    errorMessage?: string;
    timestamp: number;
    response?: {
        opcode?: number;
        mask?: boolean;
        payloadData?: string;
    };
}

interface WorkerScope {
    scopeName?: string;
    href?: string;
}

interface RuntimeSimulationResult {
    success: boolean;
    message: string;
}

interface PendingSimulationSend {
    operationId: string;
    payload: string;
    expiresAt: number;
}

/** 将数据编码为安全的 JavaScript 字面量，避免 payload 参与表达式结构。 */
const runtimeLiteral = (value: string | number): string => {
    return JSON.stringify(value).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
};
export default defineBackground(() => {
    const PORT_NAME = 'shared-worker-ws-inspector';
    const { maxFrameCount: MAX_FRAME_COUNT } = FRAME_STORE_LIMITS;
    const { maxFramesPerConnection: MAX_FRAMES_PER_CONNECTION } = FRAME_STORE_LIMITS;
    const { maxTotalBytes: MAX_TOTAL_BYTES } = FRAME_STORE_LIMITS;
    const FRAME_BATCH_SIZE = 64;
    const FRAME_BATCH_INTERVAL_MS = 70;
    const TARGET_SCAN_INTERVAL_MS = 1000;
    const DETACH_GRACE_MS = 5000;
    const TRANSIENT_DIAGNOSTIC_TTL_MS = 10000;
    // 以下集合只保存当前监听会话的运行态；业务页面及业务存储不会被修改。
    const uiPorts = new Set<chrome.runtime.Port>();
    const attachedTargets = new Map<string, CaptureTarget>();
    const socketMaps = new Map<string, Map<string, SocketRecord>>();
    const blockedTargetIds = new Set<string>();
    const pausedConnections = new Set<string>();
    const frameBuckets = new Map<string, FrameRecord[]>();
    const frameOrder: Array<{ id: number; key: string }> = [];
    const retainedFrameIds = new Set<number>();
    const connectionRecords = new Map<string, ConnectionRecord>();
    const pendingSimulationSends = new Map<string, PendingSimulationSend[]>();
    const diagnostics: CaptureDiagnostic[] = [];
    // generation 用于丢弃上一个 Inspector 会话迟到的异步消息。
    let nextFrameId = 1;
    let totalFrameCount = 0;
    let totalPayloadBytes = 0;
    let pauseNewConnections = false;
    let scanning = false;
    let initialScanning = true;
    let scanTimer: ReturnType<typeof setInterval> | null = null;
    let detachTimer: ReturnType<typeof setTimeout> | null = null;
    let captureGeneration = 0;
    // 高频帧先在内存聚合，再批量持久化和通知 UI，降低端口通信压力。
    let pendingFrames: FrameRecord[] = [];
    let pendingEvictedFrameIds: number[] = [];
    let frameBatchTimer: ReturnType<typeof setTimeout> | null = null;
    let persistenceQueue: Promise<void> = Promise.resolve();
    let frameOrderHead = 0;
    const debuggerTarget = (targetId: string): chrome.debugger.Debuggee => {
        return { targetId };
    };
    const sendDebuggerCommand = <Method extends keyof DebuggerCommandResultMap>(
        debuggee: chrome.debugger.Debuggee,
        method: Method,
        commandParams?: Record<string, unknown>,
    ): Promise<DebuggerCommandResultMap[Method]> =>
        chrome.debugger
            .sendCommand(debuggee, method, commandParams)
            .then((result) => result as unknown as DebuggerCommandResultMap[Method]);
    const pushDiagnostic = (
        level: CaptureDiagnostic['level'],
        message: string,
        targetId = '',
        source: CaptureDiagnostic['source'] = 'capture',
    ) => {
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
    };
    const removeDiagnostics = (predicate: (diagnostic: CaptureDiagnostic) => boolean): boolean => {
        let removed = false;
        for (let index = diagnostics.length - 1; index >= 0; index -= 1) {
            if (!predicate(diagnostics[index]!)) continue;
            diagnostics.splice(index, 1);
            removed = true;
        }
        return removed;
    };
    // IndexedDB 写入严格串行，避免 clear 与 frame batch 交错覆盖。
    const queuePersistence = (operation: () => Promise<void>): Promise<void> => {
        persistenceQueue = persistenceQueue.then(operation).catch((error) => {
            pushDiagnostic('error', error?.message || 'IndexedDB 写入失败', '', 'storage');
            broadcast();
        });
        return persistenceQueue;
    };
    const connectionRecord = (targetId: string, requestId: string): ConnectionRecord | undefined => {
        return connectionRecords.get(targetId + '::' + requestId);
    };
    const upsertConnectionRecord = (
        targetId: string,
        requestId: string,
        updates: Partial<ConnectionRecord> = {},
    ): ConnectionRecord => {
        const target = attachedTargets.get(targetId);
        const socket = socketMaps.get(targetId)?.get(requestId);
        const key = targetId + '::' + requestId;
        const existing = connectionRecords.get(key);
        const current: ConnectionRecord = existing || {
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
        const next: ConnectionRecord = {
            ...current,
            targetTitle: target?.title || current.targetTitle || 'SharedWorker',
            targetUrl: target?.url || current.targetUrl || '',
            url: socket?.url || current.url || '',
            createdAt: socket?.createdAt || current.createdAt || Date.now(),
            ...updates,
        };
        connectionRecords.set(key, next);
        const changed =
            !existing ||
            (Object.keys(next) as Array<keyof ConnectionRecord>).some((name) => next[name] !== current[name]);
        if (changed) queuePersistence(() => persistConnections([next]));
        return next;
    };
    const serializeConnections = () => {
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
                capturePaused: !isClosed && pausedConnections.has(connection.targetId + '::' + connection.requestId),
                frameCount: frameBuckets.get(connection.key)?.length || 0,
            };
        });
    };
    // 先执行单连接上限，再执行全局上限，避免高流量连接挤占全部容量。
    const enforceFrameLimits = (connectionKey: string): number[] => {
        const evictedFrameIds: number[] = [];
        const bucket = frameBuckets.get(connectionKey);
        while (bucket && bucket.length > MAX_FRAMES_PER_CONNECTION) {
            const oldest = bucket[0];
            if (!oldest) break;
            const removed = removeFrameFromBucket(connectionKey, oldest.id);
            if (removed) evictedFrameIds.push(removed.id);
        }
        while (
            totalFrameCount > MAX_FRAME_COUNT ||
            (MAX_TOTAL_BYTES !== null && totalPayloadBytes > MAX_TOTAL_BYTES && totalFrameCount > 1)
        ) {
            let oldest: { id: number; key: string } | null = null;
            while (frameOrderHead < frameOrder.length && !oldest) {
                const candidate = frameOrder[frameOrderHead++];
                if (!candidate) break;
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
    };
    const hydrateStoredCapture = async () => {
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
            const evictedFrameIds: number[] = [];
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
    };
    // 持久化快照恢复完成前，不开始新的 Inspector 会话。
    const storeReady = hydrateStoredCapture();
    const serializeTargets = () => {
        return [...attachedTargets.values()].map((target) => ({
            ...target,
            sockets: [...(socketMaps.get(target.id)?.entries() || [])].map(([requestId, socket]) => ({
                requestId,
                ...socket,
                capturePaused: pausedConnections.has(target.id + '::' + requestId),
            })),
        }));
    };
    const serializeState = (includeFrames = false): InspectorMessage => {
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
    };
    const broadcast = (message: InspectorMessage = serializeState(false)) => {
        for (const port of uiPorts) {
            try {
                port.postMessage(message);
            } catch {
                uiPorts.delete(port);
            }
        }
    };
    const frameConnectionKey = (frame: FrameRecord): string => {
        return frame.targetId + '::' + frame.requestId;
    };
    const removeFrameFromBucket = (key: string, frameId: number): FrameRecord | null => {
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
    };
    const clearConnectionFrames = (key: string): number[] => {
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
    };
    const resetCaptureSession = async () => {
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
        const activeRecords: ConnectionRecord[] = [];
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
    };
    const flushFrameBatch = () => {
        if (frameBatchTimer) {
            clearTimeout(frameBatchTimer);
            frameBatchTimer = null;
        }
        if (pendingFrames.length === 0 && pendingEvictedFrameIds.length === 0) return;
        const frames = pendingFrames;
        const evictedFrameIds = pendingEvictedFrameIds;
        const message: InspectorMessage = {
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
    };
    const queueFrameBroadcast = (record: FrameRecord, evictedFrameIds: number[]): void => {
        pendingFrames.push(record);
        pendingEvictedFrameIds.push(...evictedFrameIds);
        if (pendingFrames.length >= FRAME_BATCH_SIZE) {
            flushFrameBatch();
        } else if (!frameBatchTimer) {
            frameBatchTimer = setTimeout(flushFrameBatch, FRAME_BATCH_INTERVAL_MS);
        }
    };
    const appendFrame = (record: FrameRecord): void => {
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
    };

    /** 将不会产生 CDP 网络帧的模拟接收和系统事件写入当前连接列表。 */
    const appendSimulationFrame = (
        command: Extract<InspectorCommand, { type: 'simulate' }>,
        targetUrl: string,
    ): void => {
        if (command.action === 'send') return;
        const systemPayload =
            command.action === 'close'
                ? `[模拟系统事件] close (${command.closeCode || 1000}) ${command.closeReason || ''}`.trim()
                : `[模拟系统事件] ${command.action}`;
        const record = buildFrameRecord({
            id: nextFrameId++,
            direction: 'received',
            params: {
                requestId: command.requestId,
                timestamp: Date.now() / 1000,
                response: {
                    opcode: 1,
                    mask: false,
                    payloadData: command.action === 'receive' ? command.payload : systemPayload,
                },
            },
            socketUrl: command.socketUrl,
            targetId: command.targetId,
            targetUrl,
        });
        record.simulation = command.action === 'receive' ? 'receive' : 'system';
        record.eventName = command.action === 'receive' ? '模拟接收' : `模拟 ${command.action}`;
        appendFrame(record);
    };

    /** 登记插件发出的消息，用于标记随后到达的真实 CDP 发送帧。 */
    const registerSimulationSend = (command: Extract<InspectorCommand, { type: 'simulate' }>): void => {
        if (command.action !== 'send') return;
        const key = command.targetId + '::' + command.requestId;
        const now = Date.now();
        const queue = (pendingSimulationSends.get(key) || []).filter((item) => item.expiresAt > now);
        queue.push({ operationId: command.operationId, payload: command.payload, expiresAt: now + 10000 });
        pendingSimulationSends.set(key, queue);
    };

    /** 移除执行失败或已经被 CDP 发送帧消费的模拟发送登记。 */
    const removeSimulationSend = (connectionKey: string, operationId: string): void => {
        const queue = pendingSimulationSends.get(connectionKey);
        if (!queue) return;
        const remaining = queue.filter((item) => item.operationId !== operationId);
        if (remaining.length > 0) pendingSimulationSends.set(connectionKey, remaining);
        else pendingSimulationSends.delete(connectionKey);
    };

    /** 将匹配 payload 的下一条发送帧识别为插件模拟发送。 */
    const consumeSimulationSend = (connectionKey: string, payload: string): boolean => {
        const now = Date.now();
        const queue = (pendingSimulationSends.get(connectionKey) || []).filter((item) => item.expiresAt > now);
        const index = queue.findIndex((item) => item.payload === payload);
        if (index < 0) {
            if (queue.length > 0) pendingSimulationSends.set(connectionKey, queue);
            else pendingSimulationSends.delete(connectionKey);
            return false;
        }
        queue.splice(index, 1);
        if (queue.length > 0) pendingSimulationSends.set(connectionKey, queue);
        else pendingSimulationSends.delete(connectionKey);
        return true;
    };
    const safeDetach = async (targetId: string): Promise<void> => {
        try {
            await chrome.debugger.detach(debuggerTarget(targetId));
        } catch {
            // Target may already be gone.
        }
    };
    const removeTarget = (targetId: string): void => {
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
    };
    // Inspector 晚于 WebSocket 建立时，尝试从 Runtime 对象补全连接 URL。
    const discoverExistingWebSockets = async (debuggee: chrome.debugger.Debuggee): Promise<DiscoveredSocket[]> => {
        const objectGroup = 'shared-worker-ws-inspector-discovery';
        try {
            const prototypeResult = await sendDebuggerCommand(debuggee, 'Runtime.evaluate', {
                expression: 'WebSocket.prototype',
                objectGroup,
            });
            const prototypeObjectId = prototypeResult?.result?.objectId;
            if (!prototypeObjectId) return [];
            const instancesResult = await sendDebuggerCommand(debuggee, 'Runtime.queryObjects', {
                prototypeObjectId,
                objectGroup,
            });
            const instancesObjectId = instancesResult?.objects?.objectId;
            if (!instancesObjectId) return [];
            const valuesResult = await sendDebuggerCommand(debuggee, 'Runtime.callFunctionOn', {
                objectId: instancesObjectId,
                functionDeclaration:
                    'function () { globalThis.__ycloudWebSocketInspectorSockets = this; return this.map(function (socket) { return { url: socket.url, readyState: socket.readyState, protocol: socket.protocol }; }); }',
                returnByValue: true,
            });
            return Array.isArray(valuesResult?.result?.value) ? (valuesResult.result.value as DiscoveredSocket[]) : [];
        } catch {
            return [];
        }
    };

    /** 在目标运行时中定位唯一连接，并执行真实发送或本地事件模拟。 */
    const executeSimulation = async (
        targetId: string,
        requestId: string,
        socketUrl: string,
        action: SimulationAction,
        payload: string,
        closeCode = 1000,
        closeReason = '',
    ): Promise<RuntimeSimulationResult> => {
        const target = attachedTargets.get(targetId);
        const connection = connectionRecord(targetId, requestId);
        if (!target || !connection) return { success: false, message: '连接已不存在，请重新扫描' };
        if (connection.status !== 'open') return { success: false, message: '当前连接未处于连接状态' };
        if (!socketUrl) return { success: false, message: '当前连接缺少 WebSocket 地址，无法安全定位' };
        if (new TextEncoder().encode(payload).byteLength > 1024 * 1024) {
            return { success: false, message: '模拟消息不能超过 1 MB' };
        }
        const debuggee = debuggerTarget(targetId);
        try {
            const executionResult = await sendDebuggerCommand(debuggee, 'Runtime.evaluate', {
                expression: `(() => {
                    const url = ${runtimeLiteral(socketUrl)};
                    const action = ${runtimeLiteral(action)};
                    const payload = ${runtimeLiteral(payload)};
                    const closeCode = ${runtimeLiteral(closeCode)};
                    const closeReason = ${runtimeLiteral(closeReason)};
                    const registry = globalThis.__ycloudWebSocketInspectorSockets;
                    if (!Array.isArray(registry)) return { success: false, message: '连接注册表尚未就绪，请重新扫描' };
                    const sockets = registry.filter((socket) => socket.url === url && socket.readyState === WebSocket.OPEN);
                    if (sockets.length === 0) return { success: false, message: '未找到对应的活动连接' };
                    if (sockets.length > 1) return { success: false, message: '存在多个相同地址的活动连接，已拒绝执行' };
                    const socket = sockets[0];
                    if (action === 'send') socket.send(payload);
                    else setTimeout(function () {
                        if (action === 'receive') socket.dispatchEvent(new MessageEvent('message', {
                            data: payload,
                            origin: new URL(socket.url).origin,
                        }));
                        else if (action === 'close') socket.dispatchEvent(new CloseEvent('close', { code: closeCode, reason: closeReason, wasClean: false }));
                        else socket.dispatchEvent(new Event(action));
                    }, 0);
                    return {
                        success: true,
                        message: action === 'send' ? '消息已通过真实连接发送' : '模拟事件已分发给业务监听器',
                    };
                })()`,
                returnByValue: true,
                timeout: 3000,
                disableBreaks: true,
            });
            const result = executionResult?.result?.value as RuntimeSimulationResult | undefined;
            return (
                result || {
                    success: false,
                    message: executionResult?.result?.description || '目标运行时未返回执行结果',
                }
            );
        } catch (error) {
            return { success: false, message: error instanceof Error ? error.message : '模拟操作执行失败' };
        }
    };
    const assignDiscoveredSocketUrl = (targetId: string, requestId: string): void => {
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
            socket.url = candidates[0]!.url;
            socket.urlSource = 'runtime';
        }
    };
    const inspectCandidate = async (target: chrome.debugger.TargetInfo): Promise<void> => {
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
            await sendDebuggerCommand(debuggee, 'Runtime.enable');
            const result = await sendDebuggerCommand(debuggee, 'Runtime.evaluate', {
                expression:
                    "(() => ({ scopeName: self.constructor && self.constructor.name || '', href: self.location && self.location.href || '' }))()",
                returnByValue: true,
            });
            const scope = result?.result?.value as WorkerScope | undefined;
            if (scope?.scopeName !== 'SharedWorkerGlobalScope') {
                blockedTargetIds.add(target.id);
                await safeDetach(target.id);
                return;
            }
            await sendDebuggerCommand(debuggee, 'Network.enable');
            const targetRecord: CaptureTarget = {
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
    };
    const withTimeout = <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
        return Promise.race([
            promise,
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('扫描 SharedWorker 超时')), timeoutMs)),
        ]);
    };
    const scanTargets = async () => {
        if (scanning || uiPorts.size === 0) return;
        scanning = true;
        broadcast();
        try {
            const targets = await chrome.debugger.getTargets();
            removeDiagnostics(
                (diagnostic) =>
                    diagnostic.level === 'error' && diagnostic.source === 'capture' && diagnostic.targetId === '',
            );
            const liveIds = new Set(targets.map((target) => target.id));
            for (const targetId of [...blockedTargetIds]) {
                if (!liveIds.has(targetId)) blockedTargetIds.delete(targetId);
            }
            for (const targetId of [...attachedTargets.keys()]) {
                if (!liveIds.has(targetId)) removeTarget(targetId);
            }
            const candidates = targets.filter((target) => ['worker', 'shared_worker', 'other'].includes(target.type));
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
    };
    const startScanning = () => {
        if (detachTimer) {
            clearTimeout(detachTimer);
            detachTimer = null;
        }
        if (!scanTimer) {
            initialScanning = true;
            scanTimer = setInterval(scanTargets, TARGET_SCAN_INTERVAL_MS);
        }
        scanTargets();
    };
    const scheduleDetach = () => {
        if (uiPorts.size > 0 || detachTimer) return;
        detachTimer = setTimeout(async () => {
            detachTimer = null;
            if (uiPorts.size > 0) return;
            if (scanTimer) clearInterval(scanTimer);
            scanTimer = null;
            flushFrameBatch();
            await persistenceQueue;
            await Promise.all([...attachedTargets.keys()].map(safeDetach));
            for (const targetId of [...attachedTargets.keys()]) removeTarget(targetId);
            await persistenceQueue;
            pausedConnections.clear();
            pauseNewConnections = false;
        }, DETACH_GRACE_MS);
    };
    chrome.debugger.onEvent.addListener((source, method, params) => {
        const targetId = source.targetId;
        if (!targetId) return;
        const eventParams = (params ?? {}) as DebuggerEventParams;
        const target = attachedTargets.get(targetId);
        if (!target) return;
        const sockets = socketMaps.get(targetId);
        if (method === 'Network.webSocketCreated') {
            sockets?.set(eventParams.requestId, {
                url: eventParams.url || '',
                createdAt: Date.now(),
                closedAt: null,
                status: 'connecting',
            });
            if (pauseNewConnections) pausedConnections.add(targetId + '::' + eventParams.requestId);
            upsertConnectionRecord(targetId, eventParams.requestId, {
                url: eventParams.url || '',
                createdAt: Date.now(),
                closedAt: null,
                status: 'connecting',
            });
            // 新连接创建后刷新运行时引用，后续模拟操作无需再次扫描堆对象。
            void discoverExistingWebSockets(debuggerTarget(targetId)).then((discoveredSockets) => {
                const currentTarget = attachedTargets.get(targetId);
                if (!currentTarget) return;
                currentTarget.discoveredSockets = discoveredSockets;
                assignDiscoveredSocketUrl(targetId, eventParams.requestId);
                broadcast();
            });
            broadcast();
            return;
        }
        if (method === 'Network.webSocketHandshakeResponseReceived') {
            const socket = sockets?.get(eventParams.requestId);
            if (socket) socket.status = 'open';
            upsertConnectionRecord(targetId, eventParams.requestId, { status: 'open', closedAt: null });
            broadcast();
            return;
        }
        if (method === 'Network.webSocketClosed') {
            const socket = sockets?.get(eventParams.requestId);
            if (socket) {
                socket.closedAt = Date.now();
                socket.status = 'closed';
            }
            pausedConnections.delete(targetId + '::' + eventParams.requestId);
            upsertConnectionRecord(targetId, eventParams.requestId, {
                status: 'closed',
                closedAt: socket?.closedAt || Date.now(),
            });
            broadcast();
            return;
        }
        if (method === 'Network.webSocketFrameError') {
            pushDiagnostic('error', eventParams.errorMessage || 'WebSocket frame error', targetId, 'websocket');
            broadcast();
            return;
        }
        if (!['Network.webSocketFrameReceived', 'Network.webSocketFrameSent'].includes(method)) {
            return;
        }
        const direction = method === 'Network.webSocketFrameReceived' ? 'received' : 'sent';
        removeDiagnostics(
            (diagnostic) =>
                diagnostic.level === 'error' && diagnostic.source === 'websocket' && diagnostic.targetId === targetId,
        );
        let socket = sockets?.get(eventParams.requestId);
        if (!socket && sockets) {
            socket = {
                url: '',
                createdAt: null,
                closedAt: null,
                status: 'open',
            };
            sockets.set(eventParams.requestId, socket);
            if (pauseNewConnections) pausedConnections.add(targetId + '::' + eventParams.requestId);
            assignDiscoveredSocketUrl(targetId, eventParams.requestId);
            upsertConnectionRecord(targetId, eventParams.requestId, {
                createdAt: Date.now(),
                closedAt: null,
                status: 'open',
            });
        }
        if (socket) {
            socket.status = 'open';
            upsertConnectionRecord(targetId, eventParams.requestId, { status: 'open', closedAt: null });
        }
        const connectionKey = targetId + '::' + eventParams.requestId;
        if (pausedConnections.has(connectionKey)) return;
        const frame = buildFrameRecord({
            id: nextFrameId++,
            direction,
            params: eventParams,
            socketUrl: socket?.url,
            targetId,
            targetUrl: target.url,
        });
        if (direction === 'sent' && consumeSimulationSend(connectionKey, eventParams.response?.payloadData || '')) {
            frame.simulation = 'send';
            frame.eventName = '模拟发送';
        }
        appendFrame(frame);
    });
    chrome.debugger.onDetach.addListener((source, reason) => {
        if (!source.targetId || !attachedTargets.has(source.targetId)) return;
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
        port.onMessage.addListener((message: unknown) => {
            const command = message as InspectorCommand;
            if (command.type === 'clear') {
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
            } else if (command.type === 'clear-connection') {
                flushFrameBatch();
                const key = command.targetId + '::' + command.requestId;
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
            } else if (command.type === 'set-connection-paused') {
                flushFrameBatch();
                const key = command.targetId + '::' + command.requestId;
                const connection = connectionRecords.get(key);
                if (connection?.status === 'closed') return;
                if (command.paused) pausedConnections.add(key);
                else pausedConnections.delete(key);
                broadcast();
            } else if (command.type === 'set-all-connections-paused') {
                flushFrameBatch();
                pauseNewConnections = command.paused;
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
            } else if (command.type === 'rescan') {
                blockedTargetIds.clear();
                scanTargets();
            } else if (command.type === 'simulate') {
                registerSimulationSend(command);
                void withTimeout(
                    executeSimulation(
                        command.targetId,
                        command.requestId,
                        command.socketUrl,
                        command.action,
                        command.payload,
                        command.closeCode,
                        command.closeReason,
                    ),
                    5000,
                )
                    .catch((error: unknown): RuntimeSimulationResult => ({
                        success: false,
                        message: error instanceof Error ? error.message : '模拟操作执行超时',
                    }))
                    .then((result) => {
                        if (disconnected) return;
                        if (!result.success && command.action === 'send') {
                            removeSimulationSend(command.targetId + '::' + command.requestId, command.operationId);
                        }
                        if (result.success) {
                            appendSimulationFrame(command, attachedTargets.get(command.targetId)?.url || '');
                        }
                        port.postMessage({
                            type: 'simulation-result',
                            simulationResult: { operationId: command.operationId, ...result },
                        } satisfies InspectorMessage);
                    });
            }
        });
        port.onDisconnect.addListener(() => {
            disconnected = true;
            uiPorts.delete(port);
            scheduleDetach();
        });
    });
    chrome.action.onClicked.addListener(async () => {
        const candidates = ['inspector.html', 'inspector/index.html'];
        for (const relative of candidates) {
            const target = chrome.runtime.getURL(relative);
            const existingTabs = await chrome.tabs.query({ url: target });
            if (existingTabs[0]?.id) {
                await chrome.tabs.update(existingTabs[0].id, { active: true });
                if (existingTabs[0].windowId) {
                    await chrome.windows.update(existingTabs[0].windowId, { focused: true });
                }
                return;
            }
        }
        await chrome.tabs.create({ url: chrome.runtime.getURL(candidates[0]!) });
    });
});
