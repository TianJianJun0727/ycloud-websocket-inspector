import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';

import { FRAME_STORE_LIMITS } from '../../lib/frame-store';
import { parseJsonPayload } from '../../lib/frame-utils';
import {
    bucketFramesByConnection,
    isActiveDiagnostic,
    matchesTextFilter,
    mergeFrameBuckets,
    orderRecentFrames,
    resolveConnectionRecords,
} from '../../lib/inspector-utils';
import type {
    CaptureDiagnostic,
    CaptureTarget,
    ConnectionFilter,
    ConnectionRecord,
    FrameRecord,
    InspectorCommand,
    InspectorMessage,
    InspectorPort,
    SimulationAction,
    SimulationResult,
} from '../../types/capture';
import { ConnectionSidebar } from './components/ConnectionSidebar';
import {
    collectConnectionDomains,
    DEFAULT_CONNECTION_LIST_FILTERS,
    filterConnections,
} from './connection-list-filter';
import { parseConnectionGroup, parseConnectionListSort, sortConnections } from './connection-list-sort';
import { FrameDetail } from './components/FrameDetail';
import { FrameToolbar } from './components/FrameToolbar';
import { InspectorHeader } from './components/InspectorHeader';
import { SimulationPanel } from './components/SimulationPanel';
import { createDemoPort } from './demo-port';
import { buildConnections } from './inspector-helpers';
import { resolveDarkMode, resolveThemeSeason, type ColorMode, type ThemePreference } from './theme';
import { VirtualizedFrameTable } from './VirtualizedFrameTable';

const LIMITS = FRAME_STORE_LIMITS;
const demo = new URLSearchParams(location.search).get('demo') === '1';

interface RuntimeState {
    generation: number;
    frameBuckets: Record<string, FrameRecord[]>;
    targets: CaptureTarget[];
    connections: ConnectionRecord[] | null;
    diagnostics: CaptureDiagnostic[];
    limits: typeof LIMITS;
    scanning: boolean;
    disconnected: boolean;
}

const INITIAL_RUNTIME: RuntimeState = {
    generation: 0,
    frameBuckets: {},
    targets: [],
    connections: null,
    diagnostics: [],
    limits: LIMITS,
    scanning: true,
    disconnected: false,
};
const DEFAULT_FILTER: ConnectionFilter = { direction: 'all', search: '' };
const DEFAULT_HEARTBEAT_MESSAGES = 'ping,pong,heartbeat';
const DEFAULT_SCAN_INTERVAL_MS = 5000;
const savedScanIntervalMs = Number(localStorage.getItem('ycloud-ws-scan-interval'));
const INITIAL_SCAN_INTERVAL_MS = [3000, 5000, 10000, 20000, 30000, 60000, 180000, 300000, 600000].includes(
    savedScanIntervalMs,
)
    ? savedScanIntervalMs
    : DEFAULT_SCAN_INTERVAL_MS;

/** 将 Chrome Runtime Port 收敛为 Inspector 与演示环境共用的通信接口。 */
const createRuntimePort = (): InspectorPort | null => {
    const runtimePort = window.chrome?.runtime?.connect?.({ name: 'shared-worker-ws-inspector' });
    if (!runtimePort) return null;
    return {
        onMessage: {
            addListener: (listener) =>
                runtimePort.onMessage.addListener((message: unknown) => listener(message as InspectorMessage)),
        },
        onDisconnect: { addListener: (listener) => runtimePort.onDisconnect.addListener(listener) },
        postMessage: (message) => runtimePort.postMessage(message),
        disconnect: () => runtimePort.disconnect(),
    };
};

