import { Activity, CirclePause, CirclePlay, MessageCircle, ShieldCheck } from 'lucide-react';
import { Fragment } from 'react';

import type { ConnectionRecord } from '../../../types/capture';
import type { ConnectionListFilters } from '../connection-list-filter';
import type { ConnectionGroupField, ConnectionListSort } from '../connection-list-sort';
import {
    connectionStateLabel,
    displayConnection,
    displayDomain,
    displayUrl,
    formatConnectionTime,
    targetTypeLabel,
} from '../inspector-helpers';
import { ConnectionFilters } from './ConnectionFilters';

interface ConnectionSidebarProps {
    connections: ConnectionRecord[];
    domains: string[];
    filteredConnections: ConnectionRecord[];
    filters: ConnectionListFilters;
    group: ConnectionGroupField;
    sort: ConnectionListSort;
    paused: boolean;
    selectedConnection: string | null;
    totalFrames: number;
    onFiltersChange: (filters: ConnectionListFilters) => void;
    onGroupChange: (group: ConnectionGroupField) => void;
    onSortChange: (sort: ConnectionListSort) => void;
    onSelect: (key: string) => void;
    onToggleAll: () => void;
    onToggleConnection: (value: ConnectionRecord) => void;
}

/** 根据当前排序字段生成连接列表分组标题。 */
const connectionGroupLabel = (connection: ConnectionRecord, group: ConnectionGroupField): string | null => {
    if (group === 'type') return targetTypeLabel(connection.targetType);
    if (group === 'tab') {
        return typeof connection.tabId === 'number' ? `标签页 ${connection.tabId}` : 'SharedWorker';
    }
    if (group === 'name') return displayConnection(connection);
    return null;
};

interface GroupedConnectionRow {
    connection: ConnectionRecord;
    groupLabel: string | null;
    showGroupHeader: boolean;
}

/** 聚合相同分组的连接，并保留每组内部已有的排序顺序。 */
const groupConnectionRows = (
    connections: ConnectionRecord[],
    group: ConnectionGroupField,
    sort: ConnectionListSort,
): GroupedConnectionRow[] => {
    if (group === 'none') {
        return connections.map((connection) => ({ connection, groupLabel: null, showGroupHeader: false }));
    }
    const groups = new Map<string, ConnectionRecord[]>();
    for (const connection of connections) {
        const label = connectionGroupLabel(connection, group) || '其他';
        const values = groups.get(label) || [];
        values.push(connection);
        groups.set(label, values);
    }
    const groupDirection = sort.field === group && sort.direction === 'desc' ? -1 : 1;
    const orderedGroups = [...groups].sort(([leftLabel, leftValues], [rightLabel, rightValues]) => {
        if (group === 'type') {
            const typeOrder: Record<ConnectionRecord['targetType'], number> = {
                page: 0,
                worker: 1,
                shared_worker: 2,
            };
            return (typeOrder[leftValues[0]!.targetType] - typeOrder[rightValues[0]!.targetType]) * groupDirection;
        }
        if (group === 'tab') {
            const leftTabId = leftValues[0]!.tabId;
            const rightTabId = rightValues[0]!.tabId;
            if (typeof leftTabId !== 'number') return 1;
            if (typeof rightTabId !== 'number') return -1;
            return (leftTabId - rightTabId) * groupDirection;
        }
        return (
            leftLabel.localeCompare(rightLabel, 'zh-CN', { numeric: true, sensitivity: 'base' }) * groupDirection
        );
    });
    return orderedGroups.flatMap(([groupLabel, values]) =>
        values.map((connection, index) => ({
            connection,
            groupLabel,
            showGroupHeader: index === 0,
        })),
    );
};

