/** 按帧 ID 合并批次、移除淘汰项并保留最新窗口。 */
export const mergeFrameBatch = <T extends { id: number }>(
    currentFrames: T[],
    incomingFrames: T[],
    evictedFrameIds: number[] = [],
    maximum: number,
): T[] => {
    const evicted = new Set(evictedFrameIds || []);
    const byId = new Map();
    for (const frame of currentFrames) {
        if (!evicted.has(frame.id)) byId.set(frame.id, frame);
    }
    for (const frame of incomingFrames || []) {
        if (!evicted.has(frame.id)) byId.set(frame.id, frame);
    }
    const merged = [...byId.values()].sort((left, right) => left.id - right.id);
    return merged.length > maximum ? merged.slice(-maximum) : merged;
};
/** 将平铺帧按目标和 requestId 分桶。 */
export const bucketFramesByConnection = <T extends { targetId: string; requestId: string }>(
    frames: T[],
): Record<string, T[]> => {
    const buckets: Record<string, T[]> = {};
    for (const frame of frames || []) {
        const key = frame.targetId + '::' + frame.requestId;
        (buckets[key] ||= []).push(frame);
    }
    return buckets;
};
/** 按连接合并批次，淘汰操作不会跨 WebSocket requestId 传播。 */
export const mergeFrameBuckets = <T extends { id: number; targetId: string; requestId: string }>(
    currentBuckets: Record<string, T[]>,
    incomingFrames: T[],
    evictedFrameIds: number[],
    maximumPerConnection: number,
): Record<string, T[]> => {
    const incomingBuckets = bucketFramesByConnection(incomingFrames);
    const keys = new Set([...Object.keys(currentBuckets || {}), ...Object.keys(incomingBuckets)]);
    const nextBuckets: Record<string, T[]> = {};
    for (const key of keys) {
        const merged = mergeFrameBatch(
            currentBuckets?.[key] || [],
            incomingBuckets[key] || [],
            evictedFrameIds,
            maximumPerConnection,
        );
        if (merged.length > 0) nextBuckets[key] = merged;
    }
    return nextBuckets;
};
/** 按捕获时间稳定排序，并按指定方向返回最近窗口。 */
export const orderRecentFrames = <T extends { id: number; receivedAt?: number; timestamp?: number }>(
    frames: T[],
    sortOrder: 'asc' | 'desc',
    limit: number,
): T[] => {
    const ordered = [...frames].sort((left, right) => {
        const capturedAtDifference = (left.receivedAt || 0) - (right.receivedAt || 0);
        if (capturedAtDifference !== 0) return capturedAtDifference;
        const protocolTimeDifference = (left.timestamp || 0) - (right.timestamp || 0);
        if (protocolTimeDifference !== 0) return protocolTimeDifference;
        return left.id - right.id;
    });
    const limited = ordered.slice(-limit);
    return sortOrder === 'asc' ? limited : limited.reverse();
};
/** 优先采用后台快照，缺失时回退到帧推导结果。 */
export const resolveConnectionRecords = <T>(connectionSnapshot: T[] | null, fallbackRecords: T[]): T[] => {
    return Array.isArray(connectionSnapshot) ? connectionSnapshot : fallbackRecords;
};
/** 判断诊断是否仍在有效期内，永久错误不会过期。 */
export const isActiveDiagnostic = (diagnostic: { expiresAt?: number | null }, now = Date.now()): boolean => {
    return !diagnostic.expiresAt || diagnostic.expiresAt > now;
};
/** 安全解析 `/pattern/flags` 搜索语法。 */
const parseRegexFilter = (query: string): RegExp | null => {
    if (!query.startsWith('/')) return null;
    const lastSlash = query.lastIndexOf('/');
    if (lastSlash <= 0) return null;
    const pattern = query.slice(1, lastSlash);
    const flags = query.slice(lastSlash + 1);
    try {
        return new RegExp(pattern, flags);
    } catch {
        return null;
    }
};
/** 支持普通文本和正则两种方式匹配帧字段。 */
export const matchesTextFilter = (values: unknown[], query: string, regexValue: unknown = values.at(-1)): boolean => {
    const normalized = query.trim();
    if (!normalized) return true;
    const regex = parseRegexFilter(normalized);
    if (regex) {
        regex.lastIndex = 0;
        return regex.test(String(regexValue || ''));
    }
    const text = normalized.toLowerCase();
    return values.some((value) =>
        String(value || '')
            .toLowerCase()
            .includes(text),
    );
};
