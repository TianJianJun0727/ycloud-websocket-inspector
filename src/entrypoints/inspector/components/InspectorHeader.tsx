import { RefreshCw, Settings, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { SEASON_DETAILS, THEME_OPTIONS, type ColorMode, type Season, type ThemePreference } from '../theme';

interface InspectorHeaderProps {
    colorMode: ColorMode;
    heartbeatMessages: string;
    hideHeartbeat: boolean;
    preference: ThemePreference;
    scanIntervalMs: number;
    season: Season;
    scanning: boolean;
    showMetadata: boolean;
    onColorModeChange: (mode: ColorMode) => void;
    onHeartbeatMessagesChange: (value: string) => void;
    onHideHeartbeatChange: (selected: boolean) => void;
    onMetadataChange: (selected: boolean) => void;
    onScanIntervalChange: (intervalMs: number) => void;
    onThemeChange: (theme: ThemePreference) => void;
    onRescan: () => void;
}

const COLOR_MODES: Array<{ value: ColorMode; label: string }> = [
    { value: 'system', label: '跟随系统' },
    { value: 'light', label: '亮色' },
    { value: 'dark', label: '暗色' },
];
const COLOR_MODE_LABELS: Record<ColorMode, string> = { light: '亮色', dark: '暗色', system: '跟随系统' };
const SCAN_INTERVAL_OPTIONS = [
    { label: '3 秒', value: 3000 },
    { label: '5 秒', value: 5000 },
    { label: '10 秒', value: 10000 },
    { label: '20 秒', value: 20000 },
    { label: '30 秒', value: 30000 },
    { label: '1 分钟', value: 60000 },
    { label: '3 分钟', value: 180000 },
    { label: '5 分钟', value: 300000 },
    { label: '10 分钟', value: 600000 },
];
const LOCAL_DATE_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
});

