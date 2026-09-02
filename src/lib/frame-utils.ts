export const MAX_PAYLOAD_CHARS = 1024 * 1024;
// 只从稳定的通用字段推断事件名，不绑定任何 YCloud 业务协议。
const EVENT_KEYS = ['key', 'event', 'type', 'method', 'action', 'topic'];
/** 仅解析文本帧，失败时返回空值且不影响抓包。 */
export const parseJsonPayload = (payloadData: unknown, opcode = 1): unknown => {
    if (opcode !== 1 || typeof payloadData !== 'string') return null;
    try {
        return JSON.parse(payloadData);
    } catch {
        return null;
    }
};
/** 从通用字段推断事件名，不耦合具体业务协议。 */
export const inferEventName = (payloadData: unknown, opcode = 1): string => {
    if (opcode !== 1) return 'binary';
    const normalized = String(payloadData).trim().toLowerCase();
    if (normalized === 'ping' || normalized === 'pong') return normalized;
    const parsed = parseJsonPayload(payloadData, opcode);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return 'message';
    const record = parsed as Record<string, unknown>;
    for (const key of EVENT_KEYS) {
        const value = record[key];
        if (typeof value === 'string' && value) return value;
    }
    return 'json';
};
/** 按 UTF-8 编码计算 payload 的真实字节数。 */
export const getPayloadByteSize = (payloadData: unknown): number => {
    return new TextEncoder().encode(String(payloadData ?? '')).byteLength;
};
/** 将 Chrome Debugger payload 归一化为存储层和 UI 共用的帧结构。 */
export const buildFrameRecord = ({
    id,
    direction,
    params,
    socketUrl,
    targetId,
    targetType,
    targetUrl,
    receivedAt = Date.now(),
}: {
    id: number;
    direction: FrameDirection;
    params: {
        requestId: string;
        timestamp: number;
        response?: { payloadData?: string; opcode?: number; mask?: boolean };
    };
    socketUrl?: string;
    targetId: string;
    targetType: WebSocketTargetType;
    targetUrl: string;
    receivedAt?: number;
}): FrameRecord => {
    const originalPayload = String(params.response?.payloadData ?? '');
    const truncated = originalPayload.length > MAX_PAYLOAD_CHARS;
    const payloadData = truncated ? originalPayload.slice(0, MAX_PAYLOAD_CHARS) : originalPayload;
    return {
        id,
        direction,
        receivedAt,
        requestId: params.requestId,
        timestamp: params.timestamp,
        socketUrl: socketUrl || '',
        targetId,
        targetType,
        targetUrl,
        opcode: params.response?.opcode ?? 1,
        mask: Boolean(params.response?.mask),
        eventName: inferEventName(payloadData, params.response?.opcode),
        payloadData,
        payloadBytes: getPayloadByteSize(originalPayload),
        retainedPayloadBytes: getPayloadByteSize(payloadData),
        truncated,
    };
};
/** 将字节数转换为适合 Inspector 展示的紧凑单位。 */
export const formatByteSize = (bytes: number): string => {
    if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};
import type { FrameDirection, FrameRecord, WebSocketTargetType } from '../types/capture';
