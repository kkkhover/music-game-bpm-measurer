import React, { useState, useEffect, useRef, useCallback, useLayoutEffect, useMemo } from 'react';
import { 
    Play, Pause, Square, ZoomIn, ZoomOut, Upload, Music, 
    Volume2, VolumeX, Plus, Trash2, Settings, 
    PanelRightClose, PanelRightOpen, Sliders, 
    Download, FileUp, Info, MousePointer2, Keyboard, HelpCircle, Gauge, ChevronDown, LocateFixed, Check, X, ArrowUp,
    Eye, FolderOpen, RotateCcw, AlertTriangle, Save, PictureInPicture2
} from 'lucide-react';
import Visualizer from './components/Visualizer';
import OverviewBar from './components/OverviewBar';
import SettingsModal from './components/SettingsModal';
import BeatmapPreview from './components/BeatmapPreview';
import { AudioData, ViewState, TimingPoint, LineType } from './types';
import { extractPeaks } from './utils/audioUtils';
import { recalculateTiming, getPointAtTime, getTimeAtBeatIndex } from './utils/timingUtils';
import { parseTimingFile } from './utils/timingParser';
import { handleFileUpload } from './utils/fileUtils';
import { generateOsuTimingPoints } from './utils/osuExport';
import { parseOsuDocument, docToPoints, OsuDocument } from './utils/osuBeatmap';
import { patchOsuDocument, verifyTimingOnlyChange, PatchPoint } from './utils/osuPatch';
import { generateAdofaiChart, generateMalodyChart, generatePhigrosChart, generateArcaeaAff, generateVividStasisChart } from './utils/gameExports';
import { AppSettings, loadSettings, saveSettings, clearSettings, DEFAULT_SETTINGS, hexLuminance, getMetronomeSound } from './utils/settings';
import { t, setLang } from './utils/i18n';
import { PREVIEW_CHANNEL, type PreviewCommand } from './utils/previewBridge';
import { createStretchPlayer, type StretchHandle } from './utils/stretchPlayer';

const MIN_ZOOM = 10;
const MAX_ZOOM = 1500;
const DEFAULT_ZOOM = 250;
// ★ v0.8.21 视口自动跟随：播放头越过视口右侧 90% → 视口**直接跳到**下一页，播放头落回左侧 10%
//   与侧栏点击段落一致：瞬跳，不做滚动动画（v0.8.20 的「分帧滚动过去」已移除）。
const FOLLOW_TRIGGER_RATIO = 0.9;
const FOLLOW_LEAD_RATIO = 0.1;

// 虚拟列表固定行高：一张卡片 228px + 16px 间距
const ROW_H = 244;
// 直接写回原 .osu 是有风险的动作 → 每个会话首次导入时确认一次即可
let writeBackConfirmedOnce = false;

interface TimingRowProps {
    point: TimingPoint;
    index: number;
    totalCount: number;
    onUpdate: (id: string, field: 'bpm' | 'beatIndex' | 'sv' | 'svRate' | 'meter' | 'lineType', value: number | boolean | LineType) => void;
    onRemove: (id: string) => void;
    onUpdateTime: (id: string, time: number) => void;
    onJumpToTime?: (sec: number) => void;
    flash?: boolean;
    height?: number; // 虚拟列表需要固定行高
}

/** 固定高度卡片：红线改 BPM、绿线改 SV、两者都写时两个框都可用。默认 SV = 1（正常流速）。 */
const TimingRow: React.FC<TimingRowProps> = ({ point, index, totalCount, onUpdate, onRemove, onUpdateTime, onJumpToTime, flash = false, height = 228 }) => {
    const [bpmStr, setBpmStr] = useState(point.bpm.toFixed(2));
    const [beatStr, setBeatStr] = useState(point.beatIndex.toString());
    const [timeStr, setTimeStr] = useState(point.time.toFixed(3));
    const [meterStr, setMeterStr] = useState(String(point.meter ?? 4));
    // 导入的 SV 是「全精度」存的（保证写回逐位一致），输入框只显示 3 位小数
    const svDisplay = (v?: number) => String(Math.round((v && v > 0 ? v : 1) * 1000) / 1000);
    const [svStr, setSvStr] = useState(svDisplay(point.svRate));

    useEffect(() => { if (Math.abs(parseFloat(bpmStr) - point.bpm) > 0.001) setBpmStr(point.bpm.toFixed(2)); }, [point.bpm]);
    useEffect(() => { if (Math.abs(parseFloat(beatStr) - point.beatIndex) > 0.001) setBeatStr(point.beatIndex.toString()); }, [point.beatIndex]);
    useEffect(() => { if (Math.abs(parseFloat(timeStr) - point.time) > 0.0005) setTimeStr(point.time.toFixed(3)); }, [point.time]);
    useEffect(() => { const m = point.meter ?? 4; if (parseInt(meterStr, 10) !== m) setMeterStr(String(m)); }, [point.meter]);
    useEffect(() => {
        const v = point.svRate && point.svRate > 0 ? point.svRate : 1;
        if (Math.abs(parseFloat(svStr) - v) > 0.0006) setSvStr(svDisplay(v));
    }, [point.svRate]);

    const blurBpm = () => { const v = parseFloat(bpmStr); if (Number.isFinite(v) && v > 0) { const r = Math.round(v * 100) / 100; onUpdate(point.id, 'bpm', r); setBpmStr(r.toFixed(2)); } else setBpmStr(point.bpm.toFixed(2)); };
    const blurBeat = () => { const v = parseFloat(beatStr); if (Number.isFinite(v) && v >= 0) onUpdate(point.id, 'beatIndex', v); else setBeatStr(point.beatIndex.toString()); };
    const blurMeter = () => { const v = parseInt(meterStr, 10); if (Number.isFinite(v) && v >= 1) onUpdate(point.id, 'meter', v); else setMeterStr(String(point.meter ?? 4)); };
    const blurSv = () => { const v = parseFloat(svStr); if (Number.isFinite(v) && v > 0) { const r = Math.round(v * 1000) / 1000; onUpdate(point.id, 'svRate', r); setSvStr(String(r)); } else setSvStr('1'); };
    const blurTime = () => { const v = parseFloat(timeStr); if (Number.isFinite(v) && v >= 0) { const r = Math.round(v * 1000) / 1000; onUpdateTime(point.id, r); setTimeStr(r.toFixed(3)); } else setTimeStr(point.time.toFixed(3)); };

    const isStartAnchor = point.beatIndex === 0;
    const type: LineType = point.lineType ?? (point.sv === false ? 'red' : 'both');
    const hasRed = type === 'red' || type === 'both';
    const hasGreen = type === 'green' || type === 'both';
    const segBtn = (key: LineType, label: string, activeColor: string) => (
        <button
            key={key}
            onClick={() => onUpdate(point.id, 'lineType', key)}
            title={key === 'red' ? t('lineTypeRedHint') : key === 'green' ? t('lineTypeGreenHint') : t('lineTypeBothHint')}
            className={`flex-1 py-1 text-[10px] font-black rounded-md transition-all ${type === key ? activeColor : 'text-[var(--t4)] hover:text-[var(--t2)]'}`}
        >{label}</button>
    );
    const inputCls = 'w-full h-[28px] bg-[var(--bg)] border border-[var(--line2)] rounded-md px-2 text-xs font-mono focus:outline-none focus:border-[var(--accent)] disabled:opacity-30';
    const labelCls = 'text-[9px] text-[var(--t4)] block mb-0.5 uppercase font-bold';

    return (
        <div id={`section-row-${point.id}`}
             onDoubleClick={() => onJumpToTime?.(point.time)}
             title={t('jumpSection')}
             style={{ height }}
             className={`bg-[var(--chip2)] rounded-xl p-3 border-l-4 flex flex-col gap-1.5 overflow-hidden ${isStartAnchor ? 'border-red-500' : 'border-[var(--accent)]'} group transition-all duration-200 shadow-lg ${flash ? 'ring-2 ring-amber-400 shadow-[0_0_20px_rgba(251,191,36,0.5)]' : ''}`}>
            {/* 标题行 */}
            <div className="flex justify-between items-center shrink-0">
                <span className="text-[10px] font-black text-[var(--t3)] tracking-widest uppercase truncate">
                    {isStartAnchor ? t('startAnchor') : t('sectionN', { n: index })}
                    <span className="ml-1.5 font-mono text-[var(--t4)] normal-case">{(point.timeSec ?? point.time).toFixed(3)}s</span>
                </span>
                <div className="flex items-center gap-1 shrink-0">
                    {hasGreen && <span className="w-1.5 h-1.5 rounded-full bg-green-400" title={t('lineTypeGreen')} />}
                    {hasRed && <span className="w-1.5 h-1.5 rounded-full bg-red-400" title={t('lineTypeRed')} />}
                    {!isStartAnchor && (
                        <button onClick={() => onRemove(point.id)} className="text-[var(--t4)] hover:text-red-400 opacity-0 group-hover:opacity-100 transition p-0.5">
                            <Trash2 size={13} />
                        </button>
                    )}
                </div>
            </div>

            {/* ★ 线型选择：红线改 BPM / 绿线改 SV / 默认两者都写且 SV=1 */}
            <div className="flex gap-0.5 p-0.5 rounded-lg bg-[var(--bg)] border border-[var(--line2)] shrink-0" title={t('lineTypeHint')}>
                {segBtn('both', t('lineTypeBoth'), 'bg-[var(--accent)]/25 text-[var(--accent)]')}
                {segBtn('red', t('lineTypeRed'), 'bg-red-500/20 text-red-400')}
                {segBtn('green', t('lineTypeGreen'), 'bg-green-500/20 text-green-400')}
            </div>

            <div className="grid grid-cols-2 gap-2 shrink-0">
                <div>
                    <label className={labelCls}>{t('bpmLabel')}</label>
                    <input type="number" step="0.01" disabled={!hasRed} value={bpmStr}
                        onChange={e => setBpmStr(e.target.value)} onBlur={blurBpm}
                        onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                        className={`${inputCls} text-[var(--accent2)]`} title={t('lineTypeRedHint')} />
                </div>
                <div>
                    <label className={labelCls}>SV</label>
                    <input type="number" step="0.05" min="0.01" max="20" disabled={!hasGreen} value={svStr}
                        onChange={e => setSvStr(e.target.value)} onBlur={blurSv}
                        onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                        className={`${inputCls} text-green-400`} title={t('svRateHint')} />
                </div>
            </div>

            <div className="grid grid-cols-2 gap-2 shrink-0">
                <div>
                    <label className={labelCls}>{t('beatIndexLabel')}</label>
                    <input type="number" disabled={isStartAnchor} value={beatStr}
                        onChange={e => setBeatStr(e.target.value)} onBlur={blurBeat}
                        onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                        className={inputCls} />
                </div>
                <div>
                    <label className={labelCls}>{t('meterLabel')}</label>
                    <div className="flex items-center gap-1">
                        <input type="number" step="1" min="1" max="7" value={meterStr}
                            onChange={e => setMeterStr(e.target.value)} onBlur={blurMeter}
                            onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                            className={inputCls} title={t('meterHint')} />
                        <span className="text-[10px] text-[var(--t4)]">/4</span>
                    </div>
                </div>
            </div>

            <div className="flex justify-between items-center shrink-0 text-[10px] text-[var(--t4)] font-mono pt-0.5 border-t border-[var(--line)]">
                <span className="font-bold">{t('startTimeLabel')}</span>
                <div className="flex items-center gap-1">
                    <input type="number" step="0.001" min="0" value={timeStr}
                        onChange={e => setTimeStr(e.target.value)} onBlur={blurTime}
                        onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                        className="w-20 h-[24px] bg-[var(--bg)] border border-[var(--line2)] rounded-md px-1.5 text-[10px] font-mono text-right text-[var(--accent)] focus:outline-none focus:border-[var(--accent)]"
                        title={t('timeEditHint')} />
                    <span>s</span>
                </div>
            </div>
        </div>
    );
};

const OffsetInput = ({ value, onChange }: { value: number, onChange: (val: number) => void }) => {
    const [localVal, setLocalVal] = useState(value.toFixed(3));
    useEffect(() => {
        if (Math.abs(parseFloat(localVal) - value) > 0.0001) setLocalVal(value.toFixed(3));
    }, [value]);
    const handleBlur = () => {
        const val = parseFloat(localVal);
        if (!isNaN(val)) { 
            const rounded = Math.round(val * 1000) / 1000;
            onChange(rounded); 
            setLocalVal(rounded.toFixed(3)); 
        }
        else setLocalVal(value.toFixed(3));
    }
    return (
        <input 
            type="number" step="0.001" value={localVal}
            onChange={(e) => setLocalVal(e.target.value)}
            onBlur={handleBlur}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            className="w-full bg-[var(--bg)] border border-[var(--line2)] rounded-lg px-3 py-2 text-base text-red-400 font-mono focus:outline-none focus:ring-2 focus:ring-red-500/20"
        />
    )
}

