// osu! TimingPoints 导出模块
//   - 红线：定义 BPM（beatLength = 60000 / bpm）
//   - 绿线：流速 SV = 基准BPM / 当前BPM（四舍五入两位），green = -100 / SV
//   - v0.7.20：**完整导出**——每一条红线都输出（不做合并 / 冗余剔除），与软件内红线一一对应
//
// 时间计算：红线位置以「绝对时间 timeSec」为权威值 —— 有 timeSec 就用它（红线位置独立于 BPM，
// 与界面显示完全一致）；没有 timeSec 才退回按拍号差值累加（time[i] = time[i-1] + 拍数差 × 60000/bpm）。

/** 四舍五入保留指定小数位（处理浮点误差，与 Python round_half_up 一致） */
export function roundHalfUp(x: number, digits: number = 2): number {
  const factor = 10 ** digits;
  return Math.floor(x * factor + 0.5 + 1e-9) / factor;
}

export interface OsuPointInput {
  beatIndex: number;
  bpm: number;
  meter?: number;  // ★ v0.8.17：拍号（每小节几拍），默认 4；写进 [TimingPoints] 第 3 字段
  sv?: boolean;   // 是否生成变速绿线（inherited point），默认 true
  svRate?: number; // 绿线自定义倍速（0/空 = 按基准BPM自动计算）
  timeSec?: number; // 红线绝对时间（秒）—— 权威值：有则红线位置只由它决定（改 BPM 不会挪动下一条红线）
}

/** 绿线流速 SV：自定义倍速（svRate>0）优先，否则按「基准BPM/当前BPM」自动计算 */
function svValueOf(p: OsuPointInput, baseBpm: number): number {
  return p.svRate && p.svRate > 0 ? roundHalfUp(p.svRate, 2) : roundHalfUp(baseBpm / p.bpm, 2);
}

/**
 * 生成 osu! [TimingPoints] 文本
 * @param offsetSec 全局起始偏移（秒，对应 JSON 的 offset）
 * @param points    变速段落（红线；建议直接传 App 的 rawPoints，含 timeSec）
 * @param baseBpm   基准 BPM（用于计算绿线流速 SV）
 */
export function generateOsuTimingPoints(
  offsetSec: number,
  points: OsuPointInput[],
  baseBpm: number
): string {
  // 排序：优先按绝对时间（新模型），无绝对时间则按拍号（与 recalculateTiming 保持一致）
  const sorted = [...points].sort((a, b) => {
    if (typeof a.timeSec === 'number' && typeof b.timeSec === 'number') return a.timeSec - b.timeSec;
    return a.beatIndex - b.beatIndex;
  });
  if (sorted.length === 0) return '[TimingPoints]';

  const offsetMs = offsetSec * 1000.0;

  // 每个红线的绝对时间（毫秒）：timeSec 优先（位置独立），否则按上一段 BPM 累加（旧配置兼容）
  const times: number[] = [offsetMs];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    const beatLenPrev = 60000.0 / Math.max(1, prev.bpm);
    const deltaBeats = cur.beatIndex - prev.beatIndex;
    times.push(
      typeof cur.timeSec === 'number' && isFinite(cur.timeSec)
        ? cur.timeSec * 1000.0
        : times[i - 1] + deltaBeats * beatLenPrev
    );
  }

  const out: string[] = ['[TimingPoints]'];

  for (let i = 0; i < sorted.length; i++) {
    const bpm = sorted[i].bpm;
    const beatLen = 60000.0 / bpm;
    const t = Math.round(times[i]);
    // ★ v0.8.17：拍号（meter）不再硬编码 4，改用该段自己的 meter（默认 4）
    const meter = sorted[i].meter && sorted[i].meter! > 0 ? Math.round(sorted[i].meter!) : 4;

    // 完整输出（v0.7.20）：每一条红线都写一条 timing point，**不做任何合并 / 冗余剔除**
    // —— 导出后的红线数量与软件里完全一致，位置一一对应
    out.push(`${t},${beatLen.toFixed(12)},${meter},1,0,72,1,0`);

    // 绿线：流速 SV = 自定义倍速（svRate>0）或 基准bpm/当前bpm（四舍五入两位）
    // 默认每条红线后都跟一条绿线；该段关闭绿线（sv === false）时不输出
    if (sorted[i].sv !== false) {
      const green = -100.0 / svValueOf(sorted[i], baseBpm);
      out.push(`${t},${green.toFixed(12)},${meter},1,0,72,0,0`);
    }
  }

  return out.join('\n');
}
