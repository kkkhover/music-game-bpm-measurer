// osu! TimingPoints 导出模块
//   - 红线：定义 BPM（beatLength = 60000 / bpm，uninherited=1）
//   - 绿线：定义流速 SV（beatLength = -100 / SV，uninherited=0）
//   - v0.9.0：每张卡片可选 红线 / 绿线 / 红线+绿线；**默认 SV = 1（正常流速）**。
//     旧版本「SV = 基准BPM / 当前BPM 的自动补偿」已废弃 —— 现在改 BPM 就该让流速跟着变，
//     想要恒定流速请自行把绿线 SV 设成 基准BPM/当前BPM。
//   - 时间计算：红线位置以「绝对时间 timeSec」为权威值，没有 timeSec 才按拍号差值累加。
import type { LineType } from '../types';
import { emitTimingLines, type TimingEntry, type PatchPoint } from './osuPatch';

/** 四舍五入保留指定小数位（处理浮点误差，与 Python round_half_up 一致） */
export function roundHalfUp(x: number, digits: number = 2): number {
  const factor = 10 ** digits;
  return Math.floor(x * factor + 0.5 + 1e-9) / factor;
}

export interface OsuPointInput {
  beatIndex: number;
  bpm: number;
  meter?: number;   // 拍号（每小节几拍），默认 4
  sv?: boolean;    // 兼容旧配置：false = 不输出绿线
  svRate?: number; // 绿线倍速 SV（默认 1）
  timeSec?: number; // 红线绝对时间（秒）
  lineType?: LineType;
  origin?: { red?: number; green?: number };
}

/**
 * 生成 osu! [TimingPoints] 文本
 * @param offsetSec 全局起始偏移（秒）
 * @param points    变速段落卡片
 * @param baseBpm   兼容参数：旧版用于自动补偿，v0.9.0 起不再参与计算（保留签名）
 */
export function generateOsuTimingPoints(
  offsetSec: number,
  points: OsuPointInput[],
  _baseBpm: number
): string {
  const sorted = [...points].sort((a, b) => {
    if (typeof a.timeSec === 'number' && typeof b.timeSec === 'number') return a.timeSec - b.timeSec;
    return a.beatIndex - b.beatIndex;
  });
  if (sorted.length === 0) return '[TimingPoints]';

  const offsetMs = offsetSec * 1000.0;
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

  const entries: TimingEntry[] = sorted.map((p, i) => ({
    tMs: times[i],
    point: { ...p, timeSec: times[i] / 1000 } as PatchPoint,
  }));
  return ['[TimingPoints]', ...emitTimingLines(entries)].join('\n');
}