// 格式化播放时间显示：mm:ss.d
const formatTime = (t: number): string => {
    if (!isFinite(t) || t < 0) t = 0;
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

function App() {
  const [audioContext] = useState(() => new (window.AudioContext || (window as any).webkitAudioContext)());
  const [audioData, setAudioData] = useState<AudioData | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  // 音频的**绝对路径**（Electron 下由原生对话框给出）。
  // 导出 Malody 谱面包(.mcz) 要把音频本体一起打进包里，所以这里必须留住它 ——
  // 只留 fileName 是拿不到文件的。
  const [audioPath, setAudioPath] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [isMetronomeOn, setIsMetronomeOn] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [specLogBase, setSpecLogBase] = useState(50);
  const [showHelp, setShowHelp] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false); // 导出按钮二级菜单
  const [flashSectionId, setFlashSectionId] = useState<string | null>(null); // 段落高亮闪烁
  const flashTimerRef = useRef<number | null>(null);
  const [jumpIdx, setJumpIdx] = useState(''); // 段落跳转输入框
  const [showTopBtn, setShowTopBtn] = useState(false); // 变速段落区回到顶部悬浮球
  const sidebarScrollRef = useRef<HTMLDivElement>(null);
  const [listScrollTop, setListScrollTop] = useState(0);
  const [listHeight, setListHeight] = useState(600);
  const orderedIdsRef = useRef<string[]>([]);

  // ===== v0.9.0 外部谱面 / 实时写回 / 预览 =====
  const [beatmap, setBeatmap] = useState<OsuDocument | null>(null);
  const [beatmapEntries, setBeatmapEntries] = useState<{ name: string; path: string; text: string }[]>([]);
  const [beatmapAudioPath, setBeatmapAudioPath] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  /** 预览是否已弹成「独立窗口」（可以拖到软件窗口外面） */
  const [previewDetached, setPreviewDetached] = useState(false);
  const [writeBack, setWriteBack] = useState(true);
  const [writeConfirmed, setWriteConfirmed] = useState(false);
  const [writeStatus, setWriteStatus] = useState<{ kind: 'idle' | 'ok' | 'error' | 'paused'; msg: string }>({ kind: 'idle', msg: '' });
  const expectedMtimeRef = useRef(0);
  const lastWrittenRef = useRef('');
  const writeQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const writingRef = useRef(false);

  // ===== 制谱侧栏（osu-maphelper 独立窗口程序）启动状态 =====
  //   idle / launching / ok / error。原来这段逻辑在设置面板里，
  //   按需求 6 移到顶栏（紧邻「导入音频」，即截图黄圈位置）。
  const [mhState, setMhState] = useState<'idle' | 'launching' | 'ok' | 'error'>('idle');
  const [mhMsg, setMhMsg] = useState('');
  const launchSidebar = useCallback(async () => {
    // 通过 preload 暴露的 electronAPI 走主进程；浏览器里没有就提示
    const api = (window as any).electronAPI;
    if (!api?.launchMapHelper) { setMhState('error'); setMhMsg('仅在 Electron 桌面版可用'); return; }
    setMhState('launching'); setMhMsg('');
    try {
      const r = await api.launchMapHelper();
      if (r.ok) {
        setMhState('ok');
        // 主进程会在侧栏起来后自动把本软件收起（最小化），提示用户怎么回来
        setMhMsg(r.alreadyRunning ? '侧栏已在运行' : '侧栏已启动，本软件已自动收起');
      } else {
        setMhState('error'); setMhMsg(r.error || '启动失败');
      }
    } catch (e) {
      setMhState('error'); setMhMsg(String(e));
    }
  }, []);

  // 点击频谱红色小节线 → 右侧面板滚动到对应段落并高亮（虚拟列表按行号定位）
  const handleSectionClick = useCallback((id: string) => {
    const idx = orderedIdsRef.current.indexOf(id);
    if (idx >= 0) {
      const top = Math.max(0, idx * ROW_H - listHeight / 2 + ROW_H / 2);
      sidebarScrollRef.current?.scrollTo({ top, behavior: 'smooth' });
    } else {
      document.getElementById(`section-row-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    setFlashSectionId(id);
    if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => setFlashSectionId(null), 1600);
  }, [listHeight]);

  // ===== 应用设置（主题配色 / 背景底图 / 语言），localStorage 持久化 =====
  const [settings, setSettingsState] = useState<AppSettings>(() => {
    const s = loadSettings();
    setLang(s.lang);
    return s;
  });
  // 更新设置：应用 + 持久化 + 同步 i18n 语言
  const updateSettings = useCallback((s: AppSettings) => {
    setSettingsState(s);
    saveSettings(s);
    setLang(s.lang);
  }, []);
  // 一键复原：清存储 + 恢复默认
  const handleResetSettings = useCallback(() => {
    clearSettings();
    const d = { ...DEFAULT_SETTINGS };
    setSettingsState(d);
    saveSettings(d);
    setLang(d.lang);
  }, []);

  // ===== 固定 1080p 渲染 =====
  // 画布位图宽度由 Visualizer 锁死为 1920 设备像素（与屏幕缩放/窗口大小无关），这里只给
  // 「清晰度微调倍率」：1.0 = 正好 1080p（默认），<1 更省，>1 更清晰（更吃内存）。
  // 旧版本用户为了对抗卡顿常把 renderScale 调到 0.5（位图只有 ~960px 宽，糊得厉害），
  // 迁移逻辑会把它恢复成 1.0 —— 渲染路径已重写，不该再靠糊画质换流畅。
  const renderDpr = useMemo(
    () => Math.max(0.5, Math.min(2, settings.renderScale)),
    [settings.renderScale]
  );

  // 音乐主音量（masterGain），所有音频源经此输出
  const masterGainRef = useRef<GainNode | null>(null);
  /**
   * 录制音频图：
   *
   *   masterGain ──┬──────────────→ audioContext.destination（扬声器）
   *                └──→ recMix ──→ MediaStreamDestination（录制音轨）
   *   节拍器(playClick 的 gain) ──┬→ destination（扬声器，永远出声）
   *                              └→ clickRecGain(0/1) → recMix（可选）
   *
   * 为什么中间要有一层 recMix 而不是把 masterGain 直接接出去：
   *   用户要能选「节拍器要不要录进视频」。若 masterGain 直连 Destination，节拍器就
   *   只能二选一地"进/不进扬声器"；有了 recMix 这个总线，节拍器照常进扬声器，
   *   同时经一个默认 0 的 clickRecGain 汇入录制——开关只改一个 gain 值，
   *   录制端始终只有**一条音轨**（MediaRecorder 对多音轨支持很差，只认第一条）。
   *
   * 从 masterGain 取而不是 destination：取到的是**当前音量设置后**的信号
   * （用户把音乐调小，录出来也跟着小，符合"录下你听到的"）。
   */
  const recDestRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const recMixRef = useRef<GainNode | null>(null);
  /** 节拍器 → 录制总线 的开关增益（0 = 不录，1 = 录） */
  const clickRecGainRef = useRef<GainNode | null>(null);
  if (!masterGainRef.current) {
    masterGainRef.current = audioContext.createGain();
    masterGainRef.current.connect(audioContext.destination);
    masterGainRef.current.gain.value = 1.0;
    try {
      const dest = audioContext.createMediaStreamDestination();
      const mix = audioContext.createGain();
      mix.gain.value = 1.0;
      mix.connect(dest);
      masterGainRef.current.connect(mix);
      const click = audioContext.createGain();
      click.gain.value = 0; // 默认不录节拍器，由 settings.recordMetronome 同步
      click.connect(mix);
      recDestRef.current = dest;
      recMixRef.current = mix;
      clickRecGainRef.current = click;
    } catch { /* 老浏览器不支持：录制就只有画面 */ }
  }
  /** 给预览组件用：返回录制音频流（同一份，永久复用） */
  const getRecordAudioStream = useCallback(() => recDestRef.current?.stream ?? null, []);
  // 挂载/音量变化时同步到实际设置值（平滑过渡防爆音）
  useEffect(() => {
    const g = masterGainRef.current;
    if (g) g.gain.setTargetAtTime(settings.musicVolume, audioContext.currentTime, 0.02);
  }, [settings.musicVolume, audioContext]);
  /** 节拍器入录开关：只改汇入录制总线的量，扬声器支路不受影响 */
  useEffect(() => {
    const g = clickRecGainRef.current;
    if (g) g.gain.setTargetAtTime(settings.recordMetronome ? 1 : 0, audioContext.currentTime, 0.01);
  }, [settings.recordMetronome, audioContext]);
  
  const [globalOffset, setGlobalOffset] = useState(0);
  const [rawPoints, setRawPoints] = useState<Omit<TimingPoint, 'time'>[]>([
      { id: 'initial', beatIndex: 0, bpm: 120, sv: true, svRate: 1, lineType: 'both' }
  ]);

  // ===== 撤销 / 重做历史（Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z）=====
  // 快照 = 红线数组 + 全局 Offset；连续拖动/连打会合并成一步（停手 400ms 后落栈）
  type HistorySnap = { points: Omit<TimingPoint, 'time'>[]; offset: number };
  const historyRef = useRef<{ past: HistorySnap[]; future: HistorySnap[] }>({ past: [], future: [] });
  const lastSnapRef = useRef<HistorySnap>({ points: rawPoints, offset: globalOffset });
  const pendingSnapRef = useRef<HistorySnap | null>(null);
  const pendingTimerRef = useRef<number | null>(null);
  const skipHistoryRef = useRef(false);
  const HISTORY_LIMIT = 200;

  /** 把待提交的快照写入历史栈（连续操作合并为一步） */
  const flushPendingHistory = useCallback(() => {
    if (pendingTimerRef.current !== null) { window.clearTimeout(pendingTimerRef.current); pendingTimerRef.current = null; }
    const p = pendingSnapRef.current;
    pendingSnapRef.current = null;
    if (!p) return;
    historyRef.current.past.push(p);
    if (historyRef.current.past.length > HISTORY_LIMIT) historyRef.current.past.shift();
    historyRef.current.future.length = 0; // 新操作后重做链失效
  }, []);

  // 监听状态变化 → 记录「变化前的快照」，延迟落栈（合并连续变更）
  useEffect(() => {
      if (skipHistoryRef.current) {
          skipHistoryRef.current = false;
          lastSnapRef.current = { points: rawPoints, offset: globalOffset };
          return;
      }
      const prev = lastSnapRef.current;
      if (prev.points === rawPoints && prev.offset === globalOffset) return;
      if (!pendingSnapRef.current) pendingSnapRef.current = prev;
      lastSnapRef.current = { points: rawPoints, offset: globalOffset };
      if (pendingTimerRef.current !== null) window.clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = window.setTimeout(flushPendingHistory, 400);
  }, [rawPoints, globalOffset, flushPendingHistory]);

  /** 撤销 */
  const undo = useCallback(() => {
      flushPendingHistory();
      const h = historyRef.current;
      const snap = h.past.pop();
      if (!snap) return;
      h.future.push({ points: rawPoints, offset: globalOffset });
      skipHistoryRef.current = true;
      setRawPoints(snap.points);
      setGlobalOffset(snap.offset);
  }, [rawPoints, globalOffset, flushPendingHistory]);

  /** 重做 */
  const redo = useCallback(() => {
      flushPendingHistory();
      const h = historyRef.current;
      const snap = h.future.pop();
      if (!snap) return;
      h.past.push({ points: rawPoints, offset: globalOffset });
      skipHistoryRef.current = true;
      setRawPoints(snap.points);
      setGlobalOffset(snap.offset);
  }, [rawPoints, globalOffset, flushPendingHistory]);
  
  // 播放倍速（0.25x - 2.0x），ref 供实时读取
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const playbackRateRef = useRef(1.0);
  const playheadRef = useRef(0); // 播放头位置（秒）：每帧更新，供 Visualizer 独立播放头层实时读取（不经过 React 渲染）
  /** isPlaying 的同步镜像：预览发来的「录制起点」命令要在一个事件里判断当前是否在播，
   *  读 state 会拿到上一次渲染的旧值（同一个 tick 内 setState 还没生效）。 */
  const isPlayingRef = useRef(false);
  isPlayingRef.current = isPlaying;
  // 预览小窗用稳定引用：App 播放时每 100ms 重渲染一次，内联箭头函数会让 memo 失效、
  // 连带预览组件一起重渲染（频谱换区域时表现为「卡顿一下」）。
  const getPreviewPlayheadTime = useCallback(() => playheadRef.current, []);
  const closePreview = useCallback(() => {
    setPreviewOpen(false);
    // 独立窗口也要一起关，否则它会在没有谱面的状态下继续挂着
    setPreviewDetached(false);
    (window as any).electronAPI?.closePreviewWindow?.();
  }, []);
  
  // ★ v0.8.19：这里必须 useMemo。
  //   recalculateTiming 每次调用都返回新数组，而播放时 currentTime 每 100ms 触发一次 App 重渲染，
  //   于是 timingPoints 引用每 100ms 变一次 → Visualizer 里所有依赖它的绘制 effect 全部重跑，
  //   其中「拍线覆盖层」要把满屏上千条拍线整幅重画 → 导入 timing 之后就开始明显卡。
  //   依赖只有 offset 与原始点集，缓存后数组引用稳定，绘制 effect 不再被无意义唤醒。
  const timingPoints = useMemo(() => recalculateTiming(globalOffset, rawPoints), [globalOffset, rawPoints]);
  const [viewState, setViewState] = useState<ViewState>({ zoom: DEFAULT_ZOOM, scrollLeft: 0 });
  /**
   * ★ v0.8.20：视口自动跟随播放头。
   *   播放时白条滑出当前可视区域（越过右边界），视口自动"翻页"到下一区域，
   *   让白条落回视口左侧 —— 长曲目不用再手动拖时间轴。
   *   用户主动拖动/滚动时间轴时自动关闭（否则想看别处会被立刻拽回），可用底部按钮重新开启。
   */
  const [followPlayhead, setFollowPlayhead] = useState(true);
  // 底部缩放输入框的文字状态（可键入）。正在输入时不被外部变化打断。
  const [zoomText, setZoomText] = useState(String(Math.round(DEFAULT_ZOOM)));
  const zoomFocusRef = useRef(false);
  useEffect(() => {
      if (!zoomFocusRef.current) setZoomText(String(Math.round(viewState.zoom)));
  }, [viewState.zoom]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);
  // 播放 loop 不随渲染重建（依赖稳定），因此下面这些"最新值"必须走 ref 读取
  const containerWidthRef = useRef(0);
  containerWidthRef.current = containerWidth;
  const viewStateRef = useRef(viewState);
  viewStateRef.current = viewState;
  const followRef = useRef(followPlayhead);
  followRef.current = followPlayhead;

  // 当前播放位置所属段落的 BPM（footer 显示）
  const currentBpm = useMemo(() => {
    const { point } = getPointAtTime(currentTime, timingPoints);
    return point.bpm;
  }, [currentTime, timingPoints]);

  // 双击变速段落卡片 → 时间轴滚动到该红线位置（居中显示；不改动播放位置）
  const handleJumpToTimeline = useCallback((sec: number) => {
    setViewState(v => {
      const maxScroll = Math.max(0, (audioData?.duration || 0) * v.zoom - containerWidth);
      const targetX = sec * v.zoom;
      return { ...v, scrollLeft: Math.max(0, Math.min(targetX - containerWidth / 2, maxScroll)) };
    });
  }, [audioData, containerWidth]);

  // 修改全局 Offset：红线位置都是绝对时间（v0.7.18）→ 平移时整体跟随，保持红线之间的相对关系
  const handleOffsetChange = useCallback((v: number) => {
    const rounded = Math.round(v * 1000) / 1000;
    const delta = rounded - globalOffset;
    setGlobalOffset(rounded);
    if (Math.abs(delta) < 1e-9) return;
    setRawPoints(prev => prev.map(p => {
      // 起点锚点（beatIndex=0）由 Offset 本身决定，不参与平移；按 beatIndex 判断而不是下标，避免顺序变化时误判
      if (p.beatIndex === 0) return p;
      const computed = timingPoints.find(tp => tp.id === p.id);
      const base = typeof p.timeSec === 'number' ? p.timeSec : computed?.time;
      if (typeof base !== 'number') return p;
      return { ...p, timeSec: Math.round((base + delta) * 1000) / 1000 };
    }));
  }, [globalOffset, timingPoints]);

  // 输入段落序号 → 跳转对应卡片（1=第一张卡片/起点锚点）
  const jumpToSection = useCallback(() => {
    const n = parseInt(jumpIdx);
    if (isNaN(n) || n < 1 || timingPoints.length === 0) return;
    const target = timingPoints[Math.min(n - 1, timingPoints.length - 1)];
    if (target) {
      handleSectionClick(target.id);
      setJumpIdx('');
    }
  }, [jumpIdx, timingPoints, handleSectionClick]);

  // ===== 播放核心（变速不变调：soundtouchjs PitchShifter + 墙钟公式）=====
  const sourceNodeRef = useRef<StretchHandle | null>(null);
  const startTimeRef = useRef<number>(0);   // 播放开始的墙钟时间
  const startOffsetRef = useRef<number>(0); // 播放开始的内容偏移
  const rafRef = useRef<number | null>(null);
  const lastScheduledIndexRef = useRef<number>(-Infinity);
  const currentTimeRef = useRef<number>(0); // 与 currentTime state 同步，供 play/handleSeek 读取最新值
  const uiFrameRef = useRef(0); // UI 显示降频计数器：播放头由独立层驱动，时间码/总览条 ~10fps 足够
  const lastUiPublishRef = useRef(0); // 上次把播放位置推给 React 的时间（ms）

  useLayoutEffect(() => {
    if (!containerRef.current) return;
    const currentContainer = containerRef.current;
    setContainerWidth(currentContainer.clientWidth);
    setContainerHeight(currentContainer.clientHeight);
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
        setContainerHeight(entry.contentRect.height);
      }
    });
    observer.observe(currentContainer);
    return () => observer.disconnect();
  }, [audioData]);

  useEffect(() => {
    if (!audioData || containerWidth === 0) return;
    const maxScroll = Math.max(0, audioData.duration * viewState.zoom - containerWidth);
    if (viewState.scrollLeft > maxScroll) {
       setViewState(v => ({ ...v, scrollLeft: maxScroll }));
    }
  }, [containerWidth, viewState.zoom, audioData]);
  
  useEffect(() => { lastScheduledIndexRef.current = -Infinity; }, [timingPoints]);

  // 添加下一条红线：出现在「蓝线位置处」（最后一拍的下一个拍点），并暂时继承前一条红线的 BPM
  const handleAddPoint = useCallback(() => {
    if (timingPoints.length === 0) return;
    const last = timingPoints[timingPoints.length - 1];
    const beatDur = 60 / Math.max(1, last.bpm);
    const newTime = Math.round((last.time + beatDur) * 1000) / 1000; // 蓝线所在位置（下一拍）
    setRawPoints(prev => {
        const exists = prev.some(p => typeof p.timeSec === 'number' && Math.abs(p.timeSec - newTime) < 1e-4);
        if (exists) return prev;
        return [...prev, {
            id: crypto.randomUUID(),
            beatIndex: last.beatIndex + 1,
            bpm: last.bpm, // 暂时继承前一条红线的 BPM
            meter: last.meter ?? 4, // ★ v0.8.17：继承上一段的拍号（默认 4/4）
            sv: true,
            svRate: 1,        // ★ 默认 SV = 1（正常流速）
            lineType: 'both', // ★ 默认同时写红线 + 绿线
            timeSec: newTime,
        }];
    });
  }, [timingPoints]);

  const handleUpdatePoint = useCallback((id: string, field: 'bpm' | 'beatIndex' | 'sv' | 'svRate' | 'meter' | 'lineType', value: number | boolean | LineType) => {
      const idx = timingPoints.findIndex(tp => tp.id === id);
      const cur = idx >= 0 ? timingPoints[idx] : null;
      // 改 BPM 时：把「下一条红线」的当前位置固化成绝对时间 → 这次 BPM 变化不会挪动它
      const nextTp = idx >= 0 ? timingPoints[idx + 1] : null;
      setRawPoints(prev => prev.map(p => {
          if (field === 'bpm' && nextTp && p.id === nextTp.id && typeof p.timeSec !== 'number') {
              return { ...p, timeSec: Math.round(nextTp.time * 1000) / 1000 };
          }
          if (p.id !== id) return p;
          if (p.beatIndex === 0 && field === 'beatIndex') return p;
          // 绿线倍速 SV：空/0/非法值 → 1（正常流速）
          if (field === 'svRate') {
              const r = typeof value === 'number' && isFinite(value) && value > 0 ? Math.round(value * 1000) / 1000 : 1;
              return { ...p, svRate: r, sv: true };
          }
          // 卡片线型：红线改 BPM / 绿线改 SV / 两者都写
          if (field === 'lineType') {
              const lt = value as LineType;
              return { ...p, lineType: lt, sv: lt !== 'red', svRate: p.svRate && p.svRate > 0 ? p.svRate : 1 };
          }
          // 绿线开关（兼容旧配置）
          if (field === 'sv') {
              return { ...p, sv: value as boolean };
          }
          // 拍号（meter）：整数、至少 1（只影响小节线/节拍器分组，不改变红线位置）
          if (field === 'meter') {
              const m = Math.max(1, Math.min(7, Math.round(value as number)));
              return { ...p, meter: m };
          }
          // 改 BPM：只改变这条红线下方的蓝线间距（红线位置由绝对时间决定，不会挪动下一条红线）
          if (field === 'bpm') {
              return { ...p, bpm: value as number };
          }
          // 改拍号：换算成绝对时间写回（红线位置从此独立，改 BPM 也不再挪动它）
          if (!cur) return p;
          const prevPoint = idx > 0 ? timingPoints[idx - 1] : null;
          const dur = prevPoint ? 60 / Math.max(1, prevPoint.bpm) : 60 / Math.max(1, cur.bpm);
          const deltaBeats = (value as number) - cur.beatIndex;
          const newTime = Math.round((cur.time + deltaBeats * dur) * 1000) / 1000;
          return { ...p, beatIndex: value as number, timeSec: newTime };
      }).sort((a, b) => {
          if (typeof a.timeSec === 'number' && typeof b.timeSec === 'number') return a.timeSec - b.timeSec;
          return a.beatIndex - b.beatIndex;
      }));
  }, [timingPoints]);

  const handleRemovePoint = useCallback((id: string) => {
      setRawPoints(prev => prev.filter(p => p.id !== id || p.beatIndex === 0));
  }, []);

  // 修改某条红线的时间戳（秒）：起点锚点 → 改全局 Offset；其余段 → 直接写绝对时间（红线位置独立）
  const handleUpdatePointTime = useCallback((id: string, newTime: number) => {
      const target = Math.round(newTime * 1000) / 1000;
      const idx = timingPoints.findIndex(p => p.id === id);
      if (idx < 0) return;
      if (idx === 0) { handleOffsetChange(Math.max(0, target)); return; }
      const prevPoint = timingPoints[idx - 1];
      // 不允许拖/填到上一条红线之前（越界钳制，保持顺序）
      const clamped = Math.max(prevPoint.time + 0.001, target);
      setRawPoints(prev => prev.map(p => (p.id === id ? { ...p, timeSec: clamped } : p)));
  }, [timingPoints, handleOffsetChange]);

  // ★ v0.8.16：stop() 定义在下方（第 ~780 行），而 handleFileUpload 在上方。
  //   函数体虽然在运行时才求值、且 handleFileUpload 只被事件/键盘 effect 调用（渲染提交后才跑），
  //   但为了彻底避免 TDZ 隐患，这里用 ref 转发：下方 stop() 定义后立刻把最新实现写进这个 ref。
  const stopRef = useRef<() => void>(() => {});

  // forcedPath：命令行 --open-audio=<路径> / 拖文件到 exe 上的自动打开（跳过文件对话框）
  const [importing, setImporting] = useState(false);
  const importingRef = useRef(false);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement> | null = null, forcedPath?: string) => {
    // ★ v0.8.19 修「要导入两次才成功」：
    //   顶栏「导入音频」是个 <label> 包 <input type=file>，点它 **浏览器已经弹过一次系统文件框**，
    //   选完文件后 onChange 才把 e 交进来。旧代码不管 e、一律先走 electronAPI.openAudioFile()，
    //   于是又弹第二次对话框 → 第一次选的文件被丢弃，用户感觉"第一次导入没反应"。
    //   现在：只要 e 里已经带了文件，就直接用它，绝不再弹框。
    const picked = e?.target?.files?.[0] ?? null;
    if (picked && e?.target) e.target.value = ''; // 允许再次选择同一个文件（否则 change 不再触发）
    if (!picked && importingRef.current) return;  // 另一个导入还在解码 → 忽略重复触发

    let file: File | null = picked;

    if (!file && forcedPath) {
      setAudioPath(forcedPath); // 留住绝对路径，供「导出 Malody 谱面包」打包音频用
      const data = await (window as any).electronAPI.readAudioFile(forcedPath);
      if (data) {
        const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        file = new File([arrayBuffer], forcedPath.split(/[\\/]/).pop() || 'unknown', { type: 'audio/*' });
      }
    } else if (!file && typeof window !== 'undefined' && 'electronAPI' in window) {
      const filePath = await (window as any).electronAPI.openAudioFile();
      if (filePath) {
        setAudioPath(filePath); // 留住绝对路径，供「导出 Malody 谱面包」打包音频用
        // 通过 IPC 读取文件内容（contextIsolation 下无法直接使用 Node fs）
        const data = await (window as any).electronAPI.readAudioFile(filePath);
        if (data) {
          const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
          file = new File([arrayBuffer], filePath.split(/[\\/]/).pop() || 'unknown', { type: 'audio/*' });
        }
      }
    }

    if (!file) return;
    setFileName(file.name);
    // ★ 解码 7 分钟的歌要 1~3 秒，旧代码这段时间**没有任何反馈**（按钮不变、界面不动），
    //   用户以为没反应就会再点一次 —— 这也是"要导入两次"的另一半原因。
    importingRef.current = true;
    setImporting(true);
    const t0 = performance.now();
    try {
        const arrayBuffer = await file.arrayBuffer();
        if (audioContext.state === 'suspended') await audioContext.resume();
        const decodedBuffer = await audioContext.decodeAudioData(arrayBuffer);
        const peaks = extractPeaks(decodedBuffer);
        setAudioData({ buffer: decodedBuffer, peaks, duration: decodedBuffer.duration });
        setGlobalOffset(0.1);
        setRawPoints([{ id: 'initial', beatIndex: 0, bpm: 120, sv: true, svRate: 1, lineType: 'both' }]);
        currentTimeRef.current = 0;
        playheadRef.current = 0;
        setCurrentTime(0);
        setViewState({ zoom: DEFAULT_ZOOM, scrollLeft: 0 });
        // ★ v0.8.16 修 Bug：原来这里只 setIsPlaying(false)，**没有真正停止音源** ——
        //   播放中导入新音频时，旧 AudioBufferSourceNode 会继续发声（两首歌声音重叠），
        //   而且下一次 play() 会用新 source 覆盖 sourceNodeRef.current，
        //   旧句柄永久丢失 → 之后按空格也停不掉它，只能等它自然播完。
        //   改成调用 stop()（内部会断开并置空旧 sourceNodeRef）才是彻底的停止。
        stopRef.current();
        console.info(`[import] ${file.name} 解码完成 ${decodedBuffer.duration.toFixed(1)}s，耗时 ${Math.round(performance.now() - t0)}ms`);
    } catch (err) {
        console.error('[import] 解码失败：', err);
        alert(t('decodeError'));
    } finally {
        importingRef.current = false;
        setImporting(false);
    }
  };

  // ===== 外部谱面导入（.osu / .osz，绝不读取游戏进程）=====
  const applyBeatmapEntry = useCallback(async (entry: { name: string; path: string; text: string }) => {
      const doc = parseOsuDocument(entry.text, entry.path, entry.name);
      if (!doc) { alert(t('invalidBeatmap')); return; }
      const { offset, points } = docToPoints(doc);
      setBeatmap(doc);
      setGlobalOffset(offset);
      setRawPoints(points as Omit<TimingPoint, 'time'>[]);
      // 以「从卡片重建一次」的结果作为基线：导入本身不触发写回
      lastWrittenRef.current = patchOsuDocument(doc, points as PatchPoint[]);
      const a = (window as any).electronAPI;
      const st = a?.statFile ? await a.statFile(entry.path) : null;
      expectedMtimeRef.current = st?.mtimeMs ?? 0;
      setWriteStatus({ kind: 'idle', msg: t('beatmapImported', { keys: doc.keyCount, lines: doc.timing.length }) });
      setPreviewOpen(true);
  }, []);

  const handleImportBeatmap = useCallback(async () => {
      const a = (window as any).electronAPI;
      if (!a?.openBeatmap) { alert(t('onlyElectron')); return; }
      const r = await a.openBeatmap();
      if (!r) return;
      if (r.error) { alert(r.error); return; }
      if (!r.entries?.length) { alert(t('invalidBeatmap')); return; }
      setBeatmapEntries(r.entries);
      setBeatmapAudioPath(r.audioPath || null);
      // 同目录/同包里的音频顺手载入，方便「跟随播放头」预览（音频同样来自外部文件）
      if (r.audioPath) await handleFileUpload(null, r.audioPath);
      await applyBeatmapEntry(r.entries[0]);
      if (r.fromOsz) setWriteStatus({ kind: 'idle', msg: t('oszWorkCopy') });
      if (!writeBackConfirmedOnce) {
          writeBackConfirmedOnce = true;
          const ok = window.confirm(t('writeBackConfirm'));
          setWriteConfirmed(ok);
          setWriteBack(ok);
      }
  }, [applyBeatmapEntry, handleFileUpload]);

  const handleSwitchDifficulty = useCallback(async (name: string) => {
      const entry = beatmapEntries.find(e => e.name === name);
      if (entry) await applyBeatmapEntry(entry);
  }, [beatmapEntries, applyBeatmapEntry]);

  /** 把当前 timing 另存成一份可直接拖进 osu! 的 .osu（.osz 的工作副本尤其需要这一步） */
  const handleSaveBeatmapAs = useCallback(async () => {
      if (!beatmap) return;
      const a = (window as any).electronAPI;
      const content = patchOsuDocument(beatmap, rawPoints as PatchPoint[]);
      const name = beatmap.displayName.replace(/\.osu$/i, '') + '-timing.osu';
      if (a?.saveFile) {
          const p = await a.saveFile({
              defaultPath: name,
              filters: [{ name: 'osu! Beatmap', extensions: ['osu'] }],
              content
          });
          if (p) setWriteStatus({ kind: 'ok', msg: t('savedAs', { path: p }) });
      } else {
          const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const el = document.createElement('a');
          el.href = url; el.download = name; el.click();
          URL.revokeObjectURL(url);
      }
  }, [beatmap, rawPoints]);

  const handleRestoreBackup = useCallback(async () => {
      const a = (window as any).electronAPI;
      if (!a?.listOsuBackups || !beatmap) return;
      const list = await a.listOsuBackups();
      if (!list?.length) { alert(t('noBackup')); return; }
      if (!window.confirm(t('restoreConfirm', { name: list[0].name }))) return;
      const r = await a.restoreOsuBackup({ backup: list[0].path, target: beatmap.sourcePath });
      if (r?.ok) {
          setWriteBack(false);
          setWriteStatus({ kind: 'paused', msg: t('restored') });
          const text = await a.readTextFile(beatmap.sourcePath);
          if (text) await applyBeatmapEntry({ name: beatmap.displayName, path: beatmap.sourcePath, text });
      } else alert(r?.error || '恢复失败');
  }, [beatmap, applyBeatmapEntry]);

  // ===== 实时写回：改 SV → 60ms 防抖 → 串行原子写；预览走内存，不等落盘 =====
  useEffect(() => {
      if (!beatmap || !writeBack || !writeConfirmed) return;
      const doc = beatmap;
      let content = '';
      try { content = patchOsuDocument(doc, rawPoints as PatchPoint[]); }
      catch (e) { setWriteStatus({ kind: 'error', msg: String(e) }); return; }
      if (content === lastWrittenRef.current) return;
      // 安全闸：除 [TimingPoints] 外有任何一行变了，直接拒绝落盘
      if (!verifyTimingOnlyChange(doc.text, content)) {
          setWriteStatus({ kind: 'error', msg: '安全校验失败：非 TimingPoints 段被改动，已阻止写回' });
          setWriteBack(false);
          return;
      }
      const timer = window.setTimeout(() => {
          writeQueueRef.current = writeQueueRef.current.then(async () => {
              const a = (window as any).electronAPI;
              if (!a?.writeOsuAtomic) return;
              const st = await a.statFile(doc.sourcePath);
              if (st && expectedMtimeRef.current && Math.abs(st.mtimeMs - expectedMtimeRef.current) > 5) {
                  setWriteStatus({ kind: 'error', msg: t('externalChange') });
                  setWriteBack(false); // 文件被外部改动 → 自动暂停，绝不覆盖别人的修改
                  return;
              }
              writingRef.current = true;
              const r = await a.writeOsuAtomic({ path: doc.sourcePath, content, backup: true });
              writingRef.current = false;
              if (r?.ok) {
                  expectedMtimeRef.current = r.mtimeMs || 0;
                  lastWrittenRef.current = content;
                  setWriteStatus({ kind: 'ok', msg: t('writeBackOk', { name: doc.displayName }) });
              } else {
                  setWriteStatus({ kind: 'error', msg: r?.error || '写回失败' });
              }
          }).catch(e => { writingRef.current = false; setWriteStatus({ kind: 'error', msg: String(e) }); });
      }, 60);
      return () => window.clearTimeout(timer);
  }, [rawPoints, globalOffset, beatmap, writeBack, writeConfirmed]);

  // 虚拟列表容器高度（ResizeObserver，不随播放头更新）
  useEffect(() => {
      const el = sidebarScrollRef.current;
      if (!el) return;
      const update = () => setListHeight(el.clientHeight);
      update();
      const ro = new ResizeObserver(update);
      ro.observe(el);
      return () => ro.disconnect();
  }, []);

  // 命令行 `--open-audio=<路径>`（把音频文件拖到 exe 图标上 / 资源管理器「打开方式」）→ 启动后自动载入
  // 用 ref 转发，避免把 handleFileUpload 写进依赖导致监听器反复重建
  const loadAudioRef = useRef(handleFileUpload);
  loadAudioRef.current = handleFileUpload;
  useEffect(() => {
    const api = (window as any).electronAPI;
    if (!api?.onAutoOpenAudio) return;
    const off = api.onAutoOpenAudio((p: string) => { void loadAudioRef.current(null, p); });
    return () => { off?.(); };
  }, []);

  const handleExportJson = () => {
      const config = {
          version: "1.0",
          offset: globalOffset,
          // timeSec = 红线绝对时间（秒）：带上它，重新导入后红线位置/独立关系（改 BPM 不挪动）100% 保留
          points: rawPoints.map(p => ({
              beatIndex: p.beatIndex, bpm: p.bpm, meter: p.meter ?? 4,
              sv: p.sv !== false, svRate: p.svRate && p.svRate > 0 ? p.svRate : 1,
              lineType: p.lineType ?? (p.sv === false ? 'red' : 'both'),
              timeSec: p.timeSec
          }))
      };
      const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `timing_config_${new Date().getTime()}.json`;
      a.click();
      URL.revokeObjectURL(url);
  };

  const handleImportJson = (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (event) => {
          try {
              const text = event.target?.result as string;
              // 统一解析：支持软件 json / osu! 谱面 / Malody .mc / Arcaea .aff / 通用 txt
              const cfg = parseTimingFile(text, file.name);
              if (cfg && cfg.points.length > 0) {
                  // 导入的是「另一份配置」→ 断开与当前 .osu 的写回关系，避免误覆盖谱面
                  setBeatmap(null);
                  setPreviewOpen(false);
                  setGlobalOffset(cfg.offset);
                  setRawPoints(cfg.points.map(p => ({
                      id: crypto.randomUUID(),
                      beatIndex: p.beatIndex,
                      bpm: p.bpm,
                      meter: typeof p.meter === 'number' && p.meter > 0 ? p.meter : 4, // ★ v0.8.17：读回拍号
                      sv: p.sv !== false,
                      svRate: p.svRate && p.svRate > 0 ? p.svRate : 1, // ★ 默认 SV = 1
                      lineType: p.lineType ?? (p.sv === false ? 'red' : 'both'),
                      timeSec: typeof p.timeSec === 'number' && isFinite(p.timeSec) ? p.timeSec : undefined, // 红线绝对时间
                  })));
              } else {
                  alert(t('invalidJson'));
              }
          } catch (err) {
              alert(t('parseJsonError'));
          }
      };
      reader.readAsText(file);
      e.target.value = ''; // Reset input
  };

  // ===== 导出文件名与使用说明头 =====
  // 音乐名（音频文件名去扩展名，用于导出文件名「游戏名-音乐名-timing.txt」）
  const songBase = (fileName ? fileName.replace(/\.[^.]+$/, '') : 'song').replace(/[\\/:*?"<>|]/g, '');

  // 各游戏导出文件顶部的替换说明（// 注释行，勿复制进谱面文件）
  const exportHowTo: Record<string, string[]> = {
    exportOsu: [
      '复制 [TimingPoints] 段（红线+绿线）替换 .osu 谱面中的对应段落；',
      '[TimingPoints] 位于 [HitObjects] 之前；绿线为变速 SV（保持原速）。',
    ],
    // ★ v0.8.15：原先还有一个「只导出 .mc（不含音频）」的选项，已按需求**删除** ——
    //   那条路最容易踩"音频名与谱面文件夹里对不上 → Malody 里音乐只有几秒钟"的坑，
    //   现在 Malody 只保留「谱面包（含音频）」一条出口。
    exportMalodyPack: [
      '产物是一个 .mcz 包（内含 .mc + 音频本体），直接拖进 Malody 即可导入；',
      '包内音频就是你导入本软件的那个文件，音质与原文件一致（压缩包里不重新编码）。',
    ],
    exportArcaea: [
      '复制 Timing: 段的 timing(...) 行替换 .aff 谱面对应段落；',
      'AudioOffset 保持原样即可；文件已包含 t=0 的必须 timing。',
    ],
    exportPhigros: [
      '用 PhiEditor（Re:PhiEdit）打开本文件或复制 BPMList 进现有谱面；',
      '在编辑器中检查 BPM 曲线后添加音符；meta.offset 单位为毫秒。',
    ],
    exportAdofai: [
      '复制 actions 数组（SetSpeed 事件）替换 .adofai 谱面对应字段；',
      '同时替换 settings.bpm 与 settings.offset；pathData 需换成实际路径。',
    ],
    exportVividstasis: [
      '将文件改名为 xxx.vschart.json（如 finale.vschart.json）放入歌曲目录；',
      'difficultyName 需与文件名对应（OPENING/FINALE 等，均大写）；',
      'timingPoints 与 events 已含变速（speed 保持原速），notes 用编辑器补。',
    ],
  };

  // 生成 txt 文件顶部的使用说明注释块
  const buildUsageHeader = (song: string, gameLabel: string, howto: string[]): string => [
    '// ================================================',
    `// ${song} - ${gameLabel} Timing 数据`,
    '// 使用说明 (How to use):',
    ...howto.map((ln, i) => `//   ${i + 1}. ${ln}`),
    '// 以上 // 注释行为提示，替换进谱面文件时请勿复制。',
    '// ================================================',
    '',
  ].join('\n');

  // 导出 osu! TimingPoints（移植自 generate_timing.py：红线 BPM + 绿线 SV）
  // 基准 BPM 自动取第一个变速段落的 BPM（无需单独设置）
  const handleExportOsu = async () => {
      if (rawPoints.length === 0) { alert(t('needAudio')); return; }
      const baseBpmForExport = rawPoints[0]?.bpm || 182;
      const content = buildUsageHeader(songBase, t('exportOsu'), exportHowTo.exportOsu)
          + generateOsuTimingPoints(globalOffset, rawPoints, baseBpmForExport);
      const defaultName = `osu-${songBase}-timing.txt`;
      const electronAPI = (window as any).electronAPI;
      if (electronAPI?.saveFile) {
          // Electron：原生保存对话框 + 主进程写文件
          const filePath = await electronAPI.saveFile({
              defaultPath: defaultName,
              filters: [{ name: 'Text Files', extensions: ['txt'] }],
              content
          });
          if (filePath) alert(t('exportedTo', { path: filePath }));
      } else {
          // 浏览器：Blob 下载
          const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = defaultName;
          a.click();
          URL.revokeObjectURL(url);
          alert(t('downloadStarted'));
      }
  };

  // ===== 其他音游导出（新增功能，尚未充分测试：点击先提醒再导出）=====
  // 每个条目：key=i18n菜单文案 / game=提醒用游戏名 / ext=保存过滤器 / name=默认文件名 / gen=生成函数
  // plain=true 表示产物本身是**要被软件解析的文件**（JSON 类：malody .mc / phigros / adofai / vividstasis），
  //   此时**绝不能**加 "// 使用说明" 注释头 —— 标准 JSON 不容忍注释，
  //   实测把带注释头的导出文件直接改名喂给 mcz转osz.exe 会直接失败（不产出 .osu）。
  //   说明改由导出后的弹窗给出（见 handleExportGame）。
  //   Arcaea 的 .aff 是文本格式、支持注释，故保留注释头。
  const exportGameList = [
    // Malody：只保留「谱面包（含音频）」。把「导入音频的真实文件名」与「曲名(去扩展名)」传进去 ——
    // 音频名会写进 meta.song.file 与末尾特殊音符的 sound；最后一项 audioData.duration
    // 供生成末尾占位音符用（撑起谱面长度，否则 Malody 里谱面只有 1.3 秒）。
    // ★ v0.8.15：原先还有个「只导出 .mc」的选项，已按需求删除（音频名对不上时 Malody 会静默退回 1 秒占位音源）。
    { key: 'exportMalodyPack', game: 'Malody 谱面包', ext: 'mcz', name: `malody-${songBase}.mcz`,            plain: true, gen: () => generateMalodyChart(globalOffset, rawPoints, songBase, '', 4, fileName || '', audioData?.duration || 0) },
    { key: 'exportArcaea',     game: 'Arcaea',       ext: 'txt', name: `arcaea-${songBase}-timing.txt`,      gen: () => generateArcaeaAff(globalOffset, rawPoints) },
    { key: 'exportPhigros',    game: 'Phigros',      ext: 'txt', name: `phigros-${songBase}-timing.txt`,     plain: true, gen: () => generatePhigrosChart(globalOffset, rawPoints) },
    { key: 'exportAdofai',     game: 'ADOFAI',       ext: 'txt', name: `adofai-${songBase}-timing.txt`,      plain: true, gen: () => generateAdofaiChart(globalOffset, rawPoints) },
    { key: 'exportVividstasis',game: 'vivid/stasis', ext: 'txt', name: `vividstasis-${songBase}-timing.txt`, plain: true, gen: () => generateVividStasisChart(globalOffset, rawPoints) },
  ];

  const handleExportGame = async (item: typeof exportGameList[number]) => {
      if (rawPoints.length === 0) { alert(t('needAudio')); return; }
      // 新功能提醒：尚未充分测试，确认后再导出
      if (!window.confirm(t('newExportConfirm', { game: item.game }))) return;
      // 顶部使用说明：仅对支持注释的格式（Arcaea）写入；
      // JSON 类产物必须是纯数据，否则对应软件/转换器无法解析
      const howtoLines = exportHowTo[item.key] || [];
      const content = (item.plain ? '' : buildUsageHeader(songBase, t(item.key), howtoLines)) + item.gen();
      const electronAPI = (window as any).electronAPI;
      // JSON 类：说明改在导出后的弹窗里补一句，避免"文件带了注释就不能用"
      const tipSuffix = item.plain && howtoLines.length
          ? '\n\n使用说明：\n' + howtoLines.map((ln, i) => `${i + 1}. ${ln}`).join('\n')
          : '';
      if (electronAPI?.saveFile) {
          // ★ Malody 谱面包（.mcz）：走专门的打包通道 —— .mc 与音频一起塞进 zip。
          //   必须这样做的原因：Malody 只会在"谱面文件夹里"按文件名找音频，
          //   而我们在 .mc 里写的音频名（通常来自 osu! 谱面的 audio.mp3）跟目标文件夹里的
          //   音频不同名 → 找不到音乐 → 编辑器里音乐只剩几秒。把音频一起打进包就没这个问题。
          if (item.key === 'exportMalodyPack') {
              if (!electronAPI.saveMalodyPackage) {
                  alert(t('malodyPackUnsupported'));
                  return;
              }
              if (!audioPath) {
                  alert(t('malodyPackNeedPath'));
                  return;
              }
              const r = await electronAPI.saveMalodyPackage({
                  packName: songBase || 'malody-timing',
                  mcContent: content,
                  audioPath,
                  audioName: fileName || 'audio.ogg'
              });
              if (r && r.ok) alert(t('malodyPackExported', { path: r.path }) + tipSuffix);
              else if (r && !r.canceled) alert(t('malodyPackFailed', { error: r.error || '' }));
              return;
          }
          // ★ v0.8.15：原先这里还有个「只导出 .mc」的专用通道（导出后询问是否把音频名对齐成
          //   目标文件夹里的实际文件名）—— 随该选项一起删除。现在 Malody 只有「谱面包」一条路，
          //   音频跟着一起打包，不再有"名字对不上"的可能。
          const filePath = await electronAPI.saveFile({
              defaultPath: item.name,
              filters: [{ name: 'Chart Files', extensions: [item.ext] }],
              content
          });
          if (filePath) alert(t('gameExportedTo', { file: t(item.key), path: filePath }) + tipSuffix);
      } else {
          const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = item.name;
          a.click();
          URL.revokeObjectURL(url);
          alert(t('gameDownloadStarted', { file: t(item.key) }) + tipSuffix);
      }
  };

  const stop = useCallback(() => {
    if (sourceNodeRef.current) { sourceNodeRef.current.stop(); sourceNodeRef.current = null; }
    setIsPlaying(false);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
  }, []);

  // ★ v0.8.16：把 stop 的实现写进 ref，供上方的 handleFileUpload 调用（避免 TDZ）
  stopRef.current = stop;

  /**
   * 从 t 秒起重新起一个 BufferSource（只换声源，不碰 isPlaying / 不重建播放循环）。
   * ★ v0.8.21 新增，修「播放中点白条 → 播放头与时间码整段冻死」：
   *   旧 handleSeek 用的是 stop() + play()。两者在同一个事件里被 React 批处理成
   *   isPlaying: false → true（最终值仍是 true），于是播放循环的 effect 不会重建，
   *   而 stop() 已经把当前 rAF 取消了 → 声音还在放，播放头/时间码却再也不动。
   */
  const startSourceAt = useCallback((t: number) => {
    if (!audioData) return;
    if (sourceNodeRef.current) { sourceNodeRef.current.stop(); sourceNodeRef.current = null; }
    const offset = Math.max(0, Math.min(audioData.duration, t));
    // 变速不变调：用 soundtouchjs PitchShifter（tempo = 倍速，音高不变）。
    // 播完自动触发 onEnd → 走和「newTime >= duration」相同的收尾（stop + 播放头归位）。
    const handle = createStretchPlayer(
      audioContext,
      audioData.buffer,
      playbackRateRef.current,
      masterGainRef.current || audioContext.destination,
      offset,
      () => { if (sourceNodeRef.current === handle) stop(); },
    );
    sourceNodeRef.current = handle;
    startTimeRef.current = audioContext.currentTime;
    startOffsetRef.current = offset;
    playheadRef.current = offset; // 播放头立即跳到新位置
    lastScheduledIndexRef.current = -Infinity; // 新位置：下一帧从当地拍子重新调度节拍器
  }, [audioData, audioContext, stop]);

  const play = useCallback(async () => {
    if (!audioData) return;
    if (audioContext.state === 'suspended') await audioContext.resume();
    startSourceAt(currentTimeRef.current);
    uiFrameRef.current = 0;
    setIsPlaying(true);
  }, [audioData, audioContext, startSourceAt]);

  const togglePlay = useCallback(() => isPlaying ? stop() : play(), [isPlaying, play, stop]);

  const playClick = useCallback((time: number, isDownbeat: boolean) => {
    if (!isFinite(time)) return;
    // 按节拍器音色渲染（频率/波形/包络均来自音色配置）
    const sound = getMetronomeSound(settings.metronomeSound);
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    osc.connect(gain);
    gain.connect(audioContext.destination);        // 扬声器：永远出声（打拍子用的）
    // 录制总线：默认 gain=0（不录），用户在预览工具条上打开「节拍器入录」才听得见
    if (clickRecGainRef.current) gain.connect(clickRecGainRef.current);
    osc.type = sound.type;
    osc.frequency.value = isDownbeat ? sound.freqMain : sound.freqAlt;
    const startTime = Math.max(audioContext.currentTime, time);
    const vol = (isDownbeat ? sound.vol : sound.vol * 0.55) * settings.metronomeVolume;
    gain.gain.setValueAtTime(vol, startTime);
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + sound.dur);
    osc.start(startTime); osc.stop(startTime + sound.dur + 0.02);
    osc.onended = () => { osc.disconnect(); gain.disconnect(); };
  }, [audioContext, settings.metronomeSound, settings.metronomeVolume]);

  useEffect(() => {
    if (!isPlaying) return;
    lastScheduledIndexRef.current = -Infinity; // effect 重建（延迟/倍速变化）时重置调度，下一帧从当前拍重新调度
    const rate = () => playbackRateRef.current;
    const loop = () => {
        const currentAudioTime = audioContext.currentTime;
        // 墙钟公式：内容时间 = 起始偏移 + 墙钟流逝 × 倍速（60fps 每帧平滑推进，与音频位置严格一致）
        const newTime = startOffsetRef.current + (currentAudioTime - startTimeRef.current) * rate();
        if (newTime >= (audioData?.duration || 0)) {
            currentTimeRef.current = audioData?.duration || 0;
            playheadRef.current = audioData?.duration || 0;
            setCurrentTime(audioData?.duration || 0); stop();
        }
        else {
            currentTimeRef.current = newTime;
            playheadRef.current = newTime; // 播放头独立层每帧实时读取（不经过 React）
            // ★ v0.8.21：白条滑出当前区域 → 视口**一帧直接跳到**下一区域（不做滚动动画，与侧栏切段一致）
            if (followRef.current) {
                const w = containerWidthRef.current;
                if (w > 0) {
                    const vs = viewStateRef.current;
                    const targetX = newTime * vs.zoom;
                    const x = targetX - vs.scrollLeft;
                    if (x > w * FOLLOW_TRIGGER_RATIO || x < 0) {
                        const maxScroll = Math.max(0, (audioData?.duration || 0) * vs.zoom - w);
                        const next = Math.max(0, Math.min(targetX - w * FOLLOW_LEAD_RATIO, maxScroll));
                        setViewState(v => (Math.abs(v.scrollLeft - next) < 0.5 ? v : { ...v, scrollLeft: next }));
                    }
                }
            }
            // 时间码 / 总览条等 UI 显示降频到 ~10fps：按「时间」而不是「帧数」计。
            // 按帧数计的话，120Hz 屏上同一个 6 帧阈值会变成 20 次/秒，
            // 等于白白让整棵组件树重渲染 20 次（低配机上这部分全是浪费）。
            uiFrameRef.current++;
            const nowMs = performance.now();
            if (nowMs - lastUiPublishRef.current >= 100) {
                lastUiPublishRef.current = nowMs;
                setCurrentTime(newTime);
            }
            if (isMetronomeOn) {
                // 红线节拍线延迟（秒）：节拍器声音与拍线/红线显示位置统一（正=随拍线后移，负=提前）
                const beatDelaySec = settings.beatLineDelayMs / 1000;
                // 前瞻需额外覆盖负延迟的提前量（拍线提前时声音要更早调度），基础 0.1s
                const lookahead = 0.1 + Math.max(0, -beatDelaySec) + 0.05;
                // 墙钟前瞻对应的内容时间 = 前瞻 × 倍速（音乐以倍速播放）
                const horizonTime = newTime + lookahead * rate();
                let nextBeatIndex = lastScheduledIndexRef.current + 1;
                const { point } = getPointAtTime(newTime, timingPoints);
                const currentBeatEstimate = point.beatIndex + (newTime - point.time) / (60 / point.bpm);
                if (nextBeatIndex < currentBeatEstimate - 1) nextBeatIndex = Math.floor(currentBeatEstimate);
                let iters = 0;
                while (iters < 120) { // 上限放宽：红线/蓝线位置接近时也不会漏掉该拍的节拍器声音
                   const beatTime = getTimeAtBeatIndex(nextBeatIndex, timingPoints);
                   // 拍线显示时间 = 原始拍时间 + 节拍线延迟（声音打在显示的拍线/红线上，与画面统一）
                   const beatDisplayTime = beatTime + beatDelaySec;
                   if (beatDisplayTime > horizonTime) break;
                   // 节拍声调度墙钟 = 起始墙钟 + (显示拍时间 - 起始内容时间) / 倍速（与音频位置严格同步）
                   const scheduleTime = startTimeRef.current + (beatDisplayTime - startOffsetRef.current) / rate();
                   if (scheduleTime >= currentAudioTime - 0.05) {
                       // 重拍音（红线）= 段起点：每条红线自带 BPM，重拍只落在红线上
                       // 红线之间距离很近时（<几毫秒）两次点击都会照常调度 → 声音不会被丢弃
                       const { point: beatPointObj } = getPointAtTime(beatTime, timingPoints);
                       const relBeat = nextBeatIndex - beatPointObj.beatIndex;
                       const isSectionStart = relBeat === 0;
                       playClick(scheduleTime, isSectionStart);
                   }
                   lastScheduledIndexRef.current = nextBeatIndex;
                   nextBeatIndex++; iters++;
                }
            }
            rafRef.current = requestAnimationFrame(loop);
        }
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [isPlaying, audioContext, audioData, stop, isMetronomeOn, timingPoints, playClick, settings.beatLineDelayMs]);

  /**
   * 把频谱视口翻到 t 秒处（目标不在视口内才翻，播放头落在左侧 10%，与自动跟随一致）。
   * 抽出来是因为「定位」和「录制起点」两处都要用，且都不该连带改播放状态。
   */
  const scrollViewToTime = useCallback((t: number) => {
    setViewState(v => {
        const maxScroll = Math.max(0, (audioData?.duration || 0) * v.zoom - containerWidth);
        const targetX = t * v.zoom;
        if (targetX < v.scrollLeft || targetX > v.scrollLeft + containerWidth) {
            return { ...v, scrollLeft: Math.max(0, Math.min(targetX - containerWidth * FOLLOW_LEAD_RATIO, maxScroll)) };
        }
        return v;
    });
  }, [audioData, containerWidth]);

  /**
   * 跳转到 t 秒。
   * ★ v0.8.21 修 bug：**播放中点击频谱 / 白条 / 总览条 → 停在该位置**（原来会"无缝续播"，
   *   而 stop()+play() 被批处理掉之后播放头反而冻死）。
   *   段间跳转（Alt+←→、侧栏卡片）传 keepPlaying，仍按"跳过去继续放"处理。
   */
  const handleSeek = useCallback((time: number, opts?: { keepPlaying?: boolean }) => {
    const t = Math.max(0, Math.min(audioData?.duration || 0, time));
    currentTimeRef.current = t;
    playheadRef.current = t;
    setCurrentTime(t);
    if (sourceNodeRef.current) {
      if (opts?.keepPlaying) startSourceAt(t); // 换声源，播放循环不重建（播放头继续跟手）
      else stop();                            // 停下，就停在点击的位置
    }
    scrollViewToTime(t);
  }, [audioData, scrollViewToTime, stop, startSourceAt]);

  // ============================================================================
  // 谱面预览：帧率设置 / 独立窗口 / 播放控制命令
  // ============================================================================
  /** 预览帧率（设置面板里配）：identity 稳定，避免预览每帧重渲染 */
  const previewFps = useMemo(
    () => ({ vsync: settings.previewVsync, limit: settings.previewFpsLimit }),
    [settings.previewVsync, settings.previewFpsLimit]
  );
  /** 录制参数（推给独立窗口：它自己读不到设置对象的实时值） */
  const previewRec = useMemo(
    () => ({ height: settings.recHeight, fps: settings.recFps, kbps: settings.recKbps }),
    [settings.recHeight, settings.recFps, settings.recKbps]
  );

  /** 预览里发来的播放控制（录制时"点一下就从当前进度自动开播"走这条） */
  const previewCommand = useCallback((cmd: PreviewCommand) => {
    if (cmd.type === 'play') void play();
    else if (cmd.type === 'pause') stop();
    else if (cmd.type === 'seek') handleSeek(cmd.t);
    else if (cmd.type === 'recordFrom') {
      /* ★ 录制起点：改位置 + 保证在播，一步到位。
       *
       *   绝对不能在同一个事件里 seek 再 play：handleSeek 会 stop()，而 stop() 取消了
       *   播放循环的 rAF；随后 play() 又把 isPlaying 设回 true —— 两次 setState 被 React
       *   折叠成"一直是 true"，播放循环的 effect 不重建 → 声音在放、播放头冻死。
       *   （这就是「播放中按录制，小窗画面卡住不动」的成因。）
       *
       *   这里直接分两种情形处理，全程不碰 isPlaying：
       *     - 正在播放：位置变了就换声源续播，循环继续跑
       *     - 暂停中：play() 会从 currentTimeRef（刚写好的 t）起播
       */
      const dur = audioData?.duration || 0;
      const t = Math.max(0, Math.min(dur, cmd.t));
      const moved = Math.abs(t - playheadRef.current) > 0.0005;
      currentTimeRef.current = t;
      playheadRef.current = t;
      setCurrentTime(t);
      if (moved) scrollViewToTime(t);
      if (isPlayingRef.current) {
        if (moved) startSourceAt(t); // 原地开始录制时不动声音（重起会有一声断音）
      } else {
        void play();
      }
    }
  }, [play, stop, handleSeek, audioData, scrollViewToTime, startSourceAt]);

  /**
   * 预览开始/结束录制 → 临时关掉频谱的「跟随播放头」。
   * 录制期间视口跟着播放头一路翻页，既晃眼又白吃性能（翻页那一帧本来就重），
   * 而录的是小窗画面，停不停根本不进视频。录完恢复用户原来的选择。
   */
  const followBeforeRecRef = useRef(true);
  const handlePreviewRecording = useCallback((on: boolean) => {
    if (on) {
      followBeforeRecRef.current = followRef.current;
      if (followRef.current) setFollowPlayhead(false);
    } else if (followBeforeRecRef.current) {
      setFollowPlayhead(true);
    }
  }, []);

  /** 预览工具条上切换「节拍器入录」（独立窗口里改的也会经通道传回来写进设置） */
  const handleRecordMetronomeChange = useCallback((v: boolean) => {
    setSettingsState(prev => {
      if (prev.recordMetronome === v) return prev;
      const next = { ...prev, recordMetronome: v };
      saveSettings(next);
      return next;
    });
  }, []);

  /** 把预览弹成独立窗口（真正的 OS 窗口，能拖到软件窗口外面） */
  const openDetachedPreview = useCallback(async () => {
    const api = (window as any).electronAPI;
    if (!api?.openPreviewWindow) return;
    let saved: { x?: number; y?: number; w?: number; h?: number } | undefined;
    try {
      const b = JSON.parse(localStorage.getItem('bpm.preview.detach.win.v1') || 'null');
      if (b && Number.isFinite(b.w) && Number.isFinite(b.h)) saved = b;
    } catch { /* 没存过就用默认位置 */ }
    const r = await api.openPreviewWindow(saved);
    if (r?.ok) setPreviewDetached(true);
    else if (r?.error) console.warn('[preview] 独立窗口打开失败:', r.error);
  }, []);

  const closeDetachedPreview = useCallback(() => {
    (window as any).electronAPI?.closePreviewWindow?.();
    setPreviewDetached(false);
  }, []);

  // 谱面被换掉/关掉预览 → 独立窗口不能留在那儿空转
  useEffect(() => {
    if (previewDetached && (!beatmap || !previewOpen)) closeDetachedPreview();
  }, [previewDetached, beatmap, previewOpen, closeDetachedPreview]);

  // 独立窗口被用户直接关掉（标题栏 ×/Alt+F4）→ 恢复内嵌小窗
  useEffect(() => {
    const api = (window as any).electronAPI;
    const off = api?.onPreviewWindowClosed?.(() => setPreviewDetached(false));
    return () => { if (typeof off === 'function') off(); };
  }, []);

  /**
   * 主窗口 ⇄ 独立窗口 数据桥（BroadcastChannel）。
   * - init：谱面 + timing 卡片 + 帧率（换谱面/改设置时重发；独立窗口打开后也会主动要一次）
   * - tick：播放头，60Hz 推一次（暂停时只推变化，避免空转）
   * - cmd：独立窗口里点录制 → 让主窗口从当前进度开播
   */
  useEffect(() => {
    if (!previewDetached || !beatmap) return;
    let ch: BroadcastChannel;
    try { ch = new BroadcastChannel(PREVIEW_CHANNEL); } catch { return; }
    const sendInit = () => ch.postMessage({
      type: 'init', doc: beatmap, points: rawPoints as PatchPoint[], fps: previewFps,
      rec: previewRec, recMetronome: settings.recordMetronome,
      playing: isPlayingRef.current,
      audioMs: audioData ? Math.round(audioData.duration * 1000) : undefined,
      t: playheadRef.current,
    });
    ch.onmessage = (ev: MessageEvent) => {
      const m = ev.data;
      if (!m) return;
      if (m.type === 'ready') sendInit();
      else if (m.type === 'cmd' && m.cmd) previewCommand(m.cmd);
      else if (m.type === 'recording') handlePreviewRecording(!!m.on);
      else if (m.type === 'setting' && typeof m.recMetronome === 'boolean') handleRecordMetronomeChange(m.recMetronome);
    };
    sendInit();
    // 播放头按主窗口的帧节奏推给独立窗口（原来用 setInterval 16ms，天然把独立窗口顶死在 ~62fps）。
    // 现在跟 rAF 走、最短 7ms 一次：120Hz 屏上基本每帧都有新值，配合预览端的播放头平滑，
    // 独立窗口也能跑满刷新率。消息体只有一个数字，跨进程开销可以忽略。
    let lastT = -1;
    let lastPost = 0;
    let tickRaf = 0;
    let lastPlaying = isPlayingRef.current;
    const tickLoop = () => {
      const now = performance.now();
      // 播放/暂停一变就单独通知一次：独立窗口靠它让显示时钟"精确停住"
      // （只靠"播放头不动"判断永远差一个量化台阶 ≈11ms，暂停瞬间会看到画面继续落一下再跳回）
      if (isPlayingRef.current !== lastPlaying) {
        lastPlaying = isPlayingRef.current;
        ch.postMessage({ type: 'state', playing: lastPlaying });
      }
      if (now - lastPost >= 7) {
        const t = playheadRef.current;
        if (Math.abs(t - lastT) >= 0.0005) {
          lastT = t;
          lastPost = now;
          ch.postMessage({ type: 'tick', t });
        }
      }
      tickRaf = requestAnimationFrame(tickLoop);
    };
    tickRaf = requestAnimationFrame(tickLoop);
    return () => { if (tickRaf) cancelAnimationFrame(tickRaf); ch.close(); };
  }, [previewDetached, beatmap, rawPoints, previewFps, previewRec, previewCommand,
      settings.recordMetronome, handlePreviewRecording, handleRecordMetronomeChange, audioData]);

  /**
   * ★ v0.8.20：用户主动移动视口（拖拽平移 / 滚轮滚动）时关闭自动跟随。
   *   否则播放中想把视口拖到别处看一下，下一帧就被跟随逻辑拽回播放头。
   *   需要恢复跟随点底部按钮即可。
   */
  const handleUserScroll = useCallback((sl: number) => {
      setFollowPlayhead(false);
      setViewState(v => (v.scrollLeft === sl ? v : { ...v, scrollLeft: sl }));
  }, []);

  // 调整播放倍速（0.25x - 2.0x）：soundtouchjs tempo 实时变速（不变调），不打断播放
  const handleRateChange = useCallback((rate: number) => {
      const clamped = Math.max(0.25, Math.min(2.0, rate));
      if (Math.abs(clamped - playbackRateRef.current) < 0.001) return; // 无变化直接返回
      playbackRateRef.current = clamped;
      setPlaybackRate(clamped);
      if (sourceNodeRef.current) {
          // BUG 修复：倍数变了必须用「当前内容时间」重新锚定墙钟起点。
          // 否则 RAF 里 newTime = startOffset + 已流逝墙钟 × 新倍速 会把之前那段按新倍速重算 → 播放头瞬移。
          const now = audioContext.currentTime;
          startOffsetRef.current = currentTimeRef.current;
          startTimeRef.current = now;
          sourceNodeRef.current.setRate(clamped); // 实时生效（tempo：变速不变调）
          lastScheduledIndexRef.current = -Infinity; // 重置节拍调度，下一帧从当前拍重新调度
      }
  }, [audioContext]);

  // ===== 常用快捷键（不做界面标注，帮助面板里只列了 Space / 缩放 / 段落切换）=====
  //  Ctrl+Z 撤销 / Ctrl+Shift+Z · Ctrl+Y 重做 / Space 播放暂停 /
  //  ← → 快退快进 1s（Shift 5s）/ + - 缩放 / Ctrl+O 打开音频 / Ctrl+S 导出 JSON
  //  ★ v0.8.16 新增：Alt+← → 上/下一段 / Alt+滚轮 精细调 px/s（滚轮相关见 Visualizer 容器 onWheel）
  const zoomBy = useCallback((factor: number) => {
      setViewState(s => ({ ...s, zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, s.zoom * factor)) }));
  }, []);

  /**
   * ★ v0.8.19：底部缩放数值支持「直接键入」。
   *   applyZoomValue 把绝对 px/s 写进视图，并以**视口中心**为锚点重算 scrollLeft
   *   （输入 400 时，屏幕正中那段时间点保持不动，不会跳到别处）。
   */
  const applyZoomValue = useCallback((v: number) => {
      if (!isFinite(v) || v <= 0) { setZoomText(String(Math.round(viewState.zoom))); return; }
      const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, v));
      setViewState(s => {
          const maxScroll = Math.max(0, (audioData?.duration || 0) * zoom - containerWidth);
          const centerTime = containerWidth > 0 ? (s.scrollLeft + containerWidth / 2) / s.zoom : 0;
          const scrollLeft = Math.max(0, Math.min(centerTime * zoom - containerWidth / 2, maxScroll));
          return { zoom, scrollLeft };
      });
      setZoomText(String(Math.round(zoom)));
  }, [audioData, containerWidth, viewState.zoom]);

  /**
   * ★ v0.8.16：Alt+← / Alt+→ —— 切到上一段 / 下一段（与侧栏 Alt+←→ 行为对齐）。
   *   基准段 = **播放头当前所在的段**（不是"上次点过的段"），这样播放中按也符合直觉；
   *   切过去做三件事：播放头移到该段起点 + 视图把它滚到居中 + 右侧面板卡片滚过去高亮。
   *   到头就停（clamp），不循环。
   */
  const stepSection = useCallback((dir: -1 | 1) => {
      if (!timingPoints.length) return;
      const t = currentTimeRef.current;
      // 找播放头落在哪一段（timingPoints 按时间升序，最后一个 time<=t 的就是当前段）
      let idx = 0;
      for (let i = 0; i < timingPoints.length; i++) {
          if (timingPoints[i].time <= t) idx = i; else break;
      }
      const next = Math.max(0, Math.min(timingPoints.length - 1, idx + dir));
      const target = timingPoints[next];
      if (!target) return;
      handleSeek(target.time, { keepPlaying: true }); // 段间导航：播放中切段继续放，不打断试听
      // 视图居中（与 handleSeek 里"超出视区才居中"不同：这里是**明确要求**跳段，所以无条件居中）
      setViewState(v => {
          const maxScroll = Math.max(0, (audioData?.duration || 0) * v.zoom - containerWidth);
          return { ...v, scrollLeft: Math.max(0, Math.min(target.time * v.zoom - containerWidth / 2, maxScroll)) };
      });
      handleSectionClick(target.id); // 右侧面板滚到对应卡片并闪一下高亮
  }, [timingPoints, handleSeek, audioData, containerWidth, handleSectionClick]);

  useEffect(() => {
      /** 焦点在输入类元素里时不拦截（保留浏览器/输入框自身的快捷键行为） */
      const isTyping = (el: EventTarget | null): boolean => {
          const n = el as HTMLElement | null;
          if (!n || !n.tagName) return false;
          const tag = n.tagName.toUpperCase();
          return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || n.isContentEditable === true;
      };
      const handleKeyDown = (e: KeyboardEvent) => {
          const ctrl = e.ctrlKey || e.metaKey;
          const key = e.key.toLowerCase();
          const typing = isTyping(e.target);

          // 撤销 / 重做（输入框内交给浏览器自带撤销）
          if (ctrl && !e.shiftKey && key === 'z') {
              if (typing) return;
              e.preventDefault(); undo(); return;
          }
          if (ctrl && (key === 'y' || (e.shiftKey && key === 'z'))) {
              if (typing) return;
              e.preventDefault(); redo(); return;
          }
          if (typing) return; // 其余快捷键在输入框内不生效

          if (e.code === 'Space') { e.preventDefault(); togglePlay(); return; }
          if (ctrl && key === 'o') { e.preventDefault(); handleFileUpload(null); return; }
          if (ctrl && key === 's') { e.preventDefault(); handleExportJson(); return; }
          // ★ v0.8.16：Alt+← / Alt+→ 切上/下一段（必须排在普通 ←→ 之前，
          //   否则会被"快退快进 1s"先吃掉 —— 两者 e.code 相同，只差 altKey）
          if (e.altKey && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) {
              e.preventDefault();
              stepSection(e.code === 'ArrowLeft' ? -1 : 1);
              return;
          }
          if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
              const step = e.shiftKey ? 5 : 1;
              e.preventDefault();
              handleSeek(currentTimeRef.current + (e.code === 'ArrowLeft' ? -step : step));
              return;
          }
          if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomBy(1.2); return; }
          if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomBy(1 / 1.2); return; }
      };
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
  }, [togglePlay, undo, redo, handleFileUpload, handleExportJson, handleSeek, zoomBy, stepSection]);

  /**
   * ★ v0.9.0：虚拟滚动。带 SV 的谱面实测有 2982 条 timing 行，
   *   若全部渲染就是 ~3 万个 DOM 节点，播放时每秒 10 次重渲染必然卡死。
   *   固定行高 + 只渲染视口 ±3 张 → 任何谱面都只有 ~15 张卡片在 DOM 里。
   */
  const orderedPoints = useMemo(() => [...timingPoints].reverse(), [timingPoints]);
  orderedIdsRef.current = orderedPoints.map(p => p.id);
  const visibleStart = Math.max(0, Math.floor(listScrollTop / ROW_H) - 3);
  const visibleEnd = Math.min(orderedPoints.length, Math.ceil((listScrollTop + listHeight) / ROW_H) + 3);
  const timingRows = useMemo(() => orderedPoints.slice(visibleStart, visibleEnd).map((point, i) => {
      const revIdx = visibleStart + i;
      return (
          <div key={point.id} style={{ position: 'absolute', top: revIdx * ROW_H, left: 0, right: 0, height: ROW_H }}>
              <TimingRow
                  point={point}
                  index={timingPoints.length - 1 - revIdx}
                  totalCount={timingPoints.length}
                  onUpdate={handleUpdatePoint}
                  onRemove={handleRemovePoint}
                  onUpdateTime={handleUpdatePointTime}
                  onJumpToTime={handleJumpToTimeline}
                  flash={flashSectionId === point.id}
                  height={ROW_H - 16}
              />
          </div>
      );
  }), [orderedPoints, visibleStart, visibleEnd, timingPoints.length, handleUpdatePoint, handleRemovePoint, handleUpdatePointTime, handleJumpToTimeline, flashSectionId]);

  return (
    <div className="relative flex h-screen w-screen text-[var(--t1)] font-sans overflow-hidden" style={{
      '--accent': settings.accent,
      '--accent2': settings.accent2,
      '--bg': settings.bgColor,
      '--panel': settings.panelBg,
      background: settings.bgColor,
      // 对比度自适应：按背景亮度切换文本/边框/卡片色系（暗背景浅字，亮背景深字）
      ...(hexLuminance(settings.bgColor) > 0.45 ? {
        '--t1': '#1f2937', '--t2': '#374151', '--t3': '#6b7280', '--t4': '#9ca3af',
        '--line': 'rgba(0,0,0,0.08)', '--line2': 'rgba(0,0,0,0.15)',
        '--chip': 'rgba(0,0,0,0.04)', '--chip2': 'rgba(0,0,0,0.07)',
      } : {
        '--t1': '#e5e7eb', '--t2': '#d1d5db', '--t3': '#9ca3af', '--t4': '#6b7280',
        '--line': 'rgba(255,255,255,0.05)', '--line2': 'rgba(255,255,255,0.10)',
        '--chip': 'rgba(255,255,255,0.03)', '--chip2': 'rgba(255,255,255,0.06)',
      }),
    } as React.CSSProperties}>
      <div className="flex-1 flex flex-col min-w-0 h-full relative z-10">
        <header className="h-16 bg-[var(--panel)] border-b border-[var(--line)] flex items-center justify-between px-6 z-30 shrink-0 shadow-2xl">
            <div className="flex items-center gap-2 min-w-0 overflow-x-auto">
                {/* 左上角：导入音频（原「♪ BPM 测速助手」标题已按需求删除，导入按钮上移到这个位置） */}
                <label
                    className={`shrink-0 whitespace-nowrap flex items-center gap-2 px-4 py-2 bg-[var(--accent)] rounded-lg transition text-sm font-black uppercase tracking-widest shadow-lg ${importing ? 'opacity-70 cursor-wait' : 'cursor-pointer active:scale-95'}`}
                    title={importing ? t('decoding') : t('importAudio')}
                >
                    {importing
                        ? <span className="inline-block w-[18px] h-[18px] rounded-full border-2 border-white/30 border-t-white animate-spin" />
                        : <Upload size={18} />}
                    <span>{importing ? t('decoding') : t('importAudio')}</span>
                    <input type="file" accept="audio/*" onChange={handleFileUpload} className="hidden" disabled={importing} />
                </label>
                {/* 紧邻导入音频：启动制谱侧栏（原来在设置面板里，按需求移到顶栏黄圈位置） */}
                <button
                    onClick={launchSidebar}
                    disabled={mhState === 'launching'}
                    title={mhMsg || '启动 osu! 制谱侧栏（启动后本软件会自动收起；在侧栏点「返回测速」即可回到软件并关闭侧栏）'}
                    className="shrink-0 whitespace-nowrap flex items-center gap-2 px-3 py-2 bg-[var(--chip2)] hover:bg-[var(--chip)] border border-[var(--accent)]/40 text-[var(--accent)] rounded-lg cursor-pointer transition text-xs font-black uppercase tracking-wider shadow-lg active:scale-95 disabled:opacity-50"
                >
                    <PanelRightOpen size={18} />
                    <span>{mhState === 'launching' ? t('launching') : t('mapHelper')}</span>
                </button>
                {/* v0.9.0：外部谱面导入 + 实时变速预览 */}
                <button onClick={handleImportBeatmap}
                    title={t('importBeatmapHint')}
                    className="shrink-0 whitespace-nowrap flex items-center gap-1.5 px-2 py-1.5 bg-[var(--chip2)] hover:bg-[var(--chip)] border border-[var(--accent)]/40 text-[var(--accent)] rounded-lg cursor-pointer transition text-[11px] font-black uppercase tracking-wider active:scale-95">
                    <FolderOpen size={16} /> <span>{t('importBeatmap')}</span>
                </button>
                <button onClick={() => beatmap ? setPreviewOpen(true) : handleImportBeatmap()}
                    title={t('openPreview')}
                    className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg cursor-pointer transition text-[11px] font-black uppercase tracking-wider border active:scale-95 shrink-0 whitespace-nowrap ${beatmap ? 'bg-green-500/15 border-green-500/40 text-green-400 hover:bg-green-500/25' : 'bg-[var(--chip2)] border-[var(--line2)] text-[var(--t4)]'}`}>
                    <Eye size={16} /> <span>{t('openPreview')}</span>
                </button>
                {/* 独立预览窗口：真正的 OS 窗口，能拖到软件窗口外面（内嵌小窗拖不出去） */}
                <button
                    onClick={() => { if (!beatmap) return handleImportBeatmap(); setPreviewOpen(true); void openDetachedPreview(); }}
                    title="把谱面预览弹成独立窗口（可拖到软件窗口外面，和 osu! 并排放）"
                    className={`flex items-center justify-center p-2 rounded-lg cursor-pointer transition border active:scale-95 shrink-0 ${beatmap ? 'bg-[var(--chip2)] hover:bg-[var(--chip)] border-[var(--accent)]/40 text-[var(--accent)]' : 'bg-[var(--chip2)] border-[var(--line2)] text-[var(--t3)]'}`}>
                    <PictureInPicture2 size={16} />
                </button>
                {fileName && <span className="shrink-0 text-xs text-[var(--t4)] truncate max-w-[200px] font-mono bg-[var(--chip2)] px-3 py-1 rounded-full border border-[var(--line2)]">{fileName}</span>}
                {mhState === 'error' && <span className="text-xs text-red-400 max-w-[220px] truncate">{mhMsg}</span>}
            </div>
            <div className="flex items-center gap-4">
                {/* 音乐音量 + 节拍器音量滑条（设置按钮右侧空位） */}
                <div className="flex items-center gap-2.5 bg-[var(--chip2)] px-3 py-1.5 rounded-xl border border-[var(--line)]" title={t('musicVolume')}>
                    <Music size={14} className="text-[var(--accent)] shrink-0" />
                    <input
                        type="range" min="0" max="1" step="0.05"
                        value={settings.musicVolume}
                        onChange={(e) => updateSettings({ ...settings, musicVolume: parseFloat(e.target.value) })}
                        className="w-20 accent-[var(--accent)] cursor-pointer"
                    />
                    <span className="text-[10px] font-mono text-[var(--t3)] w-8 text-right shrink-0">{Math.round(settings.musicVolume * 100)}%</span>
                </div>
                <div className="flex items-center gap-2.5 bg-[var(--chip2)] px-3 py-1.5 rounded-xl border border-[var(--line)]" title={t('metronomeVolume')}>
                    <Volume2 size={14} className="text-[var(--accent2)] shrink-0" />
                    <input
                        type="range" min="0" max="1" step="0.05"
                        value={settings.metronomeVolume}
                        onChange={(e) => updateSettings({ ...settings, metronomeVolume: parseFloat(e.target.value) })}
                        className="w-20 accent-[var(--accent2)] cursor-pointer"
                    />
                    <span className="text-[10px] font-mono text-[var(--t3)] w-8 text-right shrink-0">{Math.round(settings.metronomeVolume * 100)}%</span>
                </div>
                <button 
                  onClick={() => setShowSettings(true)}
                  className={`p-2 rounded-lg transition-all ${showSettings ? 'bg-[var(--accent)] text-white' : 'text-[var(--t3)] hover:text-white hover:bg-[var(--chip2)]'}`}
                  title={t('settings')}
                >
                    <Settings size={24} />
                </button>
                <button 
                  onClick={() => setShowHelp(!showHelp)}
                  className={`p-2 rounded-lg transition-all ${showHelp ? 'bg-[var(--accent)] text-white' : 'text-[var(--t3)] hover:text-white hover:bg-[var(--chip2)]'}`}
                  title={t('help')}
                >
                    <HelpCircle size={24} />
                </button>
                <span className="text-2xl font-mono font-black text-[var(--accent)] bg-black/40 px-4 py-1 rounded-lg border border-[var(--accent)]/20">{currentTime.toFixed(3)}s</span>
                <button onClick={() => setIsSidebarOpen(!isSidebarOpen)} className="text-[var(--t3)] hover:text-white transition p-2 hover:bg-[var(--chip2)] rounded-lg">
                    {isSidebarOpen ? <PanelRightClose size={24} /> : <PanelRightOpen size={24} />}
                </button>
            </div>
        </header>

        <main className="flex-1 relative overflow-hidden bg-black">
            {audioData ? (
                <div ref={containerRef} className="absolute inset-0 w-full h-full" 
                     onWheel={(e) => {
                        const rect = containerRef.current?.getBoundingClientRect();
                        if (!rect) return;
                        const mouseX = e.clientX - rect.left;
                        if (e.altKey) {
                            // ★ v0.8.16：Alt+滚轮 = **精细**调整频谱的 px/s（缩放）。
                            //   与 Shift+滚轮（粗调，每格 ×1.1 / ×0.9）分开：精细档每格只动 3%，
                            //   用来在"看清某一拍"和"看全整段"之间微调，不会一下跳太远。
                            //   同样以鼠标位置为锚点，光标下那个时间点保持不动。
                            const zoomFactor = e.deltaY < 0 ? 1.03 : 1 / 1.03;
                            setViewState(prev => {
                                const timeAtMouse = (mouseX + prev.scrollLeft) / prev.zoom;
                                const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, prev.zoom * zoomFactor));
                                const newScrollLeft = timeAtMouse * newZoom - mouseX;
                                const maxScroll = Math.max(0, audioData.duration * newZoom - containerWidth);
                                return { zoom: newZoom, scrollLeft: Math.max(0, Math.min(newScrollLeft, maxScroll)) };
                            });
                        } else if (e.shiftKey) {
                            // Shift+滚轮 = 粗缩放（每格 ×1.1 / ×0.9），同样以鼠标位置为锚点
                            const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
                            setViewState(prev => {
                                const timeAtMouse = (mouseX + prev.scrollLeft) / prev.zoom;
                                const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, prev.zoom * zoomFactor));
                                const newScrollLeft = timeAtMouse * newZoom - mouseX;
                                const maxScroll = Math.max(0, audioData.duration * newZoom - containerWidth);
                                return { zoom: newZoom, scrollLeft: Math.max(0, Math.min(newScrollLeft, maxScroll)) };
                            });
                        } else {
                            // 普通滚轮：横向/纵向滚动（手动滚动视口 → 自动跟随暂时关闭）
                            if (followRef.current) setFollowPlayhead(false);
                            setViewState(p => {
                                const maxScroll = Math.max(0, audioData.duration * p.zoom - containerWidth);
                                return {...p, scrollLeft: Math.max(0, Math.min(p.scrollLeft + e.deltaY + e.deltaX, maxScroll))};
                            });
                        }
                     }}>
                    {containerWidth > 0 && containerHeight > 0 && (
                        <Visualizer 
                            audioData={audioData} currentTime={currentTime} viewState={viewState}
                            timingPoints={timingPoints} onUpdateBpm={(idx, bpm) => handleUpdatePoint(timingPoints.find(p => p.beatIndex === idx)?.id || '', 'bpm', bpm)}
                            onUpdateOffset={handleOffsetChange} onSeek={handleSeek}
                            onUpdateSectionTime={handleUpdatePointTime}
                            onScrollChange={handleUserScroll}
                            onSectionClick={handleSectionClick}
                            width={containerWidth} height={containerHeight}
                            specLogBase={specLogBase}
                            getPlayheadTime={() => playheadRef.current}
                            waveColor={settings.waveColor}
                            specPalette={settings.specPalette}
                            specCustom={settings.specCustom}
                            peakThreshold={settings.peakThreshold}
                            peakColor={settings.peakColor}
                            specInvert={settings.specInvert}
                            renderDpr={renderDpr}
                            specFFTSize={settings.specFFTSize}
                            specSensitivity={settings.specSensitivity}
                            beatLineDelaySec={settings.beatLineDelayMs / 1000}
                        />
                    )}
                </div>
            ) : (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-[var(--t4)] p-12 text-center">
                    <Music size={80} className="mb-6 opacity-20 animate-pulse" />
                    <h3 className="text-xl font-black text-[var(--t3)] uppercase tracking-widest mb-4">{t('getStarted')}</h3>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-4xl opacity-50">
                        <div className="bg-[var(--chip2)] p-6 rounded-2xl border border-[var(--line)]">
                            <Upload className="mx-auto mb-3 text-[var(--accent)]" />
                            <p className="text-sm font-bold mb-2">{t('step1Title')}</p>
                            <p className="text-xs">{t('step1Desc')}</p>
                        </div>
                        <div className="bg-[var(--chip2)] p-6 rounded-2xl border border-[var(--line)]">
                            <MousePointer2 className="mx-auto mb-3 text-red-400" />
                            <p className="text-sm font-bold mb-2">{t('step2Title')}</p>
                            <p className="text-xs">{t('step2Desc')}</p>
                        </div>
                        <div className="bg-[var(--chip2)] p-6 rounded-2xl border border-[var(--line)]">
                            <Sliders className="mx-auto mb-3 text-[var(--accent2)]" />
                            <p className="text-sm font-bold mb-2">{t('step3Title')}</p>
                            <p className="text-xs">{t('step3Desc')}</p>
                        </div>
                    </div>
                </div>
            )}
            
            {/* Help Overlay Modal */}
            {showHelp && (
                <div className="absolute inset-0 z-50 flex items-center justify-center p-8 bg-black/80 backdrop-blur-md">
                    <div className="bg-[var(--panel)] border border-[var(--line2)] w-full max-w-2xl rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-full">
                        <div className="p-6 border-b border-[var(--line)] bg-[var(--chip)] flex justify-between items-center">
                            <div className="flex items-center gap-3 text-[var(--accent)] font-black">
                                <HelpCircle size={24} />
                                <span className="uppercase tracking-[0.2em]">{t('guideTitle')}</span>
                            </div>
                            <button onClick={() => setShowHelp(false)} className="text-[var(--t4)] hover:text-white transition">{t('close')}</button>
                        </div>
                        <div className="flex-1 overflow-y-auto p-8 space-y-8">
                            <section className="space-y-4">
                                <h4 className="flex items-center gap-2 text-[var(--accent)] font-bold"><MousePointer2 size={18}/> {t('interactions')}</h4>
                                <ul className="space-y-3 text-sm text-[var(--t3)]">
                                    <li className="flex items-start gap-2"><span className="text-[var(--accent)] font-bold">•</span> <span><b className="text-[var(--t1)]">{t('zoomTip')}</b></span></li>
                                    <li className="flex items-start gap-2"><span className="text-[var(--accent)] font-bold">•</span> <span><b className="text-[var(--t1)]">{t('panTip')}</b></span></li>
                                    <li className="flex items-start gap-2"><span className="text-[var(--accent)] font-bold">•</span> <span><b className="text-[var(--t1)]">{t('seekTip')}</b></span></li>
                                    <li className="flex items-start gap-2"><span className="text-[var(--accent)] font-bold">•</span> <span><b className="text-[var(--t1)]">{t('adjustTip')}</b></span></li>
                                </ul>
                            </section>

                            <section className="space-y-4">
                                <h4 className="flex items-center gap-2 text-[var(--accent)] font-bold"><Keyboard size={18}/> {t('shortcuts')}</h4>
                                <div className="grid grid-cols-2 gap-4">
                                    <div className="flex justify-between items-center bg-[var(--chip2)] p-3 rounded-xl border border-[var(--line)]">
                                        <span className="text-xs text-[var(--t4)] uppercase font-black">{t('playPause')}</span>
                                        <kbd className="bg-gray-800 px-3 py-1 rounded text-white font-mono text-sm">Space</kbd>
                                    </div>
                                    <div className="flex justify-between items-center bg-[var(--chip2)] p-3 rounded-xl border border-[var(--line)]">
                                        <span className="text-xs text-[var(--t4)] uppercase font-black">{t('zoomHelp')}</span>
                                        <kbd className="bg-gray-800 px-3 py-1 rounded text-white font-mono text-sm">Shift + Scroll</kbd>
                                    </div>
                                    {/* ★ v0.8.16：新增两个快捷键 —— Alt+滚轮 精细调 px/s、Alt+←→ 上/下一段 */}
                                    <div className="flex justify-between items-center bg-[var(--chip2)] p-3 rounded-xl border border-[var(--line)]">
                                        <span className="text-xs text-[var(--t4)] uppercase font-black">{t('zoomFine')}</span>
                                        <kbd className="bg-gray-800 px-3 py-1 rounded text-white font-mono text-sm">Alt + Scroll</kbd>
                                    </div>
                                    <div className="flex justify-between items-center bg-[var(--chip2)] p-3 rounded-xl border border-[var(--line)]">
                                        <span className="text-xs text-[var(--t4)] uppercase font-black">{t('stepSection')}</span>
                                        <kbd className="bg-gray-800 px-3 py-1 rounded text-white font-mono text-sm">Alt + &larr; / &rarr;</kbd>
                                    </div>
                                </div>
                            </section>

                            <section className="space-y-4">
                                <h4 className="flex items-center gap-2 text-[var(--accent)] font-bold"><Info size={18}/> {t('workflow')}</h4>
                                <ol className="space-y-3 text-sm text-[var(--t3)] list-decimal list-inside">
                                    <li>{t('wf1')}</li>
                                    <li>{t('wf2')}</li>
                                    <li>{t('wf3')}</li>
                                    <li>{t('wf4')}</li>
                                    <li>{t('wf5')}</li>
                                </ol>
                            </section>
                        </div>
                    </div>
                </div>
            )}
        </main>

        <footer className="h-28 bg-[var(--bg)] border-t border-[var(--line)] flex flex-col z-30 shrink-0 shadow-inner">
            {/* 顶部：整曲总览条（歌曲进度条，AU 风格：迷你波形 + 视口范围 + 当前位置） */}
            <div className="w-full px-6 pt-2 shrink-0">
                <div className="flex items-center gap-4">
                    <OverviewBar 
                        peaks={audioData?.peaks || new Float32Array(0)}
                        duration={audioData?.duration || 0}
                        currentTime={currentTime}
                        viewStart={viewState.scrollLeft / viewState.zoom}
                        viewEnd={(viewState.scrollLeft + containerWidth) / viewState.zoom}
                        onSeek={handleSeek} 
                    />
                    <span className="text-xs text-[var(--t3)] font-mono shrink-0 tabular-nums">
                        {formatTime(currentTime)} / {formatTime(audioData?.duration || 0)}
                    </span>
                </div>
            </div>
            {/* 底部：控制按钮行 */}
            <div className="flex-1 flex justify-center items-center gap-6 min-h-0">
            {/* 当前 BPM（当前播放位置所在段落） */}
            <div className="flex items-center gap-2.5 bg-[var(--chip2)] px-4 py-2 rounded-xl border border-[var(--line)] shrink-0" title={t('currentBpmHint')}>
                <span className="text-[10px] text-[var(--t3)] uppercase font-black tracking-widest">{t('currentBpm')}</span>
                <span className="text-lg font-mono font-black text-[var(--accent2)] tabular-nums leading-none">{currentBpm.toFixed(2)}</span>
            </div>
            <button onClick={stop} className="text-red-500/70 hover:text-red-500 transition-all hover:scale-110 active:scale-90" title={t('stop')}><Square size={28} fill="currentColor"/></button>
            <button onClick={togglePlay} className="p-5 rounded-full bg-[var(--accent)] hover:bg-[var(--accent)] text-white shadow-[0_0_20px_rgba(79,70,229,0.4)] active:scale-90 transition-all">
                {isPlaying ? <Pause size={32} fill="currentColor"/> : <Play size={32} fill="currentColor" className="ml-1"/>}
            </button>
            <button onClick={() => setIsMetronomeOn(p => !p)} className={`transition-all hover:scale-110 active:scale-90 ${isMetronomeOn ? 'text-green-400 drop-shadow-[0_0_8px_rgba(74,222,128,0.4)]' : 'text-[var(--t4)]'}`} title={t('metronome')}>
                {isMetronomeOn ? <Volume2 size={32}/> : <VolumeX size={32}/>}
            </button>
            {/* 变速控件：滑块 + 点击数值复位 1.0x */}
            <div className="flex items-center gap-3 bg-[var(--chip2)] px-4 py-1.5 rounded-2xl border border-[var(--line)]" title={t('rateTitle')}>
                <Gauge size={18} className="text-[var(--accent2)] shrink-0" />
                <input 
                    type="range" min="0.25" max="2" step="0.05"
                    value={playbackRate}
                    onChange={(e) => handleRateChange(parseFloat(e.target.value))}
                    className="w-24 accent-[var(--accent2)] cursor-pointer"
                />
                <button 
                    onClick={() => handleRateChange(1.0)}
                    className="text-xs font-mono font-black text-[var(--accent2)] w-12 text-center hover:text-white transition-colors"
                    title={t('rateReset')}
                >
                    {playbackRate.toFixed(2)}x
                </button>
            </div>
            <div className="flex items-center gap-3 bg-[var(--chip2)] px-4 py-1.5 rounded-2xl border border-[var(--line)]">
                <button onClick={() => zoomBy(0.8)} className="text-[var(--t4)] hover:text-white transition-colors" title={t('zoomOut')}><ZoomOut size={22}/></button>
                {/* 缩放倍率：可直接键入 px/s，回车/失焦生效，↑↓ 以 1.2 倍步进，Esc 撤销 */}
                <div className="flex items-baseline gap-0.5" title={`${t('zoomScale')}：${MIN_ZOOM}~${MAX_ZOOM} px/s（可直接输入，回车生效，↑↓ 微调）`}>
                    <input
                        value={zoomText}
                        inputMode="decimal"
                        onChange={(e) => setZoomText(e.target.value.replace(/[^\d.]/g, ''))}
                        onFocus={(e) => { zoomFocusRef.current = true; e.currentTarget.select(); }}
                        onBlur={() => { zoomFocusRef.current = false; applyZoomValue(parseFloat(zoomText)); }}
                        onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === 'Enter') { e.preventDefault(); applyZoomValue(parseFloat(zoomText)); e.currentTarget.blur(); }
                            else if (e.key === 'Escape') { e.preventDefault(); setZoomText(String(Math.round(viewState.zoom))); e.currentTarget.blur(); }
                            else if (e.key === 'ArrowUp') { e.preventDefault(); applyZoomValue((parseFloat(zoomText) || viewState.zoom) * 1.2); }
                            else if (e.key === 'ArrowDown') { e.preventDefault(); applyZoomValue((parseFloat(zoomText) || viewState.zoom) / 1.2); }
                        }}
                        className="w-14 text-center bg-transparent border-b border-transparent hover:border-[var(--line2)] focus:border-[var(--accent)] outline-none text-sm font-mono font-bold text-[var(--t1)] tabular-nums cursor-text"
                    />
                    <span className="text-[10px] text-[var(--t4)] font-mono select-none">px/s</span>
                </div>
                <button onClick={() => zoomBy(1.2)} className="text-[var(--t4)] hover:text-white transition-colors" title={t('zoomIn')}><ZoomIn size={22}/></button>
            </div>
            {/* ★ v0.8.20 视口自动跟随播放头：白条滑出当前区域后自动跳到下一区域；手动拖动视口会自动关闭 */}
            <button
                onClick={() => setFollowPlayhead(f => !f)}
                className={`p-2.5 rounded-xl border transition-all hover:scale-105 active:scale-95 ${
                    followPlayhead
                        ? 'bg-[var(--accent)]/15 border-[var(--accent)]/50 text-[var(--accent2)] shadow-[0_0_12px_rgba(79,70,229,0.25)]'
                        : 'bg-[var(--chip2)] border-[var(--line)] text-[var(--t4)] hover:text-white'
                }`}
                title={`${t('followPlayhead')}${followPlayhead ? ' · ON' : ' · OFF'} — ${t('followPlayheadHint')}`}
            >
                <LocateFixed size={20} />
            </button>
            </div>
        </footer>
      </div>

      <div className={`relative bg-[var(--panel)] border-l border-[var(--line2)] flex flex-col shadow-[-10px_0_30px_rgba(0,0,0,0.5)] z-40 transition-all duration-300 shrink-0 ${isSidebarOpen ? 'w-[320px]' : 'w-0 translate-x-full'}`}>
        <div className="p-6 border-b border-[var(--line)] bg-black/40 flex items-center justify-between">
            <div className="flex items-center gap-3">
                <Settings size={20} className="text-[var(--accent)]" /> 
                <h2 className="text-sm font-black text-[var(--t1)] uppercase tracking-[0.2em]">{t('configPanel')}</h2>
            </div>
            <div className="flex items-center gap-2">
                <label className="p-2 text-[var(--t3)] hover:text-[var(--accent)] hover:bg-[var(--accent)]/10 rounded-lg cursor-pointer transition-all" title={t('importJson')}>
                    <FileUp size={18} />
                    <input type="file" accept=".json,.txt,.osu,.mc,.aff,.adofai,.vschart.json" onChange={handleImportJson} className="hidden" />
                </label>
                <button onClick={handleExportJson} className="p-2 text-[var(--t3)] hover:text-[var(--accent)] hover:bg-[var(--accent)]/10 rounded-lg transition-all" title={t('exportJson')}>
                    <Download size={18} />
                </button>
            </div>
        </div>
        
        <div className="p-6 border-b border-[var(--line)] bg-[var(--chip)] space-y-4">
             <div>
                <label className="text-[10px] text-[var(--t3)] block mb-2 uppercase font-black tracking-widest flex items-center gap-2">
                    {t('globalOffset')}
                    <div className="group relative">
                        <Info size={12} className="text-[var(--t4)]" />
                        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-48 p-2 bg-gray-800 text-white text-[10px] rounded opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity border border-[var(--line2)] shadow-xl z-50">{t('offsetHint')}</div>
                    </div>
                </label>
                <OffsetInput value={globalOffset} onChange={handleOffsetChange} />
             </div>

             {/* 导出：主按钮 JSON + 二级下拉（含 osu! TimingPoints） */}
             <div className="pt-4 border-t border-[var(--line)] relative">
                <label className="text-[10px] text-[var(--t3)] block mb-2 uppercase font-black tracking-widest flex items-center gap-2">
                    {t('exportJson')}
                    <div className="group relative">
                        <Info size={12} className="text-[var(--t4)]" />
                        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-56 p-2 bg-gray-800 text-white text-[10px] rounded opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity border border-[var(--line2)] shadow-xl z-50">{t('svHint')}</div>
                    </div>
                </label>
                <div className="flex">
                    {/* 主按钮：导出 JSON 配置 */}
                    <button 
                        onClick={handleExportJson}
                        disabled={!audioData}
                        className={`flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-l-xl text-sm font-black uppercase tracking-widest transition-all ${
                            audioData 
                                ? 'bg-[var(--accent2)] hover:bg-[var(--accent2)] text-white shadow-lg active:scale-95' 
                                : 'bg-[var(--chip2)] text-[var(--t4)] cursor-not-allowed'
                        }`}
                        title={t('exportJson')}
                    >
                        <Download size={16} />
                        {t('exportJson')}
                    </button>
                    {/* 二级菜单开关 */}
                    <button
                        onClick={() => setShowExportMenu(m => !m)}
                        disabled={!audioData}
                        className={`px-3 rounded-r-xl border-l border-black/20 transition-all ${
                            audioData ? 'bg-[var(--accent2)] hover:bg-[var(--accent2)] text-white' : 'bg-[var(--chip2)] text-[var(--t4)] cursor-not-allowed'
                        }`}
                        title={t('exportOsu')}
                    >
                        <ChevronDown size={16} className={`transition-transform ${showExportMenu ? 'rotate-180' : ''}`} />
                    </button>
                </div>
                {/* 二级下拉菜单 */}
                {showExportMenu && (
                    <div className="absolute left-0 right-0 mt-1.5 rounded-xl bg-[var(--panel)] border border-[var(--line2)] shadow-2xl z-50 overflow-hidden max-h-80 overflow-y-auto">
                        <button
                            onClick={() => { setShowExportMenu(false); handleExportJson(); }}
                            className="w-full flex items-center gap-2 px-4 py-2.5 text-xs font-bold text-[var(--t2)] hover:bg-[var(--chip2)] transition-colors"
                        >
                            <Download size={14} /> {t('exportJson')}
                        </button>
                        <button
                            onClick={() => { setShowExportMenu(false); handleExportOsu(); }}
                            className="w-full flex items-center gap-2 px-4 py-2.5 text-xs font-bold text-[var(--accent)] hover:bg-[var(--chip2)] transition-colors border-t border-[var(--line)]"
                        >
                            <Gauge size={14} /> {t('exportOsu')}
                        </button>
                        {/* 其他音游（新功能，尚未充分测试） */}
                        <div className="px-4 pt-2.5 pb-1.5 text-[9px] uppercase font-black tracking-widest text-[var(--t4)] border-t border-[var(--line)]">
                            {t('exportNewSection')}
                        </div>
                        {exportGameList.map(item => (
                            <button
                                key={item.key}
                                onClick={() => { setShowExportMenu(false); handleExportGame(item); }}
                                className="w-full flex items-center gap-2 px-4 py-2 text-xs font-bold text-[var(--t2)] hover:bg-[var(--chip2)] transition-colors"
                            >
                                <Music size={14} className="text-[var(--t4)]" />
                                <span className="flex-1 text-left">{t(item.key)}</span>
                                <span className="text-[8px] font-black px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 uppercase tracking-wider">New</span>
                            </button>
                        ))}
                    </div>
                )}
             </div>
             
             <div>
                <div className="flex justify-between items-center mb-2">
                    <label className="text-[10px] text-[var(--t3)] block uppercase font-black tracking-widest">{t('specLogBase')}</label>
                    <span className="text-xs font-mono text-[var(--accent)] font-bold">{specLogBase.toFixed(0)}</span>
                </div>
                <div className="flex items-center gap-3">
                    <Sliders size={16} className="text-[var(--t4)]" />
                    <input 
                        type="range" min="1" max="200" step="1"
                        value={specLogBase}
                        onChange={(e) => setSpecLogBase(parseInt(e.target.value))}
                        className="flex-1 h-1.5 bg-[var(--line2)] rounded-lg appearance-none cursor-pointer accent-[var(--accent)]"
                    />
                </div>
             </div>
        </div>

        {/* v0.9.0 外部谱面状态条：来源 / 难度 / 实时写回开关 / 备份恢复 */}
        {beatmap && (
            <div className="px-5 py-3 border-b border-[var(--line)] bg-green-500/[0.04] shrink-0 space-y-2">
                <div className="flex items-center gap-2">
                    <Save size={14} className="text-green-400 shrink-0" />
                    <span className="text-[10px] font-black uppercase tracking-widest text-green-400 shrink-0">{t('beatmapSource')}</span>
                    <span className="text-[10px] font-mono text-[var(--t3)] truncate flex-1" title={beatmap.sourcePath}>
                        {beatmap.displayName} · {beatmap.keyCount}K · {beatmap.timing.length} lines
                    </span>
                </div>
                {beatmapEntries.length > 1 && (
                    <select value={beatmap.displayName} onChange={e => handleSwitchDifficulty(e.target.value)}
                        className="w-full bg-[var(--bg)] border border-[var(--line2)] rounded-md px-2 py-1 text-[11px] text-[var(--t1)]">
                        {beatmapEntries.map(e => <option key={e.name} value={e.name}>{e.name}</option>)}
                    </select>
                )}
                <div className="flex items-center gap-2">
                    <label className="flex items-center gap-1.5 text-[10px] text-[var(--t2)] cursor-pointer shrink-0">
                        <input type="checkbox" checked={writeBack} onChange={e => {
                            if (e.target.checked && !writeConfirmed) {
                                const ok = window.confirm(t('writeBackConfirm'));
                                setWriteConfirmed(ok); setWriteBack(ok);
                            } else setWriteBack(e.target.checked);
                        }} />
                        {t('writeBack')}
                    </label>
                    <button onClick={handleSaveBeatmapAs} title={t('saveBeatmapAs')}
                        className="flex items-center gap-1 px-1.5 py-1 rounded bg-[var(--chip2)] hover:bg-[var(--chip)] text-[10px] text-[var(--t3)]">
                        <Save size={11} /> {t('saveBeatmapAs')}
                    </button>
                    <button onClick={handleRestoreBackup} title={t('restoreBackup')}
                        className="flex items-center gap-1 px-1.5 py-1 rounded bg-[var(--chip2)] hover:bg-[var(--chip)] text-[10px] text-[var(--t3)]">
                        <RotateCcw size={11} /> {t('restoreBackup')}
                    </button>
                </div>
                <div className={`text-[10px] leading-tight flex items-start gap-1 ${writeStatus.kind === 'error' ? 'text-red-400' : writeStatus.kind === 'ok' ? 'text-green-400' : 'text-[var(--t4)]'}`}>
                    {writeStatus.kind === 'error' && <AlertTriangle size={11} className="shrink-0 mt-0.5" />}
                    <span className="truncate">{writeStatus.msg || t('previewOnlyExternal')}</span>
                </div>
            </div>
        )}

        <div ref={sidebarScrollRef}
             onScroll={(e) => {
                 const top = (e.target as HTMLElement).scrollTop;
                 setShowTopBtn(top > 120);
                 setListScrollTop(top);
             }}
             className="flex-1 overflow-y-auto px-6 pt-5 pb-6 custom-scrollbar bg-black/20">
            <div className="flex items-center justify-between mb-3">
                <span className="text-xs text-[var(--t3)] font-black uppercase tracking-widest">{t('sections')}</span>
                <div className="flex items-center gap-1.5">
                    {/* 段落跳转输入框：输入序号跳转对应段落卡片 */}
                    <div className="flex items-center gap-1 bg-[var(--chip2)] border border-[var(--line2)] rounded-lg px-1.5 py-1" title={t('jumpSectionHint')}>
                        <input
                            type="number" min={1} max={timingPoints.length}
                            value={jumpIdx}
                            onChange={(e) => setJumpIdx(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && jumpToSection()}
                            placeholder="1"
                            className="w-9 bg-transparent text-center text-xs font-mono text-[var(--t1)] focus:outline-none appearance-none"
                        />
                        <button onClick={jumpToSection} className="text-[var(--accent)] hover:text-white transition" title={t('jumpSection')}>
                            <LocateFixed size={14} />
                        </button>
                    </div>
                    <button onClick={handleAddPoint} className="px-3 py-1.5 bg-[var(--accent)]/20 hover:bg-[var(--accent)]/30 text-[var(--accent)] rounded-lg transition-all flex items-center gap-2 text-xs font-black uppercase tracking-widest border border-[var(--accent)]/30">
                        <Plus size={14} /> {t('addSection')}
                    </button>
                </div>
            </div>
            
            {timingPoints.length === 1 && (
                <div className="mb-4 p-4 bg-[var(--accent)]/5 rounded-xl border border-[var(--accent)]/10 text-[11px] text-[var(--accent)]/60 leading-relaxed italic">
                    {t('wfTip')}
                </div>
            )}

            <div style={{ position: 'relative', height: orderedPoints.length * ROW_H }}>
                {timingRows}
            </div>
        </div>

        {/* 回到顶部悬浮球（变速段落区滚动时显示） */}
        {showTopBtn && (
            <button
                onClick={() => sidebarScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
                className="absolute bottom-5 right-5 w-11 h-11 rounded-full bg-[var(--accent)] hover:bg-[var(--accent)] text-white shadow-[0_4px_16px_rgba(0,0,0,0.5)] flex items-center justify-center transition-all active:scale-90 z-20"
                title={t('backToTop')}
            >
                <ArrowUp size={20} />
            </button>
        )}
      </div>

      {/* 设置面板（自定义配色 / 主题 / 背景底图 / 一键复原 / 语言） */}
      {showSettings && (
        <SettingsModal
          settings={settings}
          onChange={updateSettings}
          onReset={handleResetSettings}
          onClose={() => setShowSettings(false)}
        />
      )}

      {/* 谱面预览：竖屏可调小窗，浮在频谱层之上；无遮罩/虚化，播放头跟随主进度条。
          弹出独立窗口后这里不再重复渲染（独立窗口会接管，关掉后自动回到内嵌小窗）。 */}
      {previewOpen && beatmap && !previewDetached && (
        <BeatmapPreview
          doc={beatmap}
          points={rawPoints as PatchPoint[]}
          getPlayheadTime={getPreviewPlayheadTime}
          onClose={closePreview}
          fps={previewFps}
          onCommand={previewCommand}
          onDetach={openDetachedPreview}
          recHeight={settings.recHeight}
          recFps={settings.recFps}
          recKbps={settings.recKbps}
          getAudioStream={getRecordAudioStream}
          playing={isPlaying}
          audioMs={audioData ? Math.round(audioData.duration * 1000) : undefined}
          recordMetronome={settings.recordMetronome}
          onRecordMetronomeChange={handleRecordMetronomeChange}
          onRecordingChange={handlePreviewRecording}
        />
      )}
    </div>
  );
}

export default App;