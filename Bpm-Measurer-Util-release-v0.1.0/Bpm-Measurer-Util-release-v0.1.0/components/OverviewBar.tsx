import React, { useRef, useEffect, useState, useCallback } from 'react';
import { t } from '../utils/i18n';

interface OverviewBarProps {
  peaks: Float32Array;   // 整曲波形峰值（min/max 对）
  duration: number;      // 总时长（秒）
  currentTime: number;   // 当前播放位置（秒）
  viewStart: number;     // 当前频谱视图的起始时间（秒）
  viewEnd: number;       // 当前频谱视图的结束时间（秒）
  onSeek: (time: number) => void; // 跳转回调
}

/**
 * 整曲总览条（类似 Adobe Audition 的波形导航栏）：
 * - 显示整首歌的迷你波形（全局视角）
 * - 青色高亮区域 = 当前频谱视图范围
 * - 红色竖线 = 当前播放位置
 * - 点击 / 按住拖拽跳转（拖拽中仅本地预览，松手才真正 seek，避免音频反复重启）
 *
 * ★ v0.8.18 性能重构（拖动卡顿的真正元凶就在这里）
 *   旧版把「迷你波形」和「视口高亮」画在同一张 canvas 的同一个 effect 里，而这个 effect
 *   依赖 viewStart/viewEnd —— 也就是**拖动频谱每前进一像素就重画一次整曲波形**。
 *   整曲峰值约 19 万个（44100Hz / 100），旧代码为每个峰值 push 一条 moveTo/lineTo 子路径，
 *   于是出现「一次 stroke() 里 20 万条子路径」的巨型 Path。
 *   JS 侧只花几毫秒（所以看不出来），但这段路径要在 GPU 进程光栅化：实测
 *   SkCanvas::drawPath 单次 940ms（CDP trace: RasterDecoderImpl::DoRasterCHROMIUM），
 *   整个合成器被堵死 → 拖一下就卡近一秒、帧率跌到 1~2fps。
 *
 *   现在拆成两层：
 *   ① 底层 canvas「静态迷你波形 + 网格」：只依赖 peaks/duration/尺寸，拖动/播放都不重画；
 *      并且按列聚合（每个显示列只保留该列内峰值的 min/max）——子路径数从 19 万降到 ~2×像素宽。
 *   ② 顶层 canvas「视口高亮 + 播放头」：每次只 fillRect + strokeRect + 一条短竖线，成本低于 1ms。
 */
