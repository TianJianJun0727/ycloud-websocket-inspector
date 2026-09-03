import { Check, Filter, RotateCcw, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { WebSocketTargetType } from '../../../types/capture';
import type { ConnectionListFilters, ConnectionListStatus } from '../connection-list-filter';
import type { ConnectionListSort } from '../connection-list-sort';
import { ConnectionSort } from './ConnectionSort';

interface ConnectionFiltersProps {
    domains: string[];
    filters: ConnectionListFilters;
    sort: ConnectionListSort;
    onChange: (filters: ConnectionListFilters) => void;
    onSortChange: (sort: ConnectionListSort) => void;
}

const TYPE_OPTIONS: Array<{ value: WebSocketTargetType; label: string }> = [
    { value: 'page', label: '页面' },
    { value: 'worker', label: 'Web Worker' },
    { value: 'shared_worker', label: 'SharedWorker' },
];

const STATUS_OPTIONS: Array<{ value: ConnectionListStatus; label: string }> = [
    { value: 'recording', label: '记录中' },
    { value: 'connecting', label: '连接中' },
    { value: 'paused', label: '已暂停' },
    { value: 'closed', label: '已关闭' },
];

/** 在数组筛选项中切换指定值。 */
const toggleValue = <Value extends string>(values: Value[], value: Value): Value[] =>
    values.includes(value) ? values.filter((item) => item !== value) : [...values, value];

/** 展示连接搜索入口和紧凑的组合筛选弹层。 */
export const ConnectionFilters = ({ domains, filters, sort, onChange, onSortChange }: ConnectionFiltersProps) => {
    const rootRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const activeDimensionCount =
        Number(Boolean(filters.targetTypes.length)) +
        Number(Boolean(filters.statuses.length)) +
        Number(Boolean(filters.domains.length));

    useEffect(() => {
        if (!open) return;
        /** 点击筛选区域外部时关闭弹层。 */
        const closeOutside = (event: PointerEvent): void => {
            if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
        };
        document.addEventListener('pointerdown', closeOutside);
        return () => document.removeEventListener('pointerdown', closeOutside);
    }, [open]);

    /** 清空除搜索关键词之外的结构化筛选条件。 */
    const resetFilters = (): void => {
        onChange({ ...filters, targetTypes: [], statuses: [], domains: [] });
    };

    /** 输入关键词时切换为全局搜索，避免隐藏的高级筛选条件阻断匹配结果。 */
    const updateSearch = (search: string): void => {
        onChange({ search, targetTypes: [], statuses: [], domains: [] });
    };

    return (
        <div className="connection-filter-bar" ref={rootRef}>
            <label className="connection-search-field">
                <Search size={14} />
                <input
                    aria-label="搜索连接"
                    onFocus={() => setOpen(false)}
                    onChange={(event) => updateSearch(event.target.value)}
                    placeholder="搜索 WebSocket 地址或域名"
                    value={filters.search}
                />
            </label>
            <ConnectionSort sort={sort} onChange={onSortChange} />
            <button
                aria-expanded={open}
                aria-label="筛选连接"
                className={`connection-filter-trigger${activeDimensionCount ? ' is-active' : ''}`}
                onClick={() => setOpen((value) => !value)}
                type="button"
            >
                <Filter size={14} />
                {activeDimensionCount > 0 && <span>{activeDimensionCount}</span>}
            </button>
            {open && (
                <div className="connection-filter-popover">
                    <div className="connection-filter-header">
                        <strong>筛选连接</strong>
                        <button disabled={!activeDimensionCount} onClick={resetFilters} type="button">
                            <RotateCcw size={12} />
                            重置
                        </button>
                    </div>
                    <fieldset>
                        <legend>运行环境</legend>
                        <div className="connection-filter-options">
                            {TYPE_OPTIONS.map(({ value, label }) => {
                                const selected = filters.targetTypes.includes(value);
                                return (
                                    <button
                                        className={selected ? 'is-selected' : ''}
                                        key={value}
                                        onClick={() =>
                                            onChange({
                                                ...filters,
                                                targetTypes: toggleValue(filters.targetTypes, value),
                                            })
                                        }
                                        type="button"
                                    >
                                        {selected && <Check size={11} />}
                                        {label}
                                    </button>
                                );
                            })}
                        </div>
                    </fieldset>
                    <fieldset>
                        <legend>连接状态</legend>
                        <div className="connection-filter-options">
                            {STATUS_OPTIONS.map(({ value, label }) => {
                                const selected = filters.statuses.includes(value);
                                return (
                                    <button
                                        className={selected ? 'is-selected' : ''}
                                        key={value}
                                        onClick={() =>
                                            onChange({ ...filters, statuses: toggleValue(filters.statuses, value) })
                                        }
                                        type="button"
                                    >
                                        {selected && <Check size={11} />}
                                        {label}
                                    </button>
                                );
                            })}
                        </div>
                    </fieldset>
                    <fieldset>
                        <legend>WebSocket 域名</legend>
                        <div className="connection-domain-options">
                            {domains.map((domain) => {
                                const selected = filters.domains.includes(domain);
                                return (
                                    <button
                                        className={selected ? 'is-selected' : ''}
                                        key={domain}
                                        onClick={() => onChange({ ...filters, domains: toggleValue(filters.domains, domain) })}
                                        title={domain}
                                        type="button"
                                    >
                                        <span>{domain}</span>
                                        {selected && <Check size={12} />}
                                    </button>
                                );
                            })}
                        </div>
                    </fieldset>
                </div>
            )}
        </div>
    );
};