/** 展示产品标识、当前外观和真实生效的调试器设置。 */
export const InspectorHeader = ({
    colorMode,
    heartbeatMessages,
    hideHeartbeat,
    preference,
    scanIntervalMs,
    season,
    scanning,
    showMetadata,
    onColorModeChange,
    onHeartbeatMessagesChange,
    onHideHeartbeatChange,
    onMetadataChange,
    onScanIntervalChange,
    onThemeChange,
    onRescan,
}: InspectorHeaderProps) => {
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [currentDate, setCurrentDate] = useState(() => new Date());
    const settingsRef = useRef<HTMLDivElement | null>(null);
    const seasonDetails = SEASON_DETAILS[season];

    useEffect(() => {
        if (!settingsOpen) return;
        /** 点击设置区域之外时关闭浮层。 */
        const closeOnOutsideClick = (event: PointerEvent): void => {
            if (event.target instanceof Node && !settingsRef.current?.contains(event.target)) setSettingsOpen(false);
        };
        document.addEventListener('pointerdown', closeOnOutsideClick);
        return () => document.removeEventListener('pointerdown', closeOnOutsideClick);
    }, [settingsOpen]);

    useEffect(() => {
        /** 页面跨越日期或重新获得焦点时刷新本地日期。 */
        const refreshDate = (): void => setCurrentDate(new Date());
        const timer = window.setInterval(refreshDate, 60 * 1000);
        document.addEventListener('visibilitychange', refreshDate);
        return () => {
            window.clearInterval(timer);
            document.removeEventListener('visibilitychange', refreshDate);
        };
    }, []);

    /** 恢复界面的默认主题与数据展示偏好。 */
    const resetSettings = (): void => {
        onThemeChange('auto');
        onColorModeChange('system');
        onHeartbeatMessagesChange('ping,pong,heartbeat');
        onHideHeartbeatChange(false);
        onMetadataChange(true);
        onScanIntervalChange(5000);
    };

    return (
        <header className="inspector-header">
            <div className="brand-lockup">
                <span className="brand-mark">
                    <img className="brand-logo-light" alt="YCloud" src="/assets/ycloud-logo-light.svg" />
                    <img className="brand-logo-dark" alt="" aria-hidden="true" src="/assets/ycloud-logo-dark.svg" />
                </span>
                <div>
                    <h1>YCloud WebSocket 调试器</h1>
                    <p>实时捕获、检索与调试浏览器中的 WebSocket 连接和消息</p>
                </div>
            </div>
            <div className="season-almanac" aria-label={`${seasonDetails.label}时令诗句`}>
                <time>{LOCAL_DATE_FORMATTER.format(currentDate)}</time>
                <p>
                    <span>{seasonDetails.poem[0]}</span>
                    <span>{seasonDetails.poem[1]}</span>
                </p>
            </div>
            <div className="header-actions">
                <span className="season-name">
                    <Sparkles size={14} />
                    {seasonDetails.label} · {COLOR_MODE_LABELS[colorMode]}
                </span>
                <div className="settings-control" ref={settingsRef}>
                    <button
                        aria-label="显示设置"
                        className="icon-button"
                        data-tooltip="显示设置"
                        data-tooltip-align="end"
                        onClick={() => setSettingsOpen((open) => !open)}
                        title="显示设置"
                        type="button"
                    >
                        <Settings size={18} />
                    </button>
                    {settingsOpen && (
                        <div className="settings-popover" role="dialog" aria-label="显示设置">
                            <div className="settings-heading">
                                <div>
                                    <strong>显示设置</strong>
                                </div>
                            </div>
                            <div className="settings-section">
                                <label>显示模式</label>
                                <div className="color-mode-control">
                                    {COLOR_MODES.map((option) => (
                                        <button
                                            className={colorMode === option.value ? 'is-active' : ''}
                                            key={option.value}
                                            onClick={() => onColorModeChange(option.value)}
                                            type="button"
                                        >
                                            {option.label}
                                        </button>
                                    ))}
                                </div>
                                <label>季节主题</label>
                                <div className="season-mode-control">
                                    <button
                                        className={preference === 'auto' ? 'is-active' : ''}
                                        onClick={() => onThemeChange('auto')}
                                        type="button"
                                    >
                                        随时令
                                    </button>
                                    {THEME_OPTIONS.filter(({ value }) => value !== 'auto').map((option) => (
                                        <button
                                            className={preference === option.value ? 'is-active' : ''}
                                            key={option.value}
                                            onClick={() => onThemeChange(option.value)}
                                            type="button"
                                        >
                                            {option.label}
                                        </button>
                                    ))}
                                </div>
                                <label htmlFor="scan-interval">扫描周期</label>
                                <select
                                    className="heartbeat-input"
                                    id="scan-interval"
                                    onChange={(event) => onScanIntervalChange(Number(event.target.value))}
                                    value={scanIntervalMs}
                                >
                                    {SCAN_INTERVAL_OPTIONS.map((option) => (
                                        <option key={option.value} value={option.value}>
                                            {option.label}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <div className="settings-section">
                                <strong className="settings-section-title">消息显示</strong>
                                <label className="settings-check">
                                    <input
                                        checked={hideHeartbeat}
                                        onChange={(event) => onHideHeartbeatChange(event.target.checked)}
                                        type="checkbox"
                                    />
                                    隐藏心跳消息
                                </label>
                                {hideHeartbeat && (
                                    <>
                                        <label>心跳内容（英文逗号分隔）</label>
                                        <input
                                            className="heartbeat-input"
                                            onChange={(event) => onHeartbeatMessagesChange(event.target.value)}
                                            placeholder="ping,pong,heartbeat"
                                            value={heartbeatMessages}
                                        />
                                    </>
                                )}
                                <label className="settings-check">
                                    <input
                                        checked={showMetadata}
                                        onChange={(event) => onMetadataChange(event.target.checked)}
                                        type="checkbox"
                                    />
                                    显示连接元数据
                                </label>
                            </div>
                            <button className="reset-settings" onClick={resetSettings} type="button">
                                恢复默认
                            </button>
                        </div>
                    )}
                </div>
                <button
                    aria-busy={scanning}
                    aria-label={scanning ? '正在重新扫描' : '重新扫描'}
                    className={`icon-button${scanning ? ' is-scanning' : ''}`}
                    data-tooltip={scanning ? '正在重新扫描' : '重新扫描'}
                    data-tooltip-align="end"
                    disabled={scanning}
                    onClick={onRescan}
                    title={scanning ? '正在重新扫描' : '重新扫描'}
                    type="button"
                >
                    <RefreshCw size={18} />
                </button>
            </div>
        </header>
    );
};
