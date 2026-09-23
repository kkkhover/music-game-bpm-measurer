import React, { useRef, useState, useCallback } from 'react';

interface ProgressBarProps {
  currentTime: number;   // 当前播放位置（秒）
  duration: number;      // 总时长（秒）
  onSeek: (time: number) => void;  // 跳转回调
}

/**
 * 音频进度条：点击跳转 + 按住拖拽跳转
 * 拖拽过程中仅本地预览位置，松手后才真正执行 onSeek，
 * 避免播放中频繁 seek 导致音频反复重启。
 */
const ProgressBar: React.FC<ProgressBarProps> = ({ currentTime, duration, onSeek }) => {
  const barRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [dragTime, setDragTime] = useState<number | null>(null);

  // 根据鼠标 X 坐标换算为时间（秒），钳制在 [0, duration]
  const getTimeFromClientX = useCallback((clientX: number): number => {
    const rect = barRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return 0;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return ratio * duration;
  }, [duration]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (duration <= 0) return;
    e.preventDefault();
    const startTime = getTimeFromClientX(e.clientX);
    setDragging(true);
    setDragTime(startTime);

    const handleMove = (ev: MouseEvent) => {
      setDragTime(getTimeFromClientX(ev.clientX));
    };
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

  // 拖拽中显示拖拽位置，否则显示实际播放位置
  const shownTime = dragging && dragTime !== null ? dragTime : currentTime;
  const percent = duration > 0 ? Math.max(0, Math.min(100, (shownTime / duration) * 100)) : 0;

  return (
    <div
      ref={barRef}
      onMouseDown={handleMouseDown}
      className="group relative w-full h-5 flex items-center cursor-pointer select-none"
      title="点击或拖拽跳转播放位置"
    >
      {/* 背景轨道 */}
      <div className="relative w-full h-1.5 bg-gray-800 rounded-full overflow-visible">
        {/* 已播放填充 */}
        <div
          className="absolute left-0 top-0 h-full bg-indigo-500 rounded-full"
          style={{ width: `${percent}%` }}
        />
        {/* 拖拽手柄 */}
        <div
          className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3.5 h-3.5 rounded-full bg-white border-2 border-indigo-500 shadow-md transition-transform ${dragging ? 'scale-110' : 'scale-0 group-hover:scale-100'}`}
          style={{ left: `${percent}%` }}
        />
      </div>
    </div>
  );
};

export default ProgressBar;