const OverviewBar: React.FC<OverviewBarProps> = ({ peaks, duration, currentTime, viewStart, viewEnd, onSeek }) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const waveRef = useRef<HTMLCanvasElement>(null);   // ① 静态层
  const topRef = useRef<HTMLCanvasElement>(null);    // ② 动态层
  const [dragging, setDragging] = useState(false);
  const [dragTime, setDragTime] = useState<number | null>(null);
  // 画布尺寸（CSS 像素）+ dpr，随容器变化更新；作为静态层重绘的依赖
  const [size, setSize] = useState<{ w: number; h: number; dpr: number }>({ w: 0, h: 0, dpr: 1 });

  // 监听容器尺寸（窗口缩放 / 侧栏开合）
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const read = () => {
      const w = Math.round(el.clientWidth);
      const h = Math.round(el.clientHeight);
      const dpr = window.devicePixelRatio || 1;
      setSize(prev => (prev.w === w && prev.h === h && prev.dpr === dpr ? prev : { w, h, dpr }));
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    window.addEventListener('resize', read);
    return () => { ro.disconnect(); window.removeEventListener('resize', read); };
  }, []);

  // ===== ① 静态层：网格 + 迷你波形（只在 peaks / duration / 尺寸变化时重画）=====
  useEffect(() => {
    const canvas = waveRef.current;
    const { w, h, dpr } = size;
    if (!canvas || w === 0 || h === 0) return;
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#030712';
    ctx.fillRect(0, 0, w, h);

    // 背景网格
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let gx = 0; gx <= 8; gx++) {
      const x = (gx / 8) * w;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    }
    ctx.stroke();

    const n = Math.floor(peaks.length / 2);
    if (duration <= 0 || n < 1) return;

    // ★ 关键：按「显示列」聚合，而不是逐峰值建子路径。
    //   设备像素列数 = bw（默认 2 倍 dpr），每列取该区间内峰值的 min/max —— 视觉与旧版一致
    //   （旧版 19 万条子路径画进 900 多像素宽，本来就有大量重叠），子路径数降到 bw 量级。
    const cols = Math.min(bw, n);
    const mid = h / 2;
    const amp = h / 2 - 2;
    const stepPk = n / cols;
    ctx.fillStyle = 'rgba(129, 140, 248, 0.7)'; // indigo
    ctx.beginPath();
    for (let c = 0; c < cols; c++) {
      const p0 = Math.floor(c * stepPk);
      const p1 = Math.min(n, Math.max(p0 + 1, Math.floor((c + 1) * stepPk)));
      let mn = 0, mx = 0;
      for (let i = p0; i < p1; i++) {
        const lo = peaks[i * 2];
        const hi = peaks[i * 2 + 1];
        if (lo < mn) mn = lo;
        if (hi > mx) mx = hi;
      }
      const x = c / dpr;
      const yTop = mid - Math.max(0, mx) * amp;
      const yBot = mid - Math.min(0, mn) * amp;
      const hh = Math.max(1 / dpr, yBot - yTop);
      // 用矩形填充代替描边：轴对齐矩形走的是最简单的光栅化路径，比 stroke 更省
      ctx.rect(x, yTop, 1 / dpr, hh);
    }
    ctx.fill();
  }, [peaks, duration, size]);

  // ===== ② 动态层：视口高亮 + 播放头（拖动/播放时每次只有几个矩形和一条线）=====
  useEffect(() => {
    const canvas = topRef.current;
    const { w, h, dpr } = size;
    if (!canvas || w === 0 || h === 0) return;
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (duration <= 0) return;

    // 当前频谱视图范围（青色高亮）
    const vx1 = (Math.max(0, viewStart) / duration) * w;
    const vx2 = (Math.min(duration, viewEnd) / duration) * w;
    if (vx2 > vx1) {
      ctx.fillStyle = 'rgba(34, 211, 238, 0.14)';
      ctx.fillRect(vx1, 0, vx2 - vx1, h);
      ctx.strokeStyle = 'rgba(34, 211, 238, 0.4)';
      ctx.strokeRect(vx1 + 0.5, 0.5, Math.max(0, vx2 - vx1 - 1), h - 1);
    }

    // 当前播放位置（红色竖线 + 顶部三角）
    const shown = dragging && dragTime !== null ? dragTime : currentTime;
    const cx = (Math.max(0, Math.min(duration, shown)) / duration) * w;
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, h);
    ctx.stroke();
    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx - 4, 4);
    ctx.lineTo(cx + 4, 4);
    ctx.closePath();
    ctx.fill();
  }, [size, duration, viewStart, viewEnd, currentTime, dragging, dragTime]);

  const getTimeFromClientX = useCallback((clientX: number): number => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return 0;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return ratio * duration;
  }, [duration]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (duration <= 0) return;
    e.preventDefault();
    setDragging(true);
    setDragTime(getTimeFromClientX(e.clientX));

    const handleMove = (ev: MouseEvent) => setDragTime(getTimeFromClientX(ev.clientX));
    const handleUp = (ev: MouseEvent) => {
      const finalTime = getTimeFromClientX(ev.clientX);
      setDragging(false);
      setDragTime(null);
      onSeek(finalTime);
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  }, [duration, getTimeFromClientX, onSeek]);

  return (
    <div
      ref={wrapRef}
      onMouseDown={handleMouseDown}
      className="relative w-full h-10 rounded-md border border-white/10 bg-gray-950 cursor-pointer select-none overflow-hidden"
      title={t('overviewTitle')}
    >
      <canvas ref={waveRef} className="absolute inset-0 w-full h-full pointer-events-none" />
      <canvas ref={topRef} className="absolute inset-0 w-full h-full pointer-events-none" />
    </div>
  );
};

export default OverviewBar;
