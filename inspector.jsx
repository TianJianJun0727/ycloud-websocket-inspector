import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { formatByteSize, parseJsonPayload } from './frame-utils.js';
import { FRAME_STORE_LIMITS } from './frame-store.js';
import {
  bucketFramesByConnection,
  getVirtualWindow,
  isActiveDiagnostic,
  matchesTextFilter,
  mergeFrameBuckets,
  orderRecentFrames,
  resolveConnectionRecords,
} from './inspector-utils.js';

const TABLE_ROW_HEIGHT = 42;
const TABLE_OVERSCAN = 12;
const DEFAULT_LIMITS = FRAME_STORE_LIMITS;
const isDemo = new URLSearchParams(location.search).get('demo') === '1';

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function connectionKey(targetId, requestId) {
  return targetId + '::' + requestId;
}

function formatClock(timestamp) {
  const date = new Date(timestamp);
  const pad = (value, length = 2) => String(value).padStart(length, '0');
  return (
    date.getFullYear() +
    '-' +
    pad(date.getMonth() + 1) +
    '-' +
    pad(date.getDate()) +
    ' ' +
    pad(date.getHours()) +
    ':' +
    pad(date.getMinutes()) +
    ':' +
    pad(date.getSeconds()) +
    '.' +
    pad(date.getMilliseconds(), 3)
  );
}

function formatConnectionTime(timestamp, fallback) {
  if (!timestamp) return fallback;
  return formatClock(timestamp).slice(0, 19);
}

function connectionStateLabel(connection) {
  if (!connection) return '未选择连接';
  if (connection.status === 'closed') return '已关闭';
  if (connection.capturePaused) return '已暂停记录';
  if (connection.status === 'connecting') return '连接中';
  return '记录中';
}

function displayUrl(url, fallback = '未知 URL') {
  if (!url) return fallback;
  try {
    const parsed = new URL(url);
    return parsed.host + parsed.pathname;
  } catch {
    return url;
  }
}

function displayConnection(connection) {
  if (connection.url) return displayUrl(connection.url);
  const worker = displayUrl(connection.targetUrl, 'SharedWorker');
  const suffix = String(connection.requestId || '').slice(-8);
  return worker + ' · WS #' + suffix;
}

