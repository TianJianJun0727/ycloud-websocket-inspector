import dayjs from 'dayjs';

import type {
    CaptureTarget,
    ConnectionRecord,
    FrameRecord,
    SocketRecord,
    WebSocketTargetType,
} from '../../types/capture';

/** 将数值限制在给定闭区间内。 */
export const clamp = (value: number, minimum: number, maximum: number): number =>
    Math.min(maximum, Math.max(minimum, value));

/** 为目标与 WebSocket requestId 生成稳定连接主键。 */
export const connectionKey = (targetId: string, requestId: string): string => `${targetId}::${requestId}`;

/** 使用本地时区展示抓包时间，避免跨天记录产生歧义。 */
export const formatClock = (timestamp: number): string => {
    return dayjs(timestamp).format('YYYY-MM-DD HH:mm:ss.SSS');
};

/** 格式化连接时间，并为缺失值提供业务文案。 */
export const formatConnectionTime = (timestamp: number | null | undefined, fallback: string): string =>
    timestamp ? dayjs(timestamp).format('YYYY-MM-DD HH:mm:ss') : fallback;

/** 缩短 URL 以适配连接列表，非法 URL 则保留原值。 */
export const displayUrl = (url: string, fallback = '未知 URL'): string => {
    if (!url) return fallback;
    try {
        const parsed = new URL(url);
        return parsed.host + parsed.pathname;
    } catch {
        return url;
    }
};

/** 仅展示 URL 域名，用于标识页面类型连接的所属站点。 */
export const displayDomain = (url: string, fallback = '未知域名'): string => {
    if (!url) return fallback;
    try {
        const parsed = new URL(url);
        if (parsed.host) return parsed.host;
        // Blob Worker 的 URL 本身没有 host，但 origin 保留了所属页面域名。
        if (parsed.origin && parsed.origin !== 'null') return new URL(parsed.origin).host || fallback;
        return fallback;
    } catch {
        return url;
    }
};

/** 将连接来源转换为连接列表和详情共用的短标签。 */
export const targetTypeLabel = (targetType: WebSocketTargetType | undefined): string => {
    if (targetType === 'page') return '页面';
    if (targetType === 'worker') return 'Web Worker';
    return 'SharedWorker';
};

/** 优先展示 WebSocket URL，缺失时回退到运行环境与 requestId。 */
export const displayConnection = (connection: { url?: string; targetUrl: string; requestId: string }): string =>
    connection.url
        ? displayUrl(connection.url)
        : `${displayUrl(connection.targetUrl, '运行环境')} · WS #${String(connection.requestId).slice(-8)}`;

/** 将连接运行状态转换为用户可读标签。 */
export const connectionStateLabel = (connection: ConnectionRecord): string => {
    if (connection.status === 'closed') return '已关闭';
    if (connection.capturePaused) return '已暂停记录';
    return connection.status === 'connecting' ? '连接中' : '记录中';
};

/** 合并后台目标快照与已收到的帧，保证漏掉 created 事件时仍可展示连接。 */
export const buildConnections = (
    targets: CaptureTarget[],
    buckets: Record<string, FrameRecord[]>,
): ConnectionRecord[] => {
    const result: ConnectionRecord[] = [];
    for (const target of targets) {
        const sockets = new Map<string, SocketRecord & { requestId: string; capturePaused?: boolean }>(
            (target.sockets || []).map((socket) => [socket.requestId, socket]),
        );
        for (const bucket of Object.values(buckets)) {
            const frame = bucket[0];
            if (!frame || frame.targetId !== target.id || sockets.has(frame.requestId)) continue;
            sockets.set(frame.requestId, {
                requestId: frame.requestId,
                url: frame.socketUrl,
                createdAt: frame.receivedAt,
                closedAt: null,
                status: 'open',
            });
        }
        for (const socket of sockets.values()) {
            const key = connectionKey(target.id, socket.requestId);
            const frames = buckets[key] || [];
            result.push({
                key,
                targetId: target.id,
                tabId: target.tabId,
                targetType: target.type || frames[0]?.targetType || 'shared_worker',
                targetTitle: target.title || targetTypeLabel(target.type),
                targetUrl: target.url,
                requestId: socket.requestId,
                url: socket.url || frames.at(-1)?.socketUrl || '',
                createdAt: socket.createdAt || frames[0]?.receivedAt || null,
                closedAt: socket.closedAt,
                status: socket.status || (socket.closedAt ? 'closed' : 'open'),
                capturePaused: Boolean(socket.capturePaused),
                frameCount: frames.length,
            });
        }
    }
    return result;
};
