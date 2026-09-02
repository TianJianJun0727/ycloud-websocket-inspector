export type Season = 'spring' | 'summer' | 'autumn' | 'winter';
export type ThemePreference = 'auto' | Season;
export type ColorMode = 'system' | 'light' | 'dark';

export const THEME_OPTIONS: Array<{ value: ThemePreference; label: string; description: string }> = [
    { value: 'auto', label: '自动', description: '按本地月份切换' },
    { value: 'spring', label: '春', description: '三月至五月' },
    { value: 'summer', label: '夏', description: '六月至八月' },
    { value: 'autumn', label: '秋', description: '九月至十一月' },
    { value: 'winter', label: '冬', description: '十二月至二月' },
];

/** 根据电脑本地月份返回当前季节。 */
export const resolveLocalSeason = (date = new Date()): Season => {
    const month = date.getMonth() + 1;
    if (month >= 3 && month <= 5) return 'spring';
    if (month >= 6 && month <= 8) return 'summer';
    if (month >= 9 && month <= 11) return 'autumn';
    return 'winter';
};

/** 将用户偏好解析为最终展示的季节。 */
export const resolveThemeSeason = (preference: ThemePreference): Season =>
    preference === 'auto' ? resolveLocalSeason() : preference;

/** 根据显式偏好或电脑系统设置判断是否启用暗色外观。 */
export const resolveDarkMode = (mode: ColorMode): boolean =>
    mode === 'dark' || (mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
