// ===== 网格吸附：1/1 ~ 1/16 分 =====
//
// 谱面预览的节拍网格按「红线 BPM」划分整拍，再按 div 细分。
// 注意 SV（绿线）只改变**滚动位置**，不改变拍子的时间，
// 所以吸附一律在「时间轴」上做线性取整，不能掺进 SV 位置积分。

/** 1 分 = 整拍，16 分 = 十六分音符；3/6/12 用于三连音 */
export const SNAP_DIVS = [1, 2, 3, 4, 6, 8, 12, 16] as const;

export interface SnapRedLine { tMs: number; bpm?: number }

/**
 * 把时间吸附到当前红线段的 1/div 网格上。
 * @param reds   按 tMs 升序的红线列表（SvTimeline.reds）
 * @param baseBpm 谱面基准 BPM（红线没带 bpm 时兜底）
 */
export function snapTimeMs(
  reds: readonly SnapRedLine[], baseBpm: number, tMs: number, div: number,
): number {
  if (div <= 1 || !reds.length) return tMs;
  let r = reds[0];
  for (let i = 0; i < reds.length; i++) {
    if (reds[i].tMs <= tMs) r = reds[i]; else break;
  }
  const beatMs = 60000 / Math.max(1, r.bpm || baseBpm);
  const sub = beatMs / div;
  const n = Math.round((tMs - r.tMs) / sub);
  return Math.max(0, r.tMs + n * sub);
}

/** 从 localStorage 读取上次的分母（非法值回退 1 分） */
export function loadSnapDiv(key: string): number {
  try {
    const v = Number(localStorage.getItem(key));
    return (SNAP_DIVS as readonly number[]).includes(v) ? v : 1;
  } catch { return 1; }
}