/** 按消息代际合并后台快照与增量帧，丢弃迟到的旧会话数据。 */
const reduceRuntimeMessage = (runtime: RuntimeState, message: InspectorMessage): RuntimeState => {
    const generation =
        typeof message.generation === 'number' && Number.isFinite(message.generation)
            ? message.generation
            : runtime.generation;
    if (generation < runtime.generation) return runtime;
    if (message.type === 'frame' || message.type === 'frame-batch') {
        const incoming = message.type === 'frame-batch' ? message.frames || [] : message.frame ? [message.frame] : [];
        return {
            ...runtime,
            generation,
            frameBuckets: mergeFrameBuckets(
                generation > runtime.generation ? {} : runtime.frameBuckets,
                incoming,
                message.evictedFrameIds || [],
                message.limits?.maxFramesPerConnection || LIMITS.maxFramesPerConnection,
            ),
            limits: message.limits || runtime.limits,
        };
    }
    if (message.type === 'cleared') return { ...runtime, generation, frameBuckets: {} };
    if (message.type === 'connection-cleared') {
        const frameBuckets = { ...runtime.frameBuckets };
        if (message.connectionKey) delete frameBuckets[message.connectionKey];
        return { ...runtime, generation, frameBuckets };
    }
    if (message.type === 'state' || message.type === 'status') {
        return {
            ...runtime,
            generation,
            frameBuckets:
                message.frameBuckets ||
                (Array.isArray(message.frames) ? bucketFramesByConnection(message.frames) : runtime.frameBuckets),
            targets: Array.isArray(message.targets) ? message.targets : runtime.targets,
            connections: Array.isArray(message.connections) ? message.connections : runtime.connections,
            diagnostics: Array.isArray(message.diagnostics) ? message.diagnostics : runtime.diagnostics,
            limits: message.limits || runtime.limits,
            scanning: typeof message.scanning === 'boolean' ? message.scanning : runtime.scanning,
            disconnected: false,
        };
    }
    return runtime;
};

