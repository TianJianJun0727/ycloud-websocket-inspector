import { ArrowDown, ArrowUp, Download, FlaskConical, ListEnd, Search, Trash2 } from 'lucide-react';

import type { CaptureDiagnostic, ConnectionFilter, ConnectionRecord } from '../../../types/capture';
import { displayConnection } from '../inspector-helpers';

interface FrameToolbarProps {
    activeFilter: ConnectionFilter;
    captureError?: CaptureDiagnostic;
    disconnected: boolean;
    followLatest: boolean;
    selectedConnection: string | null;
    selectedConnectionData?: ConnectionRecord;
    selectedFrameCount: number;
    storageError?: CaptureDiagnostic;
    onClear: () => void;
    onExport: () => void;
    onFilterChange: <Key extends keyof ConnectionFilter>(name: Key, value: ConnectionFilter[Key]) => void;
    onFollowLatestChange: (value: boolean) => void;
    onOpenSimulator: () => void;
}

const DIRECTIONS: Array<{ value: ConnectionFilter['direction']; label: string; icon?: typeof ArrowDown }> = [
    { value: 'all', label: '全部' },
    { value: 'received', label: '接收', icon: ArrowDown },
    { value: 'sent', label: '发送', icon: ArrowUp },
];

/** 在紧凑单行工具栏中展示连接上下文和全部消息操作。 */
export const FrameToolbar = ({
    activeFilter,
    captureError,
    disconnected,
    followLatest,
    selectedConnection,
    selectedConnectionData,
    selectedFrameCount,
    storageError,
    onClear,
    onExport,
    onFilterChange,
    onFollowLatestChange,
    onOpenSimulator,
}: FrameToolbarProps) => (
    <div className="frame-toolbar">
        <div className="frame-summary">
            <strong title={selectedConnectionData?.url || selectedConnectionData?.targetUrl}>
                {selectedConnectionData ? displayConnection(selectedConnectionData) : '未选择连接'}
            </strong>
            <span className="frame-message-count">{selectedFrameCount} 条消息</span>
            <span className="frame-connection-status">
                <span
                    aria-hidden="true"
                    className={`connection-dot status-${disconnected ? 'closed' : (selectedConnectionData?.status ?? 'closed')}`}
                />
                {disconnected
                    ? '后台已断开'
                    : storageError
                      ? '存储异常'
                      : captureError
                        ? '监听异常'
                        : selectedConnectionData?.status === 'connecting'
                          ? '连接中'
                          : selectedConnectionData?.status === 'closed'
                            ? '已关闭'
                            : selectedConnectionData
                              ? '记录中'
                              : '未连接'}
            </span>
        </div>
        <div className="toolbar-controls">
            <div className="toolbar-query-group">
                <label className="search-field">
                    <Search size={15} />
                    <input
                        disabled={!selectedConnection}
                        onChange={(event) => onFilterChange('search', event.target.value)}
                        placeholder="搜索消息 / 正则表达式"
                        value={activeFilter.search}
                    />
                </label>
                <div className="segmented-control">
                    {DIRECTIONS.map(({ value, label, icon: Icon }) => (
                        <button
                            className={activeFilter.direction === value ? 'is-active' : ''}
                            disabled={!selectedConnection}
                            key={value}
                            onClick={() => onFilterChange('direction', value)}
                            type="button"
                        >
                            {Icon && <Icon size={14} />}
                            {label}
                        </button>
                    ))}
                </div>
            </div>
            <button
                aria-label="打开消息模拟面板"
                className="icon-button compact"
                data-tooltip="模拟消息"
                disabled={disconnected || !selectedConnectionData || selectedConnectionData.status !== 'open'}
                onClick={onOpenSimulator}
                title="打开消息模拟面板"
                type="button"
            >
                <FlaskConical size={15} />
            </button>
            <button
                aria-label={followLatest ? '停止跟随最新消息' : '跟随最新消息'}
                aria-pressed={followLatest}
                className={`icon-button compact${followLatest ? ' is-active' : ''}`}
                data-tooltip={followLatest ? '停止跟随最新' : '跟随最新'}
                disabled={!selectedConnection}
                onClick={() => onFollowLatestChange(!followLatest)}
                title={followLatest ? '停止跟随最新消息' : '跟随最新消息'}
                type="button"
            >
                <ListEnd size={15} />
            </button>
            <button
                aria-label="清空当前连接"
                className="icon-button compact"
                data-tooltip="删除消息"
                disabled={!selectedConnection}
                onClick={onClear}
                title="清空当前连接"
                type="button"
            >
                <Trash2 size={15} />
            </button>
            <button
                aria-label="导出当前连接"
                className="icon-button compact"
                data-tooltip="导出消息"
                disabled={!selectedConnection}
                onClick={onExport}
                title="导出当前连接"
                type="button"
            >
                <Download size={15} />
            </button>
        </div>
    </div>
);
