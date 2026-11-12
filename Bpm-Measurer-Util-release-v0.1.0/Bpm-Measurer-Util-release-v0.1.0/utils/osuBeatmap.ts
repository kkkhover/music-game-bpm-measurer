// ===== 外部 .osu 谱面文档解析器 =====
// 设计目标（v0.9.0 实时变速预览）：
//   1. 完整保留原文，写回时只替换 [TimingPoints] 段，其余字节原样；
//   2. [HitObjects] 用 TypedArray 存储 —— 10000 音符只占 ~100KB，不制造几千个 JS 对象；
//   3. 每条 timing 行都能变成一张卡片（红线 / 绿线 / 红线+绿线），
//      带 SV 的谱面（实测 2981 条绿线）不会丢任何一条；
//   4. 只解析磁盘上的外部文件，绝不读取游戏进程 / tosu / gosumemory。
//
// 【重要】实测 osu! 导出包里的 .osu 行尾可能是 "\r\r\n"（双 CR）。
// 用 text.replace(/\r\n?/g,'\n') 会把一行拆成两行 —— 曾导致 7K 的 CircleSize 扫不到、
// 段内凭空多出 900 条空行。所以这里用「吞掉连续 \r\n」的行扫描器，
// 并额外记录每个段在原文里的字符偏移，写回时做定点替换（字节级保真）。
import type { LineType, TimingPoint } from '../types';

interface LineSpan { text: string; eol: string; start: number; end: number }

function scanLines(text: string): LineSpan[] {
  const out: LineSpan[] = [];
  let i = 0;
  while (i < text.length) {
    let j = i;
    while (j < text.length && text[j] !== '\r' && text[j] !== '\n') j++;
    let k = j;
    while (k < text.length && (text[k] === '\r' || text[k] === '\n')) k++;
    out.push({ text: text.slice(i, j), eol: text.slice(j, k), start: i, end: k });
    if (k === j) break; // 末行没有行尾符
    i = k;
  }
  return out;
}

/** 在任意原文里定位 [TimingPoints] 段正文的字符范围（供写回安全校验做逐字节比对） */
export function findTimingBodyBounds(text: string): { bodyStart: number; bodyEnd: number } | null {
  const spans = scanLines(text);
  const lines = spans.map(s => s.text);
  const start = lines.findIndex(l => l.trim() === '[TimingPoints]');
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[[A-Za-z]+\]\s*$/.test(lines[i])) { end = i; break; }
  }
  return { bodyStart: spans[start].end, bodyEnd: spans[end]?.start ?? text.length };
}

/** [TimingPoints] 段内的一行原始记录 */
export interface RawTimingLine {
  index: number;        // 段内行下标（0 = 段标题后第一行）
  timeMs: number;
  beatLength: number;   // 红线 = 60000/bpm；绿线 = -100/SV
  meter: number;
  sampleSet: number;
  sampleIndex: number;
  volume: number;
  uninherited: boolean; // 第 7 字段 = 1 → 红线
  effects: number;      // 第 8 字段原值（bit0=Kiai，其它位也有含义，必须原样保留）
  kiai: boolean;        // effects bit0
  raw: string;
}

/** 音符数据（列式 TypedArray，内存友好） */
export interface OsuNotes {
  count: number;
  timeMs: Float64Array;
  endMs: Float64Array;   // 普通音符 = timeMs
  column: Uint8Array;
  isLn: Uint8Array;      // 1 = 长条 (type & 128)
  /** 最长 LN 持续时间（ms）。视口按下界回看时必须带上它，
   *  否则长条起点滚出视口后 body 会被整个裁掉 —— 高流速下就是「LN 提前消失」。 */
  maxHoldMs: number;
}

export interface OsuDocument {
  sourcePath: string;    // 磁盘上的 .osu 绝对路径（.osz → 解压出的工作副本）
  displayName: string;
  text: string;          // 导入时的原文快照（基线）
  lines: string[];
  eol: string;           // 主行尾符（信息用）
  bodyStart: number;     // ★ 原文中「[TimingPoints] 标题行之后」的字符偏移
  bodyEnd: number;       // ★ 原文中「下一个 [xxx] 段标题行」的字符偏移
  bodyEol: string;       // ★ timing 段内使用的行尾符
  sectionStart: number;  // '[TimingPoints]' 所在行下标
  sectionEnd: number;    // 下一个 '[xxx]' 行下标（不含）
  timing: RawTimingLine[];
  preserved: string[];   // 段内注释 / 无法解析的行，写回时原样放回
  notes: OsuNotes;
  keyCount: number;      // mania 键数：4K / 7K / …
  mode: number;
  circleSize: number;
  audioFilename: string;
  title: string;
  artist: string;
  version: string;
  durationMs: number;
}

