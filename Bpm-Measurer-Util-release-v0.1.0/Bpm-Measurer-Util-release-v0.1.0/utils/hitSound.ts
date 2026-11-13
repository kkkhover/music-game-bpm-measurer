// ===== 打击音效：采样选择（纯函数，可脱离浏览器回归测试） =====
//
// osu 的 hitsound 分「采样组 × 音色」两级：
//   - 采样组（sample set）：normal / soft / drum，由 timing point 的 sampleSet 字段决定（1=normal 2=soft 3=drum）
//   - 音色（hitSound 位）：normal(bit0) / whistle(bit1) / finish(bit2) / clap(bit3)
//   文件名 = `<set>-hit<kind>.wav`，例如 normal-hitnormal / soft-hitclap / drum-hitfinish。
//
// 一个音符可以同时带多个音色位（如 whistle+clap 叠加）。osu 的规则：finish/clap/whistle
// 都是「叠加在 normal 之上」的音色，但实际播放里 finish 最响、优先级最高，其次 clap，
// 再 whistle，最后只播 normal。这里按优先级选**一个**主音色（简化，不做多音叠加，
// 否则每个音符要同时起 2~3 个采样，低配机连打时音频节点爆炸）。

/** 音色位 */
export const HS_NORMAL = 1;  // bit0
export const HS_WHISTLE = 2; // bit1
export const HS_FINISH = 4;  // bit2
export const HS_CLAP = 8;    // bit3

/** 采样组 → 文件名前缀 */
const SET_PREFIX: Record<number, string> = { 1: 'normal', 2: 'soft', 3: 'drum' };

/** 音色位 → 文件名后缀（按优先级从高到低尝试） */
const KIND_ORDER: { bit: number; suffix: string }[] = [
  { bit: HS_FINISH, suffix: 'hitfinish' },
  { bit: HS_CLAP, suffix: 'hitclap' },
  { bit: HS_WHISTLE, suffix: 'hitwhistle' },
  { bit: HS_NORMAL, suffix: 'hitnormal' },
];

/**
 * 由 hitSound 位 + sampleSet 决定要播哪个采样名（`<set>-<kind>`）。
 * @param hitSound 音符的 hitSound 字段（bit0~3）
 * @param sampleSet timing point 的采样组（1=normal 2=soft 3=drum，0/缺省 → normal）
 * @returns 采样名（如 `normal-hitclap`）；永远有值（最低回退到 normal-hitnormal）
 */
export function pickHitSound(hitSound: number, sampleSet: number): string {
  const set = SET_PREFIX[sampleSet] || 'normal';
  // 最低位（normal）恒为 1 也要有音；先按优先级找第一个置位的音色
  for (const k of KIND_ORDER) {
    if (hitSound & k.bit) return `${set}-${k.suffix}`;
  }
  // 没有任何音色位（理论上不会，normal 至少 bit0）→ 回退 normal
  return `${set}-hitnormal`;
}

/**
 * 采样名若在当前皮肤里没有（比如皮肤只给了 normal 组、没给 drum 组），
 * 按 osu 的规则回退：drum → normal，soft → normal，normal → normal。
 * @param name 想播的采样名
 * @param has 一个判断「皮肤里有没有这个采样」的函数
 * @returns 实际可用的采样名（可能回退到 normal-hitX）
 */
export function fallbackHitSound(name: string, has: (name: string) => boolean): string {
  if (has(name)) return name;
  // 拆 `<set>-<kind>`，把 set 回退到 normal
  const m = name.match(/^(soft|drum)-(hit\w+)$/);
  if (m) {
    const normal = `normal-${m[2]}`;
    if (has(normal)) return normal;
  }
  // normal 组也没有该音色 → 回退 normal-hitnormal
  const kind = name.split('-')[1] || 'hitnormal';
  const last = `normal-${kind}`;
  if (has(last)) return last;
  return 'normal-hitnormal';
}