function Icon({ name, size = 16 }) {
  const paths = {
    search: (
      <>
        <path d="m21 21-4.34-4.34" />
        <circle
          cx="11"
          cy="11"
          r="8"
        />
      </>
    ),
    pause: (
      <>
        <rect
          x="14"
          y="3"
          width="5"
          height="18"
          rx="1"
        />
        <rect
          x="5"
          y="3"
          width="5"
          height="18"
          rx="1"
        />
      </>
    ),
    play: (
      <path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z" />
    ),
    refresh: (
      <>
        <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
        <path d="M21 3v5h-5" />
        <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
        <path d="M8 16H3v5" />
      </>
    ),
    trash: (
      <path d="M10 11v6M14 11v6M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    ),
    export: <path d="M19 3H5M12 21V7M6 15l6 6 6-6" />,
    copy: (
      <>
        <rect
          width="14"
          height="14"
          x="8"
          y="8"
          rx="2"
          ry="2"
        />
        <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
      </>
    ),
    monitor: (
      <>
        <rect
          width="20"
          height="14"
          x="2"
          y="3"
          rx="2"
        />
        <path d="M8 21h8M12 17v4" />
      </>
    ),
    sun: (
      <>
        <circle
          cx="12"
          cy="12"
          r="4"
        />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
      </>
    ),
    moon: (
      <path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401" />
    ),
    activity: (
      <path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" />
    ),
  };

  return (
    <svg
      aria-hidden="true"
      className="ui-icon"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
    >
      {paths[name]}
    </svg>
  );
}

function createDemoPort() {
  let generation = 0;
  let cleared = false;
  const now = Date.now();
  const showClosedConnection = new URLSearchParams(location.search).get('demoClosed') === '1';
  const target = {
    id: 'demo-shared-worker',
    type: 'shared_worker',
    title: 'inbox-shared-worker',
    url: 'http://localhost:3091/inbox-web/ws.shared-worker.js',
    attachedAt: now - 120000,
    sockets: [
      {
        requestId: 'socket-demo-1',
        url: 'ws://localhost:8787/inbox',
        createdAt: now - 120000,
        closedAt: null,
        status: 'open',
        capturePaused: false,
      },
      {
        requestId: 'socket-demo-2',
        url: 'wss://push.example.com/notifications',
        createdAt: now - 60000,
        closedAt: showClosedConnection ? now - 30000 : null,
        status: showClosedConnection ? 'closed' : 'open',
        capturePaused: false,
      },
    ],
  };
  const samples = [
    ['received', 'socket-demo-1', '{"type":"connected","connectionId":"ws-8fd2"}'],
    ['sent', 'socket-demo-1', 'ping'],
    ['received', 'socket-demo-1', 'pong'],
    [
      'received',
      'socket-demo-1',
      '{"type":"conversation.updated","conversationId":"conv_1024","unreadCount":3}',
    ],
    [
      'received',
      'socket-demo-1',
      '{"type":"message.created","message":{"id":"msg_9081","text":"Hello from websocket"}}',
    ],
    ['sent', 'socket-demo-2', '{"action":"subscribe","channel":"notifications"}'],
    ['received', 'socket-demo-2', '{"event":"notification.created","id":"notice_78"}'],
    ['received', 'socket-demo-1', '{"key":"contact.updated","contactId":"contact_31"}'],
  ];
  const requestedRows = Number(new URLSearchParams(location.search).get('demoRows'));
  const demoRowCount =
    Number.isFinite(requestedRows) && requestedRows > 0
      ? Math.min(requestedRows, DEFAULT_LIMITS.maxFramesPerConnection)
      : samples.length;
  const frames = Array.from({ length: demoRowCount }, (_, index) => {
    const [direction, requestId, payloadData] = samples[index % samples.length];
    return {
      id: index + 1,
      generation,
      direction,
      payloadData,
      payloadBytes: new TextEncoder().encode(payloadData).byteLength,
      retainedPayloadBytes: new TextEncoder().encode(payloadData).byteLength,
      truncated: false,
      opcode: 1,
      mask: false,
      requestId,
      socketUrl:
        requestId === 'socket-demo-1'
          ? 'ws://localhost:8787/inbox'
          : 'wss://push.example.com/notifications',
      targetId: target.id,
      targetUrl: target.url,
      receivedAt: now - (demoRowCount - index) * 730,
      timestamp: index,
    };
  });
  const messageListeners = [];
  const disconnectListeners = [];
  let frameBuckets = bucketFramesByConnection(frames);

  return {
    onMessage: {
      addListener(listener) {
        messageListeners.push(listener);
        queueMicrotask(() => {
          listener({
            type: 'state',
            generation,
            targets: [target],
            frameBuckets: cleared ? {} : frameBuckets,
            scanning: false,
            diagnostics: [],
            limits: DEFAULT_LIMITS,
          });
        });
      },
    },
    onDisconnect: {
      addListener(listener) {
        disconnectListeners.push(listener);
      },
    },
    postMessage(message) {
      if (message.type === 'clear') {
        generation += 1;
        cleared = true;
        for (const listener of messageListeners) {
          listener({ type: 'cleared', generation });
        }
      } else if (message.type === 'clear-connection') {
        const key = connectionKey(message.targetId, message.requestId);
        frameBuckets = { ...frameBuckets, [key]: [] };
        for (const listener of messageListeners) {
          listener({ type: 'connection-cleared', connectionKey: key, generation });
        }
      } else if (message.type === 'set-connection-paused') {
        const socket = target.sockets.find((item) => item.requestId === message.requestId);
        if (socket && socket.status !== 'closed') socket.capturePaused = message.paused;
        for (const listener of messageListeners) {
          listener({
            type: 'status',
            generation,
            targets: [target],
            scanning: false,
          });
        }
      } else if (message.type === 'set-all-connections-paused') {
        for (const socket of target.sockets) {
          if (socket.status !== 'closed') socket.capturePaused = message.paused;
        }
        for (const listener of messageListeners) {
          listener({
            type: 'status',
            generation,
            targets: [target],
            scanning: false,
          });
        }
      }
    },
  };
}

function createInspectorPort() {
  if (isDemo) return createDemoPort();
  if (!window.chrome?.runtime?.connect) return null;
  return window.chrome.runtime.connect({ name: 'shared-worker-ws-inspector' });
}

function ResizeHandle({ axis, label, onDelta }) {
  const onPointerDown = (event) => {
    event.preventDefault();
    let previous = axis === 'x' ? event.clientX : event.clientY;
    document.body.classList.add('is-resizing');

    const onPointerMove = (moveEvent) => {
      const current = axis === 'x' ? moveEvent.clientX : moveEvent.clientY;
      onDelta(current - previous);
      previous = current;
    };
    const onPointerUp = () => {
      document.body.classList.remove('is-resizing');
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

  return (
    <div
      aria-label={label}
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      className={'resize-handle resize-' + axis}
      onPointerDown={onPointerDown}
      role="separator"
    >
      <span />
    </div>
  );
}

function VirtualizedFrameTable({
  frames,
  selectedConnection,
  selectedFrameId,
  setFollowLatest,
  setSelectedFrameId,
  setSortOrder,
  sortOrder,
  tableWrapRef,
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(480);

  useEffect(() => {
    const container = tableWrapRef.current;
    if (!container) return undefined;
    const updateHeight = () => setViewportHeight(container.clientHeight);
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(container);
    return () => observer.disconnect();
  }, [tableWrapRef]);

  useEffect(() => {
    const container = tableWrapRef.current;
    if (container) container.scrollTop = 0;
    setScrollTop(0);
  }, [selectedConnection, sortOrder, tableWrapRef]);

  const { startIndex, endIndex, topSpacerHeight, bottomSpacerHeight } = getVirtualWindow(
    frames.length,
    scrollTop,
    viewportHeight,
    TABLE_ROW_HEIGHT,
    TABLE_OVERSCAN,
  );
  const renderedFrames = frames.slice(startIndex, endIndex);

  return (
    <div
      className="table-wrap"
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      ref={tableWrapRef}
    >
      <table aria-rowcount={frames.length + 1}>
        <thead>
          <tr>
            <th aria-sort={sortOrder === 'asc' ? 'ascending' : 'descending'}>
              <button
                aria-label={
                  sortOrder === 'asc' ? '时间正序，点击切换倒序' : '时间倒序，点击切换正序'
                }
                className="sort-heading"
                onClick={() => setSortOrder((current) => (current === 'asc' ? 'desc' : 'asc'))}
              >
                时间 <span aria-hidden="true">{sortOrder === 'asc' ? '↑' : '↓'}</span>
              </button>
            </th>
            <th>方向</th>
            <th>大小</th>
            <th>消息预览</th>
          </tr>
        </thead>
        <tbody>
          {topSpacerHeight > 0 && (
            <tr
              aria-hidden="true"
              className="virtual-spacer"
            >
              <td
                colSpan="4"
                style={{ height: topSpacerHeight }}
              />
            </tr>
          )}
          {renderedFrames.map((frame, index) => (
            <tr
              aria-rowindex={startIndex + index + 2}
              className={frame.id === selectedFrameId ? 'selected' : ''}
              key={frame.id}
              onClick={() => {
                setSelectedFrameId(frame.id);
                setFollowLatest(false);
              }}
            >
              <td>{formatClock(frame.receivedAt)}</td>
              <td>
                <span className={'direction ' + frame.direction}>
                  {frame.direction === 'received' ? '↓ 下行' : '↑ 上行'}
                </span>
              </td>
              <td>{formatByteSize(frame.payloadBytes)}</td>
              <td
                className="payload-preview"
                title={frame.payloadData}
              >
                {frame.payloadData || '(空消息)'}
              </td>
            </tr>
          ))}
          {bottomSpacerHeight > 0 && (
            <tr
              aria-hidden="true"
              className="virtual-spacer"
            >
              <td
                colSpan="4"
                style={{ height: bottomSpacerHeight }}
              />
            </tr>
          )}
        </tbody>
      </table>
      {frames.length === 0 && (
        <div className="empty-state">
          <span className="empty-icon">↯</span>
          <strong>{selectedConnection ? '等待当前连接消息' : '请选择 WebSocket 连接'}</strong>
          <p>
            {selectedConnection
              ? '当前搜索或方向筛选下暂无消息。'
              : '从左侧选择一次具体连接后查看对应消息。'}
          </p>
        </div>
      )}
    </div>
  );
}

function buildConnections(targets, frameBuckets) {
  const result = [];
  for (const target of targets) {
    const sockets = new Map((target.sockets || []).map((socket) => [socket.requestId, socket]));
    for (const bucket of Object.values(frameBuckets)) {
      const frame = bucket[0];
      if (!frame || frame.targetId !== target.id || sockets.has(frame.requestId)) continue;
      sockets.set(frame.requestId, { requestId: frame.requestId, url: frame.socketUrl });
    }
    for (const socket of sockets.values()) {
      const key = connectionKey(target.id, socket.requestId);
      const socketFrames = frameBuckets[key] || [];
      result.push({
        key,
        targetId: target.id,
        targetTitle: target.title || 'SharedWorker',
        targetUrl: target.url,
        requestId: socket.requestId,
        url: socket.url || socketFrames.at(-1)?.socketUrl || '',
        createdAt: socket.createdAt || socketFrames[0]?.receivedAt || null,
        closedAt: socket.closedAt,
        status: socket.status || (socket.closedAt ? 'closed' : 'open'),
        capturePaused: Boolean(socket.capturePaused),
        frameCount: socketFrames.length,
      });
    }
  }
  return result;
}

function App() {
  const portRef = useRef(null);
  const tableWrapRef = useRef(null);
  const [runtime, setRuntime] = useState({
    generation: 0,
    frameBuckets: {},
    targets: [],
    connections: null,
    diagnostics: [],
    limits: DEFAULT_LIMITS,
    scanning: true,
    disconnected: false,
  });
  const [selectedConnection, setSelectedConnection] = useState(null);
  const [selectedFrameId, setSelectedFrameId] = useState(null);
  const [filtersByConnection, setFiltersByConnection] = useState({});
  const [sortOrder, setSortOrder] = useState('asc');
  const [followLatest, setFollowLatest] = useState(true);
  const [theme, setTheme] = useState(() => {
    const savedTheme = localStorage.getItem('ycloud-ws-theme');
    return ['system', 'light', 'dark'].includes(savedTheme) ? savedTheme : 'system';
  });
  const [sidebarWidth, setSidebarWidth] = useState(270);
  const [detailHeight, setDetailHeight] = useState(290);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('ycloud-ws-theme', theme);
  }, [theme]);

  useEffect(() => {
    const port = createInspectorPort();
    portRef.current = port;
    if (!port) {
      setRuntime((current) => ({
        ...current,
        scanning: false,
        disconnected: true,
      }));
      return undefined;
    }

    const onMessage = (message) => {
      setRuntime((current) => {
        const generation = Number.isFinite(message.generation)
          ? message.generation
          : current.generation;
        if (generation < current.generation) return current;

        if (message.type === 'frame' || message.type === 'frame-batch') {
          const incomingFrames =
            message.type === 'frame-batch' ? message.frames || [] : [message.frame];
          const evictedFrameIds = [...(message.evictedFrameIds || [])];
          if (Number.isFinite(message.retainedFromId)) {
            for (const bucket of Object.values(current.frameBuckets)) {
              for (const frame of bucket) {
                if (frame.id < message.retainedFromId) evictedFrameIds.push(frame.id);
              }
            }
          }
          const maximum =
            message.limits?.maxFramesPerConnection || DEFAULT_LIMITS.maxFramesPerConnection;
          const frameBuckets = mergeFrameBuckets(
            generation > current.generation ? {} : current.frameBuckets,
            incomingFrames,
            evictedFrameIds,
            maximum,
          );
          return {
            ...current,
            generation,
            frameBuckets,
            limits: message.limits || current.limits,
          };
        }

        if (message.type === 'cleared') {
          return {
            ...current,
            generation,
            frameBuckets: {},
          };
        }

        if (message.type === 'connection-cleared') {
          const frameBuckets = { ...current.frameBuckets };
          delete frameBuckets[message.connectionKey];
          return { ...current, generation, frameBuckets };
        }

        if (message.type === 'state' || message.type === 'status') {
          return {
            ...current,
            generation,
            frameBuckets:
              message.frameBuckets && generation >= current.generation
                ? message.frameBuckets
                : Array.isArray(message.frames) && generation >= current.generation
                  ? bucketFramesByConnection(message.frames)
                  : current.frameBuckets,
            targets: Array.isArray(message.targets) ? message.targets : current.targets,
            connections: Array.isArray(message.connections)
              ? message.connections
              : current.connections,
            diagnostics: Array.isArray(message.diagnostics)
              ? message.diagnostics
              : current.diagnostics,
            limits: message.limits || current.limits,
            scanning: typeof message.scanning === 'boolean' ? message.scanning : current.scanning,
            disconnected: false,
          };
        }
        return current;
      });
    };

    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(() => {
      setRuntime((current) => ({
        ...current,
        scanning: false,
        disconnected: true,
      }));
    });
    return undefined;
  }, []);

  const connections = useMemo(() => {
    const records = resolveConnectionRecords(
      runtime.connections,
      buildConnections(runtime.targets, runtime.frameBuckets),
    );
    return records.map((connection) => ({
      ...connection,
      frameCount: runtime.frameBuckets[connection.key]?.length || 0,
    }));
  }, [runtime.connections, runtime.targets, runtime.frameBuckets]);

  const activeFilters = filtersByConnection[selectedConnection] || {
    direction: 'all',
    search: '',
  };
  const updateActiveFilter = (name, value) => {
    if (!selectedConnection) return;
    setFiltersByConnection((current) => ({
      ...current,
      [selectedConnection]: {
        direction: 'all',
        search: '',
        ...current[selectedConnection],
        [name]: value,
      },
    }));
  };
  const selectedFrames = selectedConnection ? runtime.frameBuckets[selectedConnection] || [] : [];
  const filteredFrames = useMemo(() => {
    return selectedFrames.filter((frame) => {
      if (activeFilters.direction !== 'all' && frame.direction !== activeFilters.direction) {
        return false;
      }
      return matchesTextFilter(
        [frame.socketUrl, frame.targetUrl, frame.payloadData],
        activeFilters.search,
      );
    });
  }, [selectedFrames, activeFilters.direction, activeFilters.search]);

  const recentFrames = useMemo(
    () => orderRecentFrames(filteredFrames, 'asc', filteredFrames.length),
    [filteredFrames],
  );
  const latestFrame = recentFrames.at(-1);

  useEffect(() => {
    if (followLatest) {
      setSelectedFrameId(latestFrame?.id ?? null);
    }
  }, [latestFrame?.id, followLatest]);

  useEffect(() => {
    if (connections.length === 0) setSelectedConnection(null);
    else if (!connections.some((connection) => connection.key === selectedConnection)) {
      setSelectedConnection(
        connections.find((connection) => connection.status === 'open')?.key || connections[0].key,
      );
    }
  }, [connections, selectedConnection]);

  const selectedFrame = selectedFrames.find((frame) => frame.id === selectedFrameId);
  const selectedConnectionData = connections.find(
    (connection) => connection.key === selectedConnection,
  );
  const visibleFrames = useMemo(
    () => (sortOrder === 'asc' ? recentFrames : [...recentFrames].reverse()),
    [recentFrames, sortOrder],
  );
  const latestVisibleFrameId = latestFrame?.id;
  const activeConnections = connections.filter((connection) => connection.status !== 'closed');
  const hasPausedConnections = activeConnections.some((connection) => connection.capturePaused);
  const latestStorageError = runtime.diagnostics.find(
    (diagnostic) => diagnostic.level === 'error' && diagnostic.source === 'storage',
  );
  const now = Date.now();
  const latestCaptureError = runtime.diagnostics.find(
    (diagnostic) =>
      diagnostic.level === 'error' &&
      diagnostic.source !== 'storage' &&
      isActiveDiagnostic(diagnostic, now),
  );

  useEffect(() => {
    if (!followLatest || !tableWrapRef.current) return;
    const frame = requestAnimationFrame(() => {
      const container = tableWrapRef.current;
      if (container) container.scrollTop = sortOrder === 'asc' ? container.scrollHeight : 0;
    });
    return () => cancelAnimationFrame(frame);
  }, [
    followLatest,
    latestVisibleFrameId,
    selectedConnection,
    activeFilters.direction,
    activeFilters.search,
    sortOrder,
  ]);

  const totalFrameCount = Object.values(runtime.frameBuckets).reduce(
    (total, bucket) => total + bucket.length,
    0,
  );

  const countLabel = '当前连接 ' + selectedFrames.length + ' 条';

  const send = (message) => portRef.current?.postMessage(message);

  const exportFrames = () => {
    const data = {
      exportedAt: new Date().toISOString(),
      generation: runtime.generation,
      connection: selectedConnectionData,
      directionFilter: activeFilters.direction,
      search: activeFilters.search,
      frames: filteredFrames,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: 'application/json',
    });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'shared-worker-websocket-frames-' + Date.now() + '.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  };

  const copyPayload = async () => {
    if (!selectedFrame) return;
    await navigator.clipboard.writeText(selectedFrame.payloadData);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const formattedPayload = selectedFrame
    ? (() => {
        const parsed = parseJsonPayload(selectedFrame.payloadData, selectedFrame.opcode);
        return (
          (parsed ? JSON.stringify(parsed, null, 2) : selectedFrame.payloadData) +
          (selectedFrame.truncated ? '\n\n[消息超过 1 MB，已截断]' : '')
        );
      })()
    : '从上方列表选择一条消息查看完整内容。';

  return (
    <>
      <header className="toolbar">
        <div className="brand">
          <span className="brand-mark">
            <img
              alt="YCloud"
              src="./assets/ycloud-logo.svg"
            />
          </span>
          <div>
            <h1>YCloud WebSocket 监听器</h1>
            <p>监听 SharedWorker WebSocket 消息</p>
          </div>
        </div>
        <div className="toolbar-actions">
          <div
            aria-label="主题"
            className="theme-switcher"
            role="group"
          >
            {[
              ['system', 'monitor', '跟随系统'],
              ['light', 'sun', '亮色'],
              ['dark', 'moon', '暗色'],
            ].map(([value, icon, label]) => (
              <button
                aria-label={label}
                aria-pressed={theme === value}
                className="icon-button theme-button"
                key={value}
                onClick={() => setTheme(value)}
                title={label}
              >
                <Icon name={icon} />
              </button>
            ))}
          </div>
          <button
            className="secondary-button button-with-icon"
            onClick={() => send({ type: 'rescan' })}
          >
            <Icon name="refresh" />
            重新扫描
          </button>
        </div>
      </header>

      <main
        className="workspace"
        style={{ '--sidebar-width': sidebarWidth + 'px' }}
      >
        <aside className="sidebar">
          <div className="section-heading">
            <span>WebSocket 连接</span>
            <span className="count-pill">{connections.length}</span>
          </div>
          <div className="connections-overview">
            <span className="overview-icon">
              <Icon
                name="activity"
                size={18}
              />
            </span>
            <span className="connection-copy">
              <strong>连接概览</strong>
              <small>{connections.length + ' 个连接 · ' + totalFrameCount + ' 条消息'}</small>
            </span>
            <button
              className="bulk-capture-button"
              disabled={activeConnections.length === 0}
              onClick={() =>
                send({
                  type: 'set-all-connections-paused',
                  paused: !hasPausedConnections,
                })
              }
              title={
                hasPausedConnections
                  ? '继续记录全部活动连接，已关闭连接不受影响'
                  : '暂停记录全部活动连接，已关闭连接不受影响'
              }
            >
              <Icon name={hasPausedConnections ? 'play' : 'pause'} />
              {hasPausedConnections ? '全部开始' : '全部暂停'}
            </button>
          </div>
          <div className="connection-list-label">连接实例</div>
          <div className="target-list">
            {connections.map((connection) => (
              <div
                className={
                  'target-item' +
                  (selectedConnection === connection.key ? ' selected' : '') +
                  (connection.capturePaused ? ' capture-paused' : '')
                }
                key={connection.key}
              >
                <button
                  aria-label={'选择连接 ' + displayConnection(connection)}
                  className="connection-select-button"
                  onClick={() => setSelectedConnection(connection.key)}
                >
                  <span
                    className={
                      'target-icon status-' +
                      (connection.capturePaused ? 'paused' : connection.status)
                    }
                  >
                    <span className="status-core" />
                  </span>
                  <span>
                    <strong title={connection.url || connection.targetUrl}>
                      {displayConnection(connection)}
                    </strong>
                    <small title={connection.targetUrl}>
                      {connection.frameCount +
                        ' 条保留 · ' +
                        connectionStateLabel(connection) +
                        ' · ' +
                        connection.targetTitle}
                    </small>
                  </span>
                </button>
                {connection.status !== 'closed' && (
                  <button
                    aria-label={
                      (connection.capturePaused ? '继续记录 ' : '暂停记录 ') +
                      displayConnection(connection)
                    }
                    className="connection-capture-button"
                    aria-pressed={connection.capturePaused}
                    onClick={() =>
                      send({
                        type: 'set-connection-paused',
                        targetId: connection.targetId,
                        requestId: connection.requestId,
                        paused: !connection.capturePaused,
                      })
                    }
                    title={connection.capturePaused ? '继续记录此连接' : '暂停记录此连接'}
                  >
                    <Icon name={connection.capturePaused ? 'play' : 'pause'} />
                  </button>
                )}
              </div>
            ))}
          </div>
          <div className="sidebar-footer">
            <strong>监听说明</strong>
            <p>暂停仅停止记录，不会中断业务连接。</p>
          </div>
        </aside>

        <ResizeHandle
          axis="x"
          label="调整连接列表宽度"
          onDelta={(delta) => setSidebarWidth((width) => clamp(width + delta, 210, 480))}
        />

        <section className="main-panel">
          <section className="connection-toolbar">
            <div className="connection-context-row">
              <span className="connection-period">
                {selectedConnectionData
                  ? formatConnectionTime(selectedConnectionData.createdAt, '未知') +
                    ' - ' +
                    formatConnectionTime(selectedConnectionData.closedAt, '至今')
                  : runtime.disconnected
                    ? '扩展后台已断开'
                    : '请选择连接'}
              </span>
              <span className="status-count">{countLabel}</span>
              {latestStorageError && (
                <span
                  className="storage-warning"
                  title={latestStorageError.message}
                >
                  存储异常
                </span>
              )}
              {!latestStorageError && latestCaptureError && (
                <span
                  className="storage-warning"
                  title={latestCaptureError.message}
                >
                  监听异常
                </span>
              )}
              {filteredFrames.length !== selectedFrames.length && (
                <span className="status-count filtered-count">显示 {filteredFrames.length} 条</span>
              )}
              <label className="follow-toggle">
                <input
                  checked={followLatest}
                  onChange={(event) => setFollowLatest(event.target.checked)}
                  type="checkbox"
                />
                跟随最新
              </label>
            </div>
            <div className="connection-action-row">
              <label className="search-field connection-search">
                <Icon
                  name="search"
                  size={18}
                />
                <input
                  aria-label="搜索当前连接消息"
                  disabled={!selectedConnection}
                  onChange={(event) => updateActiveFilter('search', event.target.value)}
                  placeholder="筛选当前连接消息或 /正则/i"
                  type="search"
                  value={activeFilters.search}
                />
              </label>
              <div
                aria-label="方向筛选"
                className="direction-filter"
                role="group"
              >
                {[
                  ['all', '全部'],
                  ['received', '下行'],
                  ['sent', '上行'],
                ].map(([value, label]) => (
                  <button
                    aria-pressed={activeFilters.direction === value}
                    disabled={!selectedConnection}
                    key={value}
                    onClick={() => updateActiveFilter('direction', value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <span className="action-divider" />
              <button
                aria-label="清空当前连接"
                className="icon-button danger"
                disabled={!selectedConnectionData}
                onClick={() => {
                  if (!selectedConnectionData) return;
                  send({
                    type: 'clear-connection',
                    targetId: selectedConnectionData.targetId,
                    requestId: selectedConnectionData.requestId,
                  });
                }}
                title="清空当前连接"
              >
                <Icon name="trash" />
              </button>
              <button
                aria-label="导出当前连接"
                className="icon-button export-action"
                disabled={!selectedConnectionData}
                onClick={exportFrames}
                title="导出当前连接"
              >
                <Icon name="export" />
              </button>
            </div>
          </section>

          <VirtualizedFrameTable
            frames={visibleFrames}
            selectedConnection={selectedConnection}
            selectedFrameId={selectedFrameId}
            setFollowLatest={setFollowLatest}
            setSelectedFrameId={setSelectedFrameId}
            setSortOrder={setSortOrder}
            sortOrder={sortOrder}
            tableWrapRef={tableWrapRef}
          />

          <ResizeHandle
            axis="y"
            label="调整消息详情高度"
            onDelta={(delta) =>
              setDetailHeight((height) =>
                clamp(height - delta, 150, Math.round(window.innerHeight * 0.65)),
              )
            }
          />

          <section
            className="detail-panel"
            style={{ height: detailHeight }}
          >
            <div className="detail-heading">
              <div>
                <strong>消息详情</strong>
                <span className="detail-direction">
                  {selectedFrame
                    ? selectedFrame.direction === 'received'
                      ? '下行'
                      : '上行'
                    : '尚未选择消息'}
                </span>
              </div>
              <button
                className="secondary-button button-with-icon"
                disabled={!selectedFrame}
                onClick={copyPayload}
              >
                <Icon name="copy" />
                {copied ? '已复制' : '复制'}
              </button>
            </div>
            {selectedFrame && (
              <dl className="detail-meta">
                {[
                  ['时间', formatClock(selectedFrame.receivedAt)],
                  ['大小', formatByteSize(selectedFrame.payloadBytes)],
                  ['Opcode', String(selectedFrame.opcode)],
                  [
                    'WebSocket',
                    selectedFrame.socketUrl ||
                      displayConnection({
                        url: '',
                        targetUrl: selectedFrame.targetUrl,
                        requestId: selectedFrame.requestId,
                      }),
                  ],
                  ['SharedWorker', displayUrl(selectedFrame.targetUrl)],
                  ['Request ID', selectedFrame.requestId],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            )}
            <pre>{formattedPayload}</pre>
          </section>
        </section>
      </main>
    </>
  );
}

createRoot(document.querySelector('#root')).render(<App />);
