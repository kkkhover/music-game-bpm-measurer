import { TimingPoint } from '../types';

export const recalculateTiming = (offset: number, points: Omit<TimingPoint, 'time'>[]): TimingPoint[] => {
  // 排序：优先用红线绝对时间（v0.7.18 新模型），没有则退回按拍号（旧配置兼容）
  const sorted = [...points].sort((a, b) => {
    if (typeof a.timeSec === 'number' && typeof b.timeSec === 'number') return a.timeSec - b.timeSec;
    return a.beatIndex - b.beatIndex;
  });

  const result: TimingPoint[] = [];

  // 起点锚点：时间恒等于全局 Offset（拍号强制为 0）
  if (sorted.length > 0) {
    result.push({ ...sorted[0], beatIndex: 0, time: offset });
  } else {
    return [{ id: 'default', beatIndex: 0, bpm: 120, time: offset }];
  }

  // 后续段落：
  //  ① 红线位置：有绝对时间 timeSec 就用它（红线独立，改 BPM 不会挪动下一条红线）；
  //     没有则按「拍号差值 × 上一段拍长」推算（旧配置兼容）
  //  ② 输出拍号：回到 v0.7.18 的整数派生写法（界面「拍号」显示整数，便于阅读）
  //     注意：导入的谱面会把每条红线的绝对时间存进 timeSec，所以取整不会丢精度
  for (let i = 1; i < sorted.length; i++) {
    const prevStored = sorted[i - 1];
    const prev = result[i - 1];
    const curr = sorted[i];
    const beatDur = 60 / Math.max(1, prev.bpm);
    // 有绝对时间 → 直接用（改 BPM 不动它）；没有 → 按拍号差值 + 上一段拍长推算
    const rawTime = (typeof curr.timeSec === 'number' && isFinite(curr.timeSec))
      ? curr.timeSec
      : prev.time + (curr.beatIndex - prevStored.beatIndex) * beatDur;
    // 防呆：不允许早于/等于前一条红线（拖动越界时钳制）
    const time = Math.max(prev.time + 0.001, rawTime);
    // 派生整数拍号（供节拍器调度 / 导出 / 编号使用，至少 1 拍）
    const beats = Math.max(1, Math.round((time - prev.time) / beatDur));

    result.push({
      ...curr,
      time,
      beatIndex: prev.beatIndex + beats,
    });
  }

  return result;
};

export const getPointAtTime = (time: number, points: TimingPoint[]): { point: TimingPoint, index: number } => {
  // Find the last point that has time <= query time
  for (let i = points.length - 1; i >= 0; i--) {
    if (time >= points[i].time) {
      return { point: points[i], index: i };
    }
  }
  return { point: points[0], index: 0 };
};

export const getBeatIndexAtTime = (time: number, points: TimingPoint[]): number => {
    const { point } = getPointAtTime(time, points);
    const timeDiff = time - point.time;
    const secondsPerBeat = 60 / point.bpm;
    return point.beatIndex + (timeDiff / secondsPerBeat);
};

export const getTimeAtBeatIndex = (beatIndex: number, points: TimingPoint[]): number => {
    // Find point where point.beatIndex <= beatIndex
    // We assume points are sorted
    let point = points[0];
    for(let i = points.length - 1; i >= 0; i--) {
        if (beatIndex >= points[i].beatIndex) {
            point = points[i];
            break;
        }
    }
    
    const beatDiff = beatIndex - point.beatIndex;
    return point.time + beatDiff * (60 / point.bpm);
};
