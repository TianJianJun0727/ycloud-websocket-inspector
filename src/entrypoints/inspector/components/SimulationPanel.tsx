import { AlertTriangle, ArrowDownToLine, Monitor, Send, Server, X, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { ConnectionRecord, SimulationAction, SimulationResult } from '../../../types/capture';
import { targetTypeLabel } from '../inspector-helpers';

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
type SystemEventScope = 'client' | 'server';
type SystemEventKind = 'close' | 'error';
type SystemAction = Extract<SimulationAction, 'client-close' | 'client-error' | 'server-close' | 'server-error'>;

interface ErrorPreset {
    value: string;
    label: string;
    message: string;
}

const TABS: Array<{ value: SimulationTab; label: string; icon: typeof Send }> = [
    { value: 'receive', label: '模拟接收', icon: ArrowDownToLine },
    { value: 'send', label: '发送消息', icon: Send },
    { value: 'system', label: '系统事件', icon: Zap },
];

const ERROR_PRESETS: Record<SystemEventScope, ErrorPreset[]> = {
    client: [
        { value: 'connection-failed', label: '连接失败', message: 'WebSocket 连接失败' },
        { value: 'network-disconnect', label: '网络中断', message: '客户端网络连接已中断' },
        { value: 'protocol-error', label: '协议错误', message: '客户端检测到 WebSocket 协议错误' },
        { value: 'timeout', label: '连接超时', message: 'WebSocket 连接超时' },
    ],
    server: [
        { value: 'message-format', label: '消息格式错误', message: '服务器返回了无法解析的消息' },
        { value: 'internal-error', label: '服务内部错误', message: '服务器发生内部错误' },
        { value: 'resource-exhausted', label: '服务资源不足', message: '服务器资源暂时不可用' },
        { value: 'service-restart', label: '服务重启', message: '服务器正在重新启动' },
    ],
};

/** 提供真实发送、模拟接收以及客户端和服务端事件调试。 */
export const SimulationPanel = ({ connection, pending, result, onClose, onExecute }: SimulationPanelProps) => {
    const [tab, setTab] = useState<SimulationTab>('receive');
    const [payload, setPayload] = useState('');
    const [eventScope, setEventScope] = useState<SystemEventScope>('client');
    const [eventKind, setEventKind] = useState<SystemEventKind>('close');
    const [closeCode, setCloseCode] = useState(1000);
    const [closeReason, setCloseReason] = useState('客户端主动关闭');
    const [errorPreset, setErrorPreset] = useState(ERROR_PRESETS.client[0]!.value);
    const [errorMessage, setErrorMessage] = useState(ERROR_PRESETS.client[0]!.message);
    const [validationError, setValidationError] = useState<string | null>(null);
    const [resultVisible, setResultVisible] = useState(true);

    /** 清除当前校验和上一次操作反馈。 */
    const clearFeedback = (): void => {
        setValidationError(null);
        setResultVisible(false);
    };

    /** 校验输入并向当前连接提交模拟操作。 */
    const submit = (): void => {
        if (tab !== 'system' && payload.length === 0) {
            setValidationError('请输入需要发送或模拟接收的消息内容');
            setResultVisible(false);
            return;
        }
        if (tab === 'system' && eventKind === 'close') {
            const validRange = Number.isInteger(closeCode) && closeCode >= 1000 && closeCode <= 4999;
            const validClientCode = closeCode === 1000 || (closeCode >= 3000 && closeCode <= 4999);
            if (!validRange || (eventScope === 'client' && !validClientCode)) {
                setValidationError(
                    eventScope === 'client' ? '客户端关闭代码仅支持 1000 或 3000-4999' : '关闭代码必须为 1000-4999',
                );
                setResultVisible(false);
                return;
            }
        }
        if (tab === 'system' && eventKind === 'error' && errorMessage.trim().length === 0) {
            setValidationError('请输入错误信息');
            setResultVisible(false);
            return;
        }
        clearFeedback();
        const action: SimulationAction =
            tab === 'system' ? (`${eventScope}-${eventKind}` as SystemAction) : tab;
        onExecute({
            action,
            payload: tab === 'system' && eventKind === 'error' ? errorMessage.trim() : payload,
            closeCode,
            closeReason,
        });
    };

    /** 切换主功能页签并清理上一次执行反馈。 */
    const chooseTab = (value: SimulationTab): void => {
        setTab(value);
        clearFeedback();
    };

    /** 切换事件来源，并加载与来源匹配的默认文案。 */
    const chooseEventScope = (scope: SystemEventScope): void => {
        const preset = ERROR_PRESETS[scope][0]!;
        setEventScope(scope);
        setErrorPreset(preset.value);
        setErrorMessage(preset.message);
        setCloseReason(scope === 'client' ? '客户端主动关闭' : '服务器主动关闭连接');
        clearFeedback();
    };

    /** 切换错误场景并同步可编辑的错误文案。 */
    const chooseErrorPreset = (value: string): void => {
        const preset = ERROR_PRESETS[eventScope].find((item) => item.value === value);
        if (!preset) return;
        setErrorPreset(value);
        setErrorMessage(preset.message);
        clearFeedback();
    };

    /** 接收新的执行结果并清理当前输入校验。 */
    useEffect(() => {
        if (!result) return;
        setResultVisible(true);
        setValidationError(null);
    }, [result]);

    const systemActionLabel =
        eventKind === 'close'
            ? eventScope === 'client'
                ? '关闭客户端连接'
                : '模拟服务端关闭'
            : eventScope === 'client'
              ? '触发客户端错误'
              : '模拟服务端错误';

    const notice =
        tab === 'send'
            ? '该操作会通过真实 WebSocket 发送到服务器，可能改变业务数据。'
            : tab === 'receive'
              ? '该操作会向当前 WebSocket 派发消息，页面或 Worker 中的业务监听器会真实收到。'
              : eventScope === 'client' && eventKind === 'close'
                ? '该操作会调用真实 WebSocket.close()，关闭当前连接并通知服务器。'
                : '该操作仅向业务监听器派发模拟事件，不代表服务器或底层连接状态真实改变。';

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
                        <dt>运行环境</dt>
                        <dd>{targetTypeLabel(connection.targetType)}</dd>
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
                            <div className="simulation-scope-block">
                                <div className="simulation-scope-tabs" role="tablist" aria-label="事件来源">
                                    <button
                                        aria-selected={eventScope === 'client'}
                                        className={eventScope === 'client' ? 'is-active' : ''}
                                        onClick={() => chooseEventScope('client')}
                                        role="tab"
                                        type="button"
                                    >
                                        <Monitor size={14} /> 客户端事件
                                    </button>
                                    <button
                                        aria-selected={eventScope === 'server'}
                                        className={eventScope === 'server' ? 'is-active' : ''}
                                        onClick={() => chooseEventScope('server')}
                                        role="tab"
                                        type="button"
                                    >
                                        <Server size={14} /> 服务端事件
                                    </button>
                                </div>
                                <p className="simulation-scope-copy">
                                    {eventScope === 'client'
                                        ? '模拟由当前客户端主动触发的连接行为。'
                                        : '模拟业务代码感知到的服务器侧连接事件。'}
                                </p>
                            </div>
                            <label className="simulation-field">
                                <span>事件类型</span>
                                <select
                                    value={eventKind}
                                    onChange={(event) => {
                                        setEventKind(event.target.value as SystemEventKind);
                                        clearFeedback();
                                    }}
                                >
                                    <option value="close">关闭事件</option>
                                    <option value="error">错误事件</option>
                                </select>
                            </label>
                            {eventKind === 'close' ? (
                                <div className="simulation-close-fields">
                                    <label className="simulation-field">
                                        <span>关闭代码</span>
                                        <input
                                            max={4999}
                                            min={1000}
                                            onChange={(event) => {
                                                setCloseCode(Number(event.target.value));
                                                clearFeedback();
                                            }}
                                            type="number"
                                            value={closeCode}
                                        />
                                    </label>
                                    <label className="simulation-field">
                                        <span>关闭原因</span>
                                        <input
                                            maxLength={123}
                                            onChange={(event) => {
                                                setCloseReason(event.target.value);
                                                clearFeedback();
                                            }}
                                            value={closeReason}
                                        />
                                    </label>
                                </div>
                            ) : (
                                <>
                                    <label className="simulation-field">
                                        <span>错误场景</span>
                                        <select value={errorPreset} onChange={(event) => chooseErrorPreset(event.target.value)}>
                                            {ERROR_PRESETS[eventScope].map((preset) => (
                                                <option key={preset.value} value={preset.value}>
                                                    {preset.label}
                                                </option>
                                            ))}
                                        </select>
                                    </label>
                                    <label className="simulation-field">
                                        <span>错误信息</span>
                                        <input
                                            onChange={(event) => {
                                                setErrorMessage(event.target.value);
                                                clearFeedback();
                                            }}
                                            value={errorMessage}
                                        />
                                    </label>
                                </>
                            )}
                        </>
                    ) : (
                        <label className="simulation-field simulation-payload">
                            <span>消息内容</span>
                            <textarea
                                onChange={(event) => {
                                    setPayload(event.target.value);
                                    clearFeedback();
                                }}
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
                        <p>{notice}</p>
                    </div>

                    {validationError && (
                        <p className="simulation-result is-error" role="alert">
                            {validationError}
                        </p>
                    )}

                    {resultVisible && result && (
                        <p className={`simulation-result ${result.success ? 'is-success' : 'is-error'}`} role="status">
                            {result.message}
                        </p>
                    )}

                    <button className="simulation-submit" disabled={pending} onClick={submit} type="button">
                        {tab === 'send' ? (
                            <Send size={15} />
                        ) : tab === 'receive' ? (
                            <ArrowDownToLine size={15} />
                        ) : (
                            <Zap size={15} />
                        )}
                        {pending
                            ? '执行中…'
                            : tab === 'send'
                              ? '发送到服务器'
                              : tab === 'receive'
                                ? '模拟接收消息'
                                : systemActionLabel}
                    </button>
                </div>
            </section>
        </aside>
    );
};
