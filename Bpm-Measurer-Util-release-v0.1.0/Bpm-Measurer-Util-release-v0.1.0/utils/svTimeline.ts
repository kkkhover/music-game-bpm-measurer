// ===== SV 时间轴：把 osu! 红线(BPM) / 绿线(SV) 变成「位置积分」 =====
//
// ★ 流速模型（2026-11 修正，这是 osu!mania 的真实行为）：
//     v(t) = (bpm(t) / 基准BPM) × sv(t)
//   osu! 的「Scale osu!mania scroll speed with BPM」只忽略**跨谱面**的 BPM 差异，
//   谱面内 BPM 一改，流速照样跟着变；想保持不变必须自己用绿线补偿
//   `SV = 原BPM / 新BPM`（官方论坛 posts/6564040、posts/7246487；osu! wiki 3.3 SV 一节）。
//   所以谱面里那些「BPM 改了、绿线反向补偿」的橙线（红线+同刻绿线）满足
//     bpm × sv = 基准BPM  ⇒  v = 1，流速不变。
//   旧实现取 v = sv，橙线处流速会掉到 sv 倍（例如 250BPM + SV 0.60 变成 60%），是错的。
//   bpmScale=false 仅为「只想看纯 SV 曲线」时保留，不再作为默认。
//
// 音符滚动位置 pos(t) = ∫ v(t) dt（单位：秒），再乘 osuPxPerSec 得到像素。
// 用分段常数 + 前缀和 + 二分，任意时刻查询 O(log n)，改一次 SV 重建只要 O(n)（3000 条 < 1ms）。
// 这正是 fengpengGG 预览生成器缺的一环：它的 y 是线性时间映射，改 SV 画面不会动。
import type { LineType } from '../types';
import type { PatchPoint } from './osuPatch';

export interface SvSegment {
  tMs: number;   // 段起点
  bpm: number;
  sv: number;
  speed: number; // 归一化流速
  pos: number;   // 从 0 积分到 tMs 的位置
}

export interface SvMarker {
  tMs: number;
  kind: 'red' | 'green';
  bpm?: number;
  sv?: number;
}

export interface SvTimeline {
  segments: SvSegment[];
  markers: SvMarker[];
  reds: SvMarker[]; // 预筛好的红线列表，渲染循环里不再每帧 filter（避免 GC 抖动）
  baseBpm: number;
  startMs: number;
  endMs: number;
  posAt: (tMs: number) => number;
  timeAtPos: (pos: number) => number;
  stateAt: (tMs: number) => { bpm: number; sv: number; speed: number };
  markerIndexAt: (tMs: number) => number; // 第一个 tMs >= 查询值的 marker 下标（渲染视口裁剪）
}

