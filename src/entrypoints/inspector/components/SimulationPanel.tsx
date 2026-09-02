import { AlertTriangle, ArrowDownToLine, Send, X, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { ConnectionRecord, SimulationAction, SimulationResult } from '../../../types/capture';

interface SimulationInput {
    action: SimulationAction;
    payload: string;
    closeCode?: number;
    closeReason?: string;
}

interface SimulationPanelProps {
    connection: ConnectionRecord;
    pending: boolean;
    result: SimulationResult | null;
    onClose: () => void;
    onExecute: (input: SimulationInput) => void;
}

type SimulationTab = 'send' | 'receive' | 'system';
type SystemEvent = Extract<SimulationAction, 'open' | 'error' | 'close'>;

const TABS: Array<{ value: SimulationTab; label: string; icon: typeof Send }> = [
    { value: 'receive', label: '模拟接收', icon: ArrowDownToLine },
    { value: 'send', label: '发送消息', icon: Send },
    { value: 'system', label: '系统事件', icon: Zap },
];

/** 提供真实发送、模拟接收和系统事件的独立调试面板。 */
export const SimulationPanel = ({ connection, pending, result, onClose, onExecute }: SimulationPanelProps) => {
    const [tab, setTab] = useState<SimulationTab>('receive');
    const [payload, setPayload] = useState('');
    const [systemEvent, setSystemEvent] = useState<SystemEvent>('error');
    const [closeCode, setCloseCode] = useState(1000);
    const [closeReason, setCloseReason] = useState('模拟连接关闭');

    /** 校验输入并向当前连接提交模拟操作。 */
    const submit = (): void => {
        const action: SimulationAction = tab === 'system' ? systemEvent : tab;
        onExecute({ action, payload, closeCode, closeReason });
    };

    /** 切换面板页签并清理上一次执行反馈。 */
    const chooseTab = (value: SimulationTab): void => {
        setTab(value);
    };

    const requiresPayload = tab !== 'system';

    /** 真实发送成功后清空输入框，避免用户误触造成重复发送。 */
    useEffect(() => {
        if (tab === 'send' && result?.success) setPayload('');
    }, [result, tab]);

    return (
        <aside className="frame-detail simulation-panel">
            <section className="detail-section">
                <div className="detail-heading">
                    <h2>消息模拟</h2>
                    <button className="bare-button" onClick={onClose} aria-label="关闭消息模拟" type="button">
                        <X size={17} />
                    </button>
                </div>
                <dl className="detail-list wide">
                    <div>
                        <dt>WebSocket</dt>
                        <dd title={connection.url}>{connection.url}</dd>
                    </div>
                    <div>
                        <dt>状态</dt>
                        <dd className="direction-received">● 已连接</dd>
                    </div>
                </dl>
            </section>

            <section className="payload-section simulation-body">
                <div className="detail-tabs simulation-mode-tabs" role="tablist" aria-label="消息模拟类型">
                    {TABS.map(({ value, label, icon: Icon }) => (
                        <button
                            aria-selected={tab === value}
                            className={tab === value ? 'is-active' : ''}
                            key={value}
                            onClick={() => chooseTab(value)}
                            role="tab"
                            type="button"
                        >
                            <Icon size={14} />
                            {label}
                        </button>
                    ))}
                </div>

                <div className="simulation-form">
                    {tab === 'system' ? (
                        <>
                            <label className="simulation-field">
                                <span>事件类型</span>
                                <select
                                    value={systemEvent}
                                    onChange={(event) => setSystemEvent(event.target.value as SystemEvent)}
                                >
                                    <option value="open">open</option>
                                    <option value="error">error</option>
                                    <option value="close">close</option>
                                </select>
                            </label>
                            {systemEvent === 'close' && (
                                <div className="simulation-close-fields">
                                    <label className="simulation-field">
                                        <span>关闭代码</span>
                                        <input
                                            max={4999}
                                            min={1000}
                                            onChange={(event) => setCloseCode(Number(event.target.value))}
                                            type="number"
                                            value={closeCode}
                                        />
                                    </label>
                                    <label className="simulation-field">
                                        <span>关闭原因</span>
                                        <input
                                            maxLength={123}
                                            onChange={(event) => setCloseReason(event.target.value)}
                                            value={closeReason}
                                        />
                                    </label>
                                </div>
                            )}
                        </>
                    ) : (
                        <label className="simulation-field simulation-payload">
                            <span>消息内容</span>
                            <textarea
                                onChange={(event) => setPayload(event.target.value)}
                                placeholder={
                                    tab === 'send'
                                        ? '输入发送到服务器的文本或 JSON'
                                        : '输入分发给业务监听器的文本或 JSON'
                                }
                                spellCheck={false}
                                value={payload}
                            />
                        </label>
                    )}

                    <div className="simulation-notice">
                        <AlertTriangle size={15} />
                        <p>
                            {tab === 'send'
                                ? '该操作会通过真实 WebSocket 发送到服务器，可能改变业务数据。'
                                : '该操作仅触发当前 SharedWorker 内的业务监听器，不会生成真实网络帧或改变连接状态。'}
                        </p>
                    </div>

                    {result && (
                        <p className={`simulation-result ${result.success ? 'is-success' : 'is-error'}`} role="status">
                            {result.message}
                        </p>
                    )}

                    <button
                        className="simulation-submit"
                        disabled={pending || (requiresPayload && payload.length === 0)}
                        onClick={submit}
                        type="button"
                    >
                        {tab === 'send' ? <Send size={15} /> : <Zap size={15} />}
                        {pending ? '执行中…' : tab === 'send' ? '发送到服务器' : '触发模拟事件'}
                    </button>
                </div>
            </section>
        </aside>
    );
};
