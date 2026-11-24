import React, { useState, useEffect, useRef, useCallback, useLayoutEffect, useMemo } from 'react';
import { 
    Play, Pause, Square, ZoomIn, ZoomOut, Upload, Music, 
    Volume2, VolumeX, Plus, Trash2, Settings, 
    PanelRightClose, PanelRightOpen, Sliders, 
    Download, FileUp, Info, MousePointer2, Keyboard, HelpCircle, Gauge, ChevronDown, LocateFixed, Check, X, ArrowUp,
    Copy, FolderOpen, Clock, ChevronRight
} from 'lucide-react';
import Visualizer from './components/Visualizer';
import OverviewBar from './components/OverviewBar';
import SettingsModal from './components/SettingsModal';
import { AudioData, ViewState, TimingPoint } from './types';
import { extractPeaks } from './utils/audioUtils';
import { recalculateTiming, getPointAtTime, getTimeAtBeatIndex } from './utils/timingUtils';
import { parseTimingFile, type ParsedTimingConfig } from './utils/timingParser';
import { handleFileUpload } from './utils/fileUtils';
import { generateOsuTimingPoints } from './utils/osuExport';
import { generateAdofaiChart, generateMalodyChart, generatePhigrosChart, generateArcaeaAff, generateVividStasisChart } from './utils/gameExports';
import { AppSettings, loadSettings, saveSettings, clearSettings, DEFAULT_SETTINGS, hexLuminance, getMetronomeSound } from './utils/settings';
import { t, setLang } from './utils/i18n';

const MIN_ZOOM = 10;
const MAX_ZOOM = 1500;
const DEFAULT_ZOOM = 250;
// ★ v0.8.19 视口自动跟随：播放头越过视口右侧 90% → 视口**直接跳到**下一页，播放头落回左侧 10%
//   与侧栏点击段落一致：瞬跳，不做滚动动画（早前版本的「分帧滚动过去」已移除）。
const FOLLOW_TRIGGER_RATIO = 0.9;
const FOLLOW_LEAD_RATIO = 0.1;

interface TimingRowProps {
    point: TimingPoint;
    index: number;
    totalCount: number;
    onUpdate: (id: string, field: 'bpm' | 'beatIndex' | 'sv' | 'svRate' | 'meter', value: number | boolean) => void;
    onRemove: (id: string) => void;
    onUpdateTime: (id: string, time: number) => void; // 修改该红线的时间戳（秒）
    onJumpToTime?: (sec: number) => void; // 双击卡片 → 时间轴跳转到该红线位置
    flash?: boolean; // 从频谱点击小节线跳转时的高亮闪烁
}

