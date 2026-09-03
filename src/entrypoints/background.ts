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
import { reconcileRuntimeSockets } from '../lib/socket-discovery.ts';
import { resolveWebSocketTargetType, type WorkerScope } from '../lib/target-type.ts';
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
    WebSocketTargetType,
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
    'Runtime.addBinding': object;
    'Runtime.releaseObjectGroup': object;
    'Runtime.runIfWaitingForDebugger': object;
    'Network.enable': object;
    'Target.detachFromTarget': object;
    'Target.getTargetInfo': { targetInfo?: { openerId?: string; type?: string } };
    'Target.setAutoAttach': object;
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

interface AttachedTargetEvent {
    sessionId: string;
    targetInfo: {
        targetId: string;
        title: string;
        type: string;
        url: string;
        openerId?: string;
    };
}

interface DetachedTargetEvent {
    sessionId: string;
    targetId?: string;
}

interface RuntimeExecutionContextCreatedEvent {
    context: { id: number };
}

interface RuntimeExecutionContextDestroyedEvent {
    executionContextId: number;
}

interface RuntimeBindingCalledEvent {
    name: string;
    payload: string;
}

interface WorkerRuntimeFrameEvent {
    runtimeId: string;
    url: string;
    direction: 'received' | 'sent';
    payloadData: string;
    timestamp: number;
}

/** 提供缺少调试目标标题时的稳定展示名称。 */
const targetTypeFallbackTitle = (targetType: WebSocketTargetType): string => {
    if (targetType === 'shared_worker') return 'SharedWorker';
    if (targetType === 'worker') return 'Web Worker';
    return '页面';
};

/** 页面负责自动发现 Dedicated Worker，独立 Worker 在页面附加完成后兜底扫描。 */
const isWebSocketTargetCandidate = (target: chrome.debugger.TargetInfo): boolean => {
    const targetType = String(target.type);
    if (targetType === 'page') return /^(https?|file):/.test(target.url || '');
    return ['shared_worker', 'other'].includes(targetType);
};

interface RuntimeSimulationResult {
    success: boolean;
    message: string;
}

