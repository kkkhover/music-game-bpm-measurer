// ===== .osu 增量重建：只替换 [TimingPoints] 段，其余字节原样 =====
// 关键性质：**幂等**。每次都从「卡片数组」重建整段，而不是在上一次结果上追加绿线，
// 连续改 100 次 SV 也不会叠加出 100 条绿线。
// 关键性质 2：**字节级保真**。基于原文字符偏移做定点替换，不重新拼接整份文件，
// 因此 [HitObjects]、元数据、甚至 "\r\r\n" 这种特殊行尾都一个字节不变。
import type { TimingPoint } from '../types';
import type { OsuDocument, RawTimingLine } from './osuBeatmap';
import { findTimingBodyBounds } from './osuBeatmap';

export type PatchPoint = Omit<TimingPoint, 'time'> & { time?: number };

export interface TimingEntry {
  tMs: number;
  point: PatchPoint;
}

const eff = (v: number | undefined, fb: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fb;

/** 卡片 → osu! 原始 timing 行。doc 存在时沿用原文件的采样集/音量/Kiai，避免写回破坏音色。 */
export function emitTimingLines(entries: TimingEntry[], doc?: OsuDocument): string[] {
  const byIdx = new Map<number, RawTimingLine>();
  if (doc) for (const l of doc.timing) byIdx.set(l.index, l);
  const fallback = doc?.timing[0];
  const ss = fallback?.sampleSet ?? 1;
  const si = fallback?.sampleIndex ?? 0;
  const vol = fallback?.volume ?? 100;

  type Row = { t: number; order: number; text: string };
  const rows: Row[] = [];

  for (const { tMs, point: p } of entries) {
    const t = Math.round(tMs);
    const type = p.lineType ?? (p.sv === false ? 'red' : 'both');
    const red = p.origin?.red !== undefined ? byIdx.get(p.origin.red) : undefined;
    const green = p.origin?.green !== undefined ? byIdx.get(p.origin.green) : undefined;
    const sample = red ?? green;
    const meter = Math.max(1, Math.round(eff(p.meter, sample?.meter ?? 4)));
    const sampleSet = sample?.sampleSet ?? ss;
    const sampleIndex = sample?.sampleIndex ?? si;
    const volume = sample?.volume ?? vol;
    const bpm = Math.max(1, p.bpm || 120);
    const sv = p.svRate && p.svRate > 0 ? p.svRate : 1; // ★ 默认 SV = 1（正常流速）

    if (type === 'red' || type === 'both') {
      // 第 8 字段 effects（含 Kiai 及其余标志位）原样回写，不能硬编码 0
      const fx = red?.effects ?? sample?.effects ?? 0;
      rows.push({
        t, order: 0,
        text: `${t},${(60000 / bpm).toFixed(12)},${meter},${sampleSet},${sampleIndex},${volume},1,${fx}`,
      });
    }
    if (type === 'green' || type === 'both') {
      // 合并的「红+绿」卡片：保留原谱面里绿线相对红线的毫秒偏移（常见 0~1ms），
      // 改卡片时间时两条线一起平移，不会把绿线悄悄挪到红线上。
      const greenT = red && green ? t + (green.timeMs - red.timeMs) : t;
      const fx = green?.effects ?? sample?.effects ?? 0;
      rows.push({
        t: greenT, order: 1,
        text: `${Math.round(greenT)},${(-100 / sv).toFixed(12)},${meter},${sampleSet},${sampleIndex},${volume},0,${fx}`,
      });
    }
  }

  rows.sort((a, b) => a.t - b.t || a.order - b.order);
  return rows.map(r => r.text);
}

/** 从卡片数组重建 [TimingPoints] 段正文（不含段标题，'\n' 分隔） */
export function buildTimingSection(doc: OsuDocument, points: PatchPoint[]): string {
  const entries: TimingEntry[] = points.map(p => ({
    tMs: (p.timeSec ?? p.time ?? 0) * 1000,
    point: p,
  }));
  return [...doc.preserved, ...emitTimingLines(entries, doc)].join('\n');
}

/** 定点替换段正文；段外全部使用原文切片，字节完全一致 */
export function rebuildOsuText(doc: OsuDocument, sectionBody: string): string {
  const body = sectionBody.split('\n').join(doc.bodyEol) + doc.bodyEol;
  return doc.text.slice(0, doc.bodyStart) + body + doc.text.slice(doc.bodyEnd);
}

/** 一步到位：卡片 → 完整 .osu 文本 */
export function patchOsuDocument(doc: OsuDocument, points: PatchPoint[]): string {
  return rebuildOsuText(doc, buildTimingSection(doc, points));
}

/**
 * 校验：patched 与 baseline 除 [TimingPoints] 段正文之外必须逐字节完全一致。
 * 写回前调用，任何意外改动都直接拒绝落盘。
 */
export function verifyTimingOnlyChange(baseline: string, patched: string): boolean {
  const a = findTimingBodyBounds(baseline);
  const b = findTimingBodyBounds(patched);
  if (!a || !b) return false;
  return baseline.slice(0, a.bodyStart) === patched.slice(0, b.bodyStart)
    && baseline.slice(a.bodyEnd) === patched.slice(b.bodyEnd);
}
