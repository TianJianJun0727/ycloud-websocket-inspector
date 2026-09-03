import type { ConnectionRecord, WebSocketTargetType } from '../../types/capture';

/** 连接列表可筛选的业务状态。 */
export type ConnectionListStatus = 'recording' | 'connecting' | 'paused' | 'closed';

/** 左侧连接列表的组合筛选条件。 */
export interface ConnectionListFilters {
    search: string;
    targetTypes: WebSocketTargetType[];
    statuses: ConnectionListStatus[];
    domains: string[];
}

/** 连接列表默认展示全部数据。 */
export const DEFAULT_CONNECTION_LIST_FILTERS: ConnectionListFilters = {
    search: '',
    targetTypes: [],
    statuses: [],
    domains: [],
};

/** 从本地存储安全恢复高级筛选，搜索词保持为临时状态。 */
export const parseConnectionListFilters = (value: string | null): ConnectionListFilters => {
    if (!value) return DEFAULT_CONNECTION_LIST_FILTERS;
    try {
        const parsed: unknown = JSON.parse(value);
        if (!parsed || typeof parsed !== 'object') return DEFAULT_CONNECTION_LIST_FILTERS;
        const record = parsed as Record<string, unknown>;
        const targetTypes = Array.isArray(record.targetTypes)
            ? record.targetTypes.filter(
                  (item): item is WebSocketTargetType =>
                      item === 'page' || item === 'worker' || item === 'shared_worker',
              )
            : [];
        const statuses = Array.isArray(record.statuses)
            ? record.statuses.filter(
                  (item): item is ConnectionListStatus =>
                      item === 'recording' || item === 'connecting' || item === 'paused' || item === 'closed',
              )
            : [];
        const domains = Array.isArray(record.domains)
            ? record.domains.filter((item): item is string => typeof item === 'string')
            : [];
        return { search: '', targetTypes, statuses, domains };
    } catch {
        return DEFAULT_CONNECTION_LIST_FILTERS;
    }
};

/** 提取 WebSocket 地址的域名，地址无效时回退到原始文本。 */
export const connectionDomain = (connection: ConnectionRecord): string => {
    const source = connection.url || connection.targetUrl;
    if (!source) return '未知域名';
    try {
        return new URL(source).host;
    } catch {
        return source;
    }
};

/** 将连接状态映射为列表筛选使用的互斥状态。 */
export const connectionListStatus = (connection: ConnectionRecord): ConnectionListStatus => {
    if (connection.status === 'closed') return 'closed';
    if (connection.capturePaused) return 'paused';
    return connection.status === 'connecting' ? 'connecting' : 'recording';
};

/** 汇总连接中可供选择的 WebSocket 域名。 */
export const collectConnectionDomains = (connections: ConnectionRecord[]): string[] =>
    [...new Set(connections.map(connectionDomain))].sort((left, right) => left.localeCompare(right));

/** 判断关键词字符是否按顺序出现在目标文本中，用于连接名称的轻量模糊匹配。 */
const fuzzyIncludes = (source: string, keyword: string): boolean => {
    if (source.includes(keyword)) return true;
    let keywordIndex = 0;
    for (const character of source) {
        if (character === keyword[keywordIndex]) keywordIndex += 1;
        if (keywordIndex === keyword.length) return true;
    }
    return false;
};

/** 按搜索、运行环境、状态和域名组合筛选连接。 */
export const filterConnections = (
    connections: ConnectionRecord[],
    filters: ConnectionListFilters,
): ConnectionRecord[] => {
    const keywords = filters.search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return connections.filter((connection) => {
        const domain = connectionDomain(connection);
        const searchableText = [connection.url, domain].join(' ').toLocaleLowerCase();
        const matchesSearch = keywords.every((keyword) => fuzzyIncludes(searchableText, keyword));
        const matchesType = !filters.targetTypes.length || filters.targetTypes.includes(connection.targetType);
        const matchesStatus = !filters.statuses.length || filters.statuses.includes(connectionListStatus(connection));
        const matchesDomain = !filters.domains.length || filters.domains.includes(domain);
        return matchesSearch && matchesType && matchesStatus && matchesDomain;
    });
};
