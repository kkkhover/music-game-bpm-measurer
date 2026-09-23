import React, { useRef, useState } from 'react';
import { AppSettings, DEFAULT_SETTINGS, THEME_PRESETS, SWATCH_COLORS, SPEC_PALETTES, SPEC_PREVIEW, LANGUAGES, METRONOME_SOUNDS, MetronomeCategory, SpecCategory, ThemePreset, randomAccentPair } from '../utils/settings';
import { t } from '../utils/i18n';
import { X, RefreshCw, Shuffle, FlipVertical2, ArrowLeft } from 'lucide-react';

interface SettingsModalProps {
  settings: AppSettings;
  onChange: (s: AppSettings) => void; // 更新设置（父组件负责持久化与应用）
  onReset: () => void;                // 一键复原
  onClose: () => void;
}

// 频谱精度档位（FFT 采样点数）：0.5K~4K
const SPEC_FFT_OPTIONS = [512, 1024, 2048, 4096];

// ---------- 通用小组件 ----------

/** 滑块行（含当前值显示） */
const SliderRow: React.FC<{
  label: string; value: number; min: number; max: number; step: number; suffix?: string;
  onChange: (v: number) => void;
}> = ({ label, value, min, max, step, suffix = '', onChange }) => (
  <div className="mb-3">
    <div className="flex justify-between text-xs text-[var(--t3)] mb-1">
      <span>{label}</span>
      <span className="font-mono text-[var(--t2)]">{value}{suffix}</span>
    </div>
    <input
      type="range" min={min} max={max} step={step} value={value}
      onChange={(e) => onChange(parseFloat(e.target.value))}
      className="w-full accent-[var(--accent)] cursor-pointer"
    />
  </div>
);

/** 颜色行：预设色卡（PS 风格）+ 颜色选择器 + HEX 输入 */
const ColorRow: React.FC<{ label: string; value: string; onChange: (v: string) => void }> = ({ label, value, onChange }) => (
  <div className="mb-4">
    <label className="text-xs text-[var(--t3)] block mb-1.5">{label}</label>
    <div className="flex items-center gap-2">
      <input
        type="color" value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-9 h-9 rounded-md cursor-pointer border border-[var(--line2)] bg-transparent shrink-0"
        title={t('colorPicker')}
      />
      <div className="flex flex-wrap gap-1 flex-1 min-w-0">
        {SWATCH_COLORS.map((c) => (
          <button
            key={c} onClick={() => onChange(c)}
            className={`w-5 h-5 rounded transition-transform hover:scale-110 shrink-0 ${c === value ? 'ring-2 ring-white ring-offset-1 ring-offset-[var(--panel)]' : 'border border-[var(--line2)]'}`}
            style={{ background: c }}
          />
        ))}
      </div>
      <input
        type="text" value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-20 bg-[var(--bg)] border border-[var(--line2)] rounded px-2 py-1 text-xs font-mono text-[var(--t1)] shrink-0"
      />
    </div>
  </div>
);

// ---------- 设置面板 ----------

/** 频谱方案预览点：single=单色点 / scale=色阶条 / band=三段色 */
const PalettePreview: React.FC<{ id: string; custom: [string, string, string] | null }> = ({ id, custom }) => {
  const colors = id === 'custom' && custom ? custom : (SPEC_PREVIEW[id] || ['#888888']);
  const w = colors.length === 1 ? 'w-5' : 'w-3';
  return (
    <div className="flex gap-1">
      {colors.map((c, i) => (
        <span key={i} className={`${w} h-3 rounded-full border border-white/20`} style={{ background: c }} />
      ))}
    </div>
  );
};

