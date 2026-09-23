
import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { AudioData, ViewState, TimingPoint } from '../types';
import { computeFFT, getHannWindow } from '../utils/audioUtils';
import { precomputeSpectrogram, PrecomputedSpectrogram, u8ToVal } from '../utils/spectrogramPrecompute';
import { spectrogramColor } from '../utils/settings';
import { getPointAtTime } from '../utils/timingUtils';
import { t } from '../utils/i18n';

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
  const playheadRef = useRef<HTMLCanvasElement>(null); // 独立播放头层（AU 式局部重绘）

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
  
  const availableHeight = Math.max(0, intHeight - TIMELINE_HEIGHT);
  const waveHeight = Math.floor(availableHeight * 0.5);
  const specHeight = availableHeight - waveHeight;

  // 时间 ↔ 像素映射（0.7.9 原版：无任何延迟补偿，频谱/波形/刻度尺均按真实时间）
  const timeToX = (t: number) => (t * viewState.zoom) - viewState.scrollLeft;
  const xToTime = (x: number) => (x + viewState.scrollLeft) / viewState.zoom;

  const hannWindow = useMemo(() => getHannWindow(specFFTSize), [specFFTSize]);

  // ===== 平移复用（快速滚动优化）：记录上次绘制参数，仅重绘露出边缘）=====
  const waveLastRef = useRef<{ zoom: number; scrollLeft: number; waveColor: string; w: number; h: number } | null>(null);
  const specLastRef = useRef<{ zoom: number; scrollLeft: number; specLogBase: number; specPalette: string; specCustom: string; peakThreshold: number; peakColor: string; specInvert: boolean; specSensitivity: number; w: number; h: number } | null>(null);
  const overlayLastRef = useRef<{ zoom: number; scrollLeft: number; w: number; h: number; delay: number } | null>(null);
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
  const SPEC_CACHE_LIMIT = 3000;
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
    }).catch(() => { /* 失败时保持 specData=null，绘制走 JS FFT 回退 */ })
      .then(() => {
        specRunningRef.current = false;
        specPumpRef.current(); // 有任务在等 → 接着算最新的那份
      });
  };

  useEffect(() => {
    const token = ++specPreTokenRef.current;
    setSpecData(null); // 切换音频/精度先清空，绘制回退 JS FFT（避免旧数据错位）
    if (!audioData) { specPendingRef.current = null; return; }
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
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = renderDpr || 1;
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
  }, [audioData, viewState, intWidth, waveHeight, waveColor]);

  // --- Draw Spectrogram（平移复用：滚动时只重算露出边缘的 FFT 列，消除拖动卡顿）---
  useEffect(() => {
    const sCanvas = spectrogramRef.current;
    if (!sCanvas || !audioData || intWidth <= 0 || specHeight <= 0) return;
    const ctx = sCanvas.getContext('2d');
    if (!ctx) return;

    const dpr = renderDpr || 1;
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

    // 计算 [x0, x1)（CSS 像素）区间的频谱列并写入画布
    const drawSpecRegion = (x0: number, x1: number) => {
        const px0 = Math.max(0, Math.floor(x0 * dpr));
        const px1 = Math.min(fullWidth, Math.ceil(x1 * dpr));
        if (px1 <= px0) return;
        const colW = px1 - px0;
        const idata = ctx.createImageData(colW, fullHeight);
        const buf = new Uint32Array(idata.data.buffer);
        for (let px = 0; px < colW; px++) {
            const t = xToTime((px0 + px) / dpr);
            if (t < 0 || t >= audioData.duration) continue;
            const sampleIdx = Math.floor(t * sampleRate);
            if (sampleIdx < 0 || sampleIdx + specFFTSize >= rawData.length) continue;
            // FFT 列缓存：同一采样位置只计算一次，跳转/缩放时直接复用
            let col = specCacheRef.current.get(sampleIdx);
            if (!col) {
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
                    col = new Uint32Array(fullHeight);
                    // 缓存列按自然 y 顺序存储（顶部 y=0 → 低频）；复制到 ImageData 时再做一次行反转，
                    // 保证画布顶部显示高频、底部显示低频（与 v0.6.4 及之前版本方向一致，勿再叠加反转）
                    for (let y = 0; y < fullHeight; y++) {
                        const yNorm = specInvert ? 1 - y / fullHeight : y / fullHeight;
                        // bin 浮点位置（对数/线性刻度映射），用于频率方向插值（平滑纵向）
                        const binF = base <= 1
                            ? yNorm * (numBins - 1)
                            : ((Math.pow(base, yNorm) - 1) / (base - 1)) * (numBins - 1);
                        const b0 = Math.floor(binF);
                        const b1 = Math.min(numBins - 1, b0 + 1);
                        const bFrac = binF - b0;
                        // 双线性插值：先按频率方向混合相邻 bin（两列各自），再按时间方向混合相邻列（AU 风格平滑）
                        const v00 = preCol0[b0], v01 = preCol0[b1];
                        const v10 = preCol1[b0], v11 = preCol1[b1];
                        const vF0 = v00 * (1 - bFrac) + v01 * bFrac;
                        const vF1 = v10 * (1 - bFrac) + v11 * bFrac;
                        const v = vF0 * (1 - preFrac) + vF1 * preFrac;
                        const val = Math.max(0, Math.min(1, u8ToVal(v, specSensitivity)));
                        const freqNorm = numBins > 1 ? b0 / (numBins - 1) : 0;
                        const [r, g, b] = spectrogramColor(val, freqNorm, specPalette, specCustom, peakThreshold, peakColor);
                        col[y] = (255 << 24) | (b << 16) | (g << 8) | r;
                    }
                } else {
                    // 兜底：JS FFT（预计算未完成或失败时）
                    for (let i = 0; i < specFFTSize; i++) input[i] = rawData[sampleIdx + i] * hannWindow[i];
                    const magnitudes = computeFFT(input);
                    col = new Uint32Array(fullHeight);
                    for (let y = 0; y < fullHeight; y++) {
                        const yNorm = specInvert ? 1 - y / fullHeight : y / fullHeight;
                        // bin 浮点位置 + 频率方向插值（与原生 FFT 路径一致，平滑纵向）
                        const binF = base <= 1
                            ? yNorm * (numBins - 1)
                            : ((Math.pow(base, yNorm) - 1) / (base - 1)) * (numBins - 1);
                        const b0 = Math.floor(binF);
                        const b1 = Math.min(numBins - 1, b0 + 1);
                        const bFrac = binF - b0;
                        const mag = magnitudes[b0] * (1 - bFrac) + magnitudes[b1] * bFrac;
                        const db = 20 * Math.log10(mag + 1e-9);
                        // 显示阈值 specSensitivity dB（灵敏度可调，越小越敏感）
                        const val = Math.max(0, Math.min(1, (db + specSensitivity) / specSensitivity));
                        const freqNorm = numBins > 1 ? b0 / (numBins - 1) : 0;
                        const [r, g, b] = spectrogramColor(val, freqNorm, specPalette, specCustom, peakThreshold, peakColor);
                        col[y] = (255 << 24) | (b << 16) | (g << 8) | r;
                    }
                }
                const cache = specCacheRef.current;
                cache.set(sampleIdx, col);
                if (cache.size > SPEC_CACHE_LIMIT) {
                    const oldest = cache.keys().next().value;
                    if (oldest !== undefined) cache.delete(oldest);
                }
            }
            // 复制缓存列到目标 buffer
            for (let y = 0; y < fullHeight; y++) {
                buf[y * colW + px] = col[fullHeight - 1 - y];
            }
        }
        ctx.putImageData(idata, px0, 0);
    };

    const last = specLastRef.current;
    const sameParams = last && last.zoom === viewState.zoom && last.specLogBase === specLogBase
        && last.specPalette === specPalette && last.specCustom === specCustom.join(',')
        && last.peakThreshold === peakThreshold && last.peakColor === peakColor && last.specInvert === specInvert
        && last.specSensitivity === specSensitivity
        && last.w === intWidth && last.h === specHeight;
    // 参数（对数刻度/配色/尺寸等）变化时旧缓存列作废——否则重绘会命中旧参数的缓存列，
    // 导致「对数比例滑条失效」等改了不生效的问题（缓存键只有 sampleIdx，必须显式清空）
    if (!sameParams) specCacheRef.current.clear();
    const dx = last ? Math.round(last.scrollLeft - viewState.scrollLeft) : 0;

    if (sameParams && dx !== 0 && Math.abs(dx) < intWidth) {
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
        const batchPx = 60; // 每帧处理的 device 列数
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
    };
  }, [audioData, viewState, intWidth, specHeight, hannWindow, specLogBase, specPalette, specCustom, peakThreshold, peakColor, specInvert, renderDpr, specData, specSensitivity]);

  // --- Draw Overlay（对照源码渲染方案；平移复用以降低拖动卡顿）---
  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas || intWidth <= 0 || intHeight <= 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = renderDpr || 1;
    const newW = Math.floor(intWidth * dpr);
    const newH = Math.floor(intHeight * dpr);
    // 只在尺寸变化时重置画布（否则会清空内容，破坏平移复用）
    if (canvas.width !== newW) canvas.width = newW;
    if (canvas.height !== newH) canvas.height = newH;
    canvas.style.width = `${intWidth}px`;
    canvas.style.height = `${intHeight}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 绘制 [x0, x1) 区间的刻度尺 + 拍线
    const drawOverlayRegion = (x0: number, x1: number) => {
        const startTime = xToTime(0);
        const endTime = xToTime(intWidth);
        ctx.textAlign = 'center';
        // 顶部时间刻度尺
        const RULER_H = 22;
        const targetStepPx = 80;
        const rawStepSec = targetStepPx / viewState.zoom;
        const stepSec = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
            .find(s => s >= rawStepSec) || 600;
        const startSec = Math.floor(startTime / stepSec) * stepSec;
        ctx.font = '10px sans-serif';
        for (let sec = startSec; sec <= endTime; sec += stepSec) {
            const x = timeToX(sec);
            if (x < x0 - 60 || x > x1 + 60) continue;
            ctx.strokeStyle = 'rgba(255,255,255,0.10)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x, RULER_H);
            ctx.lineTo(x, intHeight);
            ctx.stroke();
            ctx.fillStyle = 'rgba(255,255,255,0.5)';
            const mm = Math.floor(sec / 60);
            const ss = (sec % 60).toFixed(stepSec < 1 ? 1 : 0);
            ctx.fillText(`${mm}:${ss.padStart(stepSec < 1 ? 4 : 2, '0')}`, x, 14);
        }
        // ===== 刻度绘制（v0.7.18）=====
        // 红线 = 段起点（每条红线自带 BPM，位置由红线的绝对时间决定，改 BPM 不会挪动下一条红线）
        // 蓝线 = 节拍线：每拍一条，间距 = 60 / 该红线自己的 BPM（BPM 只和蓝线距离关联）
        // 绘制顺序：先红后蓝 —— 红蓝重合时蓝线叠加在红线上，红线不会盖住蓝线
        ctx.font = 'bold 12px sans-serif';
        const arrowY0 = waveHeight + specHeight + 6;
        // 段起点时间集合（用于避免蓝线编号与红色段起点编号文字重叠）
        const sectionStartSet = new Set(timingPoints.map(p => Math.round((p.time + beatLineDelaySec) * 1000)));
        // ---- 第一遍：红色段起点（2px）----
        for (let i = 0; i < timingPoints.length; i++) {
            const point = timingPoints[i];
            const x = timeToX(point.time + beatLineDelaySec);
            if (x < x0 - 2 || x > x1 + 2) continue;
            ctx.beginPath();
            ctx.strokeStyle = '#ef4444';
            ctx.lineWidth = 2;
            ctx.moveTo(x, 0);
            ctx.lineTo(x, waveHeight + specHeight);
            ctx.stroke();
            ctx.fillStyle = '#ef4444';
            ctx.beginPath();
            ctx.moveTo(x, arrowY0);
            ctx.lineTo(x - 5, arrowY0 + 8);
            ctx.lineTo(x + 5, arrowY0 + 8);
            ctx.fill();
            ctx.fillText(point.beatIndex.toString(), x, arrowY0 + 22); // 红色段起点标全局拍号
        }
        // ---- 第二遍：蓝色节拍线（1px，每拍一条，密度由该段 BPM 决定）----
        for (let i = 0; i < timingPoints.length; i++) {
            const point = timingPoints[i];
            const nextPoint = timingPoints[i+1];
            const sectionEndTime = nextPoint ? nextPoint.time : audioData!.duration;
            if (sectionEndTime < startTime) continue;
            if (point.time > endTime) break;
            const interval = 60 / point.bpm;
            const visibleStart = Math.max(startTime, point.time);
            const timeOffsetFromPoint = visibleStart - point.time;
            const beatsFromPointStart = timeOffsetFromPoint / interval;
            const startBeatRel = Math.max(1, Math.ceil(beatsFromPointStart)); // 从 1 起：第 0 拍是红线
            let relIndex = startBeatRel;
            while (true) {
                const beatIndex = point.beatIndex + relIndex;
                const time = point.time + relIndex * interval;
                if (nextPoint && beatIndex >= nextPoint.beatIndex) break;
                if (time > Math.min(endTime, sectionEndTime)) break;
                // 红线节拍线延迟补偿：仅刻度显示 x 加偏移（时间刻度尺/频谱/波形不受影响）
                const x = timeToX(time + beatLineDelaySec);
                if (x < x0 - 2 || x > x1 + 2) { relIndex++; continue; } // 只画区域内的刻度
                // ★ v0.8.17：按拍号（meter）区分强拍（小节首拍）与弱拍——强拍线更亮更粗，弱拍更淡
                const meter = Number(point.meter) > 0 ? Math.round(Number(point.meter)) : 4;
                const isDownbeat = relIndex % meter === 0;
                ctx.beginPath();
                ctx.strokeStyle = isDownbeat ? 'rgba(0, 242, 255, 0.95)' : 'rgba(0, 242, 255, 0.35)';
                ctx.lineWidth = isDownbeat ? 2 : 1;
                ctx.moveTo(x, 0);
                ctx.lineTo(x, waveHeight + specHeight);
                ctx.stroke();
                ctx.fillStyle = isDownbeat ? 'rgba(0, 242, 255, 0.95)' : 'rgba(0, 242, 255, 0.5)';
                ctx.beginPath();
                ctx.moveTo(x, arrowY0);
                ctx.lineTo(x - 5, arrowY0 + 8);
                ctx.lineTo(x + 5, arrowY0 + 8);
                ctx.fill();
                // 强拍标全局拍号；与红色段起点重合时不标，避免文字重叠
                if (isDownbeat && !sectionStartSet.has(Math.round((time + beatLineDelaySec) * 1000))) {
                    ctx.fillStyle = '#00f2ff';
                    ctx.fillText(beatIndex.toString(), x, arrowY0 + 22);
                }
                relIndex++;
            }
        }
    };

    if (!audioData) return;

    const last = overlayLastRef.current;
    const sameParams = last && last.zoom === viewState.zoom && last.w === intWidth && last.h === intHeight && last.delay === beatLineDelaySec;
    const dx = last ? Math.round(last.scrollLeft - viewState.scrollLeft) : 0;

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
    overlayLastRef.current = { zoom: viewState.zoom, scrollLeft: viewState.scrollLeft, w: intWidth, h: intHeight, delay: beatLineDelaySec };
  }, [audioData, viewState, timingPoints, intWidth, intHeight, waveHeight, specHeight, beatLineDelaySec]);

  // --- 独立播放头层（AU 式局部重绘：每帧只擦旧列 + 画新列，开销极小，跟随显示器刷新率）---
  const viewStateRef = useRef(viewState);
  viewStateRef.current = viewState;
  // 播放头层（0.7.9 原版）：播放头按真实音频时间，无任何延迟补偿
  const getPlayheadTimeRef = useRef(getPlayheadTime);
  getPlayheadTimeRef.current = getPlayheadTime;
  const lastPlayheadXRef = useRef(-1);

  useEffect(() => {
    const canvas = playheadRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    const draw = () => {
        raf = requestAnimationFrame(draw);
        const dpr = renderDpr || 1;
        if (canvas.width !== Math.floor(intWidth * dpr)) canvas.width = Math.floor(intWidth * dpr);
        if (canvas.height !== Math.floor(intHeight * dpr)) canvas.height = Math.floor(intHeight * dpr);
        canvas.style.width = `${intWidth}px`;
        canvas.style.height = `${intHeight}px`;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        const vs = viewStateRef.current;
        const t = getPlayheadTimeRef.current();
        const x = t * vs.zoom - vs.scrollLeft;
        const prev = lastPlayheadXRef.current;

        // 只擦除旧播放头所在列（含三角宽度）
        if (prev >= -8 && prev <= intWidth + 8) {
            ctx.clearRect(prev - 6, 0, 13, intHeight);
        }
        // 画新播放头（AU 风格：白色主线 + 顶部青色三角）
        if (x >= -8 && x <= intWidth + 8) {
            ctx.beginPath();
            ctx.strokeStyle = 'rgba(255,255,255,0.9)';
            ctx.lineWidth = 2;
            ctx.moveTo(x, 0);
            ctx.lineTo(x, intHeight);
            ctx.stroke();
            ctx.fillStyle = '#22d3ee';
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x - 5, 8);
            ctx.lineTo(x + 5, 8);
            ctx.closePath();
            ctx.fill();
        }
        lastPlayheadXRef.current = x;
    };
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); lastPlayheadXRef.current = -1; };
  }, [intWidth, intHeight, renderDpr]);

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
       {/* 独立播放头层：AU 式局部重绘，跟随显示器刷新率，不拦截鼠标 */}
       <canvas ref={playheadRef} className="absolute top-0 left-0 pointer-events-none" />
    </div>
  );
};

export default Visualizer;
