
import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { AudioData, ViewState, TimingPoint } from '../types';
import { computeFFT, getHannWindow } from '../utils/audioUtils';
import { precomputeSpectrogram, PrecomputedSpectrogram, u8ToVal } from '../utils/spectrogramPrecompute';
import { buildSpectrogramLUT, SPECTRO_LUT_FREQ, SPECTRO_LUT_SHIFT } from '../utils/settings';
import { getPointAtTime } from '../utils/timingUtils';
import { t } from '../utils/i18n';

// ===== dB 量化表（频谱兜底路径用）=====
// 没有整曲预计算数据时，每列每行都要算一次 20*Math.log10(mag)：一屏 2134 列 × 1282 行
// = 2.7M 次 log10，实测光这一步就 60ms —— 瞬跳翻页那个 80~130ms 长帧主要是它。
// 而最终只取 256 档颜色强度，所以把「Float32 位模式的高 16 位」直接映射成强度档即可：
// 每行只剩一次 float→bits 的位转换 + 一次 Uint8 查表（实测同等工作量 25ms → 6ms 级）。
const BITS_BUF = new ArrayBuffer(4);
const BITS_F32 = new Float32Array(BITS_BUF);
const BITS_U32 = new Uint32Array(BITS_BUF);
const buildDbQuant = (sensitivity: number): Uint8Array => {
    const table = new Uint8Array(65536);
    const sens = Math.max(1, sensitivity);
    for (let k = 0; k < 65536; k++) {
        BITS_U32[0] = k << 16; // 高 16 位 = 表索引，低 16 位补 0（幅值略偏小，误差 < 0.03dB）
        const db = 20 * Math.log10(BITS_F32[0] + 1e-9);
        const val = (db + sens) / sens;
        const qv = (val <= 0 ? 0 : val >= 1 ? 1 : val) * 255;
        table[k] = (qv + 0.5) | 0;
    }
    return table;
};

interface VisualizerProps {
  audioData: AudioData | null;
  currentTime: number;
  viewState: ViewState;
  timingPoints: TimingPoint[];
  onUpdateBpm: (beatIndex: number, bpm: number) => void;
  onUpdateOffset: (offset: number) => void;
  onSeek: (time: number) => void;
  onScrollChange: (scrollLeft: number) => void; // 拖拽平移时间轴
  onSectionClick: (pointId: string) => void;    // 点击红色小节线（段起点）→ 配置面板跳转对应段落
  width: number;
  height: number;
  specLogBase: number; // New prop for logarithmic scaling
  getPlayheadTime: () => number; // 实时读取播放头位置（秒），供独立播放头层高频绘制
  waveColor: string;   // 波形图颜色（设置中可替换）
  specPalette: string; // 频谱配色方案 id（foobar/fire/ice/rainbow/.../custom）
  specCustom: [string, string, string]; // 自定义频段颜色 [低, 中, 高]，palette=custom 时生效
  peakThreshold: number; // 峰值阈值：超过该强度的信号进入峰值突出
  peakColor: string;     // 峰值颜色（超过阈值后过渡到的颜色）
  specInvert: boolean;   // 频谱垂直倒转（低频在上/高频在下）
  renderDpr: number;     // 渲染缩放比（性能优先时 ≤1，核显/独显笔记本减负）
  specFFTSize: number;   // 频谱 FFT 精度（采样点数，2 的幂：512/1024/2048/4096，越大频率分辨率越高）
  specSensitivity: number; // 频谱显示灵敏度（dB 阈值，60~120，越小越敏感）
  beatLineDelaySec: number; // 红线节拍线延迟补偿（秒，±由用户微调）：仅偏移刻度显示位置，不影响频谱/声谱时间轴
  onUpdateSectionTime?: (id: string, sec: number) => void; // 拖动红色段起点 → 直接改该红线的绝对时间戳（红线位置独立）
}

// FFT 采样点数不再固定：由设置 specFFTSize 控制（1024~8192，越大频率分辨率越高）
const TIMELINE_HEIGHT = 40; 

