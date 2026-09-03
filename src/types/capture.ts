/** WebSocket 帧方向。 */
export type FrameDirection = 'received' | 'sent';

/** WebSocket 所在的浏览器运行环境。 */
export type WebSocketTargetType = 'page' | 'worker' | 'shared_worker';

/** Inspector 在内存、IndexedDB 和 UI 之间传递的标准帧结构。 */
export interface FrameRecord {
    id: number;
    generation?: number;
    connectionKey?: string;
    direction: FrameDirection;
    requestId: string;
    targetId: string;
    targetType: WebSocketTargetType;
    targetUrl: string;
    socketUrl: string;
    receivedAt: number;
    timestamp: number;
    opcode: number;
    mask?: boolean;
    payloadData: string;
    payloadBytes: number;
    retainedPayloadBytes: number;
    truncated: boolean;
    eventName?: string;
    simulation?: 'send' | 'receive' | 'system';
    captureSource?: 'cdp' | 'runtime';
}

/** 一次 WebSocket 连接实例，requestId 不同即视为不同连接。 */
export interface ConnectionRecord {
    key: string;
    targetId: string;
    tabId?: number;
    targetType: WebSocketTargetType;
    targetTitle: string;
    targetUrl: string;
    requestId: string;
    url: string;
    createdAt: number | null;
    closedAt?: number | null;
    status: 'connecting' | 'open' | 'closed';
    capturePaused?: boolean;
    frameCount?: number;
}

export interface ConnectionFilter {
    direction: 'all' | FrameDirection;
    search: string;
}

export interface CaptureDiagnostic {
    id: string;
    level: 'info' | 'warning' | 'error';
    message: string;
    targetId: string;
    source: 'capture' | 'storage' | 'websocket';
    timestamp: number;
    expiresAt: number | null;
}

/** WebSocket 在后台捕获过程中的运行状态。 */
export interface SocketRecord {
    url: string;
    createdAt: number | null;
    closedAt: number | null;
    status: 'connecting' | 'open' | 'closed';
    urlSource?: 'runtime';
}

/** 通过目标运行时扫描发现的 WebSocket。 */
export interface DiscoveredSocket {
    url: string;
    readyState: number;
    protocol?: string;
    runtimeId?: string;
}

/** Inspector 展示的捕获目标快照。 */
export interface CaptureTarget {
    id: string;
    tabId?: number;
    type: WebSocketTargetType;
    title: string;
    url: string;
    attachedAt: number;
    discoveredSockets: DiscoveredSocket[];
    sockets?: Array<
        SocketRecord & {
            requestId: string;
            capturePaused?: boolean;
        }
    >;
}

/** 帧缓存的容量限制。 */
export interface FrameStoreLimits {
    maxFrameCount: number;
    maxFramesPerConnection: number;
    maxTotalBytes: number | null;
}

/** 模拟面板支持的 WebSocket 操作。 */
export type SimulationAction = 'send' | 'receive' | 'open' | 'error' | 'close';

/** 模拟操作的执行结果。 */
export interface SimulationResult {
    operationId: string;
    success: boolean;
    message: string;
}

/** Inspector 可发送给后台的命令。 */
export type InspectorCommand =
    | { type: 'rescan' }
    | { type: 'set-scan-interval'; intervalMs: number }
    | { type: 'clear' }
    | { type: 'clear-connection'; targetId: string; requestId: string }
    | { type: 'set-connection-paused'; targetId: string; requestId: string; paused: boolean }
    | { type: 'set-all-connections-paused'; paused: boolean }
    | {
          type: 'simulate';
          operationId: string;
          targetId: string;
          requestId: string;
          socketUrl: string;
          action: SimulationAction;
          payload: string;
          closeCode?: number;
          closeReason?: string;
      };

/** 后台推送给 Inspector 的统一消息结构。 */
export interface InspectorMessage {
    type: 'state' | 'status' | 'frame' | 'frame-batch' | 'cleared' | 'connection-cleared' | 'simulation-result';
    generation?: number;
    frame?: FrameRecord;
    frames?: FrameRecord[];
    evictedFrameIds?: number[];
    frameBuckets?: Record<string, FrameRecord[]>;
    targets?: CaptureTarget[];
    connections?: ConnectionRecord[];
    diagnostics?: CaptureDiagnostic[];
    limits?: FrameStoreLimits;
    scanning?: boolean;
    connectionKey?: string;
    simulationResult?: SimulationResult;
}

/** Chrome Port 与演示 Port 共用的最小通信接口。 */
export interface InspectorPort {
    onMessage: {
        addListener: (listener: (message: InspectorMessage) => void) => void;
    };
    onDisconnect: {
        addListener: (listener: () => void) => void;
    };
    postMessage: (message: InspectorCommand) => void;
    disconnect: () => void;
}
