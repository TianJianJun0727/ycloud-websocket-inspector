import { FRAME_STORE_LIMITS } from '../../lib/frame-store';
import { bucketFramesByConnection } from '../../lib/inspector-utils';
import type {
    CaptureTarget,
    FrameDirection,
    FrameRecord,
    InspectorCommand,
    InspectorMessage,
    InspectorPort,
} from '../../types/capture';
import { connectionKey } from './inspector-helpers';

/** 为浏览器视觉验收提供与 chrome.runtime.Port 相同的最小接口。 */
export const createDemoPort = (): InspectorPort => {
    let generation = 0;
    const now = Date.now();
    const target: CaptureTarget = {
        id: 'demo-worker',
        title: 'inbox-shared-worker',
        url: 'http://localhost:3091/inbox-web/ws.shared-worker.js',
        attachedAt: now - 120000,
        discoveredSockets: [],
        sockets: [
            {
                requestId: 'socket-demo-1',
                url: 'ws://localhost:8787/inbox',
                createdAt: now - 120000,
                closedAt: null,
                status: 'open',
                capturePaused: false,
            },
            {
                requestId: 'socket-demo-2',
                url: 'wss://push.example.com/notifications',
                createdAt: now - 60000,
                closedAt: null,
                status: 'open',
                capturePaused: false,
            },
        ],
    };
    const samples: Array<[FrameDirection, string, string]> = [
        ['received', 'socket-demo-1', '{"type":"connected","connectionId":"ws-8fd2"}'],
        ['sent', 'socket-demo-1', 'ping'],
        ['received', 'socket-demo-1', 'pong'],
        ['received', 'socket-demo-1', '{"type":"conversation.updated","unreadCount":3}'],
        ['sent', 'socket-demo-2', '{"action":"subscribe","channel":"notifications"}'],
        ['received', 'socket-demo-2', '{"event":"notification.created","id":"notice_78"}'],
    ];
    const requested = Number(new URLSearchParams(location.search).get('demoRows'));
    const count =
        Number.isFinite(requested) && requested > 0
            ? Math.min(requested, FRAME_STORE_LIMITS.maxFramesPerConnection)
            : samples.length;
    const frames: FrameRecord[] = Array.from({ length: count }, (_, index) => {
        const [direction, requestId, payloadData] = samples[index % samples.length]!;
        const payloadBytes = new TextEncoder().encode(payloadData).byteLength;
        return {
            id: index + 1,
            direction,
            requestId,
            payloadData,
            payloadBytes,
            retainedPayloadBytes: payloadBytes,
            opcode: 1,
            mask: false,
            truncated: false,
            socketUrl: requestId.endsWith('1') ? 'ws://localhost:8787/inbox' : 'wss://push.example.com/notifications',
            targetId: target.id,
            targetUrl: target.url,
            receivedAt: now - (count - index) * 730,
            timestamp: index,
        };
    });
    let buckets = bucketFramesByConnection(frames);
    let nextFrameId = frames.length + 1;
    const listeners: Array<(message: InspectorMessage) => void> = [];
    const publishStatus = (): void =>
        listeners.forEach((listener) => listener({ type: 'status', generation, targets: [target], scanning: false }));
    return {
        onMessage: {
            addListener: (listener: (message: InspectorMessage) => void): void => {
                listeners.push(listener);
                queueMicrotask(() =>
                    listener({
                        type: 'state',
                        generation,
                        targets: [target],
                        frameBuckets: buckets,
                        scanning: false,
                        diagnostics: [],
                        limits: FRAME_STORE_LIMITS,
                    }),
                );
            },
        },
        onDisconnect: { addListener: (): void => {} },
        postMessage: (message: InspectorCommand): void => {
            if (message.type === 'clear-connection') {
                const key = connectionKey(message.targetId, message.requestId);
                buckets = { ...buckets, [key]: [] };
                listeners.forEach((listener) =>
                    listener({ type: 'connection-cleared', connectionKey: key, generation }),
                );
            } else if (message.type === 'set-connection-paused' || message.type === 'set-all-connections-paused') {
                target.sockets?.forEach((socket) => {
                    if (message.type === 'set-all-connections-paused' || socket.requestId === message.requestId)
                        socket.capturePaused = message.paused;
                });
                publishStatus();
            } else if (message.type === 'simulate') {
                queueMicrotask(() => {
                    const payloadData =
                        message.action === 'send' || message.action === 'receive'
                            ? message.payload
                            : `[模拟系统事件] ${message.action}`;
                    const payloadBytes = new TextEncoder().encode(payloadData).byteLength;
                    const key = connectionKey(message.targetId, message.requestId);
                    const frame: FrameRecord = {
                        id: nextFrameId++,
                        generation,
                        connectionKey: key,
                        direction: message.action === 'send' ? 'sent' : 'received',
                        requestId: message.requestId,
                        targetId: message.targetId,
                        targetUrl: target.url,
                        socketUrl: message.socketUrl,
                        receivedAt: Date.now(),
                        timestamp: Date.now() / 1000,
                        opcode: 1,
                        mask: false,
                        payloadData,
                        payloadBytes,
                        retainedPayloadBytes: payloadBytes,
                        truncated: false,
                        eventName:
                            message.action === 'send'
                                ? '模拟发送'
                                : `模拟${message.action === 'receive' ? '接收' : message.action}`,
                        simulation:
                            message.action === 'send' ? 'send' : message.action === 'receive' ? 'receive' : 'system',
                    };
                    buckets = { ...buckets, [key]: [...(buckets[key] || []), frame] };
                    listeners.forEach((listener) => {
                        listener({ type: 'frame', generation, frame });
                        listener({
                            type: 'simulation-result',
                            simulationResult: {
                                operationId: message.operationId,
                                success: true,
                                message: message.action === 'send' ? '演示消息已发送' : '演示事件已分发给业务监听器',
                            },
                        });
                    });
                });
            }
        },
        disconnect: (): void => {},
    };
};