/** 二分：最后一个 start <= t 的段下标 */
function segIndexAt(segs: SvSegment[], tMs: number): number {
  let lo = 0, hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (segs[mid].tMs <= tMs) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export interface TimelineOptions {
  /** true（默认）= osu!mania 的真实模型：BPM 参与流速，v=(bpm/基准)×sv；
   *  false = 只看 SV（纯 SV 曲线预览用）。 */
  bpmScale?: boolean;
}

export function buildSvTimeline(points: PatchPoint[], endMs = 0, opts: TimelineOptions = {}): SvTimeline {
  type Ev = { t: number; order: number; bpm?: number; sv?: number };
  const evs: Ev[] = [];
  const markers: SvMarker[] = [];

  for (const p of points) {
    const type: LineType = p.lineType ?? (p.sv === false ? 'red' : 'both');
    const t = ((p.timeSec ?? p.time ?? 0) * 1000);
    if (type === 'red' || type === 'both') {
      const bpm = Math.max(1, p.bpm || 120);
      evs.push({ t, order: 0, bpm });
      markers.push({ tMs: t, kind: 'red', bpm });
    }
    if (type === 'green' || type === 'both') {
      const sv = p.svRate && p.svRate > 0 ? p.svRate : 1;
      evs.push({ t, order: 1, sv });
      markers.push({ tMs: t, kind: 'green', sv });
    }
  }
  evs.sort((a, b) => a.t - b.t || a.order - b.order);
  markers.sort((a, b) => a.tMs - b.tMs || (a.kind === 'red' ? -1 : 1));

  const firstBpm = evs.find(e => e.bpm !== undefined)?.bpm ?? points[0]?.bpm ?? 120;
  // 基准 BPM = 出现次数最多的红线 BPM（次数相同取更早的），没有红线时退回第一条 BPM。
  // 用「主导 BPM」而不是「第一条」：谱面开头常有一段过渡 BPM，
  // 而作者补偿 SV 时对齐的是音乐主体速度 —— 用主导 BPM 才能让橙线正好落在 100%。
  const bpmCount = new Map<number, number>();
  for (const e of evs) {
    if (e.bpm === undefined) continue;
    bpmCount.set(e.bpm, (bpmCount.get(e.bpm) ?? 0) + 1);
  }
  let dominant = firstBpm, dominantCount = 0;
  for (const e of evs) {
    if (e.bpm === undefined) continue;
    const c = bpmCount.get(e.bpm) ?? 0;
    if (c > dominantCount) { dominant = e.bpm; dominantCount = c; }
  }
  const baseBpm = Math.max(1, dominant || firstBpm);
  const startMs = evs.length ? evs[0].t : 0;
  let bpm = firstBpm;
  let sv = 1;
  // 默认：BPM 参与流速（osu!mania 实际行为）；bpmScale=false 时退化为纯 SV
  const scale = opts.bpmScale !== false;
  const speedOf = (b: number, s: number) => scale ? (b / baseBpm) * s : s;
  const segments: SvSegment[] = [];
  let prevT = startMs;

  // 起点之前按 1 倍速：让「哨兵段」和第一条真实段在 startMs 处位置连续，
  // 否则 posAt(t) 会在第一个 timing 点跳变，timeAtPos 反解就不再是单调可逆的。
  segments.push({ tMs: -1e12, bpm: baseBpm, sv: 1, speed: 1, pos: -1e12 / 1000 });
  let pos = startMs / 1000;

  for (const e of evs) {
    if (e.t > prevT) {
      pos += ((e.t - prevT) / 1000) * speedOf(bpm, sv);
      prevT = e.t;
    }
    if (e.bpm !== undefined) bpm = e.bpm;
    if (e.sv !== undefined) sv = e.sv;
    const spd = speedOf(bpm, sv);
    const last = segments[segments.length - 1];
    if (last && last.tMs === e.t) {
      last.bpm = bpm; last.sv = sv; last.speed = spd; last.pos = pos;
    } else {
      segments.push({ tMs: e.t, bpm, sv, speed: spd, pos });
    }
  }

  const naturalEnd = Math.max(endMs, prevT + 2000, startMs + 2000);
  // 尾段用最后一档速度延伸到谱面结束
  const tailSpeed = speedOf(bpm, sv);
  segments.push({ tMs: naturalEnd + 1, bpm, sv, speed: tailSpeed,
    pos: pos + ((naturalEnd + 1 - prevT) / 1000) * tailSpeed });

  const posAt = (tMs: number): number => {
    const i = segIndexAt(segments, tMs);
    const s = segments[i];
    return s.pos + ((tMs - s.tMs) / 1000) * s.speed;
  };
  const timeAtPos = (p: number): number => {
    let lo = 0, hi = segments.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (segments[mid].pos <= p) lo = mid;
      else hi = mid - 1;
    }
    const s = segments[lo];
    return s.tMs + ((p - s.pos) / Math.max(1e-6, s.speed)) * 1000;
  };
  const stateAt = (tMs: number) => {
    const s = segments[segIndexAt(segments, tMs)];
    return { bpm: s.bpm, sv: s.sv, speed: s.speed };
  };

  const markerIndexAt = (t: number): number => {
    let lo = 0, hi = markers.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (markers[mid].tMs < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  return { segments, markers, reds: markers.filter(m => m.kind === 'red'), baseBpm, startMs, endMs: naturalEnd, posAt, timeAtPos, stateAt, markerIndexAt };
}