const Visualizer: React.FC<VisualizerProps> = ({
  audioData,
  currentTime,
  viewState,
  timingPoints,
  onUpdateBpm,
  onUpdateOffset,
  onSeek,
  onScrollChange,
  onSectionClick,
  width,
  height,
  specLogBase,
  getPlayheadTime,
  waveColor,
  specPalette,
  specCustom,
  peakThreshold,
  peakColor,
  specInvert,
  renderDpr,
  specFFTSize,
  specSensitivity,
  beatLineDelaySec,
  onUpdateSectionTime,
}) => {
  const waveformRef = useRef<HTMLCanvasElement>(null);
  const spectrogramRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  // ★ v0.8.19：播放头不再是 canvas，而是一个 14px 宽的合成层 div。
  //   原因：整窗尺寸的 canvas（2134×1282 ≈ 10.4MB）即便只改 13px 一列，Chromium 也要把
  //   **整张位图**重新上传给合成器（软件光栅化 + 无部分上传）→ 每秒 60 次 × 10.4MB ≈ 600MB/s，
  //   核显共享内存带宽直接被吃满，实测呈现帧率只有 ~25fps。
  //   换成 DOM 元素后用 transform 定位：合成器只移动已有图层，不重光栅也不上传纹理，
  //   可以稳定跑满屏幕刷新率（120Hz 也跟得上），并且把带宽让给频谱/波形。
  const playheadRef = useRef<HTMLDivElement>(null);

  const [dragging, setDragging] = useState<{ 
      type: 'offset' | 'bpm' | 'redline'; // redline = 拖动红色段起点（改它自己的时间戳）
      pointIndex: number; // type=redline 时为段起点下标；type=bpm 时为要改 BPM 的段下标
      beatIndex: number; 
      startX: number; 
      initialVal: number; 
  } | null>(null);

  // 频谱/波形区的拖拽平移状态：按下起点 + 起始滚动位置 + 是否已超过点击阈值
  const [panState, setPanState] = useState<{ startX: number; startScrollLeft: number; moved: boolean } | null>(null);

  const intWidth = Math.floor(width);
  const intHeight = Math.floor(height);

  // ===== 固定 1080p 渲染 =====
  // 位图宽度恒为 1920 设备像素（本机 16:10 → 1920×1131），与窗口大小 / 屏幕缩放 / 显卡无关。
  // 本机是 2880×1800 @200%：devicePixelRatio=2 时原版每层要建 2774×1634 ≈ 450 万像素的位图，
  // 4 层叠加把主存和核显共享显存一起打穿（可用内存常年 <1GB）→ 拖拽就卡。
  // 锁到 1920 宽后每层 217 万像素（−52%），且分辨率是「固定值」而非随屏幕浮动，
  // 观感稳定、性能可预期。renderDpr 只是用户侧清晰度微调倍率（默认 1.0 = 正好 1080p）。
  const RENDER_LOCK_WIDTH = 1920;
  const dprEff = Math.max(0.5, Math.min(2, (RENDER_LOCK_WIDTH / Math.max(1, intWidth)) * (renderDpr || 1)));
  
  const availableHeight = Math.max(0, intHeight - TIMELINE_HEIGHT);
  const waveHeight = Math.floor(availableHeight * 0.5);
  const specHeight = availableHeight - waveHeight;

  // 时间 ↔ 像素映射（0.7.9 原版：无任何延迟补偿，频谱/波形/刻度尺均按真实时间）
  const timeToX = (t: number) => (t * viewState.zoom) - viewState.scrollLeft;
  const xToTime = (x: number) => (x + viewState.scrollLeft) / viewState.zoom;

  const hannWindow = useMemo(() => getHannWindow(specFFTSize), [specFFTSize]);

  // 频谱色表（LUT）：只在配色参数变化时重建一次。
  // 绘制时每像素从「一次 spectrogramColor 调用（闭包/数组分配 + pow + hex 解析）」
  // 降为「一次 Uint32 数组查表」——这是低配机上消除频谱拖拽卡顿的关键。
  const colorLut = useMemo(
    () => buildSpectrogramLUT(specPalette, specCustom, peakThreshold, peakColor),
    [specPalette, specCustom, peakThreshold, peakColor]
  );
  // 兜底路径的 dB → 颜色强度查表（只在灵敏度变化时重建，2ms 级）
  const dbQuant = useMemo(() => buildDbQuant(specSensitivity), [specSensitivity]);

  // ===== 平移复用（快速滚动优化）：记录上次绘制参数，仅重绘露出边缘）=====
  const waveLastRef = useRef<{ zoom: number; scrollLeft: number; waveColor: string; w: number; h: number } | null>(null);
  const specLastRef = useRef<{ zoom: number; scrollLeft: number; specLogBase: number; specPalette: string; specCustom: string; peakThreshold: number; peakColor: string; specInvert: boolean; specSensitivity: number; w: number; h: number; pre: PrecomputedSpectrogram | null } | null>(null);
  const overlayLastRef = useRef<{ zoom: number; scrollLeft: number; w: number; h: number; delay: number; points: TimingPoint[] } | null>(null);

  // ===== 缩放预览：缩放期间不重绘，只做合成层变换 =====
  // 实测（本机 2880×1800@200%、Radeon 780M 核显、物理内存仅 6.8GB）：
  //   一次整幅重绘耗时 0.6~2.0 秒，其中 **JS 只占约 40ms**，
  //   其余全在 GPU 进程——对这一叠 1920×1153 的 canvas 做光栅 + 纹理上传（GPU 进程吃满一核）。
  // 这是核显共享系统内存 + 显存不足导致的「CPU/GPU 调度」瓶颈，靠优化脚本无解。
  // 对策：缩放时先用旧位图做 CSS 变换预览（合成层 scaleX，不触发重新光栅，代价≈0），
  //   等停止缩放 160ms 后再整幅重绘一次。交互路径上不再有秒级卡死。
  const [zoomSettling, setZoomSettling] = useState(false);
  const zoomSettleTimer = useRef<number | null>(null);
  const firstZoomEffect = useRef(true);
  // 允许绘制的 zoom：缩放停手后才追平；绘制 effect 用 ref 判断（当帧即生效，不依赖 state 延迟）
  const drawZoomRef = useRef(viewState.zoom);
  const [drawTick, setDrawTick] = useState(0);
  useEffect(() => {
    if (firstZoomEffect.current) { firstZoomEffect.current = false; drawZoomRef.current = viewState.zoom; return; }
    if (zoomSettleTimer.current !== null) window.clearTimeout(zoomSettleTimer.current);
    setZoomSettling(true);
    zoomSettleTimer.current = window.setTimeout(() => {
      zoomSettleTimer.current = null;
      drawZoomRef.current = viewState.zoom; // 允许绘制
      setZoomSettling(false);               // 清掉预览变换
      setDrawTick(t => t + 1);              // 触发一次整幅重绘
    }, 160);
    return () => {
      if (zoomSettleTimer.current !== null) { window.clearTimeout(zoomSettleTimer.current); zoomSettleTimer.current = null; }
    };
  }, [viewState.zoom]);

  const previewEls = (): HTMLCanvasElement[] =>
    [waveformRef.current, spectrogramRef.current, overlayRef.current].filter(Boolean) as HTMLCanvasElement[];

  // 应用 / 清除预览变换（transform 只影响合成，不重新光栅化位图）
  useEffect(() => {
    const last = specLastRef.current;
    const els = previewEls();
    const previewing = !!last && viewState.zoom !== drawZoomRef.current;
    if (!previewing || !last) {
      // 只清变换、**保留** will-change：反复摘掉提升标记会让合成器重新光栅化整层（实测更卡）
      for (const el of els) { if (el.style.transform) { el.style.transform = ''; } }
      return;
    }
    // ★ 关键：预览缩放必须限幅。合成器对「静态 transform 改变」会按新倍率重新光栅化整层，
    //   scaleX(8.9) 等于要把 1920×1153 的层按 8.9 倍重新铺一遍 → 实测直接卡 3~4 秒。
    //   限在 ±35% 以内时属于合成器免光栅化的安全范围，看起来仍是平滑缩放；
    //   超出部分不跟手（画面停住），160ms 后整幅重绘自然追上。
    const rawScale = viewState.zoom / last.zoom;
    const scale = Math.max(0.74, Math.min(1.35, rawScale));
    const tx = last.scrollLeft * scale - viewState.scrollLeft;
    for (const el of els) {
      el.style.transformOrigin = '0 0';
      el.style.willChange = 'transform';
      el.style.transform = `translateX(${tx.toFixed(2)}px) scaleX(${scale.toFixed(4)})`;
    }
  }, [viewState.zoom, viewState.scrollLeft, zoomSettling, drawTick]);

  const tmpCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // 获取共享中转 canvas（自 drawImage 中转，避免同 canvas 自绘的兼容性问题）
  const getTmp = (w: number, h: number): HTMLCanvasElement => {
    let tmp = tmpCanvasRef.current;
    if (!tmp) { tmp = document.createElement('canvas'); tmpCanvasRef.current = tmp; }
    if (tmp.width !== w) tmp.width = w;
    if (tmp.height !== h) tmp.height = h;
    return tmp;
  };

  // ===== 频谱 FFT 列缓存（键=sampleIdx，跳转/缩放时复用已计算列，避免重复 FFT）=====
  const specCacheRef = useRef<Map<number, Uint32Array>>(new Map());
  // 位图缓冲 / 列缓冲复用：原先每列 new Uint32Array(fullHeight)、每次重绘 createImageData(整幅8.8MB)，
  // 缩放时一秒能产生上百 MB 垃圾 → V8 大 GC + 内存吃紧的机器换页，实测出现 3~4 秒停顿。
  const specBufRef = useRef<Map<number, { h: number; idata: ImageData; u32: Uint32Array }>>(new Map());
  const colPoolRef = useRef<Uint32Array[]>([]);
  // 缓存上限不再写死 3000 列，而是按字节预算动态算（见频谱 effect）：
  // 3000 列 × 每列 fullHeight×4B 在 200% 缩放下就是 ~10MB 常驻，内存紧张的机器会被这一步拖累。
  const specCacheLimitRef = useRef(1200);
  // 频谱分帧渲染调度（首次/跳转全量渲染分批完成，不卡主线程）
  const specRafRef = useRef<number | null>(null);
  const cancelSpecRender = () => {
    if (specRafRef.current !== null) { cancelAnimationFrame(specRafRef.current); specRafRef.current = null; }
  };
  useEffect(() => () => cancelSpecRender(), []);

  // ===== 原生 FFT 频谱数据（GitHub 主流方案）：audioData/精度变化后后台预计算整曲频谱 =====
  // 绘制时直接从预计算 dB 列做频率映射（零 FFT 计算）；预计算失败/未完成时回退 JS FFT
  const [specData, setSpecData] = useState<PrecomputedSpectrogram | null>(null);
  const specPreTokenRef = useRef(0);
  // ★ v0.8.14：预计算调度（串行 + 只保留最新）—— 与侧栏 renderer/viz.js 同一套逻辑。
  //   一次预计算要建「整曲长度」的 OfflineAudioContext 并渲染到底（10 分钟谱 ≈ 300MB），
  //   而离线渲染**无法取消**：旧写法只要 [audioData, specFFTSize] 变化就无条件再起一个，
  //   连续换歌/连续改精度时多个整曲渲染会叠着跑（侧栏同类写法实测：10 次快速连切 = 并发 10、+1.6GB）。
  const specRunningRef = useRef(false);
  const specPendingRef = useRef<{ buffer: Parameters<typeof precomputeSpectrogram>[0]; fft: number; token: number } | null>(null);
  const specPumpRef = useRef<() => void>(() => { /* 初始化，下面立即赋值 */ });
  // 调度器：同一时刻只允许一次整曲离线渲染在跑，排队中的任务会被最新的覆盖。
  // 每跑完一次自动去取最新那份 → 连续换歌/连续改精度时只有最后一张真正被计算。
  specPumpRef.current = () => {
    if (specRunningRef.current || !specPendingRef.current) return;
    const job = specPendingRef.current;
    specPendingRef.current = null;
    specRunningRef.current = true;
    precomputeSpectrogram(job.buffer, job.fft).then((data) => {
      // 期间又换了音频/精度 → 这份结果已过期，直接丢掉（渲染本身无法中断）
      if (job.token === specPreTokenRef.current) {
        specCacheRef.current.clear(); // 新数据源（偏移/精度/歌曲变化）旧列作废，防缓存污染
        setSpecData(data);
      }
    }).catch((e) => { console.warn('[spec] 整曲预计算失败，改用逐列 FFT：', e?.message || e); })
      .then(() => {
        specRunningRef.current = false;
        specPumpRef.current(); // 有任务在等 → 接着算最新的那份
      });
  };

  useEffect(() => {
    const token = ++specPreTokenRef.current;
    setSpecData(null); // 切换音频/精度先清空，绘制回退 JS FFT（避免旧数据错位）
    if (!audioData) { specPendingRef.current = null; return; }
    // ★ 长曲跳过整曲预计算：预计算要把整首歌塞进 OfflineAudioContext（7 分钟立体声 ≈ 150MB+，
    //   渲染期间还要翻倍），本机物理内存只有 6.8GB、可用常年 1~2GB，实测会直接卡死在
    //   GPU/内存换页上（一次 3~4 秒停顿）。而逐列 JS FFT 单列只要 ~24µs（1920 列 ≈ 46ms，
    //   且列缓存命中后为 0），对 4 分钟以上的曲子完全够用，省下的是几百 MB 内存。
    if (audioData.duration > 240) { specPendingRef.current = null; return; }
    specPendingRef.current = { buffer: audioData.buffer, fft: specFFTSize, token };
    specPumpRef.current();
    return () => { specPendingRef.current = null; };
  }, [audioData, specFFTSize]);

  // 切换音频文件时重置平移缓存（强制全量重绘，避免残留旧歌曲内容）
  useEffect(() => {
    waveLastRef.current = null;
    specLastRef.current = null;
    overlayLastRef.current = null;
  }, [audioData]);

  // --- Draw Waveform（平移复用：滚动时只重绘露出边缘，大幅降低拖动卡顿）---
  useEffect(() => {
    const canvas = waveformRef.current;
    if (!canvas || !audioData || intWidth <= 0 || waveHeight <= 0) return;
    if (viewState.zoom !== drawZoomRef.current) return; // 缩放中：先走 CSS 变换预览，停手 160ms 后再整幅重绘
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = dprEff;
    const newW = Math.floor(intWidth * dpr);
    const newH = Math.floor(waveHeight * dpr);
    canvas.style.width = `${intWidth}px`;
    canvas.style.height = `${waveHeight}px`;
    // 只在尺寸变化时重置画布（否则会清空内容，破坏平移复用）
    if (canvas.width !== newW) canvas.width = newW;
    if (canvas.height !== newH) canvas.height = newH;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const rawData = audioData.buffer.getChannelData(0);
    const step = Math.ceil(audioData.buffer.sampleRate / viewState.zoom);
    const centerY = waveHeight / 2;
    const ampScale = waveHeight / 2;
    const startTime = Math.max(0, xToTime(0));
    const endTime = Math.min(audioData.duration, xToTime(intWidth));

    // 绘制 [x0, x1) 区间的波形列
    const drawColumns = (x0: number, x1: number) => {
        const s0 = Math.max(0, Math.floor(x0));
        const s1 = Math.min(intWidth, Math.ceil(x1));
        if (s1 <= s0) return;
        ctx.beginPath();
        ctx.strokeStyle = waveColor;
        ctx.lineWidth = 1;
        for (let x = s0; x < s1; x++) {
            const t = xToTime(x);
            const sampleIdx = Math.floor(t * audioData.buffer.sampleRate);
            if (sampleIdx < 0 || sampleIdx >= rawData.length) continue;
            let min = 1.0, max = -1.0;
            const chunkEnd = Math.min(sampleIdx + step, rawData.length);
            const stride = Math.max(1, Math.floor((chunkEnd - sampleIdx) / 10));
            for (let i = sampleIdx; i < chunkEnd; i += stride) {
                const val = rawData[i];
                if (val < min) min = val;
                if (val > max) max = val;
            }
            if (min > max) { min = 0; max = 0; }
            ctx.moveTo(x, centerY + min * ampScale);
            ctx.lineTo(x, centerY + max * ampScale);
        }
        ctx.stroke();
    };

    const last = waveLastRef.current;
    const sameParams = last && last.zoom === viewState.zoom && last.waveColor === waveColor
        && last.w === intWidth && last.h === waveHeight;
    const dx = last ? Math.round(last.scrollLeft - viewState.scrollLeft) : 0;

    if (sameParams && dx === 0) return; // 视口没动 → 一列都不用重画

    if (sameParams && dx !== 0 && Math.abs(dx) < intWidth) {
        // 平移复用：旧内容整体平移 dx，只重绘露出的边缘条（源矩形须用 device 像素=tmp 全尺寸）
        const tmp = getTmp(canvas.width, canvas.height);
        const tctx = tmp.getContext('2d')!;
        tctx.clearRect(0, 0, tmp.width, tmp.height);
        tctx.drawImage(canvas, 0, 0);
        ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, dx, 0, intWidth, waveHeight);
        if (dx > 0) { ctx.fillStyle = '#0a0a0a'; ctx.fillRect(0, 0, dx, waveHeight); drawColumns(0, dx); }
        else { ctx.fillStyle = '#0a0a0a'; ctx.fillRect(intWidth + dx, 0, -dx, waveHeight); drawColumns(intWidth + dx, intWidth); }
    } else {
        // 全量重绘
        ctx.fillStyle = '#0a0a0a';
        ctx.fillRect(0, 0, intWidth, waveHeight);
        ctx.beginPath();
        ctx.strokeStyle = '#1a1a1a';
        ctx.lineWidth = 1;
        ctx.moveTo(0, centerY);
        ctx.lineTo(intWidth, centerY);
        ctx.stroke();
        drawColumns(Math.floor(Math.max(0, timeToX(startTime))), Math.ceil(Math.min(intWidth, timeToX(endTime))));
    }
    waveLastRef.current = { zoom: viewState.zoom, scrollLeft: viewState.scrollLeft, waveColor, w: intWidth, h: waveHeight };
  }, [audioData, viewState, intWidth, waveHeight, waveColor, dprEff, drawTick]);

  // --- Draw Spectrogram（平移复用：滚动时只重算露出边缘的 FFT 列，消除拖动卡顿）---
  useEffect(() => {
    const sCanvas = spectrogramRef.current;
    if (!sCanvas || !audioData || intWidth <= 0 || specHeight <= 0) return;
    if (viewState.zoom !== drawZoomRef.current) return; // 缩放中：先走 CSS 变换预览，停手 160ms 后再整幅重绘
    const ctx = sCanvas.getContext('2d');
    if (!ctx) return;

    const dpr = dprEff;
    const fullWidth = Math.floor(intWidth * dpr);
    const fullHeight = Math.floor(specHeight * dpr);
    // 只在尺寸变化时重置画布（否则会清空内容，破坏平移复用）
    if (sCanvas.width !== fullWidth) sCanvas.width = fullWidth;
    if (sCanvas.height !== fullHeight) sCanvas.height = fullHeight;
    sCanvas.style.width = `${intWidth}px`;
    sCanvas.style.height = `${specHeight}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // 之后用 CSS 像素坐标操作

    const rawData = audioData.buffer.getChannelData(0);
    const sampleRate = audioData.buffer.sampleRate;
    const input = new Float32Array(specFFTSize);
    const numBins = specFFTSize / 2;
    const base = specLogBase;

    // ===== 行映射预计算（性能核心）=====
    // 频率→bin 的映射只与 y（行）有关，与 x（列）完全无关。原先每个像素都重算一次
    // Math.pow + 除法，一屏 224 万像素就是 224 万次 pow。这里按行算一次，绘制时只查表。
    // 列缓存按字节预算定上限（约 4MB）：缓存只为「跳转/缩放少算几列」服务，不值得吃满内存。
    const colBytes = Math.max(1, fullHeight * 4);
    specCacheLimitRef.current = Math.max(512, Math.min(3000, Math.floor((8 * 1024 * 1024) / colBytes)));
    const rowB0 = new Int32Array(fullHeight);
    const rowB1 = new Int32Array(fullHeight);
    const rowFrac = new Float32Array(fullHeight);
    const rowFq = new Int32Array(fullHeight); // 频率档（0~511），用作色表下标
    const freqScale = numBins > 1 ? 1 / (numBins - 1) : 0;
    for (let y = 0; y < fullHeight; y++) {
        const yNorm = specInvert ? 1 - y / fullHeight : y / fullHeight;
        const binF = base <= 1
            ? yNorm * (numBins - 1)
            : ((Math.pow(base, yNorm) - 1) / (base - 1)) * (numBins - 1);
        const b0 = Math.floor(binF);
        const b1 = Math.min(numBins - 1, b0 + 1);
        rowB0[y] = b0;
        rowB1[y] = b1;
        rowFrac[y] = binF - b0;
        const fq = Math.round(b0 * freqScale * (SPECTRO_LUT_FREQ - 1));
        rowFq[y] = fq < 0 ? 0 : fq > SPECTRO_LUT_FREQ - 1 ? SPECTRO_LUT_FREQ - 1 : fq;
    }
    // 量化 dB（0~255）→ 显示强度档（0~255）的映射表：灵敏度变化时重建，每像素只查表
    const valQ = new Uint8Array(256);
    for (let q = 0; q < 256; q++) {
        const vv = u8ToVal(q, specSensitivity) * 255;
        valQ[q] = vv <= 0 ? 0 : vv >= 255 ? 255 : (vv + 0.5) | 0;
    }
    const lut = colorLut;

    // ===== 单列构建（列缓存命中直接返回；否则算好并写入缓存）=====
    // ★ v0.8.21：绘制与「下一页预取」共用这一份逻辑 —— 预取只算列、不碰 ImageData。
    const buildColumn = (sampleIdx: number): Uint32Array => {
        const hit = specCacheRef.current.get(sampleIdx);
        if (hit) return hit;
        let col = colPoolRef.current.pop();
        if (!col || col.length !== fullHeight) col = new Uint32Array(fullHeight);
        // 优先使用原生 FFT 预计算数据（specData，AnalyserNode 提取的量化 dB 列），零 FFT 计算
        const pre = specData;
        let preCol0: Uint8Array | null = null;
        let preCol1: Uint8Array | null = null;
        let preFrac = 0;
        if (pre && pre.data.length > 0) {
            const blockF = sampleIdx / pre.hop;
            const b0 = Math.floor(blockF);
            preCol0 = pre.data[b0] ?? null;
            preCol1 = pre.data[b0 + 1] ?? preCol0;
            preFrac = blockF - b0;
        }
        if (preCol0) {
            const c0 = preCol0;
            const c1 = preCol1 as Uint8Array;
            const w1 = preFrac;
            const w0 = 1 - preFrac;
            for (let y = 0; y < fullHeight; y++) {
                const b0 = rowB0[y];
                const b1 = rowB1[y];
                const bFrac = rowFrac[y];
                // 双线性插值：先按频率方向混合相邻 bin（两列各自），再按时间方向混合相邻列
                const vF0 = c0[b0] * (1 - bFrac) + c0[b1] * bFrac;
                const vF1 = c1[b0] * (1 - bFrac) + c1[b1] * bFrac;
                const v = vF0 * w0 + vF1 * w1;
                col[y] = lut[(valQ[(v + 0.5) | 0] << SPECTRO_LUT_SHIFT) | rowFq[y]];
            }
        } else {
            // 兜底：JS FFT（预计算未完成 / 长曲跳过整曲预计算时）
            for (let i = 0; i < specFFTSize; i++) input[i] = rawData[sampleIdx + i] * hannWindow[i];
            const magnitudes = computeFFT(input);
            for (let y = 0; y < fullHeight; y++) {
                const b0 = rowB0[y];
                const b1 = rowB1[y];
                const bFrac = rowFrac[y];
                const mag = magnitudes[b0] * (1 - bFrac) + magnitudes[b1] * bFrac;
                // 显示阈值 specSensitivity dB（灵敏度可调，越小越敏感）→ 查表代替 log10
                BITS_F32[0] = mag;
                col[y] = lut[(dbQuant[BITS_U32[0] >>> 16] << SPECTRO_LUT_SHIFT) | rowFq[y]];
            }
        }
        const cache = specCacheRef.current;
        cache.set(sampleIdx, col);
        if (cache.size > specCacheLimitRef.current) {
            const oldest = cache.keys().next().value;
            if (oldest !== undefined) {
                const dead = cache.get(oldest);
                cache.delete(oldest);
                // 回收列缓冲（限量，避免池子无限长）
                if (dead && dead.length === fullHeight && colPoolRef.current.length < 128) {
                    colPoolRef.current.push(dead);
                }
            }
        }
        return col;
    };

    // 计算 [x0, x1)（CSS 像素）区间的频谱列并写入画布
    const drawSpecRegion = (x0: number, x1: number) => {
        const px0 = Math.max(0, Math.floor(x0 * dpr));
        const px1 = Math.min(fullWidth, Math.ceil(x1 * dpr));
        if (px1 <= px0) return;
        const colW = px1 - px0;
        // 复用同宽度的 ImageData（尺寸不变时零分配）
        let entry = specBufRef.current.get(colW);
        if (!entry || entry.h !== fullHeight) {
            const idata = ctx.createImageData(colW, fullHeight);
            entry = { h: fullHeight, idata, u32: new Uint32Array(idata.data.buffer) };
            specBufRef.current.set(colW, entry);
        }
        const idata = entry.idata;
        const buf = entry.u32;
        for (let px = 0; px < colW; px++) {
            const t = xToTime((px0 + px) / dpr);
            if (t < 0 || t >= audioData.duration) continue;
            const sampleIdx = Math.floor(t * sampleRate);
            if (sampleIdx < 0 || sampleIdx + specFFTSize >= rawData.length) continue;
            // 缓存列按自然 y 顺序存储（顶部 y=0 → 低频）；复制到 ImageData 时做一次行反转
            const col = buildColumn(sampleIdx);
            for (let y = 0; y < fullHeight; y++) {
                buf[y * colW + px] = col[fullHeight - 1 - y];
            }
        }
        ctx.putImageData(idata, px0, 0);
    };

    const last = specLastRef.current;
    // 「渲染参数」= 影响单列像素结果的东西（配色/对数刻度/灵敏度/尺寸/FFT）。
    // 缩放**不属于**渲染参数：列缓存键是 sampleIdx，与 zoom 无关，缩放时清空等于把
    // 4MB 已算好的列全扔进 GC（每次缩放一次 → GC 抖动的主要原因）。
    const sameRender = last && last.specLogBase === specLogBase
        && last.specPalette === specPalette && last.specCustom === specCustom.join(',')
        && last.peakThreshold === peakThreshold && last.peakColor === peakColor && last.specInvert === specInvert
        && last.specSensitivity === specSensitivity
        && last.w === intWidth && last.h === specHeight;
    if (!sameRender) {
        specCacheRef.current.clear();
        specBufRef.current.clear();
        colPoolRef.current.length = 0;
    }
    const sameZoom = last ? last.zoom === viewState.zoom : false;
    const dx = last ? Math.round(last.scrollLeft - viewState.scrollLeft) : 0;
    // 预计算数据到达/失效会改变像素结果（双线性插值 vs JS FFT 兜底），必须重画
    const sameSource = last ? last.pre === specData : false;

    if (sameRender && sameZoom && sameSource && dx === 0) return; // 视口和数据源都没变 → 不重画

    if (sameRender && sameZoom && dx !== 0 && Math.abs(dx) < intWidth) {
        // 平移复用：旧内容平移 dx，只重算露出的边缘列
        const tmp = getTmp(fullWidth, fullHeight);
        const tctx = tmp.getContext('2d')!;
        tctx.clearRect(0, 0, fullWidth, fullHeight);
        tctx.drawImage(sCanvas, 0, 0);
        ctx.drawImage(tmp, 0, 0, fullWidth, fullHeight, dx, 0, intWidth, specHeight);
        if (dx > 0) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, dx, specHeight); drawSpecRegion(0, dx); }
        else { ctx.fillStyle = '#000'; ctx.fillRect(intWidth + dx, 0, -dx, specHeight); drawSpecRegion(intWidth + dx, intWidth); }
    } else {
        // 全量重绘：分帧渐进渲染（每帧一批列，避免一次算完整的 FFT 卡死主线程）
        cancelSpecRender();
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, intWidth, specHeight);
        // 每帧处理的 device 列数：查表化后单列成本极低，可放大批量、缩短首次绘制时间。
        // 但「原生 FFT 还没预计算完」时走的是 JS FFT 兜底，单列贵 50 倍以上，
        // 这时必须把批量压回去，否则等待期每一帧都是几十毫秒的卡顿。
        // 【实测结论】分批反而更慢：每 putImageData 一次，整幅 1920×1153 纹理就要重传一次，
        // 分批 10 次 ≈ 10 倍合成开销（实测 2000ms → 单批 650ms）。所以有预计算数据时一次画完。
        // 只有「原生 FFT 还没算完、走 JS FFT 兜底」时才分小批，避免每帧几十毫秒卡顿。
        // 【实测】兜底路径单批 48 列只要 ~2ms（FFT 查表化后并不贵），但一屏 1920 列要 40 帧才画完，
        // 每次缩放都重启这个长尾 → 观感就是「缩放后画面一格一格往上爬」。直接一次画完。
        const batchPx = fullWidth;
        let cur = 0;
        const step = () => {
            if (cur >= fullWidth) { specRafRef.current = null; return; }
            const next = Math.min(fullWidth, cur + batchPx);
            drawSpecRegion(cur / dpr, next / dpr);
            cur = next;
            specRafRef.current = requestAnimationFrame(step);
        };
        specRafRef.current = requestAnimationFrame(step);
    }
    specLastRef.current = {
        zoom: viewState.zoom, scrollLeft: viewState.scrollLeft, specLogBase,
        specPalette, specCustom: specCustom.join(','), peakThreshold, peakColor, specInvert,
        specSensitivity,
        w: intWidth, h: specHeight,
        pre: specData,
    };
  }, [audioData, viewState, intWidth, specHeight, hannWindow, specLogBase, specPalette, specCustom, peakThreshold, peakColor, specInvert, dprEff, specData, specSensitivity, colorLut, dbQuant, drawTick]);

  // --- Draw Overlay（对照源码渲染方案；平移复用以降低拖动卡顿）---
  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas || intWidth <= 0 || intHeight <= 0) return;
    if (viewState.zoom !== drawZoomRef.current) return; // 缩放中：先走 CSS 变换预览，停手 160ms 后再整幅重绘
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = dprEff;
    const newW = Math.floor(intWidth * dpr);
    const newH = Math.floor(intHeight * dpr);
    // 只在尺寸变化时重置画布（否则会清空内容，破坏平移复用）
    if (canvas.width !== newW) canvas.width = newW;
    if (canvas.height !== newH) canvas.height = newH;
    canvas.style.width = `${intWidth}px`;
    canvas.style.height = `${intHeight}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 绘制 [x0, x1) 区间的刻度尺 + 拍线
    // ★ 低配机适配：原先「每根线 / 每个箭头」都单独 beginPath + stroke + fill ——
    //   整曲缩略时一屏能有上千根拍线，等于上千次状态切换 + 描边 + 填充，主线程直接被拖死。
    //   现在改成「按样式分组收集坐标 → 每组只 stroke/fill 一次」，绘制调用从上千降到个位数。
    const drawOverlayRegion = (x0: number, x1: number) => {
        const startTime = xToTime(0);
        const endTime = xToTime(intWidth);
        ctx.textAlign = 'center';
        const sceneBottom = waveHeight + specHeight;
        const arrowY0 = sceneBottom + 6;

        // ---- 顶部时间刻度尺 ----
        const RULER_H = 22;
        const targetStepPx = 80;
        const rawStepSec = targetStepPx / viewState.zoom;
        const stepSec = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
            .find(s => s >= rawStepSec) || 600;
        const startSec = Math.floor(startTime / stepSec) * stepSec;
        const tickXs: number[] = [];
        const tickLabels: { x: number; text: string }[] = [];
        for (let sec = startSec; sec <= endTime; sec += stepSec) {
            const x = timeToX(sec);
            if (x < x0 - 60 || x > x1 + 60) continue;
            tickXs.push(x);
            const mm = Math.floor(sec / 60);
            const ss = (sec % 60).toFixed(stepSec < 1 ? 1 : 0);
            tickLabels.push({ x, text: `${mm}:${ss.padStart(stepSec < 1 ? 4 : 2, '0')}` });
        }
        if (tickXs.length) {
            ctx.beginPath();
            ctx.strokeStyle = 'rgba(255,255,255,0.10)';
            ctx.lineWidth = 1;
            for (const x of tickXs) { ctx.moveTo(x, RULER_H); ctx.lineTo(x, intHeight); }
            ctx.stroke();
            ctx.font = '10px sans-serif';
            ctx.fillStyle = 'rgba(255,255,255,0.5)';
            for (const l of tickLabels) ctx.fillText(l.text, l.x, 14);
        }

        // ===== 刻度绘制（v0.7.18）=====
        // 红线 = 段起点（每条红线自带 BPM，位置由红线的绝对时间决定，改 BPM 不会挪动下一条红线）
        // 蓝线 = 节拍线：每拍一条，间距 = 60 / 该红线自己的 BPM（BPM 只和蓝线距离关联）
        // 绘制顺序：先红后蓝 —— 红蓝重合时蓝线叠加在红线上，红线不会盖住蓝线
        const redXs: number[] = [];
        const strongXs: number[] = [];
        const weakXs: number[] = [];
        const weakArrowXs: number[] = [];
        const strongArrowXs: number[] = [];
        const redLabels: { x: number; text: string }[] = [];
        const beatLabels: { x: number; text: string }[] = [];
        // 段起点时间集合（用于避免蓝线编号与红色段起点编号文字重叠）
        const sectionStartSet = new Set(timingPoints.map(p => Math.round((p.time + beatLineDelaySec) * 1000)));

        // ---- 第一遍：红色段起点（2px）----
        for (let i = 0; i < timingPoints.length; i++) {
            const point = timingPoints[i];
            const x = timeToX(point.time + beatLineDelaySec);
            if (x < x0 - 2 || x > x1 + 2) continue;
            redXs.push(x);
            redLabels.push({ x, text: point.beatIndex.toString() }); // 红色段起点标全局拍号
        }

        // ---- 第二遍：蓝色节拍线（每拍一条，密度由该段 BPM 决定）----
        for (let i = 0; i < timingPoints.length; i++) {
            const point = timingPoints[i];
            const nextPoint = timingPoints[i+1];
            const sectionEndTime = nextPoint ? nextPoint.time : audioData!.duration;
            if (sectionEndTime < startTime) continue;
            if (point.time > endTime) break;
            const interval = 60 / point.bpm;
            // 拍线在屏幕上的间距：太密时箭头/数字会糊成一片，既看不清又白耗性能
            const beatPx = interval * viewState.zoom;
            const showArrow = beatPx >= 7;
            const showBeatLabel = beatPx >= 22;
            const visibleStart = Math.max(startTime, point.time);
            const timeOffsetFromPoint = visibleStart - point.time;
            const beatsFromPointStart = timeOffsetFromPoint / interval;
            const startBeatRel = Math.max(1, Math.ceil(beatsFromPointStart)); // 从 1 起：第 0 拍是红线
            // ★ v0.8.17：按拍号（meter）区分强拍（小节首拍）与弱拍——强拍线更亮更粗，弱拍更淡
            const meter = Number(point.meter) > 0 ? Math.round(Number(point.meter)) : 4;
            let relIndex = startBeatRel;
            while (true) {
                const beatIndex = point.beatIndex + relIndex;
                const time = point.time + relIndex * interval;
                if (nextPoint && beatIndex >= nextPoint.beatIndex) break;
                if (time > Math.min(endTime, sectionEndTime)) break;
                // 红线节拍线延迟补偿：仅刻度显示 x 加偏移（时间刻度尺/频谱/波形不受影响）
                const x = timeToX(time + beatLineDelaySec);
                if (x < x0 - 2 || x > x1 + 2) { relIndex++; continue; } // 只画区域内的刻度
                const isDownbeat = relIndex % meter === 0;
                if (isDownbeat) {
                    strongXs.push(x);
                    if (showArrow) strongArrowXs.push(x);
                    // 强拍标全局拍号；与红色段起点重合时不标，避免文字重叠
                    if (showBeatLabel && !sectionStartSet.has(Math.round((time + beatLineDelaySec) * 1000))) {
                        beatLabels.push({ x, text: beatIndex.toString() });
                    }
                } else {
                    weakXs.push(x);
                    if (showArrow) weakArrowXs.push(x);
                }
                relIndex++;
            }
        }

        // ---- 统一描边 / 填充（每种样式一次调用）----
        const strokeVlines = (xs: number[], color: string, w: number) => {
            if (!xs.length) return;
            ctx.beginPath();
            ctx.strokeStyle = color;
            ctx.lineWidth = w;
            for (const x of xs) { ctx.moveTo(x, 0); ctx.lineTo(x, sceneBottom); }
            ctx.stroke();
        };
        const fillArrows = (xs: number[], color: string) => {
            if (!xs.length) return;
            ctx.beginPath();
            ctx.fillStyle = color;
            for (const x of xs) { ctx.moveTo(x, arrowY0); ctx.lineTo(x - 5, arrowY0 + 8); ctx.lineTo(x + 5, arrowY0 + 8); }
            ctx.fill();
        };
        // 先红后蓝：红蓝重合时蓝线叠在红线上（与旧版视觉顺序一致）
        strokeVlines(redXs, '#ef4444', 2);
        strokeVlines(weakXs, 'rgba(0, 242, 255, 0.35)', 1);
        strokeVlines(strongXs, 'rgba(0, 242, 255, 0.95)', 2);
        fillArrows(redXs, '#ef4444');
        fillArrows(weakArrowXs, 'rgba(0, 242, 255, 0.5)');
        fillArrows(strongArrowXs, 'rgba(0, 242, 255, 0.95)');
        if (redLabels.length || beatLabels.length) {
            ctx.font = 'bold 12px sans-serif';
            ctx.fillStyle = '#ef4444';
            for (const l of redLabels) ctx.fillText(l.text, l.x, arrowY0 + 22);
            ctx.fillStyle = '#00f2ff';
            for (const l of beatLabels) ctx.fillText(l.text, l.x, arrowY0 + 22);
        }
    };

    if (!audioData) return;

    const last = overlayLastRef.current;
    const sameParams = last && last.zoom === viewState.zoom && last.w === intWidth && last.h === intHeight && last.delay === beatLineDelaySec;
    const dx = last ? Math.round(last.scrollLeft - viewState.scrollLeft) : 0;

    // ★ v0.8.19：完全没变化就一次都不画。
    //   导入 timing 后满屏都是拍线（上千条竖线 + 箭头 + 编号），一次整幅重绘是几十毫秒；
    //   而播放时 App 每 100ms 推一次 currentTime 重渲染，只要 timingPoints 数组换了引用，
    //   这个 effect 就会重跑 → 每秒 10 次整幅重绘 → 看起来就是"导入 timing 之后开始卡"。
    //   这里用「数组引用 + 视口位置」双重判断：没变就直接返回。
    if (sameParams && last && last.points === timingPoints && dx === 0) return;

    if (sameParams && dx !== 0 && Math.abs(dx) < intWidth) {
        // 平移复用：overlay 是透明背景，必须先整体清除再画平移内容（否则旧拍线残留叠加）
        const tmp = getTmp(canvas.width, canvas.height);
        const tctx = tmp.getContext('2d')!;
        tctx.clearRect(0, 0, tmp.width, tmp.height);
        tctx.drawImage(canvas, 0, 0);
        ctx.clearRect(0, 0, intWidth, intHeight);
        ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, dx, 0, intWidth, intHeight);
        // 重绘露出的边缘
        if (dx > 0) drawOverlayRegion(0, dx);
        else drawOverlayRegion(intWidth + dx, intWidth);
    } else {
        ctx.clearRect(0, 0, intWidth, intHeight);
        drawOverlayRegion(0, intWidth);
    }
    overlayLastRef.current = { zoom: viewState.zoom, scrollLeft: viewState.scrollLeft, w: intWidth, h: intHeight, delay: beatLineDelaySec, points: timingPoints };
  }, [audioData, viewState, timingPoints, intWidth, intHeight, waveHeight, specHeight, beatLineDelaySec, drawTick]);

  // --- 独立播放头层（AU 式局部重绘：每帧只擦旧列 + 画新列，开销极小，跟随显示器刷新率）---
  const viewStateRef = useRef(viewState);
  viewStateRef.current = viewState;
  // 播放头层（0.7.9 原版）：播放头按真实音频时间，无任何延迟补偿
  const getPlayheadTimeRef = useRef(getPlayheadTime);
  getPlayheadTimeRef.current = getPlayheadTime;
  const lastPlayheadXRef = useRef(-1);

  useEffect(() => {
    const el = playheadRef.current;
    if (!el) return;
    let raf = 0;
    let lastX = -1e9;
    // ★ 与 DOM 初始 opacity:0 对齐：首帧进入视口时必须走一次「点亮」分支，
    //   否则位置在变、transform 在写，白条却一直是透明的。
    let visible = false;
    const draw = () => {
        raf = requestAnimationFrame(draw);
        const vs = viewStateRef.current;
        const t = getPlayheadTimeRef.current();
        const x = t * vs.zoom - vs.scrollLeft;
        const rx = Math.round(x);
        // 位置没变 → 一行 DOM 都不碰（暂停/静止时这一层完全零开销）
        if (rx === lastX) return;
        lastX = rx;
        // 移出视口就整体隐藏，避免在边缘留一条悬空的线
        if (rx < -12 || rx > intWidth + 12) {
            if (visible) { el.style.opacity = '0'; visible = false; }
            return;
        }
        if (!visible) { el.style.opacity = '1'; visible = true; }
        el.style.transform = `translate3d(${rx}px,0,0)`;
    };
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); lastPlayheadXRef.current = -1; };
  }, [intWidth]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!audioData) return;
    const rect = overlayRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    if (mouseY > waveHeight + specHeight) {
        // 底部时间轴区域：指示器检测与拖动；拍线延迟需反向扣减，与显示位置一致
        const mouseTime = xToTime(mouseX) - beatLineDelaySec;
        // ① 红色段起点优先：抓住红线的箭头/竖线即可左右拖动 → 直接改这条红线的时间戳
        {
            let bestIdx = -1;
            let bestDist = 8; // 命中半径（像素）
            for (let i = 1; i < timingPoints.length; i++) { // i=0 是起点锚点，走 Offset 拖动
                const d = Math.abs(timeToX(timingPoints[i].time + beatLineDelaySec) - mouseX);
                if (d <= bestDist) { bestDist = d; bestIdx = i; }
            }
            if (bestIdx !== -1) {
                setDragging({ type: 'redline', pointIndex: bestIdx, beatIndex: timingPoints[bestIdx].beatIndex, startX: mouseX, initialVal: timingPoints[bestIdx].time });
                return;
            }
        }
        let bestDist = Infinity;
        let bestPointIdx = -1;
        let bestBeatIndex = -1;
        let isSectionStart = false;

        for (let i = 0; i < timingPoints.length; i++) {
            const point = timingPoints[i];
            const nextPoint = timingPoints[i+1];
            const sectionEndTime = nextPoint ? nextPoint.time : audioData.duration;
            if (point.time > mouseTime + 1) break; 
            if (sectionEndTime < mouseTime - 1) continue;
            const interval = 60 / point.bpm;
            const diff = mouseTime - point.time;
            const beats = Math.round(diff / interval);
            const beatIndex = point.beatIndex + beats;
            const time = point.time + beats * interval;
            if (nextPoint && beatIndex >= nextPoint.beatIndex) continue;
            if (beatIndex < point.beatIndex) continue;
            const dist = Math.abs(timeToX(time + beatLineDelaySec) - mouseX);
            if (dist < 15 && dist < bestDist) {
                bestDist = dist;
                bestPointIdx = i;
                bestBeatIndex = beatIndex;
                isSectionStart = (beatIndex === point.beatIndex);
            }
        }

        if (bestPointIdx !== -1) {
            let type: 'offset' | 'bpm' | 'redline' = 'bpm';
            let targetIdx = bestPointIdx;
            if (isSectionStart) {
                // 段起点：起点锚点走 Offset；其余红线 = 拖这根红线本身（改它自己的时间戳）
                if (bestPointIdx === 0) type = 'offset';
                else type = 'redline';
            }
            setDragging({
                type,
                pointIndex: targetIdx,
                beatIndex: bestBeatIndex,
                startX: mouseX,
                initialVal: type === 'offset' ? timingPoints[0].time : timingPoints[targetIdx].bpm
            });
            return;
        }
    }
    // 波形/频谱区域：按下后暂不动作，区分"点击跳转"与"拖拽平移"
    setPanState({ startX: mouseX, startScrollLeft: viewState.scrollLeft, moved: false });
  };

  // 拖拽平移 rAF 节流：mousemove 可能远高于 60Hz，限制每帧最多一次滚动更新
  const panRafRef = useRef<number | null>(null);

  const handleMouseMove = useCallback((e: MouseEvent) => {
      if (!audioData) return;
      const rect = overlayRef.current?.getBoundingClientRect();
      if (!rect) return;
      const mouseX = e.clientX - rect.left;

      // 1) 时间轴指示器拖动（Offset/BPM 微调）
      if (dragging) {
          // 拍线延迟：交互按显示拍线位置计算（扣回延迟换算真实时间）
          const mouseTime = xToTime(mouseX) - beatLineDelaySec;

          if (dragging.type === 'offset') {
              const roundedOffset = Math.round(mouseTime * 1000) / 1000;
              onUpdateOffset(roundedOffset);
          }
          else if (dragging.type === 'redline') {
              // 拖动红色段起点：直接写这条红线的绝对时间（红线位置独立，不影响其它红线）
              const pt = timingPoints[dragging.pointIndex];
              if (pt) onUpdateSectionTime?.(pt.id, Math.max(0, Math.round(mouseTime * 1000) / 1000));
          } 
          else if (dragging.type === 'bpm') {
              const point = timingPoints[dragging.pointIndex];
              const beatsFromStart = dragging.beatIndex - point.beatIndex;
              if (beatsFromStart === 0) return; 
              const timeDiff = mouseTime - point.time;
              if (timeDiff <= 0.001) return; 
              const rawBpm = (beatsFromStart * 60) / timeDiff;
              const roundedBpm = Math.round(rawBpm * 100) / 100;
              if (roundedBpm > 10 && roundedBpm < 1000) onUpdateBpm(point.beatIndex, roundedBpm);
          }
          return;
      }

      // 2) 频谱/波形区拖拽平移时间轴（rAF 节流：mousemove 可能 >60Hz，限制每帧最多一次更新）
      if (panState) {
          if (panRafRef.current !== null) return;
          panRafRef.current = requestAnimationFrame(() => {
              panRafRef.current = null;
              if (!panState) return;
              const dx = mouseX - panState.startX;
              // 超过 4px 才认定为拖拽（否则视为点击）
              if (!panState.moved && Math.abs(dx) < 4) return;
              const newScroll = panState.startScrollLeft - dx;
              const maxScroll = Math.max(0, audioData.duration * viewState.zoom - width);
              onScrollChange(Math.max(0, Math.min(newScroll, maxScroll)));
              if (!panState.moved) setPanState(p => p ? { ...p, moved: true } : p);
          });
      }
  }, [dragging, panState, audioData, viewState, timingPoints, onUpdateBpm, onUpdateOffset, onScrollChange, width, beatLineDelaySec, onUpdateSectionTime]); 

  const handleMouseUp = useCallback((e: MouseEvent) => {
      // 若按下后未发生拖拽，视为点击跳转播放位置
      if (panState && !panState.moved && audioData) {
          const rect = overlayRef.current?.getBoundingClientRect();
          if (rect) {
              const mouseX = e.clientX - rect.left;
              const t = xToTime(mouseX);
              // 红色小节线（段起点）命中检测：±4px 内视为点击该段落 → 配置面板跳转
              const hitThreshold = 4 / viewState.zoom;
              const hit = timingPoints.find((p) => Math.abs(p.time - (t - beatLineDelaySec)) < hitThreshold);
              if (hit) {
                  onSeek(t);
                  onSectionClick(hit.id);
              } else {
                  onSeek(t);
              }
          }
      }
      setDragging(null);
      setPanState(null);
  }, [panState, audioData, onSeek, onSectionClick, timingPoints, viewState.zoom, beatLineDelaySec]);

  useEffect(() => {
    if (dragging || panState) {
        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
    }
    return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragging, panState, handleMouseMove, handleMouseUp]);

  return (
    <div className="relative select-none w-full h-full bg-black">
       <canvas ref={waveformRef} className="absolute top-0 left-0 pointer-events-none" />
       <canvas ref={spectrogramRef} className="absolute left-0 pointer-events-none" style={{ top: waveHeight }} />
       <canvas 
          ref={overlayRef} 
          className={`absolute top-0 left-0 ${panState ? 'cursor-grabbing' : 'cursor-crosshair'}`} 
          onMouseDown={handleMouseDown} 
          title={t('vizTitle')}
       />
       {/* 独立播放头层：DOM 合成层（transform 定位，不重光栅、不上传纹理），跟随屏幕刷新率，不拦截鼠标 */}
       <div
          ref={playheadRef}
          className="absolute top-0 left-0 pointer-events-none"
          style={{ willChange: 'transform', transform: 'translate3d(-9999px,0,0)', opacity: 0, zIndex: 5 }}
       >
          <div style={{ position: 'absolute', left: -1, top: 0, width: 2, height: intHeight, background: 'rgba(255,255,255,0.9)' }} />
          <div style={{ position: 'absolute', left: -5, top: 0, width: 0, height: 0, borderLeft: '5px solid transparent', borderRight: '5px solid transparent', borderTop: '8px solid #22d3ee' }} />
       </div>
    </div>
  );
};

export default Visualizer;
