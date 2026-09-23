// ===== 应用设置：类型 + 默认值 + 预设主题 + 色卡 + localStorage 持久化 =====

export type Language = 'zh' | 'en' | 'ja' | 'ko' | 'fr' | 'de' | 'es' | 'ru' | 'pt';

/** 语言列表：main=常用（中英日），more=更多常用语言 */
export const LANGUAGES: { code: Language; native: string; group: 'main' | 'more' }[] = [
  { code: 'zh', native: '中文',       group: 'main' },
  { code: 'en', native: 'English',    group: 'main' },
  { code: 'ja', native: '日本語',     group: 'main' },
  { code: 'ko', native: '한국어',     group: 'more' },
  { code: 'fr', native: 'Français',   group: 'more' },
  { code: 'de', native: 'Deutsch',    group: 'more' },
  { code: 'es', native: 'Español',    group: 'more' },
  { code: 'ru', native: 'Русский',    group: 'more' },
  { code: 'pt', native: 'Português',  group: 'more' },
];

// ---- 节拍器音色（按分类组织：电子 / 柔和 / 打击）----
export type MetronomeCategory = 'elec' | 'soft' | 'perc';
export interface MetronomeSound {
  id: string;
  category: MetronomeCategory;
  nameZh: string;
  nameEn: string;
  // ★ v0.8.16：i18n key（有值时优先走 t(nameKey)，实现 9 语言统一；无值时回退 nameZh/nameEn）
  nameKey?: string;
  type: OscillatorType; // 波形类型
  freqMain: number;     // 重拍频率 (Hz)
  freqAlt: number;      // 弱拍频率 (Hz)
  dur: number;          // 包络时长 (s)
  vol: number;          // 重拍音量 (0-1)
}

export const METRONOME_SOUNDS: MetronomeSound[] = [
  // 电子
  { id: 'beep',     category: 'elec', nameZh: '蜂鸣',     nameEn: 'Beep',     type: 'square',   freqMain: 1500, freqAlt: 1000, dur: 0.10, vol: 0.5 },
  { id: 'triangle', category: 'elec', nameZh: '三角电子', nameEn: 'Triangle', type: 'triangle', freqMain: 1200, freqAlt: 800,  dur: 0.12, vol: 0.5 },
  { id: 'tick',     category: 'elec', nameZh: '滴答',     nameEn: 'Tick',     type: 'square',   freqMain: 2500, freqAlt: 1800, dur: 0.06, vol: 0.4 },
  { id: 'click',    category: 'elec', nameZh: '咔哒',     nameEn: 'Click',    type: 'sine',     freqMain: 1200, freqAlt: 800,  dur: 0.05, vol: 0.55 },
  // 柔和
  { id: 'sine',     category: 'soft', nameZh: '正弦柔和', nameEn: 'Sine',     type: 'sine',     freqMain: 880,  freqAlt: 660,  dur: 0.12, vol: 0.55 },
  { id: 'piano',    category: 'soft', nameZh: '钢琴',     nameEn: 'Piano',    type: 'sine',     freqMain: 1046, freqAlt: 784,  dur: 0.40, vol: 0.55 },
  // 打击
  { id: 'wood',     category: 'perc', nameZh: '木鱼',     nameEn: 'Wood',     type: 'triangle', freqMain: 2000, freqAlt: 1500, dur: 0.03, vol: 0.6 },
  { id: 'marimba',  category: 'perc', nameZh: '马林巴',   nameEn: 'Marimba',  type: 'triangle', freqMain: 1318, freqAlt: 988,  dur: 0.15, vol: 0.55 },
  { id: 'drum',     category: 'perc', nameZh: '底鼓',     nameEn: 'Drum',     type: 'sine',     freqMain: 150,  freqAlt: 100,  dur: 0.15, vol: 0.7 },
  { id: 'hat',      category: 'perc', nameZh: '镲片',     nameEn: 'Hi-Hat',   type: 'square',   freqMain: 4500, freqAlt: 3200, dur: 0.04, vol: 0.3 },
  { id: 'cowbell',  category: 'perc', nameZh: '牛铃',     nameEn: 'Cowbell',  type: 'square',   freqMain: 880,  freqAlt: 660,  dur: 0.20, vol: 0.5 },
];

