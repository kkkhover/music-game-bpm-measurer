// ===== osu!mania 滚动速度模型（与 osu! stable 一致的物理量）=====
//
// 走完整个 480 单位游玩区的时间：T = 13720 / (SS × 流速)，其中
//     **流速 = (BPM / 基准BPM) × SV**
// osu! 的「Scale osu!mania scroll speed with BPM」只忽略**跨谱面**的 BPM 差异，
// 谱面内 BPM 一改流速就变；作者想保持不变必须用绿线 SV = 原BPM/新BPM 补偿
// （官方论坛 posts/6564040、posts/7246487）。所以「BPM×SV」才是游戏内的真实流速，
// 早先按「T 与 BPM 无关」实现的那版会让橙线处流速掉到 SV 倍，是错的 —— 见 svTimeline.ts。
//
// 参考：https://osu.ppy.sh/community/forums/posts/4512471
//       https://osu.ppy.sh/community/forums/posts/6564040
//       https://osu.ppy.sh/community/forums/posts/7246487
export const OSU_SCROLL_MS = 13720;
export const OSU_AREA_UNITS = 480;

/** osu! 风格的 SS 数值范围（stable 的 1~40，玩家常用 15~30） */
export const SS_MIN = 1;
export const SS_MAX = 40;
export const SS_DEFAULT = 20;

/**
 * 滚动速度（像素/秒）。
 * @param unit  x480 单位 → CSS 像素的缩放比（皮肤布局算出来的 scale）
 * @param ss    osu! ScrollSpeed（1~40）
 * SV 不在这里：它已经积分进 SvTimeline.posAt() 的位置里了。
 */
export function osuPxPerSec(unit: number, ss: number): number {
  return (OSU_AREA_UNITS * unit * Math.max(SS_MIN, ss) * 1000) / OSU_SCROLL_MS;
}

/** 当前流速下，音符从屏幕顶端落到判定线所需毫秒（HUD 显示用） */
export function osuVisibleMs(ss: number, speed: number, hitPosition = OSU_AREA_UNITS): number {
  const s = Math.max(0.01, Math.max(SS_MIN, ss) * Math.max(0.01, speed));
  return (OSU_SCROLL_MS * Math.min(1, Math.max(0.1, hitPosition) / OSU_AREA_UNITS)) / s;
}

/** SS 滑块值 → 显示文本 */
export function osuSpeedLabel(ss: number, speed: number, hitPosition = OSU_AREA_UNITS): string {
  const ms = osuVisibleMs(ss, speed, hitPosition);
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}
