import { Copy, X } from 'lucide-react';
import { useState } from 'react';

import { formatByteSize } from '../../../lib/frame-utils';
import type { ConnectionRecord, FrameRecord } from '../../../types/capture';
import { displayConnection, displayUrl, formatClock, targetTypeLabel } from '../inspector-helpers';

interface FrameDetailProps {
    copied: boolean;
    connection?: ConnectionRecord;
    formattedPayload: string;
    frame: FrameRecord;
    showMetadata: boolean;
    onClose: () => void;
    onCopy: () => void;
}

/** 生成详情面板所需的固定元数据。 */
const getMetadata = (frame: FrameRecord, connection: ConnectionRecord | undefined): Array<[string, string]> => [
    ['时间', formatClock(frame.receivedAt)],
    ...(connection && (connection.targetType === 'page' || connection.targetType === 'worker')
        ? ([['Tab ID', String(connection.tabId ?? '未知')]] as Array<[string, string]>)
        : []),
    ['方向', frame.direction === 'received' ? '↓ 接收' : '↑ 发送'],
    ...(frame.simulation
        ? ([
              [
                  '来源',
                  frame.simulation === 'send'
                      ? '模拟发送'
                      : frame.simulation === 'receive'
                        ? '模拟接收'
                        : '模拟系统事件',
              ],
          ] as Array<[string, string]>)
        : []),
    ['大小', formatByteSize(frame.payloadBytes)],
    ['Opcode', `${frame.opcode}${frame.opcode === 1 ? ' (Text)' : ''}`],
    ['Request ID', frame.requestId],
];

/** 按需展示选中消息，并允许用户手动关闭详情面板。 */
export const FrameDetail = ({
    copied,
    connection,
    formattedPayload,
    frame,
    showMetadata,
    onClose,
    onCopy,
}: FrameDetailProps) => {
    const [tab, setTab] = useState<'payload' | 'raw'>('payload');

    return (
        <aside className="frame-detail">
            <section className="detail-section">
                <div className="detail-heading">
                    <h2>消息详情</h2>
                    <button
                        className="bare-button"
                        onClick={onClose}
                        aria-label="关闭消息详情"
                        title="关闭消息详情"
                        type="button"
                    >
                        <X size={17} />
                    </button>
                </div>
                <dl className="detail-list">
                    {getMetadata(frame, connection).map(([label, value]) => (
                        <div key={label}>
                            <dt>{label}</dt>
                            <dd className={label === '方向' ? `direction-${frame.direction}` : ''}>{value}</dd>
                        </div>
                    ))}
                </dl>
            </section>
            <section className="payload-section">
                <div className="detail-tabs">
                    <button
                        className={tab === 'payload' ? 'is-active' : ''}
                        onClick={() => setTab('payload')}
                        type="button"
                    >
                        Payload
                    </button>
                    <button className={tab === 'raw' ? 'is-active' : ''} onClick={() => setTab('raw')} type="button">
                        Raw
                    </button>
                    <button className="copy-button" onClick={onCopy} type="button">
                        <Copy size={14} />
                        {copied ? '已复制' : '复制'}
                    </button>
                </div>
                <pre>{tab === 'raw' ? frame.payloadData : formattedPayload}</pre>
            </section>
            {showMetadata && (
                <section className="detail-section metadata-section">
                    <h2>元数据</h2>
                    <dl className="detail-list wide">
                        <div>
                            <dt>WebSocket</dt>
                            <dd title={frame.socketUrl}>{frame.socketUrl || displayConnection(frame)}</dd>
                        </div>
                        <div>
                            <dt>{targetTypeLabel(frame.targetType)}</dt>
                            <dd title={frame.targetUrl}>{displayUrl(frame.targetUrl)}</dd>
                        </div>
                        <div>
                            <dt>连接 ID</dt>
                            <dd>{frame.requestId}</dd>
                        </div>
                    </dl>
                </section>
            )}
        </aside>
    );
};