/** 组织 Inspector 状态和副作用，将具体视图交给独立 TSX 组件。 */
export const App = () => {
    const portRef = useRef<InspectorPort | null>(null);
    const tableRef = useRef<HTMLDivElement | null>(null);
    const simulationTimeoutRef = useRef<number | null>(null);
    const activeSimulationIdRef = useRef<string | null>(null);
    const [runtime, setRuntime] = useState<RuntimeState>(INITIAL_RUNTIME);
    const [scanIntervalMs, setScanIntervalMs] = useState(INITIAL_SCAN_INTERVAL_MS);
    const [diagnosticTick, setDiagnosticTick] = useState(0);
    const [selectedConnection, setSelectedConnection] = useState<string | null>(null);
    const [connectionFilters, setConnectionFilters] = useState(DEFAULT_CONNECTION_LIST_FILTERS);
    const [connectionGroup, setConnectionGroup] = useState(() =>
        parseConnectionGroup(localStorage.getItem('ycloud-ws-connection-group-v1')),
    );
    const [connectionSort, setConnectionSort] = useState(() =>
        parseConnectionListSort(localStorage.getItem('ycloud-ws-connection-sort-v2')),
    );
    const [selectedFrameId, setSelectedFrameId] = useState<number | null>(null);
    const [filters, setFilters] = useState<Record<string, ConnectionFilter>>({});
    const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
    const [themePreference, setThemePreference] = useState<ThemePreference>('auto');
    const [season, setSeason] = useState(() => resolveThemeSeason('auto'));
    const [hideHeartbeat, setHideHeartbeat] = useState(false);
    const [heartbeatMessagesText, setHeartbeatMessagesText] = useState(DEFAULT_HEARTBEAT_MESSAGES);
    const [showMetadata, setShowMetadata] = useState(true);
    const [colorMode, setColorMode] = useState<ColorMode>('system');
    const [followLatest, setFollowLatest] = useState(true);
    const [copied, setCopied] = useState(false);
    const [simulationOpen, setSimulationOpen] = useState(false);
    const [simulationPending, setSimulationPending] = useState(false);
    const [simulationResult, setSimulationResult] = useState<SimulationResult | null>(null);

    const records = useMemo(
        () => resolveConnectionRecords(runtime.connections, buildConnections(runtime.targets, runtime.frameBuckets)),
        [runtime.connections, runtime.frameBuckets, runtime.targets],
    );
    const connections = useMemo(
        () =>
            records.map((connection) => ({
                ...connection,
                frameCount: runtime.frameBuckets[connection.key]?.length || 0,
            })),
        [records, runtime.frameBuckets],
    );
    const filteredConnections = useMemo(
        () => sortConnections(filterConnections(connections, connectionFilters), connectionSort),
        [connectionFilters, connectionSort, connections],
    );
    const connectionDomains = useMemo(() => collectConnectionDomains(connections), [connections]);
    const activeFilter = selectedConnection ? filters[selectedConnection] || DEFAULT_FILTER : DEFAULT_FILTER;
    const selectedFrames = selectedConnection ? runtime.frameBuckets[selectedConnection] || [] : [];
    const heartbeatMessages = useMemo(
        () =>
            heartbeatMessagesText
                .split(',')
                .map((value) => value.trim().toLowerCase())
                .filter(Boolean),
        [heartbeatMessagesText],
    );
    const filteredFrames = useMemo(
        () =>
            selectedFrames.filter(
                (frame) =>
                    (activeFilter.direction === 'all' || frame.direction === activeFilter.direction) &&
                    (!hideHeartbeat || !heartbeatMessages.includes(frame.payloadData.trim().toLowerCase())) &&
                    matchesTextFilter([frame.socketUrl, frame.targetUrl, frame.payloadData], activeFilter.search),
            ),
        [activeFilter.direction, activeFilter.search, heartbeatMessages, hideHeartbeat, selectedFrames],
    );
    const recentFrames = useMemo(
        () => orderRecentFrames(filteredFrames, 'asc', filteredFrames.length),
        [filteredFrames],
    );
    const visibleFrames = useMemo(
        () => (sortOrder === 'asc' ? recentFrames : [...recentFrames].reverse()),
        [recentFrames, sortOrder],
    );
    const selectedFrame = selectedFrames.find(({ id }) => id === selectedFrameId);
    const selectedConnectionData = connections.find(({ key }) => key === selectedConnection);
    const activeConnections = connections.filter(({ status }) => status !== 'closed');
    const paused = activeConnections.some(({ capturePaused }) => capturePaused);
    const storageError = runtime.diagnostics.find(({ level, source }) => level === 'error' && source === 'storage');
    const captureError = runtime.diagnostics.find(
        (item) =>
            item.level === 'error' &&
            item.source !== 'storage' &&
            isActiveDiagnostic(item) &&
            (!item.targetId || item.targetId === selectedConnectionData?.targetId),
    );
    const totalFrames = Object.values(runtime.frameBuckets).reduce((sum, bucket) => sum + bucket.length, 0);
    const parsedPayload = selectedFrame ? parseJsonPayload(selectedFrame.payloadData, selectedFrame.opcode) : null;
    const formattedPayload = selectedFrame
        ? `${parsedPayload ? JSON.stringify(parsedPayload, null, 2) : selectedFrame.payloadData}${selectedFrame.truncated ? '\n\n[消息超过 1 MB，已截断]' : ''}`
        : '从上方列表选择一条消息查看完整内容。';

    /** 向当前后台端口发送类型安全的 Inspector 命令。 */
    const send = useCallback((message: InspectorCommand): void => portRef.current?.postMessage(message), []);

    /** 应用并持久化四季主题偏好。 */
    const chooseTheme = useCallback((value: ThemePreference): void => {
        setThemePreference(value);
        const nextSeason = resolveThemeSeason(value);
        setSeason(nextSeason);
        document.documentElement.dataset.season = nextSeason;
        localStorage.setItem('ycloud-ws-theme', value);
    }, []);

    /** 应用并持久化亮色、暗色或跟随系统的外观偏好。 */
    const chooseColorMode = useCallback((value: ColorMode): void => {
        setColorMode(value);
        document.documentElement.dataset.colorMode = resolveDarkMode(value) ? 'dark' : 'light';
        localStorage.setItem('ycloud-ws-color-mode', value);
    }, []);

    useEffect(() => {
        localStorage.setItem('ycloud-ws-connection-sort-v2', JSON.stringify(connectionSort));
    }, [connectionSort]);

    useEffect(() => {
        localStorage.setItem('ycloud-ws-connection-group-v1', connectionGroup);
    }, [connectionGroup]);

    useEffect(() => {
        const saved = localStorage.getItem('ycloud-ws-theme');
        const savedColorMode = localStorage.getItem('ycloud-ws-color-mode');
        chooseTheme(
            saved && ['auto', 'spring', 'summer', 'autumn', 'winter'].includes(saved)
                ? (saved as ThemePreference)
                : 'auto',
        );
        chooseColorMode(
            savedColorMode && ['system', 'light', 'dark'].includes(savedColorMode)
                ? (savedColorMode as ColorMode)
                : 'system',
        );
        const port = demo ? createDemoPort() : createRuntimePort();
        portRef.current = port;
        if (!port) {
            setRuntime((current) => ({ ...current, scanning: false, disconnected: true }));
            return;
        }
        port.postMessage({ type: 'set-scan-interval', intervalMs: INITIAL_SCAN_INTERVAL_MS });
        port.onMessage.addListener((message) => {
            if (message.type === 'simulation-result' && message.simulationResult) {
                if (message.simulationResult.operationId !== activeSimulationIdRef.current) return;
                if (simulationTimeoutRef.current !== null) window.clearTimeout(simulationTimeoutRef.current);
                simulationTimeoutRef.current = null;
                activeSimulationIdRef.current = null;
                setSimulationResult(message.simulationResult);
                setSimulationPending(false);
                return;
            }
            setRuntime((current) => reduceRuntimeMessage(current, message));
        });
        port.onDisconnect.addListener(() => {
            if (simulationTimeoutRef.current !== null) window.clearTimeout(simulationTimeoutRef.current);
            simulationTimeoutRef.current = null;
            activeSimulationIdRef.current = null;
            setSimulationPending(false);
            setSimulationResult({
                operationId: crypto.randomUUID(),
                success: false,
                message: '后台连接已断开，请重新打开调试器',
            });
            setRuntime((current) => ({ ...current, scanning: false, disconnected: true }));
        });
        return () => {
            if (simulationTimeoutRef.current !== null) window.clearTimeout(simulationTimeoutRef.current);
            port.disconnect();
            portRef.current = null;
        };
    }, [chooseColorMode, chooseTheme]);

    useEffect(() => {
        const now = Date.now();
        const nextExpiry = runtime.diagnostics.reduce<number | null>((nearest, diagnostic) => {
            if (!diagnostic.expiresAt || diagnostic.expiresAt <= now) return nearest;
            return nearest === null ? diagnostic.expiresAt : Math.min(nearest, diagnostic.expiresAt);
        }, null);
        if (nextExpiry === null) return;
        /** 在最近一条瞬时诊断到期后触发重渲染，避免状态依赖后续后台消息刷新。 */
        const timer = window.setTimeout(() => setDiagnosticTick((value) => value + 1), nextExpiry - now + 1);
        return () => window.clearTimeout(timer);
    }, [diagnosticTick, runtime.diagnostics]);

    useEffect(() => {
        if (colorMode !== 'system') return;
        const colorScheme = matchMedia('(prefers-color-scheme: dark)');
        /** 跟随电脑系统主题变化更新界面明暗。 */
        const syncColorMode = (): void => {
            document.documentElement.dataset.colorMode = colorScheme.matches ? 'dark' : 'light';
        };
        colorScheme.addEventListener('change', syncColorMode);
        return () => colorScheme.removeEventListener('change', syncColorMode);
    }, [colorMode]);

    useEffect(() => {
        if (themePreference !== 'auto') return;
        /** 定期依据电脑本地月份同步自动主题。 */
        const syncSeason = (): void => {
            const nextSeason = resolveThemeSeason('auto');
            setSeason(nextSeason);
            document.documentElement.dataset.season = nextSeason;
        };
        const timer = window.setInterval(syncSeason, 60 * 60 * 1000);
        document.addEventListener('visibilitychange', syncSeason);
        return () => {
            window.clearInterval(timer);
            document.removeEventListener('visibilitychange', syncSeason);
        };
    }, [themePreference]);

    useEffect(() => {
        if (!connections.length) setSelectedConnection(null);
        else if (!connections.some(({ key }) => key === selectedConnection))
            setSelectedConnection(connections.find(({ status }) => status === 'open')?.key || connections[0]!.key);
    }, [connections, selectedConnection]);

    /** 更新当前连接独立保存的搜索或方向筛选条件。 */
    const updateFilter = <Key extends keyof ConnectionFilter>(name: Key, value: ConnectionFilter[Key]): void => {
        if (!selectedConnection) return;
        setFilters((current) => ({
            ...current,
            [selectedConnection]: { ...DEFAULT_FILTER, ...current[selectedConnection], [name]: value },
        }));
    };

    /** 翻转消息列表的时间排序。 */
    const toggleSort = (): void => {
        const nextOrder = sortOrder === 'asc' ? 'desc' : 'asc';
        setSortOrder(nextOrder);
    };

    /** 将当前连接经过筛选的帧导出为 JSON 文件。 */
    const exportFrames = (): void => {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(
            new Blob(
                [
                    JSON.stringify(
                        {
                            exportedAt: new Date().toISOString(),
                            generation: runtime.generation,
                            connection: selectedConnectionData,
                            directionFilter: activeFilter.direction,
                            search: activeFilter.search,
                            frames: filteredFrames,
                        },
                        null,
                        2,
                    ),
                ],
                { type: 'application/json' },
            ),
        );
        link.download = `websocket-frames-${Date.now()}.json`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    };

    /** 复制选中帧的原始 payload，并短暂显示操作反馈。 */
    const copyPayload = async (): Promise<void> => {
        if (!selectedFrame) return;
        await navigator.clipboard.writeText(selectedFrame.payloadData);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
    };

    /** 选择消息并打开与该消息绑定的详情面板。 */
    const selectFrame = (id: number): void => {
        setSimulationOpen(false);
        setSelectedFrameId(id);
    };

    /** 切换连接时关闭旧连接的消息详情。 */
    const selectConnection = (key: string): void => {
        setSelectedConnection(key);
        setSelectedFrameId(null);
        setSimulationOpen(false);
        setSimulationResult(null);
    };

    /** 清空当前连接的全部已捕获帧。 */
    const clearSelectedConnection = (): void => {
        if (!selectedConnectionData) return;
        send({
            type: 'clear-connection',
            targetId: selectedConnectionData.targetId,
            requestId: selectedConnectionData.requestId,
        });
    };

    /** 打开模拟面板，并关闭消息详情以复用右侧可调宽度区域。 */
    const openSimulator = (): void => {
        setSelectedFrameId(null);
        setSimulationResult(null);
        setSimulationOpen(true);
    };

    /** 将模拟操作提交给当前连接所在的页面或 Worker 调试目标。 */
    const executeSimulation = (input: {
        action: SimulationAction;
        payload: string;
        closeCode?: number;
        closeReason?: string;
    }): void => {
        if (!selectedConnectionData || selectedConnectionData.status !== 'open') return;
        if (!portRef.current || runtime.disconnected) {
            setSimulationPending(false);
            setSimulationResult({
                operationId: crypto.randomUUID(),
                success: false,
                message: '后台连接不可用，请重新打开调试器',
            });
            return;
        }
        const operationId = crypto.randomUUID();
        activeSimulationIdRef.current = operationId;
        if (simulationTimeoutRef.current !== null) window.clearTimeout(simulationTimeoutRef.current);
        simulationTimeoutRef.current = window.setTimeout(() => {
            if (activeSimulationIdRef.current !== operationId) return;
            activeSimulationIdRef.current = null;
            simulationTimeoutRef.current = null;
            setSimulationPending(false);
            setSimulationResult({
                operationId,
                success: false,
                message: '模拟操作响应超时，请确认当前页面或 Worker 仍在运行',
            });
        }, 6000);
        setSimulationPending(true);
        setSimulationResult(null);
        send({
            type: 'simulate',
            operationId,
            targetId: selectedConnectionData.targetId,
            requestId: selectedConnectionData.requestId,
            socketUrl: selectedConnectionData.url,
            ...input,
        });
    };

    const sidePanelOpen = simulationOpen || Boolean(selectedFrame);

    /** 保存扫描周期，并立即通知后台重建周期扫描定时器。 */
    const updateScanInterval = (intervalMs: number): void => {
        setScanIntervalMs(intervalMs);
        localStorage.setItem('ycloud-ws-scan-interval', String(intervalMs));
        send({ type: 'set-scan-interval', intervalMs });
    };

    return (
        <div className="inspector-shell">
            <InspectorHeader
                colorMode={colorMode}
                heartbeatMessages={heartbeatMessagesText}
                hideHeartbeat={hideHeartbeat}
                preference={themePreference}
                scanIntervalMs={scanIntervalMs}
                season={season}
                scanning={runtime.scanning}
                showMetadata={showMetadata}
                onColorModeChange={chooseColorMode}
                onHeartbeatMessagesChange={setHeartbeatMessagesText}
                onHideHeartbeatChange={setHideHeartbeat}
                onMetadataChange={setShowMetadata}
                onScanIntervalChange={updateScanInterval}
                onThemeChange={chooseTheme}
                onRescan={() => send({ type: 'rescan' })}
            />
            <div className="workspace-frame">
                <Group
                    className="workspace"
                    key={sidePanelOpen ? 'side-panel-open' : 'side-panel-closed'}
                    orientation="horizontal"
                >
                    <Panel defaultSize="300px" maxSize="420px" minSize="250px">
                        <ConnectionSidebar
                            connections={connections}
                            domains={connectionDomains}
                            filteredConnections={filteredConnections}
                            filters={connectionFilters}
                            group={connectionGroup}
                            sort={connectionSort}
                            paused={paused}
                            selectedConnection={selectedConnection}
                            totalFrames={totalFrames}
                            onFiltersChange={setConnectionFilters}
                            onGroupChange={setConnectionGroup}
                            onSortChange={setConnectionSort}
                            onSelect={selectConnection}
                            onToggleAll={() => send({ type: 'set-all-connections-paused', paused: !paused })}
                            onToggleConnection={(connection) =>
                                send({
                                    type: 'set-connection-paused',
                                    targetId: connection.targetId,
                                    requestId: connection.requestId,
                                    paused: !connection.capturePaused,
                                })
                            }
                        />
                    </Panel>
                    <Separator className="panel-resizer" />
                    <Panel minSize="420px">
                        <main className="messages-panel">
                            <FrameToolbar
                                activeFilter={activeFilter}
                                captureError={captureError}
                                disconnected={runtime.disconnected}
                                followLatest={followLatest}
                                selectedConnection={selectedConnection}
                                selectedConnectionData={selectedConnectionData}
                                selectedFrameCount={selectedFrames.length}
                                storageError={storageError}
                                onClear={clearSelectedConnection}
                                onExport={exportFrames}
                                onFilterChange={updateFilter}
                                onFollowLatestChange={setFollowLatest}
                                onOpenSimulator={openSimulator}
                            />
                            <VirtualizedFrameTable
                                key={selectedConnection ?? 'no-connection'}
                                containerRef={tableRef}
                                frames={visibleFrames}
                                followLatest={followLatest}
                                selectedConnection={selectedConnection}
                                selectedFrameId={selectedFrameId}
                                sortOrder={sortOrder}
                                onSelect={selectFrame}
                                onSort={toggleSort}
                            />
                        </main>
                    </Panel>
                    {sidePanelOpen && <Separator className="panel-resizer" />}
                    {sidePanelOpen && (
                        <Panel defaultSize="380px" maxSize="560px" minSize="300px">
                            {simulationOpen && selectedConnectionData ? (
                                <SimulationPanel
                                    connection={selectedConnectionData}
                                    pending={simulationPending}
                                    result={simulationResult}
                                    onClose={() => setSimulationOpen(false)}
                                    onExecute={executeSimulation}
                                />
                            ) : selectedFrame ? (
                                <FrameDetail
                                    copied={copied}
                                    connection={selectedConnectionData}
                                    formattedPayload={formattedPayload}
                                    frame={selectedFrame}
                                    showMetadata={showMetadata}
                                    onClose={() => setSelectedFrameId(null)}
                                    onCopy={copyPayload}
                                />
                            ) : null}
                        </Panel>
                    )}
                </Group>
            </div>
        </div>
    );
};
