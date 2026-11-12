// ===== 自动游玩（autoplay）的按键状态：纯函数，可脱离浏览器回归测试 =====
//
// 预览里「音符落到判定线就自动接上」的效果（KeyImage*D 按下态、mania-stage-light 列灯、
// LightingN/L 命中光）全部由这里的每列状态驱动。
//
// ★ 这里踩过一个坑：一列按下后**永远不松开**。
//   早期实现是「只要这个音符已经越过判定线（dt >= 0）就算按住」，可是可见音符列表是按
//   **最长 LN 时长**回看的（可能几秒），于是一个音符滚过判定线之后还会在列表里待好几秒，
//   期间这一列一直被标记成按下 —— 表现出来就是「没有音符的空段里，按键和灯光还一直亮着，
//   像卡住了」。真实游戏里没有音符就没有按键，autoplay 也一样。
//
// 现在的模型（与 osu!mania 的实际手感一致）：
//   - 普通音符：命中前 HIT_LEAD 按下，命中后 TAP_HOLD 松开（点一下就抬）
//   - 长条 LN：命中前 HIT_LEAD 按下，一直按到尾巴（endMs）
//   - 时间窗之外（还没到 / 已经松开）→ 该列不按下、不亮灯
//   - 命中后的 HIT_FADE 内保留一个 0→1 的闪光值，供 LightingN 淡出用
import type { OsuNotes } from './osuBeatmap';

/** 命中光淡出时长（ms） */
export const HIT_FADE = 240;
/** 命中前多少毫秒按下（键先压下去，音才到） */
export const HIT_LEAD = 55;
/** 普通音符按下后保持多久（再长会跟同列下一个音符连成一片） */
export const TAP_HOLD = 45;

export interface AutoPlayState {
  /** 每列按下程度 0~1（命中后线性衰减，只有灯光用） */
  flash: Float32Array;
  /** 每列是否正被按住（1/0）—— 决定键图换 KeyImage*D、舞台灯亮不亮 */
  pressed: Uint8Array;
  /** 每列是否正按着一条长条（1/0）—— 决定用 LightingL 而不是 LightingN */
  held: Uint8Array;
}

/** 按当前键数准备（或复用）状态数组 */
export function ensureAutoPlayState(out: AutoPlayState, keys: number): AutoPlayState {
  if (out.flash.length !== keys) {
    out.flash = new Float32Array(keys);
    out.pressed = new Uint8Array(keys);
    out.held = new Uint8Array(keys);
  } else {
    out.flash.fill(0);
    out.pressed.fill(0);
    out.held.fill(0);
  }
  return out;
}

/**
 * 根据「可见音符下标 + 当前时间」算出每列状态（写进 out）。
 * `vis` / `visN` 来自 fillVisibleNoteIndices —— 只有屏幕内的音符才需要判断，
 * 数量有上限（≤900），比全曲扫描便宜得多。
 */
export function fillAutoPlayState(
  notes: OsuNotes, vis: readonly number[], visN: number,
  nowMs: number, keys: number, out: AutoPlayState,
): void {
  ensureAutoPlayState(out, keys);
  for (let vi = 0; vi < visN; vi++) {
    const i = vis[vi];
    const col = notes.column[i];
    if (col < 0 || col >= keys) continue;
    const t0 = notes.timeMs[i];
    const dt = nowMs - t0;              // >0 = 已越过判定线（该接了）

    // 命中光：和「是否按住」无关 —— 点一下松开后灯光还要留 ~240ms 的余晖，
    // 否则 LightingN 只会闪一两帧（120fps 下 45ms 只有 5 帧），看着像没亮。
    if (dt >= 0 && dt < HIT_FADE) {
      const f = 1 - dt / HIT_FADE;
      if (f > out.flash[col]) out.flash[col] = f;
    }

    if (dt < -HIT_LEAD) continue;       // 还没到该按的时候
    const isLn = notes.isLn[i] === 1;
    // 松开时刻：长条按到尾巴，普通音符点一下就松
    const release = isLn ? notes.endMs[i] : t0 + TAP_HOLD;
    if (nowMs > release) continue;      // 已经松开（这一列此刻可能是空的）
    out.pressed[col] = 1;
    if (isLn && dt >= 0) out.held[col] = 1;
  }
}