const SettingsModal: React.FC<SettingsModalProps> = ({ settings, onChange, onReset, onClose }) => {
  // ★ v0.8.16（修 Bug 1：多语言未全软件统一）：
  //   原来这里只有 isZh ? nameZh : nameEn 的二选一 —— 选日语/韩语/法语等语言时，
  //   主题名、频谱方案名、节拍器音色名仍然只显示中英两种，等于多语言没统一。
  //   现在优先查 i18n（nameKey）；没配 key 的条目回退到中/英名，保证任何语言下都有可读文本。
  const nameOf = (item: { nameZh: string; nameEn: string; nameKey?: string }): string =>
    item.nameKey ? t(item.nameKey) : (settings.lang === 'en' ? item.nameEn : item.nameZh);
  // 频谱方案分类二级页：默认切到当前方案所属分类
  const [specCat, setSpecCat] = useState<SpecCategory>(() => {
    const cur = SPEC_PALETTES.find((p) => p.id === settings.specPalette);
    return cur?.category ?? 'scale';
  });
  // 语言二级页：默认切到当前语言所在分组
  const [langCat, setLangCat] = useState<'main' | 'more'>(() => {
    const cur = LANGUAGES.find((l) => l.code === settings.lang);
    return cur?.group ?? 'main';
  });
  // 节拍器音色二级页分类
  const [metCat, setMetCat] = useState<MetronomeCategory>(() => {
    const cur = METRONOME_SOUNDS.find((s) => s.id === settings.metronomeSound);
    return cur?.category ?? 'elec';
  });
  const previewCtx = useRef<AudioContext | null>(null);

  // 试听节拍器音色（短促播放一次重拍声）
  const playMetronomePreview = (type: OscillatorType, freq: number, dur: number, vol: number) => {
    try {
      if (!previewCtx.current) previewCtx.current = new AudioContext();
      const actx = previewCtx.current;
      if (actx.state === 'suspended') actx.resume();
      const osc = actx.createOscillator();
      const gain = actx.createGain();
      osc.connect(gain); gain.connect(actx.destination);
      osc.type = type; osc.frequency.value = freq;
      const now = actx.currentTime;
      gain.gain.setValueAtTime(vol, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
      osc.start(now); osc.stop(now + dur + 0.02);
      osc.onended = () => { osc.disconnect(); gain.disconnect(); };
    } catch { /* 试听失败忽略 */ }
  };

  // 应用预设主题
  const applyTheme = (p: ThemePreset) => {
    onChange({ ...settings, accent: p.accent, accent2: p.accent2, bgColor: p.bgColor, panelBg: p.panelBg });
  };
  const themeActive = (p: ThemePreset) =>
    settings.accent === p.accent && settings.accent2 === p.accent2 &&
    settings.bgColor === p.bgColor && settings.panelBg === p.panelBg;

  // 随机配色：随机生成协调的主色 + 强调色
  const handleRandom = () => {
    const { accent, accent2 } = randomAccentPair();
    onChange({ ...settings, accent, accent2 });
  };

  // 一键复原（父组件执行清存储 + 重置）
  const handleReset = () => {
    if (window.confirm(t('resetConfirm'))) onReset();
  };

  const btnBase = 'px-3 py-1.5 rounded-lg text-xs font-bold transition-all active:scale-95';

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center p-6 bg-black/70 backdrop-blur-md">
      <div className="bg-[var(--panel)] border border-[var(--line2)] w-full max-w-xl rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-full">
        {/* 标题栏 */}
        <div className="p-5 border-b border-[var(--line)] flex justify-between items-center bg-[var(--chip)] shrink-0">
          <div className="flex items-center gap-3 text-[var(--accent)] font-black text-lg">
            <span className="uppercase tracking-[0.2em]">{t('settingsTitle')}</span>
          </div>
          <button onClick={onClose} className="text-[var(--t4)] hover:text-white transition p-1.5" title={t('close')}>
            <X size={22} />
          </button>
        </div>

        {/* 滚动内容 */}
        <div className="flex-1 overflow-y-auto p-6 space-y-7">
          {/* ===== 1+2 主题配色 ===== */}
          <section>
            <h4 className="text-sm font-black text-[var(--t2)] uppercase tracking-widest mb-3 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-indigo-500" /> {t('themeSection')}
            </h4>
            {/* 预设主题卡 */}
            <label className="text-[11px] text-[var(--t4)] block mb-2">{t('presetThemes')}</label>
            <div className="grid grid-cols-3 gap-2 mb-5">
              {THEME_PRESETS.map((p) => (
                <button
                  key={p.id} onClick={() => applyTheme(p)}
                  className={`p-2.5 rounded-xl border text-left transition-all ${themeActive(p) ? 'border-[var(--accent)] bg-[var(--accent)]/10' : 'border-[var(--line2)] hover:border-[var(--accent)]/40 bg-[var(--chip2)]'}`}
                >
                  <div className="flex gap-1.5 mb-2">
                    <span className="w-5 h-5 rounded-full border border-[var(--line2)]" style={{ background: p.accent }} />
                    <span className="w-5 h-5 rounded-full border border-[var(--line2)]" style={{ background: p.accent2 }} />
                    <span className="w-5 h-5 rounded-full border border-[var(--line2)]" style={{ background: p.bgColor }} />
                  </div>
                  <span className="text-[10px] text-[var(--t2)] font-bold">{nameOf(p)}</span>
                </button>
              ))}
            </div>
            {/* 自定义配色 */}
            <label className="text-[11px] text-[var(--t4)] block mb-2">{t('customColors')}</label>
            <ColorRow label={t('accentColor')} value={settings.accent} onChange={(v) => onChange({ ...settings, accent: v })} />
            <ColorRow label={t('accent2Color')} value={settings.accent2} onChange={(v) => onChange({ ...settings, accent2: v })} />
            <ColorRow label={t('bgColor')} value={settings.bgColor} onChange={(v) => onChange({ ...settings, bgColor: v })} />
            <ColorRow label={t('panelBgColor')} value={settings.panelBg} onChange={(v) => onChange({ ...settings, panelBg: v })} />

            {/* 随机配色 */}
            <button
              onClick={handleRandom}
              className="w-full px-4 py-2.5 rounded-xl bg-[var(--accent)]/10 hover:bg-[var(--accent)]/25 text-[var(--accent)] border border-[var(--accent)]/30 font-bold text-sm transition-all flex items-center justify-center gap-2 active:scale-95"
            >
              <Shuffle size={16} /> {t('randomColor')}
            </button>
          </section>

          {/* ===== 声谱图 / 频谱图配色 ===== */}
          <section className="pt-5 border-t border-[var(--line)]">
            <h4 className="text-sm font-black text-[var(--t2)] uppercase tracking-widest mb-3 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-500" /> {t('waveSpecColors')}
            </h4>
            {/* 波形颜色 */}
            <ColorRow label={t('waveColor')} value={settings.waveColor} onChange={(v) => onChange({ ...settings, waveColor: v })} />
            {/* 频谱配色方案：按分类二级页（纯色 / 色阶 / 三分频） */}
            <label className="text-xs text-[var(--t3)] block mb-1.5">{t('specPalette')}</label>
            {/* 分类标签 */}
            <div className="grid grid-cols-3 gap-2 mb-3">
              {([
                ['single', t('specCatSingle')],
                ['scale', t('specCatScale')],
                ['band', t('specCatBand')],
              ] as [string, string][]).map(([cat, label]) => (
                <button
                  key={cat}
                  onClick={() => setSpecCat(cat as SpecCategory)}
                  className={`${btnBase} ${specCat === cat ? 'bg-[var(--accent)] text-white' : 'bg-[var(--chip2)] text-[var(--t3)] hover:bg-[var(--chip)]'}`}
                >
                  {label}
                </button>
              ))}
            </div>
            {/* 当前分类下的方案 */}
            <div className="grid grid-cols-3 gap-2 mb-3">
              {SPEC_PALETTES.filter((p) => p.category === specCat).map((p) => (
                <button
                  key={p.id}
                  onClick={() => onChange({ ...settings, specPalette: p.id })}
                  className={`${btnBase} flex-col gap-1.5 py-2 ${settings.specPalette === p.id ? 'bg-[var(--accent2)] text-white' : 'bg-[var(--chip2)] text-[var(--t3)] hover:bg-[var(--chip)]'}`}
                >
                  <PalettePreview id={p.id} custom={p.id === 'custom' ? settings.specCustom : null} />
                  <span className="text-[10px]">{nameOf(p)}</span>
                </button>
              ))}
            </div>
            {/* 峰值突出设置：仅三分频（band）分类下使用，其他分类不显示 */}
            {specCat === 'band' && (
              <div className="mt-3 p-3 rounded-xl border border-[var(--line2)] bg-[var(--chip)]">
                <div className="text-[10px] text-[var(--t3)] uppercase font-bold tracking-widest mb-2">{t('peakSettings')}</div>
                <SliderRow
                  label={t('peakThreshold')} value={Math.round(settings.peakThreshold * 100)}
                  min={50} max={98} step={1} suffix="%"
                  onChange={(v) => onChange({ ...settings, peakThreshold: v / 100 })}
                />
                <ColorRow label={t('peakColor')} value={settings.peakColor} onChange={(v) => onChange({ ...settings, peakColor: v })} />
              </div>
            )}
            {/* 自定义频谱：三段色（低 / 中 / 高） */}
            {settings.specPalette === 'custom' && (
              <div className="p-3 rounded-xl border border-[var(--line2)] bg-[var(--chip)] space-y-1">
                <div className="text-[10px] text-[var(--t3)] uppercase font-bold tracking-widest mb-2">{t('specCustomHint')}</div>
                <ColorRow label={t('specCustomLow')}  value={settings.specCustom[0]} onChange={(v) => onChange({ ...settings, specCustom: [v, settings.specCustom[1], settings.specCustom[2]] })} />
                <ColorRow label={t('specCustomMid')}  value={settings.specCustom[1]} onChange={(v) => onChange({ ...settings, specCustom: [settings.specCustom[0], v, settings.specCustom[2]] })} />
                <ColorRow label={t('specCustomHigh')} value={settings.specCustom[2]} onChange={(v) => onChange({ ...settings, specCustom: [settings.specCustom[0], settings.specCustom[1], v] })} />
              </div>
            )}
            {/* 频谱倒转按钮（对所有方案生效，保留原位） */}
            <div className="mt-3">
              <button
                onClick={() => onChange({ ...settings, specInvert: !settings.specInvert })}
                className={`w-full px-3 py-2 rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-2 ${settings.specInvert ? 'bg-[var(--accent)] text-white' : 'bg-[var(--chip2)] text-[var(--t3)] hover:bg-[var(--chip)]'}`}
              >
                <FlipVertical2 size={14} /> {t('specInvert')}：{settings.specInvert ? t('on') : t('off')}
              </button>
            </div>
            {/* 整体渲染分辨率（DPI 缩放）：越低渲染像素越少越流畅（笔记本减负），越高越清晰但更耗性能 */}
            <div className="mt-3 pt-3 border-t border-[var(--line)]">
              <div className="flex justify-between items-center mb-1.5">
                <span className="text-[10px] text-[var(--t3)] uppercase font-bold tracking-widest">{t('renderScale')}</span>
                <span className="text-xs font-mono text-[var(--accent)] font-bold">{Math.round(settings.renderScale * 100)}%</span>
              </div>
              <input
                type="range" min={0.25} max={2} step={0.05}
                value={settings.renderScale}
                onChange={(e) => onChange({ ...settings, renderScale: parseFloat(e.target.value) })}
                className="w-full accent-[var(--accent)] cursor-pointer"
                title={t('renderScaleHint')}
              />
            </div>
            {/* 红线节拍线延迟微调（手动）：滑条 ±100ms，输入框可填任意值；仅偏移节拍线，不影响频谱/声谱时间轴 */}
            <div className="mt-3 pt-3 border-t border-[var(--line)]">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[10px] text-[var(--t3)] uppercase font-bold tracking-widest">{t('beatLineDelayMs')}</span>
                <div className="flex items-center gap-1.5">
                  <input
                    type="number" step={1}
                    value={settings.beatLineDelayMs}
                    onChange={(e) => onChange({ ...settings, beatLineDelayMs: parseInt(e.target.value) || 0 })}
                    className="w-20 bg-[var(--bg)] border border-[var(--line2)] rounded-md px-2 py-1 text-xs font-mono text-right focus:outline-none focus:border-[var(--accent)]"
                    title={t('beatLineDelayMsHint')}
                  />
                  <span className="text-[10px] text-[var(--t3)]">ms</span>
                </div>
              </div>
              <input
                type="range" min={-100} max={100} step={1}
                value={Math.max(-100, Math.min(100, settings.beatLineDelayMs))}
                onChange={(e) => onChange({ ...settings, beatLineDelayMs: parseInt(e.target.value) })}
                className="w-full accent-[var(--accent)] cursor-pointer"
                title={t('beatLineDelayMsHint')}
              />
            </div>
            {/* 频谱精度（FFT 采样点数）滑条：越大频率分辨率越高（0.5K≈86Hz / 1K≈43Hz / 2K≈21Hz / 4K≈11Hz @44.1kHz） */}
            <div className="mt-3 pt-3 border-t border-[var(--line)]">
              <div className="flex justify-between items-center mb-1.5">
                <span className="text-[10px] text-[var(--t3)] uppercase font-bold tracking-widest">{t('specFFTSize')}</span>
                <span className="text-xs font-mono text-[var(--accent)] font-bold">
                  {(settings.specFFTSize / 1024).toFixed(settings.specFFTSize < 1024 ? 1 : 0)}K
                </span>
              </div>
              <input
                type="range" min={0} max={3} step={1}
                value={SPEC_FFT_OPTIONS.indexOf(settings.specFFTSize) === -1 ? 1 : SPEC_FFT_OPTIONS.indexOf(settings.specFFTSize)}
                onChange={(e) => onChange({ ...settings, specFFTSize: SPEC_FFT_OPTIONS[parseInt(e.target.value)] })}
                className="w-full accent-[var(--accent)] cursor-pointer"
                title={t('specFFTSizeHint')}
              />
            </div>
            {/* 频谱灵敏度（dB 显示阈值）滑条：越小越敏感，弱信号越明显（60~120dB） */}
            <div className="mt-3 pt-3 border-t border-[var(--line)]">
              <div className="flex justify-between items-center mb-1.5">
                <span className="text-[10px] text-[var(--t3)] uppercase font-bold tracking-widest">{t('specSensitivity')}</span>
                <span className="text-xs font-mono text-[var(--accent)] font-bold">{settings.specSensitivity}dB</span>
              </div>
              <input
                type="range" min={60} max={120} step={5}
                value={settings.specSensitivity}
                onChange={(e) => onChange({ ...settings, specSensitivity: parseInt(e.target.value) })}
                className="w-full accent-[var(--accent)] cursor-pointer"
                title={t('specSensitivityHint')}
              />
            </div>
          </section>

          {/* ===== 4 一键复原 ===== */}
          <section className="pt-5 border-t border-[var(--line)]">
            <h4 className="text-sm font-black text-[var(--t2)] uppercase tracking-widest mb-3 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-red-500" /> {t('resetSection')}
            </h4>
            <button
              onClick={handleReset}
              className="w-full px-4 py-2.5 rounded-xl bg-red-500/15 hover:bg-red-500/30 text-red-300 font-bold text-sm transition-all flex items-center justify-center gap-2 active:scale-95"
            >
              <RefreshCw size={16} /> {t('resetAll')}
            </button>
          </section>

          {/* ===== 6 节拍器音色（二级页：电子 / 柔和 / 打击）===== */}
          <section className="pt-5 border-t border-[var(--line)]">
            <h4 className="text-sm font-black text-[var(--t2)] uppercase tracking-widest mb-3 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-amber-500" /> {t('metronomeSounds')}
            </h4>
            {/* 分类标签 */}
            <div className="grid grid-cols-3 gap-2 mb-3">
              {([
                ['elec', t('metCatElec')],
                ['soft', t('metCatSoft')],
                ['perc', t('metCatPerc')],
              ] as [string, string][]).map(([cat, label]) => (
                <button
                  key={cat}
                  onClick={() => setMetCat(cat as MetronomeCategory)}
                  className={`${btnBase} ${metCat === cat ? 'bg-[var(--accent)] text-white' : 'bg-[var(--chip2)] text-[var(--t3)] hover:bg-[var(--chip)]'}`}
                >
                  {label}
                </button>
              ))}
            </div>
            {/* 当前分类音色（点击应用 + 试听） */}
            <div className="grid grid-cols-3 gap-2">
              {METRONOME_SOUNDS.filter((s) => s.category === metCat).map((s) => (
                <button
                  key={s.id}
                  onClick={() => {
                    onChange({ ...settings, metronomeSound: s.id });
                    playMetronomePreview(s.type, s.freqMain, s.dur, s.vol);
                  }}
                  className={`${btnBase} ${settings.metronomeSound === s.id ? 'bg-[var(--accent2)] text-white' : 'bg-[var(--chip2)] text-[var(--t3)] hover:bg-[var(--chip)]'}`}
                  title={t('metPreview')}
                >
                  {nameOf(s)}
                </button>
              ))}
            </div>
          </section>

          {/* ===== 5 语言切换（二级页：常用中英日 / 更多语言） ===== */}
          <section className="pt-5 border-t border-[var(--line)]">
            <h4 className="text-sm font-black text-[var(--t2)] uppercase tracking-widest mb-3 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-green-500" /> {t('languageSection')}
            </h4>
            {/* 语言分类标签 */}
            <div className="grid grid-cols-2 gap-2 mb-3">
              <button
                onClick={() => setLangCat('main')}
                className={`${btnBase} ${langCat === 'main' ? 'bg-[var(--accent)] text-white' : 'bg-[var(--chip2)] text-[var(--t3)] hover:bg-[var(--chip)]'}`}
              >
                {t('langMain')}
              </button>
              <button
                onClick={() => setLangCat('more')}
                className={`${btnBase} ${langCat === 'more' ? 'bg-[var(--accent)] text-white' : 'bg-[var(--chip2)] text-[var(--t3)] hover:bg-[var(--chip)]'}`}
              >
                {t('langMore')}
              </button>
            </div>
            {/* 当前分类语言按钮 */}
            <div className="grid grid-cols-3 gap-2">
              {LANGUAGES.filter((l) => l.group === langCat).map((l) => (
                <button
                  key={l.code}
                  onClick={() => onChange({ ...settings, lang: l.code })}
                  className={`${btnBase} ${settings.lang === l.code ? 'bg-[var(--accent2)] text-white' : 'bg-[var(--chip2)] text-[var(--t3)] hover:bg-[var(--chip)]'}`}
                >
                  {l.native}
                </button>
              ))}
            </div>
          </section>
        </div>

        {/* 底部完成按钮 */}
        <div className="p-4 border-t border-[var(--line)] bg-[var(--chip)] shrink-0">
          <button onClick={onClose} className="w-full px-4 py-2.5 rounded-xl bg-[var(--accent)] hover:bg-[var(--accent)] text-white font-black text-sm transition-all active:scale-95">
            {t('done')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default SettingsModal;
