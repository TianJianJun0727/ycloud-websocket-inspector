export type Season = 'spring' | 'summer' | 'autumn' | 'winter';
export type ThemePreference = 'auto' | Season;
export type ColorMode = 'system' | 'light' | 'dark';

export const SEASON_DETAILS: Record<Season, { label: string; poem: readonly [string, string] }> = {
    spring: { label: '春', poem: ['沾衣欲湿杏花雨', '吹面不寒杨柳风'] },
    summer: { label: '夏', poem: ['接天莲叶无穷碧', '映日荷花别样红'] },
    autumn: { label: '秋', poem: ['一道残阳铺水中', '半江瑟瑟半江红'] },
    winter: { label: '冬', poem: ['忽如一夜春风来', '千树万树梨花开'] },
};

export const THEME_OPTIONS: Array<{ value: ThemePreference; label: string; description: string }> = [
    { value: 'auto', label: '随时令', description: '按本地月份流转' },
    { value: 'spring', label: SEASON_DETAILS.spring.label, description: '三月至五月' },
    { value: 'summer', label: SEASON_DETAILS.summer.label, description: '六月至八月' },
    { value: 'autumn', label: SEASON_DETAILS.autumn.label, description: '九月至十一月' },
    { value: 'winter', label: SEASON_DETAILS.winter.label, description: '十二月至二月' },
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
