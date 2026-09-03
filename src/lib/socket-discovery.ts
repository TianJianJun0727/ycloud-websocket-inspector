import type { DiscoveredSocket, SocketRecord } from '../types/capture';

export interface IdentifiedSocket {
    requestId: string;
    socket: SocketRecord;
}

/** 将运行时 readyState 转换为连接列表使用的状态。 */
const runtimeSocketStatus = (readyState: number): SocketRecord['status'] => (readyState === 0 ? 'connecting' : 'open');

/**
 * 将 Runtime.queryObjects 发现的活动连接补成可展示的占位连接。
 * 已经收到 CDP requestId 的真实连接会抵扣同 URL 占位数量，避免重复统计。
 */
export const reconcileRuntimeSockets = (
    existingSockets: Iterable<[string, SocketRecord]>,
    discoveredSockets: DiscoveredSocket[],
    createRequestId: () => string,
    now = Date.now(),
): IdentifiedSocket[] => {
    const existing = [...existingSockets];
    const realSocketCounts = new Map<string, number>();
    const runtimeSockets = new Map<string, IdentifiedSocket[]>();

    for (const [requestId, socket] of existing) {
        if (!socket.url || socket.status === 'closed') continue;
        if (socket.urlSource === 'runtime') {
            const candidates = runtimeSockets.get(socket.url) || [];
            candidates.push({ requestId, socket });
            runtimeSockets.set(socket.url, candidates);
        } else {
            realSocketCounts.set(socket.url, (realSocketCounts.get(socket.url) || 0) + 1);
        }
    }

    const discoveredByUrl = new Map<string, DiscoveredSocket[]>();
    for (const socket of discoveredSockets) {
        if (!socket.url || socket.readyState > 1) continue;
        const candidates = discoveredByUrl.get(socket.url) || [];
        candidates.push(socket);
        discoveredByUrl.set(socket.url, candidates);
    }

    const result: IdentifiedSocket[] = [];
    for (const [url, discovered] of discoveredByUrl) {
        const requiredCount = Math.max(0, discovered.length - (realSocketCounts.get(url) || 0));
        const reusable = runtimeSockets.get(url) || [];
        for (let index = 0; index < requiredCount; index += 1) {
            const previous = reusable[index];
            result.push({
                requestId: previous?.requestId || createRequestId(),
                socket: {
                    url,
                    createdAt: previous?.socket.createdAt || now,
                    closedAt: null,
                    status: runtimeSocketStatus(discovered[index]?.readyState ?? 1),
                    urlSource: 'runtime',
                },
            });
        }
    }
    return result;
};
