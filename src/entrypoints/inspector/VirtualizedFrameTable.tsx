import { tableFeatures, useTable, type ColumnDef } from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, RadioTower } from 'lucide-react';
import { useEffect, type RefObject } from 'react';

import { formatByteSize } from '../../lib/frame-utils';
import type { FrameRecord } from '../../types/capture';
import { formatClock } from './inspector-helpers';

interface VirtualizedFrameTableProps {
    containerRef: RefObject<HTMLDivElement | null>;
    frames: FrameRecord[];
    selectedConnection: string | null;
    selectedFrameId: number | null;
    sortOrder: 'asc' | 'desc';
    onSelect: (id: number) => void;
    onSort: () => void;
}

const features = tableFeatures({});
const columns: Array<ColumnDef<typeof features, FrameRecord>> = [
    {
        id: 'time',
        accessorKey: 'receivedAt',
        header: '时间',
        cell: (info) => formatClock(info.row.original.receivedAt),
    },
    { id: 'direction', accessorKey: 'direction', header: '方向' },
    {
        id: 'size',
        accessorKey: 'payloadBytes',
        header: '大小',
        cell: (info) => formatByteSize(info.row.original.payloadBytes),
    },
    {
        id: 'payload',
        accessorKey: 'payloadData',
        header: '消息预览',
        cell: (info) => info.row.original.payloadData || '(空消息)',
    },
];

/** 使用 TanStack Table 生成行模型，并仅挂载当前可视区域的消息行。 */
export const VirtualizedFrameTable = ({
    containerRef,
    frames,
    selectedConnection,
    selectedFrameId,
    sortOrder,
    onSelect,
    onSort,
}: VirtualizedFrameTableProps) => {
    const table = useTable({ key: 'websocket-frames', features, columns, data: frames });
    const rows = table.getRowModel().rows;
    const virtualizer = useVirtualizer({
        count: rows.length,
        getScrollElement: () => containerRef.current,
        estimateSize: () => 43,
        overscan: 12,
    });
    const virtualRows = virtualizer.getVirtualItems();
    const top = virtualRows[0]?.start || 0;
    const bottom = virtualRows.length ? virtualizer.getTotalSize() - virtualRows.at(-1)!.end : 0;

    useEffect(() => {
        virtualizer.scrollToOffset(0);
    }, [selectedConnection, sortOrder]);

    return (
        <div className="table-scroll" ref={containerRef}>
            <table className="frame-table">
                <thead>
                    <tr>
                        {table.getHeaderGroups()[0]?.headers.map((header) => (
                            <th className={`column-${header.column.id}`} key={header.id}>
                                {header.column.id === 'time' ? (
                                    <button onClick={onSort} type="button">
                                        时间 {sortOrder === 'asc' ? '↑' : '↓'}
                                    </button>
                                ) : (
                                    <table.FlexRender header={header} />
                                )}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {top > 0 && (
                        <tr aria-hidden="true">
                            <td colSpan={columns.length} style={{ height: top, padding: 0 }} />
                        </tr>
                    )}
                    {virtualRows.map((virtualRow) => {
                        const row = rows[virtualRow.index]!;
                        const received = row.original.direction === 'received';
                        return (
                            <tr
                                aria-selected={row.original.id === selectedFrameId}
                                key={row.id}
                                onClick={() => onSelect(row.original.id)}
                            >
                                {row.getAllCells().map((cell) => (
                                    <td
                                        className={`column-${cell.column.id}`}
                                        key={cell.id}
                                        title={cell.column.id === 'payload' ? row.original.payloadData : undefined}
                                    >
                                        {cell.column.id === 'direction' ? (
                                            <span className={`direction-${row.original.direction}`}>
                                                {received ? <ArrowDown size={16} /> : <ArrowUp size={16} />}
                                                {received ? '接收' : '发送'}
                                            </span>
                                        ) : (
                                            <table.FlexRender cell={cell} />
                                        )}
                                    </td>
                                ))}
                            </tr>
                        );
                    })}
                    {bottom > 0 && (
                        <tr aria-hidden="true">
                            <td colSpan={columns.length} style={{ height: bottom, padding: 0 }} />
                        </tr>
                    )}
                </tbody>
            </table>
            {!frames.length && (
                <div className="table-empty">
                    <span>
                        <RadioTower size={20} />
                    </span>
                    <strong>{selectedConnection ? '等待当前连接消息' : '请选择 WebSocket 连接'}</strong>
                    <p>{selectedConnection ? '当前筛选条件下暂无消息' : '从左侧连接列表开始查看'}</p>
                </div>
            )}
        </div>
    );
};
