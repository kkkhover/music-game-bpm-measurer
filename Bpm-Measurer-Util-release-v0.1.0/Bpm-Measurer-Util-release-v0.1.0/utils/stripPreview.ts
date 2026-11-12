// ===== 静态长图预览渲染（沿用 fengpengGG / om_Beatmap_Preview_Generator 的版式规范）=====
// 参考其 preview_generator.py / shared.py 的：暗色配色、窄条钢琴卷帘、
// 「每 5 小节一条 → 自动换行铺满画布」的流式布局、红线/绿线/BPM 标注、LN 画法、图例。
// 本文件是独立 JS/Canvas 实现（不复制其 Python 代码，也不打包 Python/ffmpeg），
// 并补上原工具缺失的两点：① SV 时间轴积分参与 y 坐标 ② 键数自适应 4K/7K。
import type { OsuDocument } from './osuBeatmap';
import { firstNoteAtOrAfter } from './osuBeatmap';
import type { SvTimeline } from './svTimeline';

const C = {
  bg: '#141420', header: '#1c1c2c', card: '#28283e',
  pink: '#ff66aa', blue: '#66b2ff', green: '#66ffb2', orange: '#ffb266',
  dim: '#8282a0', red: '#dc3c3c', greenLine: '#3cc83c',
  col: '#1e1e30', colAlt: '#222236',
  note: '#c8c8eb', ln: '#9696c3', outline: '#5a5a7d',
  grid: '#34344c', divider: '#3c3c55', strip: '#191928',
};

export interface StripPreviewResult { width: number; height: number; strips: number }

/** 按 osu! 红线把全曲切成「每 5 小节一段」，与 Python 版 _build_measure_segments 同构 */
function buildSegments(tl: SvTimeline, durationMs: number, measuresPerStrip = 5): [number, number][] {
  const reds = tl.reds;
  const boundaries: number[] = [];
  if (reds.length === 0) {
    const measure = (60000 / tl.baseBpm) * 4;
    for (let t = 0; t < durationMs; t += measure) boundaries.push(t);
  } else {
    for (let i = 0; i < reds.length; i++) {
      const start = reds[i].tMs;
      const end = i + 1 < reds.length ? reds[i + 1].tMs : durationMs;
      const beatMs = 60000 / Math.max(1, reds[i].bpm || tl.baseBpm);
      const measure = beatMs * 4;
      for (let t = start; t < end - 0.5 && boundaries.length < 20000; t += measure) {
        if (t > (boundaries[boundaries.length - 1] ?? -1) + 0.5) boundaries.push(t);
      }
    }
  }
  boundaries.push(durationMs);
  const segs: [number, number][] = [];
  for (let i = 0; i < boundaries.length - 1; i += measuresPerStrip) {
    const end = boundaries[Math.min(i + measuresPerStrip, boundaries.length - 1)];
    if (end > boundaries[i]) segs.push([boundaries[i], end + 1]);
  }
  return segs;
}

const fmtTime = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * 把整曲长图画进一张离屏 canvas。调用方负责分配 canvas 并导出 Blob，
 * 导出后把 canvas.width/height 置 0 即可立刻释放显存/主存。
 */