export function getMetronomeSound(id: string): MetronomeSound {
  return METRONOME_SOUNDS.find((s) => s.id === id) ?? METRONOME_SOUNDS[0];
}

export interface AppSettings {
  // ---- 主题配色 ----
  accent: string;        // 主色（按钮/高亮，原 indigo）
  accent2: string;       // 强调色（拍线/次要高亮，原 cyan）
  bgColor: string;       // 界面背景色（原 gray-950）
  panelBg: string;       // 面板/头部背景色（原 gray-900）
  // ---- 波形 / 频谱配色 ----
  waveColor: string;     // 波形图颜色
  specPalette: string;   // 频谱配色方案 id（spectrum/foobar/fire/.../custom）
  specCustom: [string, string, string]; // 自定义频段颜色 [低频, 中频, 高频]
  peakThreshold: number; // 峰值阈值（0.5-0.98）：超过此强度的信号进入峰值突出
  peakColor: string;     // 峰值颜色（超过阈值后过渡到的颜色）
  specInvert: boolean;   // 频谱垂直倒转
  metronomeSound: string; // 节拍器音色 id
  metronomeVolume: number; // 节拍器音量 0-1
  musicVolume: number;   // 音乐音量 0-1
  renderScale: number; // 整体渲染分辨率（DPI 缩放倍率）：1=跟随屏幕缩放，<1 渲染像素减少（更流畅），>1 提高清晰度（更耗性能）
  beatLineDelayMs: number; // 红线节拍线延迟手动微调（毫秒，滑条 ±100 / 输入框任意值）：仅偏移节拍线显示位置，不影响频谱/声谱时间轴
  specFFTSize: number;  // 频谱 FFT 精度（采样点数，2 的幂）：越大频率分辨率越高（0.5K≈86Hz / 1K≈43Hz / 2K≈21Hz / 4K≈11Hz @44.1kHz）
  specSensitivity: number; // 频谱显示灵敏度（dB 阈值）：低于该 dB 显示为黑色，越小越敏感（60~120）
  // ★ v0.8.16：播放时自动跟随播放头（与侧栏 viz 的「自动翻页」同款行为）
  followPlayhead: boolean;
  // ---- 语言 ----
  lang: Language;
}

export const DEFAULT_SETTINGS: AppSettings = {
  accent: '#6366f1',
  accent2: '#06b6d4',
  bgColor: '#030712',
  panelBg: '#111827',
  waveColor: '#a855f7',  // 波形：默认紫色
  specPalette: 'spectrum',
  specCustom: ['#ff2222', '#ff2222', '#ff2222'],
  peakThreshold: 0.5,
  peakColor: '#ffee00',
  specInvert: false,
  metronomeSound: 'tick', // 默认滴答
  metronomeVolume: 0.8,
  musicVolume: 1.0,
  renderScale: 1.0, // 默认跟随屏幕缩放（devicePixelRatio × 1.0）
  beatLineDelayMs: 30, // 默认红线节拍线延迟 30ms（v0.7.22 起；用户仍可在设置里微调）
  specFFTSize: 1024, // 默认 1K 精度（频率分辨率 ~43Hz，兼顾清晰度与性能）
  specSensitivity: 75, // 默认灵敏度阈值 75dB（弱信号较明显，画面通透）
  followPlayhead: true, // 默认开启自动跟随（播放头滑出视区即翻页，符合绝大多数制谱习惯）
  lang: 'zh',
};

// ---- 预设主题（整套配色一键应用）----
export interface ThemePreset {
  id: string;
  nameZh: string;
  nameEn: string;
  accent: string;
  accent2: string;
  bgColor: string;
  panelBg: string;
  // ★ v0.8.16：i18n key（有值时优先走 t(nameKey)，实现 9 语言统一）
  nameKey?: string;
}

