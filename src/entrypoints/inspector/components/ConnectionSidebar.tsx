import { Activity, CirclePause, CirclePlay, MessageCircle, ShieldCheck } from 'lucide-react';

import type { ConnectionRecord } from '../../../types/capture';
import type { ConnectionListFilters } from '../connection-list-filter';
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
    paused: boolean;
    selectedConnection: string | null;
    totalFrames: number;
    onFiltersChange: (filters: ConnectionListFilters) => void;
    onSelect: (key: string) => void;
    onToggleAll: () => void;
    onToggleConnection: (value: ConnectionRecord) => void;
}

/** 展示整体监听状态、提示信息和可切换的连接列表。 */
export const ConnectionSidebar = ({
    connections,
    domains,
    filteredConnections,
    filters,
    paused,
    selectedConnection,
    totalFrames,
    onFiltersChange,
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
                <ConnectionFilters domains={domains} filters={filters} onChange={onFiltersChange} />
                <div className="connection-list" role="listbox" aria-label="WebSocket 连接">
                    {filteredConnections.map((connection) => (
                        <button
                            aria-selected={selectedConnection === connection.key}
                            className={`connection-item${selectedConnection === connection.key ? ' is-selected' : ''}`}
                            key={connection.key}
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
                                    <span className={`connection-target-badge target-${connection.targetType}`}>
                                        {targetTypeLabel(connection.targetType)}
                                    </span>
                                    <span>
                                        {connection.targetType === 'page' || connection.targetType === 'worker'
                                            ? displayDomain(connection.targetUrl)
                                            : displayUrl(connection.targetUrl, '未知运行环境')}
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
                    ))}
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