export function renderStripPreview(
  canvas: HTMLCanvasElement,
  doc: OsuDocument,
  tl: SvTimeline,
  opts: { maxWidth?: number; maxHeight?: number } = {}
): StripPreviewResult {
  const keys = doc.keyCount;
  const colW = Math.max(9, Math.round(96 / keys));
  const colGap = 2;
  const timeLabelW = 34;
  const stripPad = 8;
  const stripW = stripPad * 2 + timeLabelW + keys * colW + (keys - 1) * colGap;
  const gapX = 16, gapY = 20;
  const margin = 28;
  const headerH = 400;

  const refBpm = tl.baseBpm;
  const scale = Math.max(0.08, Math.min(0.40, refBpm / 1000));
  const stripH = Math.max(260, Math.min(760, Math.round(5 * (60000 / refBpm) * 4 * scale)));
  const maxWidth = opts.maxWidth ?? 2000;
  const maxHeight = opts.maxHeight ?? 6000;
  const perRow = Math.max(1, Math.floor((maxWidth - margin * 2 + gapX) / (stripW + gapX)));

  let segs = buildSegments(tl, doc.durationMs);
  let rows = Math.ceil(segs.length / perRow);
  // 硬上限：再高就按比例截断，避免 5000×20000 的画布把内存打穿
  const maxRows = Math.max(1, Math.floor((maxHeight - headerH - 100) / (stripH + gapY)));
  if (rows > maxRows) {
    segs = segs.slice(0, maxRows * perRow);
    rows = maxRows;
  }
  const width = Math.min(maxWidth, margin * 2 + perRow * stripW + (perRow - 1) * gapX);
  const height = headerH + 36 + rows * (stripH + gapY) + 60;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return { width, height, strips: segs.length };

  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = C.header;
  ctx.fillRect(0, 0, width, headerH);

  // ---- 头部信息（同原工具的标题 / 作者 / 统计行 / 谱面 ID 行）----
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 60px "Microsoft YaHei", sans-serif';
  ctx.fillText(doc.title || doc.displayName.replace(/\.osu$/i, ''), margin, 28);
  ctx.fillStyle = '#f0f0ff';
  ctx.font = '32px "Microsoft YaHei", sans-serif';
  ctx.fillText(`by ${doc.artist || 'Unknown'}`, margin, 112);
  ctx.fillStyle = '#dcdcf5';
  ctx.font = '25px "Microsoft YaHei", sans-serif';
  ctx.fillText(`${doc.version}   ·   ${keys}K   ·   Mode ${doc.mode}`, margin, 158);

  let bpmMin = Infinity, bpmMax = 0, svMin = Infinity, svMax = 0, svCount = 0;
  for (const m of tl.markers) {
    if (m.kind === 'red' && m.bpm) { bpmMin = Math.min(bpmMin, m.bpm); bpmMax = Math.max(bpmMax, m.bpm); }
    if (m.kind === 'green' && m.sv) { svMin = Math.min(svMin, m.sv); svMax = Math.max(svMax, m.sv); svCount++; }
  }
  const bpmText = bpmMax > 0 ? `${Math.round(bpmMin)}~${Math.round(bpmMax)}` : `${Math.round(refBpm)}`;
  const stats: [string, string, string][] = [
    [bpmText, 'BPM', C.pink],
    [String(doc.notes.count), 'NOTES', C.blue],
    [svCount ? `${svMin.toFixed(2)}~${svMax.toFixed(2)}` : '1.00', 'SV', C.green],
    [fmtTime(doc.durationMs), 'LENGTH', C.orange],
  ];
  let sx = margin;
  ctx.font = 'bold 50px "Microsoft YaHei", sans-serif';
  for (const [val, label, color] of stats) {
    ctx.fillStyle = color;
    ctx.fillText(val, sx, 220);
    const w = ctx.measureText(val).width;
    ctx.fillStyle = '#dcdcf0';
    ctx.font = '22px "Microsoft YaHei", sans-serif';
    ctx.fillText(label, sx + w + 10, 244);
    sx += w + Math.max(120, ctx.measureText(label).width + 60);
    ctx.font = 'bold 50px "Microsoft YaHei", sans-serif';
  }
  ctx.fillStyle = C.dim;
  ctx.font = '20px "Microsoft YaHei", sans-serif';
  ctx.fillText(`Source: ${doc.displayName}  |  SV-aware piano roll  |  ${segs.length} strips`, margin, 320);
  ctx.fillText('红线 = BPM   ·   绿线 = SV   ·   纵轴按 ∫(BPM × SV) dt 积分（可看出变速）', margin, 352);

  // ---- 窄条钢琴卷帘 ----
  const topY = headerH + 36;
  const notes = doc.notes;
  const redMarkers = tl.reds;
  for (let si = 0; si < segs.length; si++) {
    const [s, e] = segs[si];
    const row = Math.floor(si / perRow);
    const col = si % perRow;
    const x = margin + col * (stripW + gapX);
    const y = topY + row * (stripH + gapY);
    const posS = tl.posAt(s), posE = tl.posAt(e);
    const posSpan = Math.max(1e-6, posE - posS);
    // 关键：y 由 SV 积分位置决定，而不是线性时间
    const yOf = (tMs: number) => y + stripH - ((tl.posAt(tMs) - posS) / posSpan) * stripH;

    ctx.fillStyle = C.strip;
    ctx.fillRect(x, y, stripW, stripH);
    const colX = x + stripPad + timeLabelW;
    for (let k = 0; k < keys; k++) {
      ctx.fillStyle = k % 2 === 0 ? C.col : C.colAlt;
      ctx.fillRect(colX + k * (colW + colGap), y + 2, colW, stripH - 4);
    }
    // 小节 / 拍网格（按每条红线的 BPM 铺拍线）
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    for (let ri = 0; ri < redMarkers.length; ri++) {
      const m = redMarkers[ri];
      if (m.tMs > e) break;
      const beatMs = 60000 / Math.max(1, m.bpm || refBpm);
      const stop = Math.min(e, redMarkers[ri + 1]?.tMs ?? e);
      for (let t = m.tMs; t <= stop; t += beatMs) {
        if (t < s) continue;
        const gy = yOf(t);
        if (gy < y + 2 || gy > y + stripH - 2) continue;
        ctx.beginPath();
        ctx.moveTo(x + stripPad, gy);
        ctx.lineTo(colX + keys * (colW + colGap), gy);
        ctx.stroke();
      }
    }
    // 红/绿 timing 线
    for (let mi = tl.markerIndexAt(s); mi < tl.markers.length; mi++) {
      const m = tl.markers[mi];
      if (m.tMs > e) break;
      const my = yOf(m.tMs);
      ctx.strokeStyle = m.kind === 'red' ? C.red : C.greenLine;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x + stripPad, my);
      ctx.lineTo(colX + keys * (colW + colGap), my);
      ctx.stroke();
      ctx.fillStyle = ctx.strokeStyle;
      ctx.font = '11px monospace';
      ctx.fillText(m.kind === 'red' ? `${Math.round(m.bpm || 0)}` : `${(m.sv || 1).toFixed(2)}x`, x + stripPad + 2, my - 13);
    }
    // 音符（二分定位，只遍历本段时间窗）
    let i = firstNoteAtOrAfter(notes, s);
    for (; i < notes.count && notes.timeMs[i] <= e; i++) {
      const yb = yOf(notes.timeMs[i]);
      const yt = notes.isLn[i] ? yOf(notes.endMs[i]) : yb - 7;
      const cx = colX + notes.column[i] * (colW + colGap) + 1;
      const w = colW - 2;
      const h = Math.max(4, yb - Math.max(yt, y - 8));
      if (yb < y - 8 || yt > y + stripH + 8) continue;
      ctx.fillStyle = notes.isLn[i] ? C.ln : C.note;
      ctx.strokeStyle = C.outline;
      ctx.lineWidth = 1;
      ctx.fillRect(cx, yb - h, w, h);
      ctx.strokeRect(cx, yb - h, w, h);
      if (notes.isLn[i]) {
        ctx.fillStyle = C.note;
        ctx.fillRect(cx, yb - Math.min(7, h), w, Math.min(7, h));
      }
    }
    // 时间标签
    ctx.fillStyle = C.dim;
    ctx.font = '11px monospace';
    ctx.fillText(fmtTime(e), x + stripPad, y + 4);
    ctx.fillText(fmtTime(s), x + stripPad, y + stripH - 16);
  }

  // ---- 图例 ----
  const ly = height - 36;
  let lx = width - 400;
  const legend: [string, string][] = [['Normal', C.note], ['LN', C.ln], ['BPM', C.red], ['SV', C.greenLine]];
  ctx.font = '14px "Microsoft YaHei", sans-serif';
  for (const [label, color] of legend) {
    ctx.fillStyle = color;
    ctx.fillRect(lx, ly, 12, 12);
    ctx.fillStyle = C.dim;
    ctx.fillText(label, lx + 18, ly - 2);
    lx += 96;
  }
  return { width, height, strips: segs.length };
}
