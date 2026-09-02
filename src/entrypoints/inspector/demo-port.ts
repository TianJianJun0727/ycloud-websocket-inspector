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
            }
        },
        disconnect: (): void => {},
    };
};