const num = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** 解析完整 .osu 文本；失败（无 [TimingPoints]）返回 null */
export function parseOsuDocument(text: string, sourcePath = '', displayName = ''): OsuDocument | null {
  const spans = scanLines(text);
  const lines = spans.map(s => s.text);
  const sectionStart = lines.findIndex(l => l.trim() === '[TimingPoints]');
  if (sectionStart < 0) return null;
  let sectionEnd = lines.length;
  for (let i = sectionStart + 1; i < lines.length; i++) {
    if (/^\s*\[[A-Za-z]+\]\s*$/.test(lines[i])) { sectionEnd = i; break; }
  }
  const eol = spans.find(s => s.eol)?.eol || '\n';
  const bodyStart = spans[sectionStart]?.end ?? text.length;
  const bodyEnd = spans[sectionEnd]?.start ?? text.length;
  const bodyEol = spans[sectionStart + 1]?.eol || eol;

  // ---- 元数据（要扫到 [TimingPoints] 之前的所有行；[Difficulty] 可能在第 70 行）----
  const meta: Record<string, string> = {};
  for (let i = 0; i < sectionStart; i++) {
    const m = lines[i].match(/^\s*([A-Za-z][A-Za-z0-9]*)\s*:\s*(.*)$/);
    if (m) meta[m[1].toLowerCase()] = m[2].trim();
  }
  const mode = num(meta['mode'], 0);
  const circleSize = num(meta['circlesize'], 4);
  const keyCount = Math.max(1, Math.min(18, Math.round(circleSize) || 4));

  // ---- [TimingPoints] ----
  const timing: RawTimingLine[] = [];
  const preserved: string[] = [];
  for (let i = sectionStart + 1; i < sectionEnd; i++) {
    const raw = lines[i];
    const s = raw.trim();
    if (!s || s.startsWith('//')) { preserved.push(raw); continue; }
    const p = s.split(',');
    if (p.length < 2 || !Number.isFinite(parseFloat(p[0])) || !Number.isFinite(parseFloat(p[1]))) {
      preserved.push(raw); continue;
    }
    const beatLength = parseFloat(p[1]);
    if (beatLength === 0) { preserved.push(raw); continue; }
    const effects = p.length >= 8 ? parseInt(p[7], 10) || 0 : 0;
    timing.push({
      index: i - sectionStart - 1,
      timeMs: parseFloat(p[0]),
      beatLength,
      meter: p.length >= 3 ? (parseInt(p[2], 10) || 4) : 4,
      sampleSet: p.length >= 4 ? (parseInt(p[3], 10) || 0) : 0,
      sampleIndex: p.length >= 5 ? (parseInt(p[4], 10) || 0) : 0,
      volume: p.length >= 6 ? (parseInt(p[5], 10) || 100) : 100,
      uninherited: p.length >= 7 ? parseInt(p[6], 10) === 1 : beatLength > 0,
      effects,
      kiai: (effects & 1) === 1,
      raw,
    });
  }

  // ---- [HitObjects] ----
  const hoIdx = lines.findIndex(l => l.trim() === '[HitObjects]');
  const tmpT: number[] = [], tmpE: number[] = [], tmpC: number[] = [], tmpL: number[] = [];
  if (hoIdx >= 0) {
    for (let i = hoIdx + 1; i < lines.length; i++) {
      const s = lines[i].trim();
      if (!s || s.startsWith('//')) continue;
      if (/^\[[A-Za-z]+\]$/.test(s)) break;
      const p = s.split(',');
      if (p.length < 5) continue;
      const x = parseFloat(p[0]);
      const timeMs = parseFloat(p[2]);
      const type = parseInt(p[3], 10) || 0;
      if (!Number.isFinite(x) || !Number.isFinite(timeMs)) continue;
      let isLn = (type & 128) !== 0 ? 1 : 0;
      // mania: column = floor(x * keyCount / 512)，与 fengpengGG/get_column 一致
      let col = Math.floor((x * keyCount) / 512);
      if (col < 0) col = 0;
      if (col >= keyCount) col = keyCount - 1;
      let endMs = timeMs;
      if (isLn) {
        const end = p.length >= 6 ? parseFloat(p[5].split(':')[0]) : NaN;
        if (Number.isFinite(end) && end > timeMs) endMs = end;
        else isLn = 0; // 无效长条按普通音符画
      }
      tmpT.push(timeMs); tmpE.push(endMs); tmpC.push(col); tmpL.push(isLn);
    }
  }
  // 视口裁剪依赖「按时间有序」。绝大多数 .osu 本来有序，个别导出工具会乱序 → 只对这种情况排序
  let sorted = true;
  for (let i = 1; i < tmpT.length; i++) if (tmpT[i] < tmpT[i - 1]) { sorted = false; break; }
  if (!sorted) {
    const idx = tmpT.map((_, i) => i).sort((a, b) => tmpT[a] - tmpT[b]);
    const t2 = idx.map(i => tmpT[i]), e2 = idx.map(i => tmpE[i]);
    const c2 = idx.map(i => tmpC[i]), l2 = idx.map(i => tmpL[i]);
    for (let i = 0; i < idx.length; i++) {
      tmpT[i] = t2[i]; tmpE[i] = e2[i]; tmpC[i] = c2[i]; tmpL[i] = l2[i];
    }
  }
  const count = tmpT.length;
  let maxHoldMs = 0;
  for (let i = 0; i < count; i++) {
    const hold = tmpE[i] - tmpT[i];
    if (hold > maxHoldMs) maxHoldMs = hold;
  }
  const notes: OsuNotes = {
    count,
    timeMs: Float64Array.from(tmpT),
    endMs: Float64Array.from(tmpE),
    column: Uint8Array.from(tmpC),
    isLn: Uint8Array.from(tmpL),
    maxHoldMs,
  };

  let maxEnd = 0;
  for (let i = 0; i < count; i++) if (notes.endMs[i] > maxEnd) maxEnd = notes.endMs[i];
  const maxTiming = timing.reduce((m, l) => Math.max(m, l.timeMs), 0);

  return {
    sourcePath,
    displayName: displayName || (sourcePath.split(/[\\/]/).pop() || 'beatmap.osu'),
    text, lines, eol, bodyStart, bodyEnd, bodyEol,
    sectionStart, sectionEnd, timing, preserved, notes,
    keyCount, mode, circleSize,
    audioFilename: meta['audiofilename'] || '',
    title: meta['title'] || '',
    artist: meta['artist'] || '',
    version: meta['version'] || '',
    durationMs: Math.max(maxEnd, maxTiming) + 2000,
  };
}

