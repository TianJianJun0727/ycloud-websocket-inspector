import type { ConnectionRecord, WebSocketTargetType } from '../../types/capture';

export type ConnectionSortField = 'time' | 'type' | 'tab' | 'name' | 'frameCount';
export type ConnectionSortDirection = 'asc' | 'desc';
export type ConnectionGroupField = 'none' | 'type' | 'tab' | 'name';

export interface ConnectionListSort {
    field: ConnectionSortField;
    direction: ConnectionSortDirection;
}

export const DEFAULT_CONNECTION_LIST_SORT: ConnectionListSort = { field: 'type', direction: 'asc' };
export const DEFAULT_CONNECTION_GROUP: ConnectionGroupField = 'none';

const TARGET_TYPE_ORDER: Record<WebSocketTargetType, number> = {
    page: 0,
    worker: 1,
    shared_worker: 2,
};

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

/** 将 WebSocket URL 转换为名称排序使用的域名与路径。 */
const connectionSortName = (connection: ConnectionRecord): string => {
    if (!connection.url) return '';
    try {
        const parsed = new URL(connection.url);
        return `${parsed.host}${parsed.pathname}`;
    } catch {
        return connection.url;
    }
};

/** 从本地存储中安全恢复连接排序偏好。 */
export const parseConnectionListSort = (value: string | null): ConnectionListSort => {
    if (!value) return DEFAULT_CONNECTION_LIST_SORT;
    try {
        const parsed: unknown = JSON.parse(value);
        if (!parsed || typeof parsed !== 'object') return DEFAULT_CONNECTION_LIST_SORT;
        const record = parsed as Record<string, unknown>;
        const fields: ConnectionSortField[] = ['time', 'type', 'tab', 'name', 'frameCount'];
        if (!fields.includes(record.field as ConnectionSortField)) return DEFAULT_CONNECTION_LIST_SORT;
        if (record.direction !== 'asc' && record.direction !== 'desc') return DEFAULT_CONNECTION_LIST_SORT;
        return { field: record.field as ConnectionSortField, direction: record.direction };
    } catch {
        return DEFAULT_CONNECTION_LIST_SORT;
    }
};

/** 从本地存储中安全恢复连接分组偏好。 */
export const parseConnectionGroup = (value: string | null): ConnectionGroupField => {
    return value === 'type' || value === 'tab' || value === 'name' ? value : DEFAULT_CONNECTION_GROUP;
};

/** 按用户选择排序连接，并使用时间与连接键保证结果稳定。 */
export const sortConnections = (connections: ConnectionRecord[], sort: ConnectionListSort): ConnectionRecord[] => {
    const direction = sort.direction === 'asc' ? 1 : -1;
    return connections.map((connection, index) => ({ connection, index })).sort((left, right) => {
        const leftConnection = left.connection;
        const rightConnection = right.connection;
        let difference = 0;
        if (sort.field === 'time') {
            if (leftConnection.createdAt === null && rightConnection.createdAt !== null) return 1;
            if (leftConnection.createdAt !== null && rightConnection.createdAt === null) return -1;
            difference = (leftConnection.createdAt || 0) - (rightConnection.createdAt || 0);
        } else if (sort.field === 'type') {
            difference = TARGET_TYPE_ORDER[leftConnection.targetType] - TARGET_TYPE_ORDER[rightConnection.targetType];
        } else if (sort.field === 'tab') {
            const leftHasTab = typeof leftConnection.tabId === 'number';
            const rightHasTab = typeof rightConnection.tabId === 'number';
            // SharedWorker 没有所属标签页，无论升降序都固定排在末尾。
            if (!leftHasTab && rightHasTab) return 1;
            if (leftHasTab && !rightHasTab) return -1;
            difference = (leftConnection.tabId || 0) - (rightConnection.tabId || 0);
        } else if (sort.field === 'name') {
            const leftName = connectionSortName(leftConnection);
            const rightName = connectionSortName(rightConnection);
            if (!leftName && rightName) return 1;
            if (leftName && !rightName) return -1;
            difference = collator.compare(leftName, rightName);
        } else {
            difference = (leftConnection.frameCount || 0) - (rightConnection.frameCount || 0);
        }
        if (difference !== 0) return difference * direction;
        if (sort.field === 'tab') {
            const typeDifference =
                TARGET_TYPE_ORDER[leftConnection.targetType] - TARGET_TYPE_ORDER[rightConnection.targetType];
            if (typeDifference !== 0) return typeDifference;
        }
        const timeDifference = (rightConnection.createdAt || 0) - (leftConnection.createdAt || 0);
        if (timeDifference !== 0) return timeDifference;
        const keyDifference = collator.compare(leftConnection.key, rightConnection.key);
        return keyDifference || left.index - right.index;
    }).map(({ connection }) => connection);
};
