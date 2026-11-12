// ===== 钢琴卷帘视口裁剪（纯函数，可脱离浏览器做回归测试）=====
//
// 旧实现有两个会互相放大的 bug：
//  1. 视口下界只看 `nowMs - 400` 之后**起点**的音符。LN 的起点滚过判定线 400ms 后
//     就被跳过，可它的尾巴（endMs）还在屏幕上 —— 表现为「长条提前消失」，
//     SV / ScrollSpeed 越高，起点越早出界，消失得越早。
//  2. `for (...; i++, drawn++)` 把**被 continue 跳过**的音符也算进 1500 的绘制配额，
//     高流速下回看区间里全是已过去的音符，配额瞬间被吃光，可见音符反而画不出来。
//
// 正确做法：按「最长 LN 时长」回看，用 endMs 判断整条是否已经过去，
// 并且只把真正要画的音符计入配额。
import type { OsuNotes } from './osuBeatmap';
import { firstNoteAtOrAfter } from './osuBeatmap';

/** 视口内可见的音符下标（按 timeMs 升序，最多 maxDrawn 个） */
export function visibleNoteIndices(notes: OsuNotes, tMin: number, tMax: number, maxDrawn = 1500): number[] {
  const out: number[] = [];
  fillVisibleNoteIndices(notes, tMin, tMax, maxDrawn, out);
  return out;
}

/**
 * 同上，但把结果写进调用方给的数组（返回实际个数）。
 * 渲染循环每帧都要算一次可见音符，用固定数组可以避免每秒上千次小数组分配。
 */
export function fillVisibleNoteIndices(
  notes: OsuNotes, tMin: number, tMax: number, maxDrawn: number, out: number[],
): number {
  out.length = 0;
  if (notes.count === 0 || tMax < tMin) return 0;
  // 回看上界：最长的一条 LN 有可能「起点早已过去、尾巴还挂在屏幕上」。
  // 夹到 60 秒，避免异常谱面（几十分钟的 LN）把整曲扫一遍。
  const lookback = Math.min(notes.maxHoldMs || 0, 60000);
  let i = firstNoteAtOrAfter(notes, tMin - lookback);
  let n = 0;
  for (; i < notes.count; i++) {
    if (notes.timeMs[i] > tMax) break;
    if (notes.endMs[i] < tMin) continue; // 整条已过视口（普通音符 endMs === timeMs）
    out[n++] = i;
    if (n >= maxDrawn) break;            // 只有真正要画的才占配额
  }
  return n;
}

export interface NoteRect {
  top: number;     // 裁剪后的上边界（屏幕坐标）
  bottom: number;  // 裁剪后的下边界
  height: number;
}

/**
 * 把一个音符（含 LN body）裁剪到 [0, height] 画布。
 * @param yStart 起点 y（普通音符 / LN 头，靠近判定线的一侧，数值较大）
 * @param yEnd   尾部 y（LN 尾，更靠屏幕上方，数值较小；普通音符 = yStart - 头高）
 * @returns null = 整条都在屏幕外，不用画
 */
export function noteRect(yStart: number, yEnd: number, height: number): NoteRect | null {
  if (yStart < 0 || yEnd > height) return null;
  const top = Math.max(0, yEnd);
  const bottom = Math.min(height, yStart);
  if (bottom - top < 0.5) return null;
  return { top, bottom, height: bottom - top };
}