/** 展示整体监听状态、提示信息和可切换的连接列表。 */
export const ConnectionSidebar = ({
    connections,
    domains,
    filteredConnections,
    filters,
    group,
    sort,
    paused,
    selectedConnection,
    totalFrames,
    onFiltersChange,
    onGroupChange,
    onSortChange,
    onSelect,
    onToggleAll,
    onToggleConnection,
}: ConnectionSidebarProps) => {
    const activeConnections = connections.filter(({ status }) => status !== 'closed');
    /** 以本地时间展示单次 WebSocket 连接的起止区间。 */
    const formatConnectionRange = (connection: ConnectionRecord): string => {
        const start = formatConnectionTime(connection.createdAt, '未知');
        const end = connection.closedAt ? formatConnectionTime(connection.closedAt, '未知') : '现在';
        return `${start} — ${end}`;
    };

    return (
        <aside className="connection-sidebar">
            <section className="overview-section">
                <h2>概览</h2>
                <div className="side-card overview-card">
                    <div className="overview-metrics">
                        <div className="overview-metric">
                            <Activity size={18} />
                            <strong>{connections.length}</strong>
                            <span>连接总数</span>
                        </div>
                        <div className="overview-metric">
                            <MessageCircle size={18} />
                            <strong>{totalFrames}</strong>
                            <span>消息总数</span>
                        </div>
                    </div>
                </div>
            </section>
            <section className="connection-list-section">
                <div className="connection-list-heading">
                    <span>
                        连接列表{' '}
                        <small>
                            {filteredConnections.length === connections.length
                                ? connections.length
                                : `${filteredConnections.length} / ${connections.length}`}
                        </small>
                    </span>
                    <button
                        className="bare-button"
                        disabled={!activeConnections.length}
                        onClick={onToggleAll}
                        title={paused ? '全部继续记录' : '全部暂停记录'}
                        type="button"
                    >
                        {paused ? <CirclePlay size={17} /> : <CirclePause size={17} />}
                    </button>
                </div>
                <ConnectionFilters
                    domains={domains}
                    filters={filters}
                    group={group}
                    sort={sort}
                    onChange={onFiltersChange}
                    onGroupChange={onGroupChange}
                    onSortChange={onSortChange}
                />
                <div className="connection-list" role="listbox" aria-label="WebSocket 连接">
                    {groupConnectionRows(filteredConnections, group, sort).map(
                        ({ connection, groupLabel, showGroupHeader }) => {
                        return (
                            <Fragment key={connection.key}>
                                {groupLabel && showGroupHeader && (
                                    <div className="connection-group-header">
                                        <span>{groupLabel}</span>
                                    </div>
                                )}
                        <button
                            aria-selected={selectedConnection === connection.key}
                            className={`connection-item${selectedConnection === connection.key ? ' is-selected' : ''}`}
                            onClick={() => onSelect(connection.key)}
                            role="option"
                            type="button"
                        >
                            <span className={`connection-dot status-${connection.status}`} />
                            <span className="connection-copy">
                                <strong title={connection.url || connection.targetUrl}>
                                    {displayConnection(connection)}
                                </strong>
                                <small className="connection-owner-line" title={connection.targetUrl}>
                                    <span className="connection-domain">
                                        {connection.targetType === 'page' || connection.targetType === 'worker'
                                            ? displayDomain(connection.targetUrl)
                                            : displayUrl(connection.targetUrl, '未知运行环境')}
                                    </span>
                                    <span className="connection-owner-badges">
                                        <span className={`connection-target-badge target-${connection.targetType}`}>
                                            {targetTypeLabel(connection.targetType)}
                                        </span>
                                        {(connection.targetType === 'page' || connection.targetType === 'worker') &&
                                            typeof connection.tabId === 'number' && (
                                                <span
                                                    className={`connection-target-badge target-${connection.targetType} connection-tab-id`}
                                                >
                                                    {connection.tabId}
                                                </span>
                                            )}
                                    </span>
                                </small>
                                <small className="connection-status-line">
                                    {connection.frameCount} 条 · {connectionStateLabel(connection)}
                                </small>
                                <small className="connection-time">{formatConnectionRange(connection)}</small>
                            </span>
                            {connection.status !== 'closed' && (
                                <span
                                    className={`mini-switch${!connection.capturePaused ? ' is-on' : ''}`}
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        onToggleConnection(connection);
                                    }}
                                    role="switch"
                                    aria-checked={!connection.capturePaused}
                                    aria-label={connection.capturePaused ? '继续记录' : '暂停记录'}
                                    tabIndex={0}
                                >
                                    <span />
                                </span>
                            )}
                        </button>
                            </Fragment>
                        );
                        },
                    )}
                    {!connections.length && <p className="empty-copy">正在发现 WebSocket 连接…</p>}
                    {Boolean(connections.length) && !filteredConnections.length && (
                        <p className="empty-copy">没有符合条件的连接</p>
                    )}
                </div>
            </section>
            <section className="side-card notice-card">
                <div className="notice-icon" aria-hidden="true">
                    <ShieldCheck size={17} />
                </div>
                <div className="notice-copy">
                    <p>仅记录消息，不会中断业务连接。</p>
                </div>
            </section>
        </aside>
    );
};