export const THEME_PRESETS: ThemePreset[] = [
  { id: 'dark',    nameZh: '暗黑·默认', nameEn: 'Dark Default', nameKey: 'themeDark',     accent: '#6366f1', accent2: '#06b6d4', bgColor: '#030712', panelBg: '#111827' },
  { id: 'deepblue',nameZh: '深海蓝',    nameEn: 'Deep Blue',    nameKey: 'themeDeepBlue', accent: '#3b82f6', accent2: '#22d3ee', bgColor: '#020617', panelBg: '#0f172a' },
  { id: 'aurora',  nameZh: '极光',      nameEn: 'Aurora',       nameKey: 'themeAurora',   accent: '#8b5cf6', accent2: '#10b981', bgColor: '#0b0f19', panelBg: '#151c2c' },
  { id: 'neon',    nameZh: '霓虹',      nameEn: 'Neon',         nameKey: 'themeNeon',     accent: '#ec4899', accent2: '#22d3ee', bgColor: '#120a1a', panelBg: '#1e1230' },
  { id: 'matrix',  nameZh: '矩阵绿',    nameEn: 'Matrix',       nameKey: 'themeMatrix',   accent: '#22c55e', accent2: '#84cc16', bgColor: '#02120a', panelBg: '#0a2014' },
  { id: 'gold',    nameZh: '黑金',      nameEn: 'Black & Gold', nameKey: 'themeGold',     accent: '#d4af37', accent2: '#f0c75e', bgColor: '#0a0908', panelBg: '#16130c' },
  { id: 'light',   nameZh: '亮白',      nameEn: 'Light',        nameKey: 'themeLight',    accent: '#4f46e5', accent2: '#0891b2', bgColor: '#f8fafc', panelBg: '#ffffff' },
];

// ---- PS 风格预设色卡（点击选取）----
export const SWATCH_COLORS: string[] = [
  '#6366f1', '#3b82f6', '#06b6d4', '#14b8a6', '#22c55e', '#84cc16',
  '#facc15', '#f97316', '#ef4444', '#ec4899', '#8b5cf6', '#f43f5e',
  '#f8fafc', '#94a3b8', '#475569', '#0f172a', '#000000', '#ffffff',
];

const STORAGE_KEY = 'bpm-measurer-settings';
const STORAGE_VERSION = 8; // v0.8.16：新增 followPlayhead（自动跟随播放头，默认开）

/** 从 localStorage 读取设置（合并默认值，容错；旧版本自动迁移频谱默认） */
export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    const merged: AppSettings = { ...DEFAULT_SETTINGS, ...parsed };
    // v0.7.13：旧键清理（renderQuality → renderScale、audioDelayMs → beatLineDelayMs）
    // v0.7.18：defaultMeasureLength 已废弃（红线位置改为各自的绝对时间戳）
    delete (merged as any).renderQuality;
    delete (merged as any).audioDelayMs;
    delete (merged as any).defaultMeasureLength;
    // 旧版本（无版本标记或版本过低）→ 强制套用新频谱默认（完整色阶 + 青绿波形），主题/语言保留
    if (parsed.__v !== STORAGE_VERSION) {
      merged.specPalette = DEFAULT_SETTINGS.specPalette;
      merged.waveColor = DEFAULT_SETTINGS.waveColor;
      // v0.7.22：红线节拍线延迟新默认 30ms；旧默认值（0 = 从未校准过）自动升级为 30，
      // 已手动调过的值保持不变
      if (merged.beatLineDelayMs === 0) merged.beatLineDelayMs = DEFAULT_SETTINGS.beatLineDelayMs;
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...merged, __v: STORAGE_VERSION })); } catch { /* ignore */ }
    }
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** 保存设置到 localStorage（附带版本标记，避免迁移逻辑反复触发） */
export function saveSettings(s: AppSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...s, __v: STORAGE_VERSION }));
  } catch { /* 存储失败静默忽略 */ }
}