interface PendingSimulationSend {
    operationId: string;
    payload: string;
    socketUrl: string;
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
    const TARGET_SCAN_INTERVAL_MS = 5000;
    const TARGET_SCAN_CONCURRENCY = 2;
    const TARGET_RETRY_DELAYS_MS = [5000, 30000, 120000, 600000] as const;
    const TARGET_SCAN_STEP_DELAY_MS = 120;
    const DETACH_GRACE_MS = 5000;
    const TRANSIENT_DIAGNOSTIC_TTL_MS = 10000;
    // 以下集合只保存当前监听会话的运行态；业务页面及业务存储不会被修改。
    const uiPorts = new Set<chrome.runtime.Port>();
    const attachedTargets = new Map<string, CaptureTarget>();
    const socketMaps = new Map<string, Map<string, SocketRecord>>();
    const blockedTargetIds = new Set<string>();
    const occupiedTargetIds = new Set<string>();
    const targetRetryStates = new Map<string, { failureCount: number; retryAt: number }>();
    const pausedConnections = new Set<string>();
    const frameBuckets = new Map<string, FrameRecord[]>();
    const frameOrder: Array<{ id: number; key: string }> = [];
    const retainedFrameIds = new Set<number>();
    const connectionRecords = new Map<string, ConnectionRecord>();
    const debuggerSessions = new Map<string, chrome.debugger.DebuggerSession>();
    const rootSessionTargetIds = new Map<string, string>();
    const sessionTargetIds = new Map<string, string>();
    const childTargetParents = new Map<string, string>();
    const targetExecutionContexts = new Map<string, Set<number>>();
    const pendingChildInspections = new Set<Promise<void>>();
    const workerSocketAliases = new Map<string, Map<string, string>>();
    const pendingSimulationSends = new Map<string, PendingSimulationSend[]>();
    const diagnostics: CaptureDiagnostic[] = [];
    // generation 用于丢弃上一个 Inspector 会话迟到的异步消息。
    let nextFrameId = 1;
    let totalFrameCount = 0;
    let totalPayloadBytes = 0;
    let pauseNewConnections = false;
    let scanning = false;
    let resettingCapture = false;
    let initialScanning = true;
    let scanTimer: ReturnType<typeof setInterval> | null = null;
    let detachTimer: ReturnType<typeof setTimeout> | null = null;
    let captureInitialization: Promise<void> | null = null;
    let captureGeneration = 0;
    // 高频帧先在内存聚合，再批量持久化和通知 UI，降低端口通信压力。
    let pendingFrames: FrameRecord[] = [];
    let pendingEvictedFrameIds: number[] = [];
    let frameBatchTimer: ReturnType<typeof setTimeout> | null = null;
    let persistenceQueue: Promise<void> = Promise.resolve();
    let frameOrderHead = 0;
    /** 为根调试会话生成稳定键，区分同 URL 的多个浏览器标签页。 */
    const rootSessionKey = (session: chrome.debugger.DebuggerSession): string => {
        if (typeof session.tabId === 'number') return `tab:${session.tabId}`;
        if (session.targetId) return `target:${session.targetId}`;
        return '';
    };
    const debuggerTarget = (targetId: string): chrome.debugger.DebuggerSession => {
        return debuggerSessions.get(targetId) || { targetId };
    };
    /** 将 chrome.debugger 事件来源还原为内部捕获目标。 */
    const resolveEventTargetId = (source: chrome.debugger.DebuggerSession): string | undefined => {
        if (source.sessionId) return sessionTargetIds.get(source.sessionId);
        return rootSessionTargetIds.get(rootSessionKey(source)) || source.targetId;
    };
    const sendDebuggerCommand = <Method extends keyof DebuggerCommandResultMap>(
        debuggee: chrome.debugger.DebuggerSession,
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
            tabId: target?.tabId,
            targetType: target?.type || 'shared_worker',
            targetTitle: target?.title || targetTypeFallbackTitle(target?.type || 'shared_worker'),
            targetUrl: target?.url || '',
            url: socket?.url || '',
            createdAt: socket?.createdAt || Date.now(),
            closedAt: null,
            status: socket?.status || 'connecting',
        };
        const next: ConnectionRecord = {
            ...current,
            tabId: target?.tabId ?? current.tabId,
            targetType: target?.type || current.targetType || 'shared_worker',
            targetTitle:
                target?.title || current.targetTitle || targetTypeFallbackTitle(target?.type || 'shared_worker'),
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
            const emptyConnectionKeys = [...connectionRecords.keys()].filter((key) => !frameBuckets.has(key));
            for (const key of emptyConnectionKeys) connectionRecords.delete(key);
            await Promise.all(emptyConnectionKeys.map((key) => clearStoredConnection(key, captureGeneration)));
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
    /** 刷新 Inspector 时清空上一轮数据和调试会话，再从空列表重新发现连接。 */
    const resetCaptureSession = async (): Promise<void> => {
        resettingCapture = true;
        if (scanTimer) clearInterval(scanTimer);
        scanTimer = null;
        while (scanning) {
            await new Promise<void>((resolve) => setTimeout(resolve, 25));
        }
        // 等待旧扫描的写入全部结束，避免数据库清空后又被迟到任务写回旧连接。
        await persistenceQueue;
        if (frameBatchTimer) clearTimeout(frameBatchTimer);
        frameBatchTimer = null;
        pendingFrames = [];
        pendingEvictedFrameIds = [];
        await Promise.allSettled(pendingChildInspections);
        await Promise.allSettled([...attachedTargets.keys()].map(safeDetach));
        attachedTargets.clear();
        socketMaps.clear();
        debuggerSessions.clear();
        rootSessionTargetIds.clear();
        sessionTargetIds.clear();
        childTargetParents.clear();
        targetExecutionContexts.clear();
        workerSocketAliases.clear();
        blockedTargetIds.clear();
        occupiedTargetIds.clear();
        pausedConnections.clear();
        pendingSimulationSends.clear();
        pauseNewConnections = false;
        frameBuckets.clear();
        frameOrder.length = 0;
        retainedFrameIds.clear();
        connectionRecords.clear();
        diagnostics.length = 0;
        frameOrderHead = 0;
        nextFrameId = 1;
        totalFrameCount = 0;
        totalPayloadBytes = 0;
        captureGeneration += 1;
        initialScanning = true;
        await resetStoredCapture(captureGeneration);
        resettingCapture = false;
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
        const previousFrame = bucket.at(-1);
        if (
            previousFrame &&
            previousFrame.direction === record.direction &&
            previousFrame.opcode === record.opcode &&
            previousFrame.payloadData === record.payloadData &&
            ((previousFrame.timestamp === record.timestamp && previousFrame.captureSource === record.captureSource) ||
                (previousFrame.captureSource !== record.captureSource &&
                    Boolean(previousFrame.captureSource) &&
                    Boolean(record.captureSource) &&
                    Math.abs(previousFrame.receivedAt - record.receivedAt) <= 250))
        ) {
            return;
        }
        if (!frameBuckets.has(connectionKey)) frameBuckets.set(connectionKey, bucket);
        bucket.push(record);
        frameOrder.push({ id: record.id, key: connectionKey });
        retainedFrameIds.add(record.id);
        totalFrameCount += 1;
        totalPayloadBytes += record.retainedPayloadBytes ?? record.payloadBytes;
        const evictedFrameIds = enforceFrameLimits(connectionKey);
        queueFrameBroadcast(record, evictedFrameIds);
    };

    /** 模拟操作成功后通过唯一入口写入一条带来源标记的列表帧。 */
    const appendSimulationFrame = (
        command: Extract<InspectorCommand, { type: 'simulate' }>,
        targetUrl: string,
    ): FrameRecord => {
        const isClientEvent = command.action.startsWith('client-');
        const isServerEvent = command.action.startsWith('server-');
        const isCloseEvent = command.action.endsWith('-close');
        const eventSide = isClientEvent ? '客户端' : '服务端';
        const systemPayload = isCloseEvent
            ? `[模拟${eventSide}事件] close (${command.closeCode ?? 1000}) ${command.closeReason || ''}`.trim()
            : `[模拟${eventSide}事件] error: ${command.payload || '未知错误'}`;
        const record = buildFrameRecord({
            id: nextFrameId++,
            direction: command.action === 'send' || isClientEvent ? 'sent' : 'received',
            params: {
                requestId: command.requestId,
                timestamp: Date.now() / 1000,
                response: {
                    opcode: 1,
                    mask: false,
                    payloadData:
                        command.action === 'send' || command.action === 'receive' ? command.payload : systemPayload,
                },
            },
            socketUrl: command.socketUrl,
            targetId: command.targetId,
            targetType: attachedTargets.get(command.targetId)?.type || 'shared_worker',
            targetUrl,
        });
        record.simulation = command.action === 'send' ? 'send' : command.action === 'receive' ? 'receive' : 'system';
        record.eventName =
            command.action === 'send'
                ? '模拟发送'
                : command.action === 'receive'
                  ? '模拟接收'
                  : `模拟${isServerEvent ? '服务端' : '客户端'}${isCloseEvent ? '关闭' : '错误'}`;
        appendFrame(record);
        return record;
    };

    /** 登记模拟发送，用于消费真实 socket.send 产生的 CDP 回声。 */
    const registerSimulationSend = (command: Extract<InspectorCommand, { type: 'simulate' }>): void => {
        if (command.action !== 'send') return;
        const key = command.targetId + '::' + command.requestId;
        const now = Date.now();
        const queue = (pendingSimulationSends.get(key) || []).filter((item) => item.expiresAt > now);
        queue.push({
            operationId: command.operationId,
            payload: command.payload,
            socketUrl: command.socketUrl,
            expiresAt: now + 10000,
        });
        pendingSimulationSends.set(key, queue);
    };

    /** 移除执行失败或已经被 CDP 发送帧消费的模拟发送登记。 */
    const removeSimulationSend = (connectionKey: string, operationId: string): PendingSimulationSend | null => {
        const queue = pendingSimulationSends.get(connectionKey);
        if (!queue) return null;
        const removed = queue.find((item) => item.operationId === operationId) || null;
        const remaining = queue.filter((item) => item.operationId !== operationId);
        if (remaining.length > 0) pendingSimulationSends.set(connectionKey, remaining);
        else pendingSimulationSends.delete(connectionKey);
        return removed;
    };

    /** 消费指定连接队列中与真实发送帧匹配的模拟发送登记。 */
    const consumeSimulationSendFromQueue = (
        connectionKey: string,
        payload: string,
        socketUrl: string | undefined,
        now: number,
        requireSocketUrl: boolean,
    ): PendingSimulationSend | null => {
        const queue = (pendingSimulationSends.get(connectionKey) || []).filter((item) => item.expiresAt > now);
        const index = queue.findIndex(
            (item) => item.payload === payload && (!requireSocketUrl || !socketUrl || item.socketUrl === socketUrl),
        );
        if (index < 0) {
            if (queue.length > 0) pendingSimulationSends.set(connectionKey, queue);
            else pendingSimulationSends.delete(connectionKey);
            return null;
        }
        const [matched] = queue.splice(index, 1);
        if (queue.length > 0) pendingSimulationSends.set(connectionKey, queue);
        else pendingSimulationSends.delete(connectionKey);
        return matched || null;
    };

    /** 将匹配连接、地址和 payload 的下一条发送帧识别为插件模拟发送。 */
    const consumeSimulationSend = (
        targetId: string,
        requestId: string,
        payload: string,
        socketUrl: string | undefined,
    ): PendingSimulationSend | null => {
        const now = Date.now();
        const exactConnectionKey = targetId + '::' + requestId;
        const exactMatch = consumeSimulationSendFromQueue(exactConnectionKey, payload, socketUrl, now, false);
        if (exactMatch) return exactMatch;
        for (const connectionKey of pendingSimulationSends.keys()) {
            if (connectionKey === exactConnectionKey || !connectionKey.startsWith(targetId + '::')) continue;
            const fallbackMatch = consumeSimulationSendFromQueue(connectionKey, payload, socketUrl, now, true);
            if (fallbackMatch) return fallbackMatch;
        }
        return null;
    };

    const safeDetach = async (targetId: string): Promise<void> => {
        const session = debuggerSessions.get(targetId);
        try {
            if (session?.sessionId) {
                const parentTargetId = childTargetParents.get(targetId);
                const parentSession = parentTargetId ? debuggerSessions.get(parentTargetId) : undefined;
                if (parentSession) {
                    await sendDebuggerCommand(parentSession, 'Target.detachFromTarget', {
                        sessionId: session.sessionId,
                    });
                }
            } else {
                await chrome.debugger.detach(session || { targetId });
            }
        } catch {
            // Target may already be gone.
        }
    };
    const removeTarget = (targetId: string): void => {
        for (const [childTargetId, parentTargetId] of childTargetParents) {
            if (parentTargetId === targetId) removeTarget(childTargetId);
        }
        const sockets = socketMaps.get(targetId);
        const closedAt = Date.now();
        for (const [requestId] of sockets?.entries() || []) {
            const key = targetId + '::' + requestId;
            if (!frameBuckets.has(key)) {
                removeRuntimeSocketPlaceholder(targetId, requestId);
                continue;
            }
            const record = connectionRecord(targetId, requestId);
            if (record?.status !== 'closed') {
                upsertConnectionRecord(targetId, requestId, { status: 'closed', closedAt });
            }
        }
        attachedTargets.delete(targetId);
        socketMaps.delete(targetId);
        const debuggerSession = debuggerSessions.get(targetId);
        const sessionId = debuggerSession?.sessionId;
        if (sessionId) sessionTargetIds.delete(sessionId);
        else if (debuggerSession) rootSessionTargetIds.delete(rootSessionKey(debuggerSession));
        debuggerSessions.delete(targetId);
        targetExecutionContexts.delete(targetId);
        workerSocketAliases.delete(targetId);
        childTargetParents.delete(targetId);
        for (const key of pausedConnections) {
            if (key.startsWith(targetId + '::')) pausedConnections.delete(key);
        }
    };
    // Inspector 晚于 WebSocket 建立时，尝试从 Runtime 对象补全连接 URL。
    const discoverExistingWebSockets = async (
        targetId: string,
        debuggee: chrome.debugger.DebuggerSession,
    ): Promise<DiscoveredSocket[] | null> => {
        const contextIds = [...(targetExecutionContexts.get(targetId) || [])];
        const contexts: Array<number | undefined> = contextIds.length > 0 ? contextIds : [undefined];
        const results = await Promise.all(
            contexts.map(async (contextId): Promise<DiscoveredSocket[] | null> => {
                const objectGroup = `shared-worker-ws-inspector-discovery-${contextId ?? 'default'}`;
                try {
                    const prototypeResult = await sendDebuggerCommand(debuggee, 'Runtime.evaluate', {
                        expression: 'typeof WebSocket === "function" ? WebSocket.prototype : null',
                        objectGroup,
                        ...(typeof contextId === 'number' ? { contextId } : {}),
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
                            `function () {
                                const bindingName = '__ycloudWebSocketInspectorFrame';
                                const state = globalThis.__ycloudWebSocketInspectorState || {
                                    ids: new WeakMap(),
                                    sockets: new Map(),
                                    watched: new WeakSet(),
                                    simulationDepth: 0,
                                    nextId: 1,
                                    sendPatched: false,
                                };
                                globalThis.__ycloudWebSocketInspectorState = state;
                                if (!state.sockets) state.sockets = new Map();
                                if (!Number.isFinite(state.simulationDepth)) state.simulationDepth = 0;
                                const socketId = function (socket) {
                                    let id = state.ids.get(socket);
                                    if (!id) {
                                        id = String(state.nextId++);
                                        state.ids.set(socket, id);
                                    }
                                    state.sockets.set(id, socket);
                                    return id;
                                };
                                state.emit = function (socket, direction, data) {
                                    if (typeof data !== 'string') return;
                                    if (state.simulationDepth > 0) return;
                                    const notify = globalThis[bindingName];
                                    if (typeof notify !== 'function') return;
                                    try {
                                        notify(JSON.stringify({
                                            runtimeId: socketId(socket),
                                            url: socket.url,
                                            direction,
                                            payloadData: data,
                                            timestamp: Date.now(),
                                        }));
                                    } catch {}
                                };
                                if (typeof globalThis[bindingName] === 'function' && !state.sendPatched) {
                                    const originalSend = WebSocket.prototype.send;
                                    WebSocket.prototype.send = function (data) {
                                        const result = originalSend.call(this, data);
                                        state.emit(this, 'sent', data);
                                        return result;
                                    };
                                    state.sendPatched = true;
                                }
                                if (typeof globalThis[bindingName] === 'function') {
                                    this.forEach(function (socket) {
                                        socketId(socket);
                                        if (state.watched.has(socket)) return;
                                        socket.addEventListener('message', function (event) {
                                            state.emit(socket, 'received', event.data);
                                        });
                                        state.watched.add(socket);
                                    });
                                }
                                globalThis.__ycloudWebSocketInspectorSockets = this;
                                return this.map(function (socket) {
                                    return {
                                        url: socket.url,
                                        readyState: socket.readyState,
                                        protocol: socket.protocol,
                                        runtimeId: socketId(socket),
                                    };
                                });
                            }`,
                        returnByValue: true,
                    });
                    return Array.isArray(valuesResult?.result?.value)
                        ? (valuesResult.result.value as DiscoveredSocket[]).map((socket) => ({
                              ...socket,
                              ...(typeof contextId === 'number' ? { executionContextId: contextId } : {}),
                          }))
                        : [];
                } catch {
                    return null;
                } finally {
                    await sendDebuggerCommand(debuggee, 'Runtime.releaseObjectGroup', { objectGroup }).catch(
                        () => undefined,
                    );
                }
            }),
        );
        const successfulResults = results.filter((result): result is DiscoveredSocket[] => result !== null);
        return successfulResults.length > 0 ? successfulResults.flat() : null;
    };

    /** 通过扫描阶段建立的运行时实例 ID 直接操作选中的 WebSocket。 */
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
        if (!target || !connection) return { success: false, message: '当前连接已不存在' };
        if (connection.status !== 'open') return { success: false, message: '当前连接未处于连接状态' };
        if (!socketUrl) return { success: false, message: '当前连接缺少 WebSocket 地址，无法安全定位' };
        if (new TextEncoder().encode(payload).byteLength > 1024 * 1024) {
            return { success: false, message: '模拟消息不能超过 1 MB' };
        }
        if (action === 'client-close' && (closeCode !== 1000 && (closeCode < 3000 || closeCode > 4999))) {
            return { success: false, message: '客户端主动关闭仅支持代码 1000 或 3000-4999' };
        }
        if (action.endsWith('-close') && new TextEncoder().encode(closeReason).byteLength > 123) {
            return { success: false, message: '关闭原因不能超过 123 字节' };
        }
        const socket = socketMaps.get(targetId)?.get(requestId);
        if (!socket?.runtimeId) return { success: false, message: '当前连接实例映射尚未就绪，请稍后重试' };
        const debuggee = debuggerTarget(targetId);
        try {
            const executionResult = await sendDebuggerCommand(debuggee, 'Runtime.evaluate', {
                expression: `(() => {
                    const runtimeId = ${runtimeLiteral(socket.runtimeId)};
                    const action = ${runtimeLiteral(action)};
                    const payload = ${runtimeLiteral(payload)};
                    const closeCode = ${runtimeLiteral(closeCode)};
                    const closeReason = ${runtimeLiteral(closeReason)};
                    const state = globalThis.__ycloudWebSocketInspectorState;
                    if (!state || !state.sockets) return { success: false, message: '当前连接实例映射已失效' };
                    const socket = state.sockets.get(runtimeId);
                    if (!socket || socket.readyState !== WebSocket.OPEN) return { success: false, message: '当前连接实例已失效' };
                    state.simulationDepth = (state.simulationDepth || 0) + 1;
                    try {
                        if (action === 'send') socket.send(payload);
                        if (action === 'receive') {
                            socket.dispatchEvent(new MessageEvent('message', {
                                data: payload,
                                origin: new URL(socket.url).origin,
                            }));
                        }
                        else if (action === 'client-close') socket.close(closeCode, closeReason);
                        else if (action === 'server-close') {
                            socket.dispatchEvent(new CloseEvent('close', {
                                code: closeCode,
                                reason: closeReason,
                                wasClean: closeCode === 1000,
                            }));
                        }
                        else if (action === 'client-error' || action === 'server-error') {
                            socket.dispatchEvent(new ErrorEvent('error', {
                                message: payload || '模拟 WebSocket 错误',
                                error: new Error(payload || '模拟 WebSocket 错误'),
                            }));
                        }
                    } finally {
                        state.simulationDepth = Math.max(0, state.simulationDepth - 1);
                    }
                    return {
                        success: true,
                        message: action === 'send'
                            ? '消息已通过真实连接发送'
                            : action === 'receive'
                              ? '模拟消息已分发给业务监听器'
                              : action === 'client-close'
                                ? '已通过真实连接发起关闭握手'
                                : '模拟事件已分发给业务监听器',
                    };
                })()`,
                returnByValue: true,
                timeout: 3000,
                disableBreaks: true,
                ...(typeof socket.executionContextId === 'number'
                    ? { contextId: socket.executionContextId }
                    : {}),
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
        const unknownSockets = [...sockets.values()].filter((item) => item.status !== 'closed' && !item.url);
        const knownUrlCounts = new Map<string, number>();
        for (const item of sockets.values()) {
            if (item.status === 'closed' || !item.url) continue;
            knownUrlCounts.set(item.url, (knownUrlCounts.get(item.url) || 0) + 1);
        }
        const discoveredUrlCounts = new Map<string, number>();
        const candidates = (target.discoveredSockets || []).filter((item) => {
            if (!item.url || item.readyState > 1) return false;
            const discoveredCount = (discoveredUrlCounts.get(item.url) || 0) + 1;
            discoveredUrlCounts.set(item.url, discoveredCount);
            return discoveredCount > (knownUrlCounts.get(item.url) || 0);
        });
        if (unknownSockets.length === 1 && candidates.length === 1) {
            socket.url = candidates[0]!.url;
        }
    };

    /** 删除仅用于运行时发现的占位连接，不将其误报为已关闭的真实连接。 */
    const removeRuntimeSocketPlaceholder = (targetId: string, requestId: string): void => {
        const key = targetId + '::' + requestId;
        socketMaps.get(targetId)?.delete(requestId);
        connectionRecords.delete(key);
        pausedConnections.delete(key);
        queuePersistence(() => clearStoredConnection(key, captureGeneration));
    };

    /** 将运行时发现结果同步为连接记录，使 Inspector 启动前已建立的连接也能显示。 */
    const synchronizeDiscoveredSockets = (targetId: string, discoveredSockets: DiscoveredSocket[]): void => {
        const target = attachedTargets.get(targetId);
        const sockets = socketMaps.get(targetId);
        if (!target || !sockets) return;
        target.discoveredSockets = discoveredSockets;
        const discoveredCounts = new Map<string, number>();
        for (const socket of discoveredSockets) {
            if (!socket.url || socket.readyState > 1) continue;
            discoveredCounts.set(socket.url, (discoveredCounts.get(socket.url) || 0) + 1);
        }
        const activeByUrl = new Map<string, Array<[string, SocketRecord]>>();
        for (const entry of sockets.entries()) {
            const [, socket] = entry;
            if (!socket.url || socket.status === 'closed') continue;
            const matches = activeByUrl.get(socket.url) || [];
            matches.push(entry);
            activeByUrl.set(socket.url, matches);
        }
        for (const [url, activeSockets] of activeByUrl) {
            let excess = activeSockets.length - (discoveredCounts.get(url) || 0);
            if (excess <= 0) continue;
            const candidates = [...activeSockets].sort((left, right) => {
                const runtimeDifference = Number(Boolean(right[1].urlSource)) - Number(Boolean(left[1].urlSource));
                if (runtimeDifference !== 0) return runtimeDifference;
                return (left[1].createdAt || 0) - (right[1].createdAt || 0);
            });
            for (const [requestId, socket] of candidates) {
                if (excess <= 0) break;
                const key = targetId + '::' + requestId;
                if (socket.urlSource === 'runtime' || !frameBuckets.has(key)) {
                    removeRuntimeSocketPlaceholder(targetId, requestId);
                } else {
                    socket.status = 'closed';
                    socket.closedAt = Date.now();
                    pausedConnections.delete(key);
                    upsertConnectionRecord(targetId, requestId, {
                        status: 'closed',
                        closedAt: socket.closedAt,
                    });
                }
                excess -= 1;
            }
        }
        // 将尚未映射的真实 CDP requestId 与同 URL 的 Runtime 实例一一绑定。
        const claimedRuntimeSockets = new Set(
            [...sockets.values()]
                .filter((socket) => socket.runtimeId)
                .map((socket) => `${socket.executionContextId ?? 'default'}:${socket.runtimeId}`),
        );
        const availableRuntimeSockets = new Map<string, DiscoveredSocket[]>();
        for (const discoveredSocket of discoveredSockets) {
            if (!discoveredSocket.runtimeId || !discoveredSocket.url || discoveredSocket.readyState > 1) continue;
            const runtimeKey = `${discoveredSocket.executionContextId ?? 'default'}:${discoveredSocket.runtimeId}`;
            if (claimedRuntimeSockets.has(runtimeKey)) continue;
            const available = availableRuntimeSockets.get(discoveredSocket.url) || [];
            available.push(discoveredSocket);
            availableRuntimeSockets.set(discoveredSocket.url, available);
        }
        for (const socket of sockets.values()) {
            if (socket.status === 'closed' || !socket.url || socket.runtimeId) continue;
            const runtimeSocket = availableRuntimeSockets.get(socket.url)?.shift();
            if (!runtimeSocket?.runtimeId) continue;
            socket.runtimeId = runtimeSocket.runtimeId;
            socket.executionContextId = runtimeSocket.executionContextId;
        }
        const runtimeSockets = reconcileRuntimeSockets(
            sockets.entries(),
            discoveredSockets,
            () => `runtime:${crypto.randomUUID()}`,
        );
        const aliases = workerSocketAliases.get(targetId) || new Map<string, string>();
        workerSocketAliases.set(targetId, aliases);
        for (const [requestId, socket] of sockets) {
            if (socket.runtimeId) aliases.set(socket.runtimeId, requestId);
        }
        const retainedRequestIds = new Set(runtimeSockets.map(({ requestId }) => requestId));
        for (const [requestId, socket] of sockets) {
            if (socket.urlSource === 'runtime' && !retainedRequestIds.has(requestId)) {
                removeRuntimeSocketPlaceholder(targetId, requestId);
            }
        }
        for (const { requestId, socket } of runtimeSockets) {
            sockets.set(requestId, socket);
            if (socket.runtimeId) aliases.set(socket.runtimeId, requestId);
            if (pauseNewConnections) pausedConnections.add(targetId + '::' + requestId);
            upsertConnectionRecord(targetId, requestId, {
                url: socket.url,
                createdAt: socket.createdAt,
                closedAt: null,
                status: socket.status,
            });
        }
        // Runtime 发现与 CDP 事件可能并发：为空 URL 的真实 requestId 接管一个占位连接，避免拆成两行。
        const unresolvedSockets = [...sockets.entries()].filter(
            ([, socket]) => socket.status !== 'closed' && !socket.url && socket.urlSource !== 'runtime',
        );
        for (const [requestId, unresolvedSocket] of unresolvedSockets) {
            const adoptedSocket = adoptRuntimeSocket(targetId, requestId);
            if (!adoptedSocket) break;
            const resolvedSocket: SocketRecord = {
                ...adoptedSocket,
                createdAt: unresolvedSocket.createdAt || adoptedSocket.createdAt,
                closedAt: unresolvedSocket.closedAt,
                status: unresolvedSocket.status,
            };
            sockets.set(requestId, resolvedSocket);
            upsertConnectionRecord(targetId, requestId, {
                url: resolvedSocket.url,
                createdAt: resolvedSocket.createdAt,
                closedAt: resolvedSocket.closedAt,
                status: resolvedSocket.status,
            });
        }
    };

    /** 用真实 CDP requestId 接管一个运行时占位连接，保持连接数量稳定。 */
    const adoptRuntimeSocket = (targetId: string, requestId: string, url = ''): SocketRecord | null => {
        const sockets = socketMaps.get(targetId);
        if (!sockets) return null;
        const placeholder = [...sockets.entries()].find(
            ([, socket]) =>
                socket.urlSource === 'runtime' && socket.status !== 'closed' && (!url || socket.url === url),
        );
        if (!placeholder) return null;
        const [placeholderRequestId, placeholderSocket] = placeholder;
        const placeholderKey = targetId + '::' + placeholderRequestId;
        const nextKey = targetId + '::' + requestId;
        const wasPaused = pausedConnections.delete(placeholderKey);
        for (const [runtimeId, aliasedRequestId] of workerSocketAliases.get(targetId) || []) {
            if (aliasedRequestId === placeholderRequestId) {
                workerSocketAliases.get(targetId)?.set(runtimeId, requestId);
            }
        }
        removeRuntimeSocketPlaceholder(targetId, placeholderRequestId);
        if (wasPaused) pausedConnections.add(nextKey);
        const adoptedSocket = { ...placeholderSocket };
        delete adoptedSocket.urlSource;
        return adoptedSocket;
    };

    /** 读取 Worker 全局作用域，Chrome 将 SharedWorker 暴露为通用 worker 时据此纠正类型。 */
    const inspectRuntimeScope = async (debuggee: chrome.debugger.DebuggerSession): Promise<WorkerScope | undefined> => {
        const result = await sendDebuggerCommand(debuggee, 'Runtime.evaluate', {
            expression: `(() => {
                    const scopeName = self.constructor && self.constructor.name || '';
                    const scopeTag = Object.prototype.toString.call(self);
                    const isSharedWorker =
                        scopeName === 'SharedWorkerGlobalScope' ||
                        scopeTag === '[object SharedWorkerGlobalScope]' ||
                        (typeof SharedWorkerGlobalScope !== 'undefined' && self instanceof SharedWorkerGlobalScope) ||
                        (!('document' in self) && 'onconnect' in self);
                    const isDedicatedWorker =
                        scopeName === 'DedicatedWorkerGlobalScope' ||
                        scopeTag === '[object DedicatedWorkerGlobalScope]' ||
                        (typeof DedicatedWorkerGlobalScope !== 'undefined' && self instanceof DedicatedWorkerGlobalScope);
                    return {
                        scopeName,
                        scopeType: isSharedWorker ? 'shared_worker' : isDedicatedWorker ? 'worker' : '',
                        href: self.location && self.location.href || '',
                    };
                })()`,
            returnByValue: true,
        });
        return result?.result?.value as WorkerScope | undefined;
    };

    /** 初始化已经附加的页面或 Worker 调试会话，并注册统一捕获目标。 */
    const initializeAttachedTarget = async (
        targetId: string,
        debuggerTargetType: string,
        title: string,
        url: string,
        debuggee: chrome.debugger.DebuggerSession,
        ownerPageUrl?: string,
        ownerTabId?: number,
    ): Promise<WebSocketTargetType | null> => {
        await sendDebuggerCommand(debuggee, 'Runtime.enable');
        const scope = await inspectRuntimeScope(debuggee);
        const targetType = resolveWebSocketTargetType(debuggerTargetType, scope);
        if (!targetType) return null;
        if (targetType === 'worker') {
            await sendDebuggerCommand(debuggee, 'Runtime.addBinding', {
                name: '__ycloudWebSocketInspectorFrame',
            }).catch(() => undefined);
        }
        await sendDebuggerCommand(debuggee, 'Network.enable');
        const targetRecord: CaptureTarget = {
            id: targetId,
            tabId:
                targetType === 'page'
                    ? debuggee.tabId
                    : targetType === 'worker'
                      ? ownerTabId ?? debuggee.tabId
                      : undefined,
            type: targetType,
            title: title || targetTypeFallbackTitle(targetType),
            // Dedicated Worker 记录所属页面，便于多个页面存在同源 Worker 时识别来源。
            url: targetType === 'worker' && ownerPageUrl ? ownerPageUrl : scope?.href || url || '',
            attachedAt: Date.now(),
            discoveredSockets: [],
        };
        attachedTargets.set(targetId, targetRecord);
        socketMaps.set(targetId, new Map());
        const discoveredSockets = await discoverExistingWebSockets(targetId, debuggee);
        if (discoveredSockets) synchronizeDiscoveredSockets(targetId, discoveredSockets);
        removeDiagnostics(
            (diagnostic) =>
                diagnostic.level === 'error' && diagnostic.source === 'capture' && diagnostic.targetId === targetId,
        );
        pushDiagnostic('info', `已连接${targetTypeFallbackTitle(targetType)}调试目标`, targetId);
        broadcast();
        return targetType;
    };

    /** 手动重新扫描时校准已附加目标的类型、运行地址和活动连接数量。 */
    const refreshAttachedTargets = async (): Promise<void> => {
        await Promise.allSettled(
            [...attachedTargets.entries()].map(async ([targetId, target]) => {
                const debuggee = debuggerTarget(targetId);
                const scope = await inspectRuntimeScope(debuggee);
                const runtimeType = resolveWebSocketTargetType('', scope);
                if (runtimeType && runtimeType !== target.type) {
                    target.type = runtimeType;
                    target.title = targetTypeFallbackTitle(runtimeType);
                    if (runtimeType === 'shared_worker' && scope?.href) target.url = scope.href;
                    for (const requestId of socketMaps.get(targetId)?.keys() || []) {
                        upsertConnectionRecord(targetId, requestId);
                    }
                }
                const discoveredSockets = await discoverExistingWebSockets(targetId, debuggee);
                if (discoveredSockets) synchronizeDiscoveredSockets(targetId, discoveredSockets);
            }),
        );
        broadcast();
    };

    /** 将页面自动附加的 Dedicated Worker 子会话接入现有捕获模型。 */
    const inspectAttachedChild = async (
        rootSession: chrome.debugger.DebuggerSession,
        event: AttachedTargetEvent,
    ): Promise<void> => {
        const rootTargetId = resolveEventTargetId(rootSession);
        const { targetId, title, type, url } = event.targetInfo;
        if (!rootTargetId) return;
        if (attachedTargets.has(targetId)) {
            await sendDebuggerCommand(debuggerTarget(rootTargetId), 'Target.detachFromTarget', {
                sessionId: event.sessionId,
            }).catch(() => undefined);
            return;
        }
        if (!['worker', 'shared_worker'].includes(type)) {
            await sendDebuggerCommand({ targetId: rootTargetId }, 'Target.detachFromTarget', {
                sessionId: event.sessionId,
            }).catch(() => undefined);
            return;
        }
        const parentSession = debuggerTarget(rootTargetId);
        const ownerTarget = attachedTargets.get(event.targetInfo.openerId || rootTargetId);
        const ownerTabId = ownerTarget?.tabId ?? attachedTargets.get(rootTargetId)?.tabId ?? rootSession.tabId;
        const childSession: chrome.debugger.DebuggerSession = {
            ...(typeof parentSession.tabId === 'number'
                ? { tabId: parentSession.tabId }
                : { targetId: parentSession.targetId || rootTargetId }),
            sessionId: event.sessionId,
        };
        debuggerSessions.set(targetId, childSession);
        sessionTargetIds.set(event.sessionId, targetId);
        childTargetParents.set(targetId, rootTargetId);
        try {
            const targetType = await initializeAttachedTarget(
                targetId,
                type,
                title,
                url,
                childSession,
                attachedTargets.get(event.targetInfo.openerId || rootTargetId)?.url ||
                    attachedTargets.get(rootTargetId)?.url,
                ownerTabId,
            );
            await sendDebuggerCommand(childSession, 'Runtime.runIfWaitingForDebugger').catch(() => undefined);
            if (!targetType) {
                await safeDetach(targetId);
                removeTarget(targetId);
            }
        } catch (error) {
            // 即使初始化失败也必须恢复 Worker，避免调试器影响业务页面。
            await sendDebuggerCommand(childSession, 'Runtime.runIfWaitingForDebugger').catch(() => undefined);
            await safeDetach(targetId);
            removeTarget(targetId);
            pushDiagnostic('error', error instanceof Error ? error.message : '连接 Web Worker 调试目标失败', targetId);
            broadcast();
        }
    };

    const inspectCandidate = async (
        target: chrome.debugger.TargetInfo,
        ownerPageUrl?: string,
        ownerTabId?: number,
    ): Promise<void> => {
        if (
            attachedTargets.has(target.id) ||
            blockedTargetIds.has(target.id) ||
            occupiedTargetIds.has(target.id) ||
            target.url?.startsWith(chrome.runtime.getURL(''))
        ) {
            return;
        }
        if (target.attached) {
            occupiedTargetIds.add(target.id);
            pushDiagnostic('warning', '目标已被其他 DevTools 或调试器占用', target.id);
            return;
        }
        const debuggee: chrome.debugger.DebuggerSession =
            target.type === 'page' && typeof target.tabId === 'number'
                ? { tabId: target.tabId }
                : { targetId: target.id };
        try {
            await chrome.debugger.attach(debuggee, '1.3');
            debuggerSessions.set(target.id, debuggee);
            rootSessionTargetIds.set(rootSessionKey(debuggee), target.id);
            const targetType = await initializeAttachedTarget(
                target.id,
                String(target.type),
                target.title || '',
                target.url || '',
                debuggee,
                ownerPageUrl,
                ownerTabId ?? target.tabId,
            );
            if (!targetType) {
                blockedTargetIds.add(target.id);
                targetRetryStates.delete(target.id);
                await safeDetach(target.id);
                removeTarget(target.id);
                return;
            }
            targetRetryStates.delete(target.id);
            if (targetType === 'page') {
                await sendDebuggerCommand(debuggee, 'Target.setAutoAttach', {
                    autoAttach: true,
                    filter: [{ type: 'worker' }, { type: 'shared_worker' }, { exclude: true }],
                    flatten: true,
                    waitForDebuggerOnStart: false,
                });
            }
        } catch (error) {
            const previousRetry = targetRetryStates.get(target.id);
            const failureCount = (previousRetry?.failureCount || 0) + 1;
            const retryDelay =
                TARGET_RETRY_DELAYS_MS[Math.min(failureCount - 1, TARGET_RETRY_DELAYS_MS.length - 1)] ?? 30000;
            targetRetryStates.set(target.id, { failureCount, retryAt: Date.now() + retryDelay });
            await safeDetach(target.id);
            removeTarget(target.id);
            pushDiagnostic('error', error?.message || '连接 WebSocket 调试目标失败', target.id);
            broadcast();
        }
    };
    const withTimeout = <T>(promise: Promise<T>, timeoutMs: number, timeoutMessage = '扫描 WebSocket 目标超时'): Promise<T> => {
        return Promise.race([
            promise,
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs),
            ),
        ]);
    };
    /** 仅将新增或退避到期的目标加入扫描队列，稳定目标不再产生等待开销。 */
    const shouldQueueTarget = (target: chrome.debugger.TargetInfo): boolean => {
        if (
            attachedTargets.has(target.id) ||
            blockedTargetIds.has(target.id) ||
            occupiedTargetIds.has(target.id) ||
            target.url?.startsWith(chrome.runtime.getURL(''))
        ) {
            return false;
        }
        const retryState = targetRetryStates.get(target.id);
        return !retryState || retryState.retryAt <= Date.now();
    };
    /** 使用固定并发处理待附加目标，避免标签页较多时瞬间创建大量 CDP 会话。 */
    const inspectCandidateQueue = async (
        candidates: chrome.debugger.TargetInfo[],
        resolveOwner?: (
            target: chrome.debugger.TargetInfo,
        ) => Promise<{ ownerPageUrl?: string; ownerTabId?: number }>,
    ): Promise<boolean> => {
        let nextIndex = 0;
        let partialScanFailed = false;
        const worker = async (): Promise<void> => {
            while (nextIndex < candidates.length) {
                const target = candidates[nextIndex++];
                if (!target) continue;
                if (!shouldQueueTarget(target)) continue;
                try {
                    const owner = resolveOwner ? await resolveOwner(target) : undefined;
                    await withTimeout(inspectCandidate(target, owner?.ownerPageUrl, owner?.ownerTabId), 3000);
                } catch {
                    const previousRetry = targetRetryStates.get(target.id);
                    const failureCount = (previousRetry?.failureCount || 0) + 1;
                    const retryDelay =
                        TARGET_RETRY_DELAYS_MS[Math.min(failureCount - 1, TARGET_RETRY_DELAYS_MS.length - 1)] ??
                        30000;
                    targetRetryStates.set(target.id, { failureCount, retryAt: Date.now() + retryDelay });
                    partialScanFailed = true;
                }
                await new Promise<void>((resolve) => setTimeout(resolve, TARGET_SCAN_STEP_DELAY_MS));
            }
        };
        const workerCount = Math.min(TARGET_SCAN_CONCURRENCY, candidates.length);
        await Promise.all(Array.from({ length: workerCount }, worker));
        return partialScanFailed;
    };
    const scanTargets = async () => {
        if (scanning || resettingCapture || uiPorts.size === 0) return;
        scanning = true;
        broadcast();
        try {
            const targets = await chrome.debugger.getTargets();
            removeDiagnostics(
                (diagnostic) =>
                    diagnostic.level === 'error' && diagnostic.source === 'capture' && diagnostic.targetId === '',
            );
            const liveTargets = new Map(targets.map((target) => [target.id, target]));
            const liveIds = new Set(liveTargets.keys());
            for (const targetId of blockedTargetIds) {
                if (!liveIds.has(targetId)) blockedTargetIds.delete(targetId);
            }
            for (const targetId of occupiedTargetIds) {
                const target = liveTargets.get(targetId);
                if (!target || !target.attached) occupiedTargetIds.delete(targetId);
            }
            for (const targetId of targetRetryStates.keys()) {
                if (!liveIds.has(targetId)) targetRetryStates.delete(targetId);
            }
            for (const targetId of attachedTargets.keys()) {
                if (!liveIds.has(targetId)) removeTarget(targetId);
            }
            let partialScanFailed = false;
            const targetPriority = (target: chrome.debugger.TargetInfo): number => {
                if (target.type === 'page') return 0;
                if (String(target.type) === 'shared_worker') return 1;
                return 2;
            };
            // Page 必须先完成自动附加，避免并发队列直接抢占其 Worker 子目标并丢失 Network 事件。
            const pageCandidates = targets
                .filter((target) => target.type === 'page' && isWebSocketTargetCandidate(target))
                .filter(shouldQueueTarget)
                .sort((left, right) => targetPriority(left) - targetPriority(right));
            partialScanFailed = await inspectCandidateQueue(pageCandidates);
            // 先等待页面自动附加 Dedicated Worker，避免后续兜底直接抢占其调试目标。
            await new Promise<void>((resolve) => setTimeout(resolve, 100));
            await Promise.allSettled(pendingChildInspections);
            // 部分 Chromium 版本会把 SharedWorker 暴露为通用 worker。剩余目标统一通过运行时
            // 判定类型；若存在 opener，则同时补全 Dedicated Worker 的所属页面和 Tab ID。
            const refreshedTargets = await chrome.debugger.getTargets();
            const pageSession = [...attachedTargets.entries()].find(([, target]) => target.type === 'page');
            const pageDebuggee = pageSession ? debuggerTarget(pageSession[0]) : null;
            const fallbackWorkers = refreshedTargets
                .filter(
                (item) =>
                    ['worker', 'shared_worker'].includes(item.type) &&
                    !item.attached &&
                    shouldQueueTarget(item),
                )
                .sort((left, right) => targetPriority(left) - targetPriority(right));
            const fallbackFailed = await inspectCandidateQueue(fallbackWorkers, async (target) => {
                if (!pageDebuggee) return {};
                const targetInfo = await sendDebuggerCommand(pageDebuggee, 'Target.getTargetInfo', {
                    targetId: target.id,
                }).catch(() => null);
                const ownerTarget = targetInfo?.targetInfo?.openerId
                    ? attachedTargets.get(targetInfo.targetInfo.openerId)
                    : undefined;
                return { ownerPageUrl: ownerTarget?.url, ownerTabId: ownerTarget?.tabId };
            });
            partialScanFailed ||= fallbackFailed;
            if (partialScanFailed) {
                pushDiagnostic('warning', '部分 WebSocket 目标扫描超时');
            }
        } catch (error) {
            pushDiagnostic('error', error?.message || '扫描调试目标失败');
        } finally {
            scanning = false;
            initialScanning = false;
            broadcast();
        }
    };
    /** 手动重新扫描时覆盖刷新目标和枚举目标的完整过程，确保界面持续显示扫描状态。 */
    const rescanTargets = async (): Promise<void> => {
        if (scanning || resettingCapture || uiPorts.size === 0) return;
        scanning = true;
        broadcast();
        blockedTargetIds.clear();
        occupiedTargetIds.clear();
        targetRetryStates.clear();
        try {
            await refreshAttachedTargets();
        } catch (error: unknown) {
            scanning = false;
            pushDiagnostic('error', error instanceof Error ? error.message : '刷新调试目标失败');
            broadcast();
            return;
        }
        scanning = false;
        await scanTargets();
    };
    let targetScanIntervalMs = TARGET_SCAN_INTERVAL_MS;
    const startScanning = () => {
        if (detachTimer) {
            clearTimeout(detachTimer);
            detachTimer = null;
        }
        if (!scanTimer) {
            initialScanning = true;
            scanTimer = setInterval(scanTargets, targetScanIntervalMs);
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
            await Promise.all(Array.from(attachedTargets.keys(), safeDetach));
            for (const targetId of attachedTargets.keys()) removeTarget(targetId);
            await persistenceQueue;
            pausedConnections.clear();
            pauseNewConnections = false;
        }, DETACH_GRACE_MS);
    };
    chrome.debugger.onEvent.addListener((source, method, params) => {
        // 重置期间只负责主动拆除旧会话，忽略旧目标迟到的事件。
        if (resettingCapture) return;
        if (method === 'Target.attachedToTarget') {
            const inspection = inspectAttachedChild(source, (params ?? {}) as AttachedTargetEvent);
            pendingChildInspections.add(inspection);
            void inspection.finally(() => pendingChildInspections.delete(inspection));
            return;
        }
        if (method === 'Target.detachedFromTarget') {
            const event = (params ?? {}) as DetachedTargetEvent;
            const childTargetId = event.targetId || sessionTargetIds.get(event.sessionId);
            if (childTargetId) {
                removeTarget(childTargetId);
                broadcast();
            }
            return;
        }
        const targetId = resolveEventTargetId(source);
        if (!targetId) return;
        if (method === 'Runtime.executionContextCreated') {
            const event = (params ?? {}) as RuntimeExecutionContextCreatedEvent;
            if (!Number.isFinite(event.context?.id)) return;
            const contexts = targetExecutionContexts.get(targetId) || new Set<number>();
            contexts.add(event.context.id);
            targetExecutionContexts.set(targetId, contexts);
            return;
        }
        if (method === 'Runtime.executionContextDestroyed') {
            const event = (params ?? {}) as RuntimeExecutionContextDestroyedEvent;
            targetExecutionContexts.get(targetId)?.delete(event.executionContextId);
            return;
        }
        if (method === 'Runtime.executionContextsCleared') {
            targetExecutionContexts.delete(targetId);
            return;
        }
        if (method === 'Runtime.bindingCalled') {
            const event = (params ?? {}) as RuntimeBindingCalledEvent;
            const target = attachedTargets.get(targetId);
            if (event.name !== '__ycloudWebSocketInspectorFrame' || target?.type !== 'worker') return;
            let runtimeFrame: WorkerRuntimeFrameEvent;
            try {
                runtimeFrame = JSON.parse(event.payload) as WorkerRuntimeFrameEvent;
            } catch {
                return;
            }
            if (
                !runtimeFrame.runtimeId ||
                !runtimeFrame.url ||
                !['received', 'sent'].includes(runtimeFrame.direction) ||
                typeof runtimeFrame.payloadData !== 'string' ||
                !Number.isFinite(runtimeFrame.timestamp)
            ) {
                return;
            }
            const requestId =
                workerSocketAliases.get(targetId)?.get(runtimeFrame.runtimeId) ||
                `runtime:${runtimeFrame.runtimeId}`;
            const sockets = socketMaps.get(targetId);
            if (!sockets) return;
            if (!sockets.has(requestId)) {
                sockets.set(requestId, {
                    url: runtimeFrame.url,
                    createdAt: Date.now(),
                    closedAt: null,
                    status: 'open',
                    urlSource: 'runtime',
                    runtimeId: runtimeFrame.runtimeId,
                });
                workerSocketAliases.get(targetId)?.set(runtimeFrame.runtimeId, requestId);
            }
            upsertConnectionRecord(targetId, requestId, {
                url: runtimeFrame.url,
                status: 'open',
                closedAt: null,
            });
            const connectionKey = targetId + '::' + requestId;
            if (pausedConnections.has(connectionKey)) return;
            const frame = buildFrameRecord({
                id: nextFrameId++,
                direction: runtimeFrame.direction,
                params: {
                    requestId,
                    timestamp: runtimeFrame.timestamp / 1000,
                    response: { opcode: 1, mask: false, payloadData: runtimeFrame.payloadData },
                },
                socketUrl: runtimeFrame.url,
                targetId,
                targetType: target.type,
                targetUrl: target.url,
                receivedAt: runtimeFrame.timestamp,
            });
            frame.captureSource = 'runtime';
            appendFrame(frame);
            return;
        }
        const eventParams = (params ?? {}) as DebuggerEventParams;
        const target = attachedTargets.get(targetId);
        if (!target) return;
        const sockets = socketMaps.get(targetId);
        if (method === 'Network.webSocketCreated') {
            const adoptedSocket = adoptRuntimeSocket(targetId, eventParams.requestId, eventParams.url || '');
            sockets?.set(eventParams.requestId, {
                ...adoptedSocket,
                url: eventParams.url || adoptedSocket?.url || '',
                createdAt: adoptedSocket?.createdAt || Date.now(),
                closedAt: null,
                status: 'connecting',
            });
            if (pauseNewConnections) pausedConnections.add(targetId + '::' + eventParams.requestId);
            upsertConnectionRecord(targetId, eventParams.requestId, {
                url: eventParams.url || adoptedSocket?.url || '',
                createdAt: adoptedSocket?.createdAt || Date.now(),
                closedAt: null,
                status: 'connecting',
            });
            // 新连接创建后刷新运行时引用，后续模拟操作无需再次扫描堆对象。
            void discoverExistingWebSockets(targetId, debuggerTarget(targetId)).then((discoveredSockets) => {
                const currentTarget = attachedTargets.get(targetId);
                if (!currentTarget || !discoveredSockets) return;
                synchronizeDiscoveredSockets(targetId, discoveredSockets);
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
            socket = adoptRuntimeSocket(targetId, eventParams.requestId) || {
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
        const simulationSend =
            direction === 'sent'
                ? consumeSimulationSend(
                      targetId,
                      eventParams.requestId,
                      eventParams.response?.payloadData || '',
                      socket?.url,
                  )
                : null;
        if (simulationSend) return;
        const frame = buildFrameRecord({
            id: nextFrameId++,
            direction,
            params: eventParams,
            socketUrl: socket?.url,
            targetId,
            targetType: target.type,
            targetUrl: target.url,
        });
        frame.captureSource = 'cdp';
        appendFrame(frame);
    });
    chrome.debugger.onDetach.addListener((source, reason) => {
        // resetCaptureSession 会统一清空旧目标，不允许 detach 回调重新写入旧连接。
        if (resettingCapture) return;
        const targetId = resolveEventTargetId(source);
        if (!targetId || !attachedTargets.has(targetId)) return;
        removeTarget(targetId);
        pushDiagnostic('warning', '调试目标已断开: ' + reason, targetId);
        broadcast();
    });
    chrome.runtime.onConnect.addListener((port) => {
        if (port.name !== PORT_NAME) return;
        if (detachTimer) {
            clearTimeout(detachTimer);
            detachTimer = null;
        }
        let disconnected = false;
        const shouldResetCapture = uiPorts.size === 0;
        uiPorts.add(port);
        void (async () => {
            await storeReady;
            if (shouldResetCapture && !captureInitialization) {
                captureInitialization = (async () => {
                    flushFrameBatch();
                    await persistenceQueue;
                    try {
                        await resetCaptureSession();
                    } catch (error) {
                        resettingCapture = false;
                        pushDiagnostic('error', error?.message || '重置捕获数据失败', '', 'storage');
                    }
                })().finally(() => {
                    captureInitialization = null;
                });
            }
            if (captureInitialization) await captureInitialization;
            if (disconnected) return;
            startScanning();
            port.postMessage(serializeState(true));
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
            } else if (command.type === 'set-scan-interval') {
                targetScanIntervalMs = Math.min(600000, Math.max(1000, Math.round(command.intervalMs)));
                if (scanTimer) {
                    clearInterval(scanTimer);
                    scanTimer = setInterval(scanTargets, targetScanIntervalMs);
                }
            } else if (command.type === 'rescan') {
                void rescanTargets();
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
                    '模拟操作响应超时',
                )
                    .catch((error: unknown): RuntimeSimulationResult => ({
                        success: false,
                        message: error instanceof Error ? error.message : '模拟操作执行超时',
                    }))
                    .then((result) => {
                        if (disconnected) return;
                        // 先恢复 Inspector 操作状态，帧标记与补记失败不应让按钮一直停留在执行中。
                        port.postMessage({
                            type: 'simulation-result',
                            simulationResult: { operationId: command.operationId, ...result },
                        } satisfies InspectorMessage);
                        const connectionKey = command.targetId + '::' + command.requestId;
                        if (!result.success && command.action === 'send')
                            removeSimulationSend(connectionKey, command.operationId);
                        if (result.success) {
                            const targetUrl = attachedTargets.get(command.targetId)?.url || '';
                            appendSimulationFrame(command, targetUrl);
                            if (command.action === 'send') {
                                setTimeout(
                                    () => removeSimulationSend(connectionKey, command.operationId),
                                    10000,
                                );
                            }
                        }
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