const TimingRow: React.FC<TimingRowProps> = ({ point, index, totalCount, onUpdate, onRemove, onUpdateTime, onJumpToTime, flash = false }) => {
    const [bpmStr, setBpmStr] = useState(point.bpm.toFixed(2));
    const [beatStr, setBeatStr] = useState(point.beatIndex.toString());
    const [timeStr, setTimeStr] = useState(point.time.toFixed(3));
    const [meterStr, setMeterStr] = useState(String(point.meter ?? 4));

    useEffect(() => {
        if (Math.abs(parseFloat(bpmStr) - point.bpm) > 0.001) {
             setBpmStr(point.bpm.toFixed(2));
        }
    }, [point.bpm]);

    useEffect(() => {
        if (Math.abs(parseFloat(beatStr) - point.beatIndex) > 0.001) {
            setBeatStr(point.beatIndex.toString());
        }
    }, [point.beatIndex]);

    useEffect(() => {
        if (Math.abs(parseFloat(timeStr) - point.time) > 0.0005) {
            setTimeStr(point.time.toFixed(3));
        }
    }, [point.time]);

    // 拍号（meter）变化时同步输入框（默认 4）
    useEffect(() => {
        const m = point.meter ?? 4;
        if (parseInt(meterStr, 10) !== m) {
            setMeterStr(String(m));
        }
    }, [point.meter]);

    // 时间戳提交：直接改这条红线的时间（起点锚点 = 全局 Offset）
    const handleBlurTime = () => {
        const val = parseFloat(timeStr);
        if (!isNaN(val) && val >= 0) {
            const rounded = Math.round(val * 1000) / 1000;
            onUpdateTime(point.id, rounded);
            setTimeStr(rounded.toFixed(3));
        } else {
            setTimeStr(point.time.toFixed(3));
        }
    };

    const handleBlurBpm = () => {
        const val = parseFloat(bpmStr);
        if (!isNaN(val) && val > 0) {
            const rounded = Math.round(val * 100) / 100;
            onUpdate(point.id, 'bpm', rounded);
            setBpmStr(rounded.toFixed(2));
        } else {
            setBpmStr(point.bpm.toFixed(2));
        }
    };

    const handleBlurBeat = () => {
        const val = parseFloat(beatStr);
        if (!isNaN(val) && val >= 0) {
             onUpdate(point.id, 'beatIndex', val);
             setBeatStr(val.toString());
        } else {
             setBeatStr(point.beatIndex.toString());
        }
    };

    // 拍号提交：整数、至少 1（osu! 的 meter 语义 = 每小节几拍）
    const handleBlurMeter = () => {
        const val = parseInt(meterStr, 10);
        if (!isNaN(val) && val >= 1) {
            onUpdate(point.id, 'meter', val);
            setMeterStr(String(val));
        } else {
            setMeterStr(String(point.meter ?? 4));
        }
    };

    const isStartAnchor = point.beatIndex === 0;

    return (
        <div id={`section-row-${point.id}`}
             onDoubleClick={() => onJumpToTime?.(point.time)}
             title={t('jumpSection')}
             className={`bg-[var(--chip2)] rounded-xl p-5 border-l-4 ${isStartAnchor ? 'border-red-500' : 'border-[var(--accent)]'} group transition-all duration-200 shadow-lg ${flash ? 'ring-2 ring-amber-400 shadow-[0_0_20px_rgba(251,191,36,0.5)]' : ''}`}>
            <div className="flex justify-between items-center mb-3">
                <span className="text-xs font-black text-[var(--t3)] tracking-widest uppercase">
                    {isStartAnchor ? t('startAnchor') : t('sectionN', { n: index })}
                </span>
                <div className="flex items-center gap-2">
                    {!isStartAnchor && (
                        <button
                            onClick={() => onUpdate(point.id, 'sv', !(point.sv !== false))}
                            className={`w-6 h-6 rounded-md border flex items-center justify-center transition-all shrink-0 ${point.sv !== false ? 'bg-green-500/20 border-green-500/50 text-green-400 hover:bg-green-500/30' : 'bg-[var(--chip2)] border-[var(--line2)] text-[var(--t4)] hover:border-[var(--t4)]'}`}
                            title={point.sv !== false ? t('svToggleOnHint') : t('svToggleOffHint')}
                        >
                            {point.sv !== false ? <Check size={14} strokeWidth={3} /> : <X size={14} strokeWidth={3} />}
                        </button>
                    )}
                    {!isStartAnchor && (
                        <input
                            type="number" step="0.05" min="0" max="10"
                            disabled={point.sv === false}
                            placeholder={t('svRatePlaceholder')}
                            value={point.svRate && point.svRate > 0 ? point.svRate : ''}
                            onChange={(e) => onUpdate(point.id, 'svRate', e.target.value === '' ? 0 : parseFloat(e.target.value))}
                            className="w-16 bg-[var(--bg)] border border-[var(--line2)] rounded-md px-2 py-1 text-xs font-mono text-center focus:outline-none focus:border-[var(--accent)] disabled:opacity-30"
                            title={t('svRateHint')}
                        />
                    )}
                    {!isStartAnchor && (
                        <button onClick={() => onRemove(point.id)} className="text-[var(--t4)] hover:text-red-400 opacity-0 group-hover:opacity-100 transition p-1.5">
                            <Trash2 size={16} />
                        </button>
                    )}
                </div>
            </div>
            
            <div className="grid grid-cols-2 gap-3">
                <div>
                    <label className="text-[10px] text-[var(--t4)] block mb-1 uppercase font-bold">{t('beatIndexLabel')}</label>
                    <input 
                        type="number" 
                        disabled={isStartAnchor}
                        value={beatStr}
                        onChange={(e) => setBeatStr(e.target.value)}
                        onBlur={handleBlurBeat}
                        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                        className={`w-full bg-[var(--bg)] border border-[var(--line2)] rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-[var(--accent)] ${isStartAnchor ? 'text-[var(--t4)]' : 'text-[var(--t1)]'}`}
                    />
                </div>
                <div>
                    <label className="text-[10px] text-[var(--t4)] block mb-1 uppercase font-bold">{t('bpmLabel')}</label>
                    <input 
                        type="number" 
                        step="0.01"
                        value={bpmStr}
                        onChange={(e) => setBpmStr(e.target.value)}
                        onBlur={handleBlurBpm}
                        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                        className="w-full bg-[var(--bg)] border border-[var(--line2)] rounded-lg px-3 py-2 text-sm text-[var(--accent2)] font-mono focus:outline-none focus:border-[var(--accent2)]"
                    />
                </div>
            </div>

            {/* ★ v0.8.17：拍号（meter）—— 可读可改，参考 osu! 制谱器的拍号设置。
                meter 语义 = 每小节几拍（分母固定为四分音符），如 4=4/4、3=3/4、7=7/4 */}
            <div className="mt-3">
                <label className="text-[10px] text-[var(--t4)] block mb-1 uppercase font-bold">{t('meterLabel')}</label>
                <div className="flex items-center gap-1.5">
                    <input
                        type="number"
                        step="1" min="1" max="7"
                        value={meterStr}
                        onChange={(e) => setMeterStr(e.target.value)}
                        onBlur={handleBlurMeter}
                        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                        title={t('meterHint')}
                        className="w-full bg-[var(--bg)] border border-[var(--line2)] rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-[var(--accent)]"
                    />
                    <span className="text-[var(--t4)] font-mono text-sm shrink-0">/4</span>
                </div>
            </div>
            
            <div className="mt-3 pt-3 border-t border-[var(--line)] flex justify-between items-center text-xs text-[var(--t4)] font-mono gap-2">
                <span className="font-bold shrink-0">{t('startTimeLabel')}</span>
                <div className="flex items-center gap-1.5">
                    {/* 时间戳可直接编辑（秒）：起点锚点 = 全局 Offset，其余段按上一段 BPM 换算拍号 */}
                    <input
                        type="number" step="0.001" min="0"
                        value={timeStr}
                        onChange={(e) => setTimeStr(e.target.value)}
                        onBlur={handleBlurTime}
                        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                        className="w-24 bg-[var(--bg)] border border-[var(--line2)] rounded-md px-2 py-1 text-xs font-mono text-right text-[var(--accent)] focus:outline-none focus:border-[var(--accent)]"
                        title={t('timeEditHint')}
                    />
                    <span className="text-[var(--t4)]">s</span>
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

// ===== 谱面导入（.osz / .osu / 谱面文件夹）：候选难度 =====
interface MapCandidate {
    name: string;    // 文件名
    path: string;    // 磁盘路径
    text: string;    // .osu 原文（只为解析 timing 用）
    title: string;   // 曲名
    artist: string;
    version: string; // 难度名
}

/** 从 .osu 文本里取展示用元信息 */
const parseOsuMeta = (text: string): { title: string; artist: string; version: string } => {
    const get = (k: string): string => {
        const m = text.match(new RegExp(`^\\s*${k}\\s*:\\s*(.*)$`, 'im'));
        return m ? m[1].trim() : '';
    };
    return { title: get('Title'), artist: get('Artist'), version: get('Version') };
};

function App() {
  const [audioContext] = useState(() => new (window.AudioContext || (window as any).webkitAudioContext)());
  const [audioData, setAudioData] = useState<AudioData | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  // 音频的**绝对路径**（Electron 下由原生对话框给出）。
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

  // ===== 谱面导入（.osz / .osu / 谱面文件夹）=====
  const [mapCandidates, setMapCandidates] = useState<MapCandidate[]>([]); // 多个难度供选择
  const [mapSourceName, setMapSourceName] = useState(''); // 谱面包 / 文件夹名（展示用）
  const [activeOsuName, setActiveOsuName] = useState(''); // 当前已载入 timing 的 .osu
  const [mapDir, setMapDir] = useState(''); // 谱面所在目录（切换难度时去这里找音频）
  const [showMapDrawer, setShowMapDrawer] = useState(false); // 「谱面难度」抽屉
  const [importMenuOpen, setImportMenuOpen] = useState(false); // 导入按钮的二级菜单
  const [copied, setCopied] = useState(false); // 「复制 timing」成功反馈
  const copyTimerRef = useRef<number | null>(null);
  // 左下角播放位置输入框（可直接键入秒数跳转）
  const [timeText, setTimeText] = useState('0.000');
  const timeFocusRef = useRef(false);

  // ===== 制谱侧栏（osu-maphelper 独立窗口程序）启动状态 =====
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

  // 点击频谱红色小节线 → 右侧面板滚动到对应段落并高亮
  const handleSectionClick = useCallback((id: string) => {
    document.getElementById(`section-row-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setFlashSectionId(id);
    if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => setFlashSectionId(null), 1600);
  }, []);

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
  const renderDpr = useMemo(
    () => Math.max(0.5, Math.min(2, settings.renderScale)),
    [settings.renderScale]
  );

  // 音乐主音量（masterGain），所有音频源经此输出
  const masterGainRef = useRef<GainNode | null>(null);
  if (!masterGainRef.current) {
    masterGainRef.current = audioContext.createGain();
    masterGainRef.current.connect(audioContext.destination);
    masterGainRef.current.gain.value = 1.0;
  }
  // 挂载/音量变化时同步到实际设置值（平滑过渡防爆音）
  useEffect(() => {
    const g = masterGainRef.current;
    if (g) g.gain.setTargetAtTime(settings.musicVolume, audioContext.currentTime, 0.02);
  }, [settings.musicVolume, audioContext]);

  /**
   * ★ v0.8.19：常驻一路**静音**输出，让音频流从启动起就保持 running。
   *   原因：outputLatency 只有在输出流真正跑起来之后才有值（本机首次播放前读到的恒为 0），
   *   而它正是起播提前量的一部分 —— 不预热的话**第一次播放**会漏补偿 50ms 左右。
   */
  useEffect(() => {
    const ctx = audioContext;
    const buf = ctx.createBuffer(1, Math.max(1, Math.ceil(ctx.sampleRate * 0.05)), ctx.sampleRate);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const g = ctx.createGain();
    g.gain.value = 0; // 完全静音，只为了让流保持运行
    src.connect(g);
    g.connect(ctx.destination);
    try { src.start(); } catch (e) {}
    void ctx.resume().catch(() => {});
    return () => { try { src.stop(); } catch (e) {} g.disconnect(); };
  }, [audioContext]);
  
  const [globalOffset, setGlobalOffset] = useState(0);
  const [timingLoaded, setTimingLoaded] = useState(false); // 导入过 timing（无音频时也能复制/导出）
  const [rawPoints, setRawPoints] = useState<Omit<TimingPoint, 'time'>[]>([
      { id: 'initial', beatIndex: 0, bpm: 120, sv: true }
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
  /** 最近一次实测并冻结的输出链路延迟（毫秒）：只用于设置面板如实显示，让用户能核对软件补了多少 */
  const [outputLatencyMs, setOutputLatencyMs] = useState(0);
  const playbackRateRef = useRef(1.0);
  const playheadRef = useRef(0); // 播放头位置（秒）：每帧更新，供 Visualizer 独立播放头层实时读取（不经过 React 渲染）
  
  // ★ v0.8.19：这里必须 useMemo。
  const timingPoints = useMemo(() => recalculateTiming(globalOffset, rawPoints), [globalOffset, rawPoints]);
  const [viewState, setViewState] = useState<ViewState>({ zoom: DEFAULT_ZOOM, scrollLeft: 0 });
  /**
   * ★ v0.8.19：视口自动跟随播放头。
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

  // 左下角播放位置输入框：不在编辑状态时跟随播放位置刷新
  useEffect(() => {
    if (!timeFocusRef.current) setTimeText(currentTime.toFixed(3));
  }, [currentTime]);

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

  // ===== 播放核心（对照原源码恢复：AudioBufferSourceNode + 墙钟公式）=====
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const startTimeRef = useRef<number>(0);   // 起播时的 audioContext.currentTime（渲染时钟锚点）
  const bufferStartRef = useRef<number>(0); // 起播时「送进渲染图」的内容位置（秒，已含输出延迟提前量）
  const latencyRef = useRef<number>(0);     // 本次起播冻结的输出链路延迟（秒）：中途不再重读，否则节拍器/播放头会漂
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
            timeSec: newTime,
        }];
    });
  }, [timingPoints]);

  const handleUpdatePoint = useCallback((id: string, field: 'bpm' | 'beatIndex' | 'sv' | 'svRate' | 'meter', value: number | boolean) => {
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
          // 绿线倍速：空/0/非法值 → 存 0（导出时按自动计算）
          if (field === 'svRate') {
              const r = typeof value === 'number' && isFinite(value) && value > 0 ? Math.round(value * 100) / 100 : 0;
              return { ...p, svRate: r };
          }
          // 绿线开关
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
  const stopRef = useRef<() => void>(() => {});

  // forcedPath：命令行 --open-audio=<路径> / 拖文件到 exe 上的自动打开（跳过文件对话框）
  const [importing, setImporting] = useState(false);
  const importingRef = useRef(false);

  /** 解码音频并载入（导入音频 / .osu / .osz 都走这里） */
  const loadAudioBuffer = useCallback(async (arrayBuffer: ArrayBuffer, name: string, absPath: string | null): Promise<boolean> => {
    setFileName(name);
    if (absPath) setAudioPath(absPath); // 留住绝对路径，供「导出 Malody 谱面包」打包音频用
    // 解码 7 分钟的歌要 1~3 秒，期间按钮显示「解码中…」，避免用户以为没反应而重复点击
    importingRef.current = true;
    setImporting(true);
    const t0 = performance.now();
    try {
        if (audioContext.state === 'suspended') await audioContext.resume();
        const decodedBuffer = await audioContext.decodeAudioData(arrayBuffer);
        const peaks = extractPeaks(decodedBuffer);
        setAudioData({ buffer: decodedBuffer, peaks, duration: decodedBuffer.duration });
        setGlobalOffset(0.1);
        setRawPoints([{ id: 'initial', beatIndex: 0, bpm: 120, sv: true }]);
        setTimingLoaded(false);
        currentTimeRef.current = 0;
        playheadRef.current = 0;
        setCurrentTime(0);
        setViewState({ zoom: DEFAULT_ZOOM, scrollLeft: 0 });
        // 播放中导入新音频时，旧 AudioBufferSourceNode 必须真正停掉（否则两首歌声音重叠）
        stopRef.current();
        console.info(`[import] ${name} 解码完成 ${decodedBuffer.duration.toFixed(1)}s，耗时 ${Math.round(performance.now() - t0)}ms`);
        return true;
    } catch (err) {
        console.error('[import] 解码失败：', err);
        alert(t('decodeError'));
        return false;
    } finally {
        importingRef.current = false;
        setImporting(false);
    }
  }, [audioContext]);

  /** 把解析出的 timing 写进红线（导入 .osu / timing 文件共用） */
  const applyParsedConfig = useCallback((cfg: ParsedTimingConfig) => {
      setTimingLoaded(true);
      setGlobalOffset(cfg.offset);
      setRawPoints(cfg.points.map(p => ({
          id: crypto.randomUUID(),
          beatIndex: p.beatIndex,
          bpm: p.bpm,
          meter: typeof p.meter === 'number' && p.meter > 0 ? p.meter : 4, // ★ v0.8.17：读回拍号
          sv: p.sv !== false, // 默认开启绿线
          svRate: p.svRate && p.svRate > 0 ? p.svRate : 0,
          timeSec: typeof p.timeSec === 'number' && isFinite(p.timeSec) ? p.timeSec : undefined, // 红线绝对时间
      })));
  }, []);

  /** 载入一个 .osu 的 timing（在抽屉里切换难度也走这里） */
  const applyOsuText = useCallback((text: string): boolean => {
      const cfg = parseTimingFile(text, 'map.osu');
      if (!cfg || cfg.points.length === 0) { alert(t('invalidOsuTiming')); return false; }
      applyParsedConfig(cfg);
      return true;
  }, [applyParsedConfig]);

  /** 从 .osu 文本里取 AudioFilename（切换到别的难度时按它找音频） */
  const audioNameOfOsu = useCallback((text: string): string => {
      const m = text.match(/^\s*AudioFilename\s*:\s*(.+?)\s*$/im);
      return m ? m[1].trim() : '';
  }, []);

  /** .osz / .osu / 谱面文件夹 统一落地：先解音频，再读 timing */
  const applyMapImport = useCallback(async (r: any) => {
      const api = (window as any).electronAPI;
      if (!api) return;
      if (!r || !r.ok) { alert(`${t('mapImportFailed')}：${r?.error || ''}`); return; }
      const bytes = await api.readAudioFile(r.audioPath);
      if (!bytes) { alert(t('mapImportFailed')); return; }
      const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const okAudio = await loadAudioBuffer(buf as ArrayBuffer, r.audioName, r.audioPath);
      if (!okAudio) return;
      const cands: MapCandidate[] = (r.osuFiles || []).map((f: any) => ({ ...f, ...parseOsuMeta(f.text) }));
      setMapCandidates(cands);
      setMapDir(r.dir || '');
      setMapSourceName(r.sourceName || String(r.dir || '').split(/[\\/]/).filter(Boolean).pop() || '');
      if (cands.length) {
          setActiveOsuName(cands[0].name);
          applyOsuText(cands[0].text);
          setShowMapDrawer(cands.length > 1);
      }
  }, [loadAudioBuffer, applyOsuText]);

  /** 抽屉里切换难度：那份 .osu 引用的音频不一样时，连音频一起换掉 */
  const selectOsuDifficulty = useCallback(async (name: string) => {
      const cand = mapCandidates.find(c => c.name === name);
      if (!cand) return;
      setActiveOsuName(name);
      const api = (window as any).electronAPI;
      const want = audioNameOfOsu(cand.text);
      const changed = !!want && want.toLowerCase() !== String(fileName || '').toLowerCase();
      if (changed && api?.findMapAudio && mapDir) {
          const found = await api.findMapAudio(mapDir, want);
          const bytes = found ? await api.readAudioFile(found.path) : null;
          if (bytes) {
              const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
              await loadAudioBuffer(buf as ArrayBuffer, found.name, found.path);
          } else {
              alert(`${t('mapImportFailed')}：${want}`); // 音频缺失 → 保持当前音频，只换 timing
          }
      }
      applyOsuText(cand.text);
  }, [mapCandidates, mapDir, fileName, audioNameOfOsu, loadAudioBuffer, applyOsuText]);

  /** 按磁盘路径导入：音频 / .osu / .osz */
  const importPath = useCallback(async (p: string) => {
      const api = (window as any).electronAPI;
      if (!api) return;
      const ext = (p.split('.').pop() || '').toLowerCase();
      if (ext === 'osz') { await applyMapImport(await api.readMapPackage(p)); return; }
      if (ext === 'osu') { await applyMapImport(await api.readOsuFile(p)); return; }
      // 音频：读字节 → 解码（谱面候选清空，避免抽屉里留着上一首的难度）
      const bytes = await api.readAudioFile(p);
      if (!bytes) {
          // 不是音频（多半是把谱面文件夹拖到 exe 上）→ 按文件夹扫一遍
          if (api.scanMapFolder) await applyMapImport(await api.scanMapFolder(p));
          return;
      }
      const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      setMapCandidates([]); setMapSourceName(''); setActiveOsuName(''); setMapDir(''); setShowMapDrawer(false);
      await loadAudioBuffer(buf as ArrayBuffer, p.split(/[\\/]/).pop() || 'unknown', p);
  }, [applyMapImport, loadAudioBuffer]);

  /** 顶部「导入」主按钮：Electron 走原生对话框（音频 / .osu / .osz 一起选） */
  const handleImportClick = useCallback(async () => {
      const api = (window as any).electronAPI;
      if (!api?.openImportFile) { (document.getElementById('audio-file-input') as HTMLInputElement | null)?.click(); return; }
      const p = await api.openImportFile();
      if (p) await importPath(p);
  }, [importPath]);

  /** 导入谱面文件夹（选 osu! Songs 下的单曲文件夹） */
  const handleImportFolder = useCallback(async () => {
      const api = (window as any).electronAPI;
      if (!api?.openMapFolder) return;
      const dir = await api.openMapFolder();
      if (!dir) return;
      await applyMapImport(await api.scanMapFolder(dir));
  }, [applyMapImport]);

  /** 浏览器兜底：<input type=file> 直接选的音频文件 */
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement> | null = null, forcedPath?: string) => {
    const picked = e?.target?.files?.[0] ?? null;
    if (picked && e?.target) e.target.value = ''; // 允许再次选择同一个文件
    if (!picked && importingRef.current) return;  // 另一个导入还在解码 → 忽略重复触发
    let file: File | null = picked;
    if (!file && forcedPath) {
      const data = await (window as any).electronAPI.readAudioFile(forcedPath);
      if (data) {
        const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        file = new File([arrayBuffer], forcedPath.split(/[\\/]/).pop() || 'unknown', { type: 'audio/*' });
      }
    }
    if (!file) return;
    await loadAudioBuffer(await file.arrayBuffer(), file.name, forcedPath || null);
  };

  // 命令行 `--open-audio=<路径>`（把音频文件拖到 exe 图标上 / 资源管理器「打开方式」）→ 启动后自动载入
  // 用 ref 转发，避免把 handleFileUpload 写进依赖导致监听器反复重建
  const loadAudioRef = useRef(importPath);
  loadAudioRef.current = importPath;
  useEffect(() => {
    const api = (window as any).electronAPI;
    if (!api?.onAutoOpenAudio) return;
    const off = api.onAutoOpenAudio((p: string) => { void loadAudioRef.current(p); });
    return () => { off?.(); };
  }, []);

  /** 当前编辑结果 → osu! timing 文本（纯数据，没有任何注释/提示行，可直接全选替换） */
  const buildTimingText = useCallback((): string => {
      if (rawPoints.length === 0) return '';
      const baseBpm = rawPoints[0]?.bpm || 182;
      return generateOsuTimingPoints(globalOffset, rawPoints, baseBpm);
  }, [globalOffset, rawPoints]);

  /** 复制到剪贴板：直接粘进 .osu 的 [TimingPoints] 段 */
  const handleCopyTiming = useCallback(async () => {
      const text = buildTimingText();
      if (!text) { alert(t('needAudio')); return; }
      try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
          copyTimerRef.current = window.setTimeout(() => setCopied(false), 1600);
      } catch {
          alert(t('copyFailed'));
      }
  }, [buildTimingText]);

  /** 导入 timing（.osu 谱面 / 本软件导出的 timing txt / 旧版 JSON 配置都能读） */
  const handleImportTiming = (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = ''; // 允许重复选同一个文件
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (event) => {
          try {
              const cfg = parseTimingFile(String(event.target?.result || ''), file.name);
              if (cfg && cfg.points.length > 0) applyParsedConfig(cfg);
              else alert(t('invalidJson'));
          } catch (err) {
              alert(t('parseJsonError'));
          }
      };
      reader.readAsText(file);
  };

  // ===== 导出文件名与使用说明头 =====
  // 音乐名（音频文件名去扩展名，用于导出文件名「游戏名-音乐名-timing.txt」）
  const songBase = (fileName ? fileName.replace(/\.[^.]+$/, '') : 'song').replace(/[\\/:*?"<>|]/g, '');

  // 各游戏导出文件顶部的替换说明（// 注释行，勿复制进谱面文件）
  const exportHowTo: Record<string, string[]> = {
    // ★ v0.8.15：原先还有一个「只导出 .mc（不含音频）」的选项，已按需求**删除** ——
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
      // 纯 timing 行：没有注释头、没有 [TimingPoints] 标题 —— 打开后全选复制即可替换谱面对应段
      const content = buildTimingText();
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
  const exportGameList = [
    // Malody：只保留「谱面包（含音频）」。把「导入音频的真实文件名」与「曲名(去扩展名)」传进去 ——
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
    if (sourceNodeRef.current) { try { sourceNodeRef.current.stop(); } catch(e) {} sourceNodeRef.current = null; }
    setIsPlaying(false);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
  }, []);

  // ★ v0.8.16：把 stop 的实现写进 ref，供上方的 handleFileUpload 调用（避免 TDZ）
  stopRef.current = stop;

  /**
   * 从 t 秒起重新起一个 BufferSource（只换声源，不碰 isPlaying / 不重建播放循环）。
   * ★ v0.8.19 新增，修「播放中点白条 → 播放头与时间码整段冻死」：
   *   旧 handleSeek 用的是 stop() + play()。两者在同一个事件里被 React 批处理成
   *   isPlaying: false → true（最终值仍是 true），于是播放循环的 effect 不会重建，
   *   而 stop() 已经把当前 rAF 取消了 → 声音还在放，播放头/时间码却再也不动。
   */
  /**
   * 读一次输出链路延迟（秒）：样本送进 AudioContext 到扬声器真正发声。
   *
   * ★ v0.8.19：两条独立口径互相校验 —— 这是 lazer 那套「一个时钟 + 串偏移」里最容易被忽略的一步。
   *   · ts  = currentTime - getOutputTimestamp().contextTime
   *            「正从扬声器出来的那一帧」对应的渲染时间差，MDN 语义即真实延迟，最准。
   *   · nom = outputLatency + baseLatency
   *            浏览器自己算的「设备缓冲 + 图延迟」，稳定但个别设备多报/少报。
   *   两者本机吻合（62.6ms vs 62ms）。**差超过 40ms 说明 ts 是过时读数** ——
   *   例如上一轮播放停在 30s、现在 currentTime 已在 60s 附近，差值看起来「合理」却完全错误，
   *   会让画面多滞后几十毫秒，听起来就是「节拍器抢在播放头压线之前响」。此时只信 nom。
   */
  const readOutputLatencyOnce = useCallback((): number => {
    const ctx = audioContext as AudioContext & { outputLatency?: number; baseLatency?: number };
    let tsVal = 0;
    try {
      const ts = ctx.getOutputTimestamp?.();
      if (ts && Number.isFinite(ts.contextTime) && ts.contextTime > 0) {
        const d = ctx.currentTime - ts.contextTime;
        if (Number.isFinite(d) && d > 0.004 && d < 0.25) tsVal = d;
      }
    } catch { /* 个别实现不支持则忽略 */ }
    const hard = typeof ctx.outputLatency === 'number' && ctx.outputLatency > 0 ? ctx.outputLatency : 0;
    const soft = typeof ctx.baseLatency === 'number' && ctx.baseLatency > 0 ? ctx.baseLatency : 0;
    const nominal = hard > 0 ? hard + soft : soft;
    if (tsVal > 0 && (nominal <= 0 || Math.abs(tsVal - nominal) < 0.04)) return tsVal;
    if (nominal > 0) return nominal;
    return tsVal;
  }, [audioContext]);

  /**
   * 起播前采样取中位数：单次读数会因 render quantum 边界抖动，
   * 中位数 + 上面的交叉校验能同时滤掉「过时 ts」与「瞬时毛刺」。
   * 三次一致（极差 < 4ms）就提前结束，通常 3 次采样 ≈ 48ms，不拖慢起播。
   */
  const measureOutputLatency = useCallback(async (): Promise<number> => {
    const samples: number[] = [];
    for (let i = 0; i < 6; i++) {
      const v = readOutputLatencyOnce();
      if (v > 0) samples.push(v);
      if (samples.length >= 3) {
        const mn = Math.min(...samples), mx = Math.max(...samples);
        if (mx - mn < 0.004) break;
      }
      if (i < 5) await new Promise((r) => setTimeout(r, 24));
    }
    if (!samples.length) return 0;
    samples.sort((a, b) => a - b);
    return Math.min(samples[Math.floor(samples.length / 2)], 0.25);
  }, [readOutputLatencyOnce]);

  const startSourceAt = useCallback((t: number, lagOverride?: number) => {
    if (!audioData) return;
    if (sourceNodeRef.current) { try { sourceNodeRef.current.stop(); } catch(e) {} }
    const offset = Math.max(0, Math.min(audioData.duration, t));
    const source = audioContext.createBufferSource();
    source.buffer = audioData.buffer;
    source.connect(masterGainRef.current || audioContext.destination);
    source.playbackRate.value = playbackRateRef.current; // 变速（原生变速，音调随倍速变化）
    /**
     * ★ v0.8.19：频谱不再随设置位移 —— 画面严格按音乐真实时间渲染（用户要求「不要动频谱」）。
     *   这里的提前量**只剩输出链路延迟**：声音晚 L 秒才从扬声器出来，那就让内容提前 L 秒起播，
     *   于是「现在听到的」= 「播放头指的位置」。
     *
     * ★ v0.8.19：延迟**由调用方传入**：起播时实测（measureOutputLatency 取中位数），
     *   播放中 seek 复用同一个冻结值（latencyRef）。旧代码每帧重读，起播时读到 0（退回
     *   baseLatency 10ms）、播放中读到 53ms，两处数字不同 → 节拍器提前 43ms 响。
     */
    const lag = lagOverride ?? latencyRef.current;
    latencyRef.current = lag;
    const leadSec = lag * playbackRateRef.current;
    const bufferOffset = Math.max(0, Math.min(audioData.duration - 0.001, offset + leadSec));
    source.start(0, bufferOffset);
    sourceNodeRef.current = source;
    startTimeRef.current = audioContext.currentTime;
    bufferStartRef.current = bufferOffset;
    playheadRef.current = offset; // 播放头立即跳到新位置
    lastScheduledIndexRef.current = -Infinity; // 新位置：下一帧从当地拍子重新调度节拍器
  }, [audioData, audioContext]);

  /**
   * 最终生效的输出延迟 = 自动实测 + 用户「同步微调」。
   * 两者分工：自动值解决设备上报；微调解决上报不准（蓝牙 / 虚拟声卡）—— 这就是 lazer 的
   * platformOffsetClock + userGlobalOffsetClock，一个是测量值，一个是用户校准值。
   */
  const resolveLatency = useCallback(async (): Promise<number> => {
    const auto = await measureOutputLatency();
    const adj = Number.isFinite(settings.syncAdjustMs) ? settings.syncAdjustMs / 1000 : 0;
    return Math.max(0, Math.min(0.3, auto + adj));
  }, [measureOutputLatency, settings.syncAdjustMs]);

  /** getOutputTimestamp 是否已经给出有效读数（输出流真正跑起来之前 contextTime 为 0） */
  const hasValidOutputClock = useCallback((): boolean => {
    try {
      const ts = audioContext.getOutputTimestamp?.();
      return !!ts && Number.isFinite(ts.contextTime) && ts.contextTime > 0;
    } catch { return false; }
  }, [audioContext]);

  const play = useCallback(async () => {
    if (!audioData) return;
    const cold = audioContext.state !== 'running';
    if (cold) {
      await audioContext.resume();
      /**
       * ★ v0.8.19：冷启动时先等输出流真正跑起来再起播（最多 200ms）。
       *   否则 readOutputLatency 拿到的是无效值 → 退回 baseLatency(10ms)，
       *   整段播放的画面会比声音早约 50ms（声音迟迟不到位）。
       *   注意：这只影响**画面**，节拍器与音乐的同步走渲染时钟，不依赖这个值。
       */
      const t0 = performance.now();
      while (!hasValidOutputClock() && performance.now() - t0 < 200) {
        await new Promise((r) => setTimeout(r, 16));
      }
    }
    // ★ v0.8.19：起播前实测一次输出延迟并冻结（多口径交叉校验，避免过时读数把画面推偏）
    const lag = await resolveLatency();
    setOutputLatencyMs(Math.round(lag * 1000));
    startSourceAt(currentTimeRef.current, lag);
    uiFrameRef.current = 0;
    setIsPlaying(true);
  }, [audioData, audioContext, hasValidOutputClock, resolveLatency, startSourceAt]);

  /**
   * 播放中改「同步微调」→ 防抖 350ms 后重新测量并重锚起播点。
   * 校准要能当场听出来，所以不能等下次播放；但拖滑条每一步都重起 BufferSource 会把声音打碎，
   * 因此防抖。注意依赖故意只留 syncAdjustMs：isPlaying / startSourceAt 取闭包当前值。
   */
  useEffect(() => {
    if (!isPlaying) return;
    const id = window.setTimeout(async () => {
      const lag = await resolveLatency();
      setOutputLatencyMs(Math.round(lag * 1000));
      startSourceAt(currentTimeRef.current, lag);
    }, 350);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.syncAdjustMs]);

  const togglePlay = useCallback(() => isPlaying ? stop() : play(), [isPlaying, play, stop]);

  const playClick = useCallback((time: number, isDownbeat: boolean) => {
    if (!isFinite(time)) return;
    // 按节拍器音色渲染（频率/波形/包络均来自音色配置）
    const sound = getMetronomeSound(settings.metronomeSound);
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    osc.connect(gain); gain.connect(audioContext.destination);
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
        /**
         * ★ v0.8.19：时钟分两层（同 osu!lazer 的思路：一个时钟 + 一串偏移，绝不让各画各的）
         *   contentNow = 此刻**送进渲染图**的内容位置
         *   newTime    = 此刻**从扬声器出来**的内容位置 = contentNow - 输出延迟×倍速
         *   画面（频谱 / 波形 / 红线 / 播放头 / 时间码）统一用 newTime → 「看见的 = 听见的」。
         *   节拍器走渲染时钟换算（见下方 scheduleTime），与音乐同一条路，天然零误差。
         */
        const contentNow = bufferStartRef.current + (currentAudioTime - startTimeRef.current) * rate();
        const newTime = Math.max(0, contentNow - latencyRef.current * rate());
        if (newTime >= (audioData?.duration || 0)) {
            currentTimeRef.current = audioData?.duration || 0;
            playheadRef.current = audioData?.duration || 0;
            setCurrentTime(audioData?.duration || 0); stop();
        }
        else {
            currentTimeRef.current = newTime;
            playheadRef.current = newTime; // 播放头独立层每帧实时读取（不经过 React）
            // ★ v0.8.19：白条滑出当前区域 → 视口**一帧直接跳到**下一区域（不做滚动动画，与侧栏切段一致）
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
            uiFrameRef.current++;
            const nowMs = performance.now();
            if (nowMs - lastUiPublishRef.current >= 100) {
                lastUiPublishRef.current = nowMs;
                setCurrentTime(newTime);
            }
            if (isMetronomeOn) {
                // ★ v0.8.19：节拍器打在「红线画出来的位置」= 谱面拍时间 + beatLineDelaySec。
                //   第一条红线之前没有线可压 → 不响（原来会按 BPM 往时间轴左侧外推，前奏里空响）。
                const firstLineTime = timingPoints.length ? timingPoints[0].time : 0;
                const lookahead = 0.15;
                // 墙钟前瞻对应的内容时间 = 前瞻 × 倍速（音乐以倍速播放）
                const horizonTime = newTime + lookahead * rate();
                let nextBeatIndex = lastScheduledIndexRef.current + 1;
                const { point } = getPointAtTime(newTime, timingPoints);
                const currentBeatEstimate = point.beatIndex + (newTime - point.time) / (60 / point.bpm);
                if (nextBeatIndex < currentBeatEstimate - 1) nextBeatIndex = Math.floor(currentBeatEstimate);
                let iters = 0;
                while (iters < 120) { // 上限放宽：红线/蓝线位置接近时也不会漏掉该拍的节拍器声音
                   const beatTime = getTimeAtBeatIndex(nextBeatIndex, timingPoints);
                   if (beatTime > horizonTime) break;
                   /**
                    * ★ v0.8.19：节拍器打在**红线画出来的位置**上（beatTime + 刻度延迟），
                    *   而不是谱面里的原始拍时间。这样「播放头压到红线」与「听到咔哒」是同一瞬间；
                    *   再减掉输出链路延迟，让声音从扬声器出来的时刻正好落在播放头压线那一刻。
                    */
                   const shiftSec = Number.isFinite(settings.beatLineDelayMs) ? settings.beatLineDelayMs / 1000 : 0;
                   const clickTime = beatTime + shiftSec;
                   /**
                    * ★ v0.8.19：只用**渲染时钟**换算，不再减 readOutputLatency()。
                    *   咔哒声和音乐是从同一个渲染图出去的 —— 只要两者在「渲染时刻」对齐，到扬声器就一定对齐。
                    *   旧写法每帧重读延迟：起播时 0（退回 baseLatency 10ms）、播放中 53ms，
                    *   两处数字不同 → 节拍器整整提前 43ms 响（这就是「节拍器提前响」）。
                    */
                   const scheduleTime = startTimeRef.current + (clickTime - bufferStartRef.current) / rate();
                   if (scheduleTime >= currentAudioTime - 0.05 && beatTime >= firstLineTime) {
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
   * 跳转到 t 秒。
   * ★ v0.8.19 修 bug：**播放中点击频谱 / 白条 / 总览条 → 停在该位置**（原来会"无缝续播"，
   *   而 stop()+play() 被批处理掉之后播放头反而冻死）。
   *   段间跳转（Alt+←→、侧栏卡片）传 keepPlaying，仍按"跳过去继续放"处理。
   */
  const handleSeek = useCallback((time: number, opts?: { keepPlaying?: boolean }) => {
    const t = Math.max(0, Math.min(audioData?.duration || 0, time));
    currentTimeRef.current = t;
    playheadRef.current = t;
    setCurrentTime(t);
    if (sourceNodeRef.current) {
      if (opts?.keepPlaying) startSourceAt(t, latencyRef.current); // 换声源，复用冻结延迟（重读会让画面跳一下）
      else stop();                            // 停下，就停在点击的位置
    }
    // 频谱视图：目标位置在视口外时把视口翻过去（播放头落在左侧 10%，与自动跟随一致）
    setViewState(v => {
        const maxScroll = Math.max(0, (audioData?.duration || 0) * v.zoom - containerWidth);
        const targetX = t * v.zoom;
        if (targetX < v.scrollLeft || targetX > v.scrollLeft + containerWidth) {
            return { ...v, scrollLeft: Math.max(0, Math.min(targetX - containerWidth * FOLLOW_LEAD_RATIO, maxScroll)) };
        }
        return v;
    });
  }, [audioData, containerWidth, stop, startSourceAt]);

  /** 双击变速段落卡片 → 播放头 / 时间码 / 总览条一起跳到该卡片的 timing 位置 */
  const handleJumpToTimeline = useCallback((sec: number) => {
      handleSeek(sec, { keepPlaying: true });
  }, [handleSeek]);

  /** 左下角输入秒数 → 跳转（回车/失焦生效） */
  const commitTimeSeek = useCallback(() => {
      const v = parseFloat(timeText);
      if (!isFinite(v)) { setTimeText(currentTimeRef.current.toFixed(3)); return; }
      handleSeek(Math.max(0, v));
  }, [timeText, handleSeek]);

  /**
   * ★ v0.8.19：用户主动移动视口（拖拽平移 / 滚轮滚动）时关闭自动跟随。
   *   否则播放中想把视口拖到别处看一下，下一帧就被跟随逻辑拽回播放头。
   *   需要恢复跟随点底部按钮即可。
   */
  const handleUserScroll = useCallback((sl: number) => {
      setFollowPlayhead(false);
      setViewState(v => (v.scrollLeft === sl ? v : { ...v, scrollLeft: sl }));
  }, []);

  // 调整播放倍速（0.25x - 2.0x）：原生 playbackRate 实时变速（变调），不打断播放
  const handleRateChange = useCallback((rate: number) => {
      const clamped = Math.max(0.25, Math.min(2.0, rate));
      const prev = playbackRateRef.current;
      if (Math.abs(clamped - prev) < 0.001) return; // 无变化直接返回
      playbackRateRef.current = clamped;
      setPlaybackRate(clamped);
      if (sourceNodeRef.current) {
          // BUG 修复：倍数变了必须用「当前内容时间」重新锚定墙钟起点。
          // 否则 RAF 里 newTime = startOffset + 已流逝墙钟 × 新倍速 会把之前那段按新倍速重算 → 播放头瞬移。
          // ★ v0.8.19：按**旧倍速**把此刻的渲染位置固化下来当新锚点（delay 沿用本次冻结值）。
          const now = audioContext.currentTime;
          bufferStartRef.current = bufferStartRef.current + (now - startTimeRef.current) * prev;
          startTimeRef.current = now;
          sourceNodeRef.current.playbackRate.value = clamped; // 实时生效
          lastScheduledIndexRef.current = -Infinity; // 重置节拍调度，下一帧从当前拍重新调度
      }
  }, [audioContext]);

  // ===== 常用快捷键（不做界面标注，帮助面板里只列了 Space / 缩放 / 段落切换）=====
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
      const targetT = target.time;
      handleSeek(targetT, { keepPlaying: true }); // 段间导航：播放中切段继续放，不打断试听
      // 视图居中（与 handleSeek 里"超出视区才居中"不同：这里是**明确要求**跳段，所以无条件居中）
      setViewState(v => {
          const maxScroll = Math.max(0, (audioData?.duration || 0) * v.zoom - containerWidth);
          return { ...v, scrollLeft: Math.max(0, Math.min(targetT * v.zoom - containerWidth / 2, maxScroll)) };
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
          if (ctrl && key === 'o') { e.preventDefault(); handleImportClick(); return; }
          if (ctrl && key === 's') { e.preventDefault(); handleExportOsu(); return; }
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
  }, [togglePlay, undo, redo, handleImportClick, handleExportOsu, handleSeek, zoomBy, stepSection]);

  /**
   * ★ v0.8.19：变速段落卡片列表必须缓存。
   *   导入 .osu 后可能有 **几百条红线**（本机测试谱 700+ 条），而播放时 currentTime 每 100ms
   *   触发一次 App 重渲染。旧写法在 JSX 里直接 [...timingPoints].reverse().map(...)，
   *   每次渲染都生成全新元素 → 几百张卡片全部重渲染，每秒 10 轮，主线程直接被填满。
   *   用 useMemo 缓存元素后，React 拿到的是同一批元素对象，会整棵子树跳过，播放期间零成本。
   */
  const timingRows = useMemo(() => [...timingPoints].reverse().map((point, revIdx) => {
      const originalIdx = timingPoints.length - 1 - revIdx;
      return (
          <TimingRow
              key={point.id}
              point={point}
              index={originalIdx}
              totalCount={timingPoints.length}
              onUpdate={handleUpdatePoint}
              onRemove={handleRemovePoint}
              onUpdateTime={handleUpdatePointTime}
              onJumpToTime={handleJumpToTimeline}
              flash={flashSectionId === point.id}
          />
      );
  }), [timingPoints, handleUpdatePoint, handleRemovePoint, handleUpdatePointTime, handleJumpToTimeline, flashSectionId]);

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
        <header className="h-16 bg-[var(--panel)] border-b border-[var(--line)] flex items-center justify-between gap-3 px-4 z-30 shrink-0 shadow-2xl">
            <div className="flex items-center gap-2.5 min-w-0 flex-nowrap">
                {/* 导入：音频 / .osu / .osz 一起选；右侧小箭头可只选「谱面文件夹」。
                    v0.8.19：按钮改成定高 nowrap 的一体式控件，顶栏永远只占 64px，不会压到下面的播放/频谱区 */}
                <div className="relative flex items-stretch shrink-0">
                    <button
                        onClick={() => { setImportMenuOpen(false); void handleImportClick(); }}
                        disabled={importing}
                        title={t('importFileMenu')}
                        className={`flex items-center gap-2 px-3.5 h-10 bg-[var(--accent)] text-white rounded-l-lg transition text-sm font-black uppercase tracking-widest shadow-lg whitespace-nowrap ${importing ? 'opacity-70 cursor-wait' : 'active:scale-95'}`}
                    >
                        {importing
                            ? <span className="inline-block w-[18px] h-[18px] rounded-full border-2 border-white/30 border-t-white animate-spin" />
                            : <Upload size={18} />}
                        <span>{importing ? t('decoding') : t('importAudio')}</span>
                    </button>
                    <button
                        onClick={() => setImportMenuOpen(v => !v)}
                        title={t('importFolder')}
                        className="px-1.5 h-10 bg-[var(--accent)] text-white rounded-r-lg border-l border-white/25 transition active:scale-95"
                    >
                        <ChevronDown size={14} className={`transition-transform ${importMenuOpen ? 'rotate-180' : ''}`} />
                    </button>
                    {importMenuOpen && (
                        <div className="absolute left-0 top-full mt-1.5 w-56 rounded-xl bg-[var(--panel)] border border-[var(--line2)] shadow-2xl z-50 overflow-hidden">
                            <button
                                onClick={() => { setImportMenuOpen(false); void handleImportClick(); }}
                                className="w-full flex items-center gap-2 px-3.5 py-2.5 text-xs font-bold text-[var(--t2)] hover:bg-[var(--chip2)] transition-colors"
                            >
                                <Upload size={14} /> {t('importFileMenu')}
                            </button>
                            <button
                                onClick={() => { setImportMenuOpen(false); void handleImportFolder(); }}
                                className="w-full flex items-center gap-2 px-3.5 py-2.5 text-xs font-bold text-[var(--t2)] hover:bg-[var(--chip2)] transition-colors border-t border-[var(--line)]"
                            >
                                <FolderOpen size={14} /> {t('importFolder')}
                            </button>
                        </div>
                    )}
                </div>
                {/* 浏览器兜底（Electron 下不会用到） */}
                <input id="audio-file-input" type="file" accept="audio/*" onChange={handleFileUpload} className="hidden" disabled={importing} />
                {/* 紧邻导入：启动制谱侧栏 */}
                <button
                    onClick={launchSidebar}
                    disabled={mhState === 'launching'}
                    title={mhMsg || '启动 osu! 制谱侧栏（启动后本软件会自动收起；在侧栏点「返回测速」即可回到软件并关闭侧栏）'}
                    className="flex items-center gap-2 px-3.5 h-10 bg-[var(--chip2)] hover:bg-[var(--chip)] border border-[var(--accent)]/40 text-[var(--accent)] rounded-lg cursor-pointer transition text-sm font-black uppercase tracking-widest shadow-lg active:scale-95 disabled:opacity-50 whitespace-nowrap shrink-0"
                >
                    <PanelRightOpen size={18} />
                    <span>{mhState === 'launching' ? t('launching') : t('mapHelper')}</span>
                </button>
                {fileName && <span className="hidden xl:inline text-xs text-[var(--t4)] truncate max-w-[170px] font-mono bg-[var(--chip2)] px-3 py-1 rounded-full border border-[var(--line2)]">{fileName}</span>}
                {mhState === 'error' && <span className="text-xs text-red-400 max-w-[200px] truncate hidden lg:inline">{mhMsg}</span>}
            </div>
            <div className="flex items-center gap-2.5 shrink-0">
                {/* 音乐音量 + 节拍器音量滑条：窄窗口下隐藏，保证右侧按钮不被挤进播放区 */}
                <div className="hidden xl:flex items-center gap-2.5 bg-[var(--chip2)] px-3 py-1.5 rounded-xl border border-[var(--line)]" title={t('musicVolume')}>
                    <Music size={14} className="text-[var(--accent)] shrink-0" />
                    <input
                        type="range" min="0" max="1" step="0.05"
                        value={settings.musicVolume}
                        onChange={(e) => updateSettings({ ...settings, musicVolume: parseFloat(e.target.value) })}
                        className="w-20 accent-[var(--accent)] cursor-pointer"
                    />
                    <span className="text-[10px] font-mono text-[var(--t3)] w-8 text-right shrink-0">{Math.round(settings.musicVolume * 100)}%</span>
                </div>
                <div className="hidden xl:flex items-center gap-2.5 bg-[var(--chip2)] px-3 py-1.5 rounded-xl border border-[var(--line)]" title={t('metronomeVolume')}>
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
                {/* 时间码已移到左下角（当前 BPM 左侧，可直接输入跳转） */}
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
                        // ★ v0.8.19 触控板双指捏合：Chromium 把 pinch 报成 ctrl + wheel。
                        //   以光标位置为锚点缩放；两指左右滑动仍是普通 wheel，走下面的平移分支（行为不变）。
                        if (e.ctrlKey) {
                            if (e.cancelable) e.preventDefault();
                            const zoomFactor = Math.exp(-e.deltaY * 0.012);
                            setViewState(prev => {
                                const timeAtMouse = (mouseX + prev.scrollLeft) / prev.zoom;
                                const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, prev.zoom * zoomFactor));
                                const newScrollLeft = timeAtMouse * newZoom - mouseX;
                                const maxScroll = Math.max(0, audioData.duration * newZoom - containerWidth);
                                return { zoom: newZoom, scrollLeft: Math.max(0, Math.min(newScrollLeft, maxScroll)) };
                            });
                            return;
                        }
                        if (e.altKey) {
                            // ★ v0.8.16：Alt+滚轮 = **精细**调整频谱的 px/s（缩放）。
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
                            beatLineDelaySec={Number.isFinite(settings.beatLineDelayMs) ? settings.beatLineDelayMs / 1000 : 0}
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
            <div className="flex-1 flex justify-start xl:justify-center items-center gap-3 min-h-0 px-4 overflow-x-auto custom-scrollbar">
            {/* 播放位置：时间码 + 可直接输入秒数跳转（原顶栏右上角的时间窗口移到这里） */}
            <div className="flex items-center gap-1.5 h-11 bg-[var(--chip2)] px-3 rounded-xl border border-[var(--line)] shrink-0" title={t('timeSeekHint')}>
                <Clock size={14} className="text-[var(--accent)] shrink-0" />
                <input
                    value={timeText}
                    inputMode="decimal"
                    onFocus={(e) => { timeFocusRef.current = true; e.currentTarget.select(); }}
                    onChange={(e) => setTimeText(e.target.value.replace(/[^\d.]/g, ''))}
                    onBlur={() => { timeFocusRef.current = false; commitTimeSeek(); }}
                    onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter') { e.preventDefault(); commitTimeSeek(); (e.target as HTMLInputElement).blur(); }
                        else if (e.key === 'Escape') { e.preventDefault(); setTimeText(currentTimeRef.current.toFixed(3)); (e.target as HTMLInputElement).blur(); }
                    }}
                    className="w-16 text-center bg-transparent border-b border-transparent hover:border-[var(--line2)] focus:border-[var(--accent)] outline-none text-base font-mono font-black text-[var(--accent)] tabular-nums cursor-text"
                />
            </div>
            {/* 当前 BPM（当前播放位置所在段落） */}
            <div className="flex items-center gap-2.5 h-11 bg-[var(--chip2)] px-4 rounded-xl border border-[var(--line)] shrink-0" title={t('currentBpmHint')}>
                <span className="text-[10px] text-[var(--t3)] uppercase font-black tracking-widest">{t('currentBpm')}</span>
                <span className="text-lg font-mono font-black text-[var(--accent2)] tabular-nums leading-none">{currentBpm.toFixed(2)}</span>
            </div>
            {/* 播放控制组：停止 / 播放 / 节拍器 */}
            <div className="flex items-center gap-2 px-1 shrink-0">
                <button onClick={stop} className="text-red-500/70 hover:text-red-500 transition-all hover:scale-110 active:scale-90" title={t('stop')}><Square size={24} fill="currentColor"/></button>
                <button onClick={togglePlay} className="w-14 h-14 rounded-full flex items-center justify-center bg-[var(--accent)] hover:bg-[var(--accent)] text-white shadow-[0_0_20px_rgba(79,70,229,0.4)] active:scale-90 transition-all">
                    {isPlaying ? <Pause size={30} fill="currentColor"/> : <Play size={30} fill="currentColor" className="ml-1"/>}
                </button>
                <button onClick={() => setIsMetronomeOn(p => !p)} className={`transition-all hover:scale-110 active:scale-90 ${isMetronomeOn ? 'text-green-400 drop-shadow-[0_0_8px_rgba(74,222,128,0.4)]' : 'text-[var(--t4)]'}`} title={t('metronome')}>
                    {isMetronomeOn ? <Volume2 size={28}/> : <VolumeX size={28}/>}
                </button>
            </div>
            {/* 变速控件：滑块 + 点击数值复位 1.0x */}
            <div className="flex items-center gap-2.5 h-11 bg-[var(--chip2)] px-3.5 rounded-xl border border-[var(--line)] shrink-0" title={t('rateTitle')}>
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
            {/* 视口自动跟随播放头：紧邻变速滑条 */}
            <button
                onClick={() => setFollowPlayhead(f => !f)}
                className={`w-11 h-11 shrink-0 flex items-center justify-center rounded-xl border transition-all hover:scale-105 active:scale-95 ${
                    followPlayhead
                        ? 'bg-[var(--accent)]/15 border-[var(--accent)]/50 text-[var(--accent2)] shadow-[0_0_12px_rgba(79,70,229,0.25)]'
                        : 'bg-[var(--chip2)] border-[var(--line)] text-[var(--t4)] hover:text-white'
                }`}
                title={`${t('followPlayhead')}${followPlayhead ? ' · ON' : ' · OFF'} — ${t('followPlayheadHint')}`}
            >
                <LocateFixed size={20} />
            </button>
            {/* 缩放倍率：可直接键入 px/s，回车/失焦生效，↑↓ 以 1.2 倍步进，Esc 撤销 */}
            <div className="flex items-center gap-2 h-11 bg-[var(--chip2)] px-3.5 rounded-xl border border-[var(--line)] shrink-0">
                <button onClick={() => zoomBy(0.8)} className="text-[var(--t4)] hover:text-white transition-colors" title={t('zoomOut')}><ZoomOut size={20}/></button>
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
                        className="w-12 text-center bg-transparent border-b border-transparent hover:border-[var(--line2)] focus:border-[var(--accent)] outline-none text-sm font-mono font-bold text-[var(--t1)] tabular-nums cursor-text"
                    />
                    <span className="text-[10px] text-[var(--t4)] font-mono select-none">px/s</span>
                </div>
                <button onClick={() => zoomBy(1.2)} className="text-[var(--t4)] hover:text-white transition-colors" title={t('zoomIn')}><ZoomIn size={20}/></button>
            </div>
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
                {/* v0.8.19：只保留「导入 timing」（原「导入 JSON 配置」），按钮放大一号 */}
                <label
                    className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[var(--accent)]/10 border border-[var(--accent)]/30 text-[var(--accent)] hover:bg-[var(--accent)]/20 cursor-pointer transition-all active:scale-95"
                    title={t('importTiming')}
                >
                    <FileUp size={22} />
                    <span className="text-[11px] font-black uppercase tracking-wider whitespace-nowrap">{t('importTiming')}</span>
                    <input type="file" accept=".osu,.txt,.json,.mc,.aff,.adofai,.vschart.json" onChange={handleImportTiming} className="hidden" />
                </label>
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

             {/* 导出：osu! timing（纯数据，可直接全选替换）+ 复制 + 其他格式 */}
             <div className="pt-4 border-t border-[var(--line)] relative">
                <div className="flex items-center justify-between mb-2">
                    <label className="text-[10px] text-[var(--t3)] block uppercase font-black tracking-widest flex items-center gap-2">
                        {t('exportOsuTiming')}
                        <div className="group relative">
                            <Info size={12} className="text-[var(--t4)]" />
                            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-56 p-2 bg-gray-800 text-white text-[10px] rounded opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity border border-[var(--line2)] shadow-xl z-50">{t('svHint')}</div>
                        </div>
                    </label>
                    {copied && <span className="text-[10px] font-black text-green-400 uppercase tracking-widest">{t('copied')}</span>}
                </div>
                <div className="flex items-center gap-1.5">
                    {/* 复制当前 timing 到剪贴板（粘进谱面即可） */}
                    <button
                        onClick={handleCopyTiming}
                        disabled={!audioData && !timingLoaded}
                        className={`w-10 h-10 shrink-0 flex items-center justify-center rounded-xl border transition-all ${
                            copied
                                ? 'bg-green-500/20 border-green-500/50 text-green-400'
                                : (audioData || timingLoaded)
                                    ? 'bg-[var(--chip2)] border-[var(--line2)] text-[var(--accent)] hover:border-[var(--accent)] hover:text-[var(--accent2)] active:scale-95'
                                    : 'bg-[var(--chip2)] border-[var(--line2)] text-[var(--t4)] cursor-not-allowed'
                        }`}
                        title={t('copyTiming')}
                    >
                        {copied ? <Check size={16} /> : <Copy size={16} />}
                    </button>
                    {/* 主按钮：导出 osu! timing */}
                    <button 
                        onClick={handleExportOsu}
                        disabled={!audioData && !timingLoaded}
                        className={`flex-1 h-10 flex items-center justify-center gap-2 px-2 rounded-xl text-[11px] font-black tracking-wide whitespace-nowrap transition-all ${
                            (audioData || timingLoaded)
                                ? 'bg-[var(--accent2)] hover:bg-[var(--accent2)] text-white shadow-lg active:scale-95' 
                                : 'bg-[var(--chip2)] text-[var(--t4)] cursor-not-allowed'
                        }`}
                        title={t('exportOsuTiming')}
                    >
                        <Download size={16} />
                        {t('exportOsuTiming')}
                    </button>
                    {/* 其他音游格式 */}
                    <button
                        onClick={() => setShowExportMenu(m => !m)}
                        disabled={!audioData && !timingLoaded}
                        className={`w-9 h-10 shrink-0 flex items-center justify-center rounded-xl border-l transition-all ${
                            (audioData || timingLoaded) ? 'bg-[var(--accent2)] text-white' : 'bg-[var(--chip2)] text-[var(--t4)] cursor-not-allowed'
                        }`}
                        title={t('exportNewSection')}
                    >
                        <ChevronDown size={16} className={`transition-transform ${showExportMenu ? 'rotate-180' : ''}`} />
                    </button>
                </div>
                {/* 二级下拉菜单（其他音游） */}
                {showExportMenu && (
                    <div className="absolute left-0 right-0 mt-1.5 rounded-xl bg-[var(--panel)] border border-[var(--line2)] shadow-2xl z-50 overflow-hidden max-h-80 overflow-y-auto">
                        <div className="px-4 pt-2.5 pb-1.5 text-[9px] uppercase font-black tracking-widest text-[var(--t4)]">
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

             {/* 谱面难度抽屉：.osz / 谱面文件夹里有多份 .osu 时出现，点一下切到那份谱面的 timing */}
             {mapCandidates.length > 1 && (
                <div>
                    <button
                        onClick={() => setShowMapDrawer(v => !v)}
                        className="w-full flex items-center gap-2 text-[10px] uppercase font-black tracking-widest text-[var(--t3)] hover:text-[var(--t1)] transition-colors"
                        title={mapSourceName}
                    >
                        <Music size={12} />
                        <span className="flex-1 text-left">{t('mapOsuList')} · {mapCandidates.length}</span>
                        <ChevronDown size={14} className={`transition-transform ${showMapDrawer ? 'rotate-180' : ''}`} />
                    </button>
                    {showMapDrawer && (
                        <div className="mt-2 rounded-xl border border-[var(--line2)] bg-[var(--chip)] overflow-hidden max-h-56 overflow-y-auto custom-scrollbar">
                            {mapCandidates.map(c => {
                                const active = c.name === activeOsuName;
                                return (
                                    <button
                                        key={c.path}
                                        onClick={() => { void selectOsuDifficulty(c.name); }}
                                        className={`w-full flex items-center gap-2 px-3 py-2 text-left transition-colors border-b border-[var(--line)] last:border-b-0 ${
                                            active ? 'bg-[var(--accent)]/15 text-[var(--accent)]' : 'text-[var(--t2)] hover:bg-[var(--chip2)]'
                                        }`}
                                        title={c.name}
                                    >
                                        <span className="flex-1 min-w-0">
                                            <span className="block text-xs font-bold truncate">{c.version || c.name}</span>
                                            <span className="block text-[9px] text-[var(--t4)] truncate font-mono">{c.name}</span>
                                        </span>
                                        {active && <Check size={14} className="shrink-0" />}
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>
             )}
             
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

        <div ref={sidebarScrollRef} onScroll={(e) => setShowTopBtn((e.target as HTMLElement).scrollTop > 120)} className="flex-1 overflow-y-auto p-6 space-y-5 custom-scrollbar bg-black/20">
            <div className="flex items-center justify-between mb-2">
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
                <div className="p-4 bg-[var(--accent)]/5 rounded-xl border border-[var(--accent)]/10 text-[11px] text-[var(--accent)]/60 leading-relaxed italic">
                    {t('wfTip')}
                </div>
            )}

            {timingRows}
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
          outputLatencyMs={outputLatencyMs}
          onChange={updateSettings}
          onReset={handleResetSettings}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}

export default App;