import { ArrowDown, ArrowUp, Download, Search, Trash2 } from 'lucide-react';

import type { CaptureDiagnostic, ConnectionFilter, ConnectionRecord } from '../../../types/capture';
import { displayConnection } from '../inspector-helpers';

interface FrameToolbarProps {
    activeFilter: ConnectionFilter;
    captureError?: CaptureDiagnostic;
    disconnected: boolean;
    filteredFrameCount: number;
    selectedConnection: string | null;
    selectedConnectionData?: ConnectionRecord;
    selectedFrameCount: number;
    storageError?: CaptureDiagnostic;
    onClear: () => void;
    onExport: () => void;
    onFilterChange: <Key extends keyof ConnectionFilter>(name: Key, value: ConnectionFilter[Key]) => void;
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
    filteredFrameCount,
    selectedConnection,
    selectedConnectionData,
    selectedFrameCount,
    storageError,
    onClear,
    onExport,
    onFilterChange,
}: FrameToolbarProps) => (
    <div className="frame-toolbar">
        <div className="frame-summary">
            <strong title={selectedConnectionData?.url || selectedConnectionData?.targetUrl}>
                {selectedConnectionData ? displayConnection(selectedConnectionData) : '未选择连接'}
            </strong>
            <span>
                {filteredFrameCount === selectedFrameCount
                    ? selectedFrameCount
                    : `${filteredFrameCount} / ${selectedFrameCount}`}{' '}
                条消息
            </span>
            <span>
                {disconnected ? '后台已断开' : storageError ? '存储异常' : captureError ? '监听异常' : '实时记录中'}
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
                className="icon-button compact"
                disabled={!selectedConnection}
                onClick={onClear}
                title="清空当前连接"
                type="button"
            >
                <Trash2 size={15} />
            </button>
            <button
                className="icon-button compact"
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