/** 清除全部设置（一键复原） */
export function clearSettings(): void {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

/** 辅助：hex → rgb 字符串（供 canvas 等场景使用） */
export function hexToRgb(hex: string): string {
  const m = hex.replace('#', '');
  const full = m.length === 3 ? m.split('').map(c => c + c).join('') : m;
  const num = parseInt(full, 16);
  if (isNaN(num)) return '99,102,241';
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `${r},${g},${b}`;
}

/** 计算 hex 颜色的相对亮度（0=纯黑，1=纯白），用于对比度自适应 */
export function hexLuminance(hex: string): number {
  const m = hex.replace('#', '');
  const full = m.length === 3 ? m.split('').map(c => c + c).join('') : m;
  const num = parseInt(full, 16);
  if (isNaN(num)) return 0.02;
  const r = ((num >> 16) & 255) / 255;
  const g = ((num >> 8) & 255) / 255;
  const b = (num & 255) / 255;
  // sRGB → 线性
  const lin = (c: number) => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// ---- 频谱配色方案（声谱/频谱颜色替换）----
export interface SpecPalette {
  id: string;
  nameZh: string;
  nameEn: string;
}

// ---- 频谱配色方案（按分类组织）----
export type SpecCategory = 'single' | 'scale' | 'band';
export interface SpecPalette {
  id: string;
  category: SpecCategory; // single=纯色渐变 / scale=完整色阶 / band=三分频
  nameZh: string;
  nameEn: string;
  // ★ v0.8.16：i18n key（有值时优先走 t(nameKey)，实现 9 语言统一）
  nameKey?: string;
}

export const SPEC_PALETTES: SpecPalette[] = [
  // ===== 纯色渐变（单色，由信号强度决定亮度）=====
  { id: 'au',    category: 'single', nameZh: 'AU 蓝青', nameEn: 'AU Cyan' },
  { id: 'neon',  category: 'single', nameZh: '霓虹',    nameEn: 'Neon' },
  { id: 'heat',  category: 'single', nameZh: '热力',    nameEn: 'Heat' },
  { id: 'gray',  category: 'single', nameZh: '灰度',    nameEn: 'Grayscale' },
  { id: 'psy',   category: 'single', nameZh: '紫粉',    nameEn: 'Psy' },
  // ===== 完整色阶（黑→…→亮色多级渐变，谱师实用）=====
  { id: 'spectrum', category: 'scale', nameZh: '完整色阶',   nameEn: 'Full Spectrum' },
  { id: 'classic',  category: 'scale', nameZh: '经典紫红',   nameEn: 'Classic Purple' },
  { id: 'ocean',    category: 'scale', nameZh: '海洋青蓝',   nameEn: 'Ocean' },
  { id: 'ember',    category: 'scale', nameZh: '余烬火焰',   nameEn: 'Ember' },
  { id: 'toxic',    category: 'scale', nameZh: '毒液绿',     nameEn: 'Toxic' },
  { id: 'rose',     category: 'scale', nameZh: '玫瑰粉紫',   nameEn: 'Rose' },
  { id: 'candy',    category: 'scale', nameZh: '糖果',       nameEn: 'Candy' },
  { id: 'midnight', category: 'scale', nameZh: '午夜霓虹',   nameEn: 'Midnight' },
  { id: 'lava',     category: 'scale', nameZh: '熔岩',       nameEn: 'Lava' },
  { id: 'forest',   category: 'scale', nameZh: '森林',       nameEn: 'Forest' },
  { id: 'sakura',   category: 'scale', nameZh: '樱花',       nameEn: 'Sakura' },
  { id: 'citrus',   category: 'scale', nameZh: '柑橘',       nameEn: 'Citrus' },
  // ===== 三分频（按频率低/中/高分段变色）=====
  { id: 'foobar',  category: 'band', nameZh: '经典·foobar', nameEn: 'Classic foobar' },
  { id: 'fire',    category: 'band', nameZh: '火焰',        nameEn: 'Fire' },
  { id: 'ice',     category: 'band', nameZh: '冰霜',        nameEn: 'Ice' },
  { id: 'rainbow', category: 'band', nameZh: '彩虹',        nameEn: 'Rainbow' },
  { id: 'neonB',   category: 'band', nameZh: '霓虹分段',    nameEn: 'Neon Banded' },
  { id: 'sunset',  category: 'band', nameZh: '日落',        nameEn: 'Sunset' },
  { id: 'fbclassic', category: 'band', nameZh: 'foobar 七色', nameEn: 'foobar 7-Color' },
  { id: 'warm',    category: 'band', nameZh: '暖频',        nameEn: 'Warm' },
  { id: 'cool',    category: 'band', nameZh: '冷频',        nameEn: 'Cool' },
  { id: 'violet',  category: 'band', nameZh: '紫罗兰',      nameEn: 'Violet' },
  { id: 'gold',    category: 'band', nameZh: '黑金',        nameEn: 'Black & Gold' },
  { id: 'miami',   category: 'band', nameZh: '迈阿密',      nameEn: 'Miami' },
  { id: 'custom',  category: 'band', nameZh: '自定义',      nameEn: 'Custom' },
];

/** 多色分段方案的三段色 [低频, 中频, 高频] */
const MULTI_COLORS: Record<string, [string, string, string]> = {
  foobar:  ['#4a0080', '#ff4500', '#1a0a1a'], // 深紫 → 红橙 → 黑（foobar 截图风格）
  fire:    ['#2a0010', '#ff5000', '#ffec00'], // 深红 → 橙 → 金黄
  ice:     ['#001a4a', '#00aaff', '#ffffff'], // 深蓝 → 青 → 亮白
  rainbow: ['#6a00a8', '#00aa44', '#ffaa00'], // 紫 → 绿 → 金
  neonB:   ['#ff00aa', '#00ffff', '#aaff00'], // 品红 → 青 → 黄绿
  sunset:  ['#2d0066', '#ff8000', '#ffec70'], // 深紫 → 橙 → 亮黄
  // —— 新增分频器音色（参考 foobar2000 声谱七色等）——
  fbclassic: ['#3d0080', '#20cccc', '#ffd700'], // 暗紫 → 青绿 → 金黄（foobar 声谱经典三段）
  warm:      ['#8a0000', '#ff6000', '#ffe000'], // 深红 → 橙 → 亮黄（暖频突出低频能量）
  cool:      ['#002060', '#00c0ff', '#ffffff'], // 深蓝 → 青 → 白（冷频清爽）
  violet:    ['#2d0066', '#8a2be2', '#ff77ff'], // 深紫 → 紫 → 粉（紫罗兰）
  gold:      ['#402000', '#d4af37', '#ffee80'], // 深棕 → 金 → 亮金（黑金）
  miami:     ['#2d0050', '#ff2d95', '#00ffff'], // 深紫 → 粉 → 青（迈阿密霓虹）
};

/** 完整色阶方案（多级渐变，val 驱动；每项 t=色标位置 0-1） */
const SCALES: Record<string, { t: number; rgb: [number, number, number] }[]> = {
  // 默认：黑 → 深紫 → 蓝紫 → 品红 → 鲜红 → 橙红 → 亮金黄（谱师实用）
  spectrum: [
    { t: 0.00, rgb: [0, 0, 0] },
    { t: 0.25, rgb: [45, 0, 102] },
    { t: 0.40, rgb: [106, 0, 179] },
    { t: 0.55, rgb: [200, 0, 160] },
    { t: 0.70, rgb: [255, 0, 34] },
    { t: 0.85, rgb: [255, 85, 0] },
    { t: 1.00, rgb: [255, 238, 0] },
  ],
  // 经典紫红：黑 → 深紫 → 紫 → 红 → 橙 → 黄（原源码热力图风格）
  classic: [
    { t: 0.00, rgb: [0, 0, 0] },
    { t: 0.20, rgb: [80, 0, 80] },
    { t: 0.40, rgb: [160, 0, 160] },
    { t: 0.60, rgb: [255, 0, 0] },
    { t: 0.80, rgb: [255, 120, 0] },
    { t: 1.00, rgb: [255, 240, 0] },
  ],
  // 海洋：黑 → 深蓝 → 蓝 → 青 → 亮青白
  ocean: [
    { t: 0.00, rgb: [0, 0, 0] },
    { t: 0.25, rgb: [0, 0, 90] },
    { t: 0.50, rgb: [0, 60, 220] },
    { t: 0.75, rgb: [0, 180, 255] },
    { t: 1.00, rgb: [230, 255, 255] },
  ],
  // 余烬：黑 → 深红 → 红 → 橙 → 金黄 → 白
  ember: [
    { t: 0.00, rgb: [0, 0, 0] },
    { t: 0.25, rgb: [60, 0, 0] },
    { t: 0.50, rgb: [200, 0, 0] },
    { t: 0.75, rgb: [255, 80, 0] },
    { t: 0.90, rgb: [255, 200, 0] },
    { t: 1.00, rgb: [255, 255, 255] },
  ],
  // 毒液：黑 → 深绿 → 绿 → 亮绿 → 黄绿白
  toxic: [
    { t: 0.00, rgb: [0, 0, 0] },
    { t: 0.25, rgb: [0, 60, 20] },
    { t: 0.50, rgb: [0, 180, 60] },
    { t: 0.75, rgb: [80, 255, 120] },
    { t: 1.00, rgb: [220, 255, 120] },
  ],
  // 玫瑰：黑 → 深紫 → 品红 → 粉 → 亮粉白
  rose: [
    { t: 0.00, rgb: [0, 0, 0] },
    { t: 0.25, rgb: [70, 0, 90] },
    { t: 0.50, rgb: [220, 0, 140] },
    { t: 0.75, rgb: [255, 80, 180] },
    { t: 1.00, rgb: [255, 210, 235] },
  ],
  // 糖果：黑 → 深蓝 → 紫 → 粉 → 黄 → 白
  candy: [
    { t: 0.00, rgb: [0, 0, 0] },
    { t: 0.20, rgb: [20, 0, 80] },
    { t: 0.40, rgb: [120, 0, 160] },
    { t: 0.60, rgb: [255, 40, 180] },
    { t: 0.80, rgb: [255, 200, 60] },
    { t: 1.00, rgb: [255, 255, 255] },
  ],
  // 午夜霓虹：黑 → 深蓝 → 品红 → 紫 → 青
  midnight: [
    { t: 0.00, rgb: [0, 0, 0] },
    { t: 0.25, rgb: [0, 10, 90] },
    { t: 0.50, rgb: [200, 0, 120] },
    { t: 0.75, rgb: [130, 40, 220] },
    { t: 1.00, rgb: [0, 220, 255] },
  ],
  // 熔岩：黑 → 深红 → 橙红 → 亮橙 → 白
  lava: [
    { t: 0.00, rgb: [0, 0, 0] },
    { t: 0.25, rgb: [70, 0, 0] },
    { t: 0.50, rgb: [220, 30, 0] },
    { t: 0.75, rgb: [255, 140, 20] },
    { t: 1.00, rgb: [255, 255, 255] },
  ],
  // 森林：黑 → 深绿 → 绿 → 青绿 → 白
  forest: [
    { t: 0.00, rgb: [0, 0, 0] },
    { t: 0.25, rgb: [0, 40, 20] },
    { t: 0.50, rgb: [0, 130, 60] },
    { t: 0.75, rgb: [0, 220, 150] },
    { t: 1.00, rgb: [230, 255, 245] },
  ],
  // 樱花：黑 → 深紫 → 粉 → 亮粉 → 白
  sakura: [
    { t: 0.00, rgb: [0, 0, 0] },
    { t: 0.25, rgb: [60, 0, 80] },
    { t: 0.50, rgb: [220, 60, 150] },
    { t: 0.75, rgb: [255, 150, 210] },
    { t: 1.00, rgb: [255, 240, 250] },
  ],
  // 柑橘：黑 → 深橙 → 橙 → 黄 → 亮黄白
  citrus: [
    { t: 0.00, rgb: [0, 0, 0] },
    { t: 0.25, rgb: [60, 25, 0] },
    { t: 0.50, rgb: [220, 110, 0] },
    { t: 0.75, rgb: [255, 200, 0] },
    { t: 1.00, rgb: [255, 250, 180] },
  ],
};

/** 各方案预览色（设置面板按钮用；single=单色点、scale=色阶条、band=三分频） */
export const SPEC_PREVIEW: Record<string, string[]> = {
  au:       ['#06b6d4'],
  neon:     ['#ec4899'],
  heat:     ['#ff4500'],
  gray:     ['#94a3b8'],
  psy:      ['#a855f7'],
  spectrum: ['#2d0066', '#c800a0', '#ff4500', '#ffee00'],
  classic:  ['#500050', '#a000a0', '#ff0000', '#fff000'],
  ocean:    ['#00005a', '#003cdc', '#00b4ff', '#e6ffff'],
  ember:    ['#3c0000', '#c80000', '#ff5000', '#ffc800'],
  toxic:    ['#003c14', '#00b43c', '#50ff78', '#dcff78'],
  rose:     ['#46005a', '#dc008c', '#ff50b4', '#ffd2eb'],
  candy:    ['#140050', '#7800a0', '#ff28b4', '#ffc83c'],
  midnight: ['#000a5a', '#c80078', '#8228dc', '#00dcff'],
  lava:     ['#460000', '#dc1e00', '#ff8c14', '#ffffff'],
  forest:   ['#002814', '#00823c', '#00dc96', '#e6fff5'],
  sakura:   ['#3c0050', '#dc3c96', '#ff96d2', '#fff0fa'],
  citrus:   ['#3c1900', '#dc6e00', '#ffc800', '#fffab4'],
  foobar:   ['#4a0080', '#ff4500', '#1a0a1a'],
  fire:     ['#2a0010', '#ff5000', '#ffec00'],
  ice:      ['#001a4a', '#00aaff', '#ffffff'],
  rainbow:  ['#6a00a8', '#00aa44', '#ffaa00'],
  neonB:    ['#ff00aa', '#00ffff', '#aaff00'],
  sunset:   ['#2d0066', '#ff8000', '#ffec70'],
  fbclassic: ['#3d0080', '#20cccc', '#ffd700'],
  warm:     ['#8a0000', '#ff6000', '#ffe000'],
  cool:     ['#002060', '#00c0ff', '#ffffff'],
  violet:   ['#2d0066', '#8a2be2', '#ff77ff'],
  gold:     ['#402000', '#d4af37', '#ffee80'],
  miami:    ['#2d0050', '#ff2d95', '#00ffff'],
  custom:   ['#ff2222', '#ff2222', '#ff2222'], // 实际用 settings.specCustom
};

/** hex → rgb 三元组 */
function hexToRgbArr(hex: string): [number, number, number] {
  const m = hex.replace('#', '');
  const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  const n = parseInt(full, 16);
  if (isNaN(n)) return [128, 128, 128];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** 在色标 stops 间按 freqNorm 线性插值得 baseColor */
function interpStops(stops: { t: number; rgb: [number, number, number] }[], f: number): [number, number, number] {
  if (f <= stops[0].t) return stops[0].rgb;
  for (let i = 0; i < stops.length - 1; i++) {
    if (f <= stops[i + 1].t) {
      const span = stops[i + 1].t - stops[i].t;
      const t = span > 0 ? (f - stops[i].t) / span : 0;
      return [
        Math.round(stops[i].rgb[0] + (stops[i + 1].rgb[0] - stops[i].rgb[0]) * t),
        Math.round(stops[i].rgb[1] + (stops[i + 1].rgb[1] - stops[i].rgb[1]) * t),
        Math.round(stops[i].rgb[2] + (stops[i + 1].rgb[2] - stops[i].rgb[2]) * t),
      ];
    }
  }
  return stops[stops.length - 1].rgb;
}

/** 频谱配色映射：val ∈ [0,1]（信号强度）+ freqNorm ∈ [0,1]（频率位置 0=低 1=高） → [r,g,b]
 *  - 单色方案：只由 val 决定
 *  - 多色分段方案：freqNorm 找到所在段（低/中/高），段间 RGB 插值；val 决定段色亮度（val=0→黑混合 92%，val=1→段色满色）
 *  - 峰值增强（多色方案统一）：超过 peakThreshold 的信号向 peakColor 过渡（更陡、更刺眼）
 *  - custom：使用 settings.specCustom 三色作为分段色
 */
export function spectrogramColor(
  val: number,
  freqNorm: number,
  palette: string,
  custom?: [string, string, string],
  peakThreshold = 0.8,
  peakColor = '#ffffff'
): [number, number, number] {
  const v = Math.max(0, Math.min(1, val));
  const f = Math.max(0, Math.min(1, freqNorm));

  // 单色方案（只由 val 决定，保持原曲线；色阶方案为多级渐变）
  const single: Record<string, () => [number, number, number]> = {
    // ===== 完整色阶（数据驱动，SCALES 查表；黑色噪声门限）=====
    neon: () => { if (v < 0.5) { const t = v / 0.5; return [t * 90, 0, t * 160]; } const t = (v - 0.5) / 0.5; return [90 + t * 165, t * 60, 160 + t * 95]; },
    heat: () => { if (v < 0.33) { const t = v / 0.33; return [t * 200, 0, 0]; } if (v < 0.66) { const t = (v - 0.33) / 0.33; return [200, t * 160, 0]; } const t = (v - 0.66) / 0.34; return [255, 160 + t * 95, t * 255]; },
    gray: () => { const g = Math.round(v * 255); return [g, g, g]; },
    psy:  () => { if (v < 0.5) { const t = v / 0.5; return [t * 80, 0, t * 130]; } const t = (v - 0.5) / 0.5; return [80 + t * 175, t * 40, 130 + t * 125]; },
    au:   () => { if (v < 0.5) { const t = v / 0.5; return [t * 25, t * 140, 45 + t * 210]; } const t = (v - 0.5) / 0.5; return [25 + t * 230, 140 + t * 115, 255 - t * 70]; },
  };
  if (palette in single) return single[palette]();

  // 完整色阶方案：SCALES 多级渐变（val<0.06 噪声门限涂黑）
  if (palette in SCALES) {
    if (v < 0.06) return [0, 0, 0];
    return interpStops(SCALES[palette], v);
  }

  // 多色分段方案：在 [0, 0.5, 0.85, 1] 色标间插值（低/中/高 + 高频顶端亮白）
  let stops: { t: number; rgb: [number, number, number] }[];
  if (palette === 'custom' && custom && custom.length === 3) {
    stops = [
      { t: 0,    rgb: hexToRgbArr(custom[0]) },
      { t: 0.5,  rgb: hexToRgbArr(custom[1]) },
      { t: 0.85, rgb: hexToRgbArr(custom[2]) },
      { t: 1,    rgb: [255, 255, 255] },
    ];
  } else if (palette in MULTI_COLORS) {
    const c = MULTI_COLORS[palette];
    stops = [
      { t: 0,    rgb: hexToRgbArr(c[0]) },
      { t: 0.5,  rgb: hexToRgbArr(c[1]) },
      { t: 0.85, rgb: hexToRgbArr(c[2]) },
      { t: 1,    rgb: [255, 255, 255] },
    ];
  } else {
    return single.au();
  }

  // 段间插值得 baseColor（按频率位置）
  const base = interpStops(stops, f);

  // ===== 对比度增强（弱信号压暗、强信号突出）=====
  // ① gamma 提升中高段亮度：弱信号更暗，层次分明
  const boosted = Math.pow(v, 0.55);
  const darkness = (1 - boosted) * 0.92;
  // ② 峰值增强：超过阈值后向 peakColor 过渡（阈值可调、峰值色可调、过渡陡峭更刺眼）
  const th = Math.max(0.3, Math.min(0.98, peakThreshold));
  const peakT = th >= 0.99 ? 0 : Math.max(0, Math.min(1, (v - th) / (1 - th)));
  const sharp = Math.pow(peakT, 0.6); // 陡峭过渡：刚过阈值就明显偏峰值色
  const peak = hexToRgbArr(peakColor);
  const pr = base[0] + (peak[0] - base[0]) * sharp;
  const pg = base[1] + (peak[1] - base[1]) * sharp;
  const pb = base[2] + (peak[2] - base[2]) * sharp;
  // 峰值段额外减小 darkness（峰值更亮、更刺眼）
  const peakLighten = sharp * 0.25; // 峰值时额外提亮 25%
  const dark2 = Math.max(0, darkness - peakLighten);
  return [
    Math.round(pr * (1 - dark2)),
    Math.round(pg * (1 - dark2)),
    Math.round(pb * (1 - dark2)),
  ];
}

/** 随机配色：生成一组协调的主色 + 强调色（HSB 随机 + 类似色） */export function randomAccentPair(): { accent: string; accent2: string } {
  const hue = Math.floor(Math.random() * 360);
  const sat = 70 + Math.floor(Math.random() * 25); // 70-95
  const light = 50 + Math.floor(Math.random() * 20); // 50-70
  const h2 = (hue + 40 + Math.floor(Math.random() * 60)) % 360; // 类似色偏移
  const hslToHex = (h: number, s: number, l: number): string => {
    s /= 100; l /= 100;
    const k = (n: number) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    const toHex = (x: number) => Math.round(255 * x).toString(16).padStart(2, '0');
    return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
  };
  return {
    accent: hslToHex(hue, sat, light),
    accent2: hslToHex(h2, sat, Math.min(100, light + 10)),
  };
}
