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
 */
const OverviewBar: React.FC<OverviewBarProps> = ({ peaks, duration, currentTime, viewStart, viewEnd, onSeek }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const baseRef = useRef<HTMLCanvasElement | null>(null); // 波形+视口底图（offscreen，避免每次进度更新全量重绘）
  const [dragging, setDragging] = useState(false);
  const [dragTime, setDragTime] = useState<number | null>(null);

  // ① 波形 + 视口范围画到底图（只在 peaks/duration/viewStart/viewEnd 变化时重绘）
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;

    let base = baseRef.current;
    if (!base) {
      base = document.createElement('canvas');
      baseRef.current = base;
    }
    base.width = Math.round(w * dpr);
    base.height = Math.round(h * dpr);
    const bctx = base.getContext('2d');
    if (!bctx) return;
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bctx.clearRect(0, 0, w, h);
    bctx.fillStyle = '#030712';
    bctx.fillRect(0, 0, w, h);

    if (duration <= 0 || peaks.length < 2) {
      return;
    }

    // 背景网格
    bctx.strokeStyle = 'rgba(255,255,255,0.04)';
    bctx.lineWidth = 1;
    bctx.beginPath();
    for (let gx = 0; gx <= 8; gx++) {
      const x = (gx / 8) * w;
      bctx.moveTo(x, 0); bctx.lineTo(x, h);
    }
    bctx.stroke();

    // 迷你波形（整曲缩略）
    const mid = h / 2;
    const amp = h / 2 - 2;
    const n = Math.floor(peaks.length / 2);
    bctx.strokeStyle = 'rgba(129, 140, 248, 0.7)'; // indigo
    bctx.lineWidth = 1;
    bctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = (i / n) * w;
      const min = peaks[i * 2];
      const max = peaks[i * 2 + 1];
      const y1 = mid - Math.max(0, max) * amp;
      const y2 = mid - Math.min(0, min) * amp;
      bctx.moveTo(x, y1);
      bctx.lineTo(x, Math.max(y1, y2));
    }
    bctx.stroke();

    // 当前频谱视图范围（青色高亮）
    const vx1 = (Math.max(0, viewStart) / duration) * w;
    const vx2 = (Math.min(duration, viewEnd) / duration) * w;
    if (vx2 > vx1) {
      bctx.fillStyle = 'rgba(34, 211, 238, 0.14)';
      bctx.fillRect(vx1, 0, vx2 - vx1, h);
      bctx.strokeStyle = 'rgba(34, 211, 238, 0.4)';
      bctx.strokeRect(vx1 + 0.5, 0.5, vx2 - vx1 - 1, h - 1);
    }
  }, [peaks, duration, viewStart, viewEnd]);

  // ② 显示层：复制底图 + 画播放位置线（currentTime 已由 App 降频 ~10fps，开销极小）
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr);
    if (canvas.height !== Math.round(h * dpr)) canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const base = baseRef.current;
    if (base && base.width > 0) ctx.drawImage(base, 0, 0, w, h);
    else ctx.clearRect(0, 0, w, h);

    if (duration <= 0) return;

    // 当前播放位置（红色竖线 + 顶部三角，加粗 + 发光更显眼）
    const shown = dragging && dragTime !== null ? dragTime : currentTime;
    const cx = (Math.max(0, Math.min(duration, shown)) / duration) * w;
    ctx.save();
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 3;
    ctx.shadowColor = 'rgba(239, 68, 68, 0.8)';
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, h);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = '#ef4444';
    ctx.shadowColor = 'rgba(239, 68, 68, 0.8)';
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx - 4, 4);
    ctx.lineTo(cx + 4, 4);
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;
  }, [peaks, duration, currentTime, dragging, dragTime]);

  const getTimeFromClientX = useCallback((clientX: number): number => {
    const rect = canvasRef.current?.getBoundingClientRect();
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
    <canvas
      ref={canvasRef}
      onMouseDown={handleMouseDown}
      className="w-full h-10 rounded-md border border-white/10 bg-gray-950 cursor-pointer select-none"
      title={t('overviewTitle')}
    />
  );
};

export default OverviewBar;
