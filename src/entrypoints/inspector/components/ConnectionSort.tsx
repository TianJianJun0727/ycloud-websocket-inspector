import { ArrowDown, ArrowUp, ArrowUpDown, Check } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { ConnectionListSort, ConnectionSortField } from '../connection-list-sort';

interface ConnectionSortProps {
    sort: ConnectionListSort;
    onChange: (sort: ConnectionListSort) => void;
}

const FIELD_OPTIONS: Array<{ value: ConnectionSortField; label: string }> = [
    { value: 'time', label: '时间' },
    { value: 'type', label: '类型' },
    { value: 'name', label: '名称' },
    { value: 'frameCount', label: '消息数' },
];

/** 将排序方向转换为统一的简短文案。 */
const directionLabel = ({ direction }: ConnectionListSort): string => (direction === 'asc' ? '升序' : '降序');

/** 展示连接列表的排序字段和升降序选择。 */
export const ConnectionSort = ({ sort, onChange }: ConnectionSortProps) => {
    const rootRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);

    useEffect(() => {
        if (!open) return;
        /** 点击排序区域外部时关闭弹层。 */
        const closeOutside = (event: PointerEvent): void => {
            if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
        };
        document.addEventListener('pointerdown', closeOutside);
        return () => document.removeEventListener('pointerdown', closeOutside);
    }, [open]);

    const activeLabel = FIELD_OPTIONS.find(({ value }) => value === sort.field)?.label || '时间';

    return (
        <div className="connection-sort-control" ref={rootRef}>
            <button
                aria-expanded={open}
                aria-label="连接排序"
                className="connection-sort-trigger"
                onClick={() => setOpen((value) => !value)}
                title={`排序：${activeLabel}，${directionLabel(sort)}`}
                type="button"
            >
                <ArrowUpDown size={14} />
            </button>
            {open && (
                <div className="connection-sort-popover">
                    <strong>连接排序</strong>
                    <div className="connection-sort-options">
                        {FIELD_OPTIONS.map(({ value, label }) => (
                            <button
                                className={sort.field === value ? 'is-selected' : ''}
                                key={value}
                                onClick={() => onChange({ ...sort, field: value })}
                                type="button"
                            >
                                <span>{label}</span>
                                {sort.field === value && <Check size={12} />}
                            </button>
                        ))}
                    </div>
                    <button
                        className="connection-sort-direction"
                        onClick={() => onChange({ ...sort, direction: sort.direction === 'asc' ? 'desc' : 'asc' })}
                        type="button"
                    >
                        {sort.direction === 'asc' ? <ArrowUp size={13} /> : <ArrowDown size={13} />}
                        {directionLabel(sort)}
                    </button>
                </div>
            )}
        </div>
    );
};