/** 从文档生成 UI 卡片：红线+同刻绿线合并成 'both'，其余各占一张卡片 */
export function docToPoints(doc: OsuDocument): { offset: number; points: Omit<TimingPoint, 'time'>[] } {
  const lines = doc.timing;
  const used = new Set<number>();
  const points: Omit<TimingPoint, 'time'>[] = [];
  let lastBpm = 120;
  const firstRed = lines.find(l => l.uninherited);
  if (firstRed) lastBpm = 60000 / firstRed.beatLength;

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (used.has(l.index)) continue;
    if (l.uninherited) {
      used.add(l.index);
      const bpm = Math.round((60000 / l.beatLength) * 1000) / 1000;
      lastBpm = bpm;
      // 找紧随其后、时间差 ≤1ms 的绿线（osu! 里常见的红线+绿线配对）
      let paired: RawTimingLine | null = null;
      for (let j = i + 1; j < lines.length && lines[j].timeMs - l.timeMs <= 1; j++) {
        if (!used.has(lines[j].index) && !lines[j].uninherited) { paired = lines[j]; break; }
      }
      points.push({
        id: `osu-${l.index}`,
        beatIndex: points.length,
        bpm,
        meter: l.meter,
        sv: !!paired,
        // 不能四舍五入！-100/beatLength 再反解回 beatLength 必须逐位相等，
        // 否则整张谱面的 SV 会被悄悄改写（实测 -63.636363… → -63.653723…）。
        svRate: paired ? -100 / paired.beatLength : 1,
        timeSec: l.timeMs / 1000,
        lineType: paired ? 'both' : 'red',
        origin: { red: l.index, green: paired?.index },
      });
      if (paired) used.add(paired.index);
    } else {
      used.add(l.index);
      const sv = -100 / l.beatLength;
      points.push({
        id: `osu-${l.index}`,
        beatIndex: points.length,
        bpm: lastBpm, // 绿线卡片的 BPM 仅供节拍网格参考，导出时不写红线
        meter: l.meter,
        sv: true,
        svRate: Number.isFinite(sv) && sv > 0 ? sv : 1, // 全精度保留
        timeSec: l.timeMs / 1000,
        lineType: 'green',
        origin: { green: l.index },
      });
    }
  }

  // timeSec 升序（同刻：红线在前），稳定排序
  points.sort((a, b) => (a.timeSec ?? 0) - (b.timeSec ?? 0) || a.beatIndex - b.beatIndex);
  return { offset: (firstRed?.timeMs ?? 0) / 1000, points };
}

/** 二分：返回第一个 timeMs >= t 的音符下标 */
export function firstNoteAtOrAfter(notes: OsuNotes, t: number): number {
  let lo = 0, hi = notes.count;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (notes.timeMs[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
