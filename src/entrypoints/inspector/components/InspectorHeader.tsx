import { RefreshCw, Settings, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { THEME_OPTIONS, type ColorMode, type Season, type ThemePreference } from '../theme';

interface InspectorHeaderProps {
    colorMode: ColorMode;
    heartbeatMessages: string;
    hideHeartbeat: boolean;
    preference: ThemePreference;
    season: Season;
    showMetadata: boolean;
    onColorModeChange: (mode: ColorMode) => void;
    onHeartbeatMessagesChange: (value: string) => void;
    onHideHeartbeatChange: (selected: boolean) => void;
    onMetadataChange: (selected: boolean) => void;
    onThemeChange: (theme: ThemePreference) => void;
    onRescan: () => void;
}

const SEASON_LABELS: Record<Season, string> = { spring: '春季', summer: '夏季', autumn: '秋季', winter: '冬季' };
const COLOR_MODES: Array<{ value: ColorMode; label: string }> = [
    { value: 'system', label: '跟随系统' },
    { value: 'light', label: '亮色' },
    { value: 'dark', label: '暗色' },
];
const COLOR_MODE_LABELS: Record<ColorMode, string> = { light: '亮色', dark: '暗色', system: '跟随系统' };

/** 展示产品标识、当前外观和真实生效的监听器设置。 */
export const InspectorHeader = ({
    colorMode,
    heartbeatMessages,
    hideHeartbeat,
    preference,
    season,
    showMetadata,
    onColorModeChange,
    onHeartbeatMessagesChange,
    onHideHeartbeatChange,
    onMetadataChange,
    onThemeChange,
    onRescan,
}: InspectorHeaderProps) => {
    const [settingsOpen, setSettingsOpen] = useState(false);
    const settingsRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!settingsOpen) return;
        /** 点击设置区域之外时关闭浮层。 */
        const closeOnOutsideClick = (event: PointerEvent): void => {
            if (event.target instanceof Node && !settingsRef.current?.contains(event.target)) setSettingsOpen(false);
        };
        document.addEventListener('pointerdown', closeOnOutsideClick);
        return () => document.removeEventListener('pointerdown', closeOnOutsideClick);
    }, [settingsOpen]);

    /** 恢复界面的默认主题与数据展示偏好。 */
    const resetSettings = (): void => {
        onThemeChange('auto');
        onColorModeChange('system');
        onHeartbeatMessagesChange('ping,pong,heartbeat');
        onHideHeartbeatChange(false);
        onMetadataChange(true);
    };

    return (
        <header className="inspector-header">
            <div className="brand-lockup">
                <span className="brand-mark">
                    <img alt="YCloud" src="/assets/ycloud-logo.svg" />
                </span>
                <div>
                    <h1>YCloud WebSocket 监听器</h1>
                    <p>监听 SharedWorker WebSocket 消息</p>
                </div>
            </div>
            <div className="header-actions">
                <span className="season-name">
                    <Sparkles size={14} />
                    {SEASON_LABELS[season]} · {COLOR_MODE_LABELS[colorMode]}
                </span>
                <div className="settings-control" ref={settingsRef}>
                    <button
                        aria-label="显示设置"
                        className="icon-button"
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
                                        自动
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
                <button aria-label="重新扫描" className="icon-button" onClick={onRescan} title="重新扫描" type="button">
                    <RefreshCw size={18} />
                </button>
            </div>
        </header>
    );
};
