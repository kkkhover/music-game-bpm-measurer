// ===== osu! 皮肤解析（预览渲染层，纯浏览器 API）=====
//
// 方案参考 fengpengGG/OsuSkinMaker_New 的「游玩预览」（src/js/preview.js，静态舞台示意图）：
//   · 坐标系固定 480 单位高，scale = 屏幕高 / 480；Y(y)=y*scale，UpsideDown 时翻转；
//   · 列布局由 ColumnStart + Σ(ColumnWidth + ColumnSpacing) 递推；
//   · HitPosition 是判定线 / 接收器 / 音符 / LN 的纵向锚点；
//   · 素材读取优先级：skin.ini 指定路径(@2x→1x) → 官方默认名(@2x→1x)；
//   · 图层顺序：列底 → 分隔线 → 舞台 → 接收器 → 音符/LN → 判定线；
//   · LN 用 NoteImage{i}H / L / T，NoteBodyStyle 0=拉伸 1=从顶 2=从底；
//   · 缺组件不报错，用默认色块兜底。
// 该预览本身**没有流速计算**（音符只是静态摆在 hitY-k*70），所以滚动模型独立实现于
// utils/osuScroll.ts + svTimeline.ts。本项目不复制其代码，只参考坐标/图层/字段规范。
//
// 【许可】该仓库根目录没有 LICENSE，本文件是独立编写的 TypeScript 实现。
import type { LineType } from '../types';

export interface SkinPayload {
  name: string;
  iniText: string;
  images: Record<string, string>; // 相对路径（小写）→ dataURL
  count: number;
  note?: string;
  error?: string;
  /** 主进程改写过像素的素材（TIFF→PNG 且只留顶部 rows 行）：h = 原图完整高度，rows = 实际行数 */
  imageMeta?: Record<string, { h: number; rows: number }>;
}

export interface SkinImage {
  img: HTMLImageElement | HTMLCanvasElement;
  is2x: boolean;
  /** 1x 逻辑尺寸（@2x 图按 floor(w/2)） */
  w: number;
  h: number;
  /** 超长底纹只保留了顶部若干行时，这里记录「img 实际覆盖的逻辑行数」。
   *  例：`Orbs\noteL` 是 138×39850，只保留顶部 4096 行 → h=39850、cropRows=4096。 */
  cropRows?: number;
}

type Section = Record<string, string>;
interface ManiaSection { keys: number; sec: Section }

export interface SkinStyle {
  name: string;
  images: Map<string, SkinImage>;   // 精确 stem（可含子目录）
  byBase: Map<string, SkinImage>;   // 仅 basename，兼容 ini 写文件名而素材在子目录
  mania: ManiaSection[];
  general: Section;
  colours: Section;
  imageCount: number;
}

export interface ResolvedSkin {
  laneColors: string[];
  laneLights: string[];
  columnWidth: number[];      // x480 单位
  columnSpacing: number[];
  columnLineWidth: number[];
  columnStart: number;
  hitPosition: number;
  noteStems: string[];        // 普通音符 / 兜底 LN 头
  headStems: string[];        // LN 头
  lnBodyStems: string[];      // LN body
  lnTailStems: string[];      // LN 尾帽
  keyStems: string[];
  keyDownStems: string[];
  stageLeft: string;
  stageRight: string;
  stageBottom: string;
  stageHint: string;
  stageLight: string;
  lightingN: string;
  lightingL: string;
  /** LightingNWidth / LightingLWidth：命中光的宽度（x480 单位），0 = 用列宽 */
  lightingNWidth: number[];
  lightingLWidth: number[];
  colourHold: string;
  judgeLine: boolean;
  keysUnderNotes: boolean;
  upsideDown: boolean;
  noteBodyStyle: number;      // 0=拉伸 / 1=从顶 / 2=从底
  widthForNoteHeightScale: number;
}

/** 解析 skin.ini；段名大小写不敏感，重复 [Mania] 段按出现顺序保留。
 *  同一段内同名字段取**第一个**值（与 OsuSkinMaker / osu! 官方一致）。 */
export function parseSkinIni(text: string): { general: Section; colours: Section; mania: ManiaSection[] } {
  const general: Section = {};
  const colours: Section = {};
  const mania: ManiaSection[] = [];
  let cur: Section = general;
  let isMania = false;
  for (const raw of text.split(/\r\n|\n|\r/)) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;
    const sec = line.match(/^\[\s*([^\]]+?)\s*\]$/);
    if (sec) {
      const n = sec[1].toLowerCase();
      isMania = n === 'mania';
      if (isMania) { cur = {}; mania.push({ keys: 0, sec: cur }); }
      else if (n === 'colours' || n === 'colors') cur = colours;
      else if (n === 'general') cur = general;
      else cur = {};
      continue;
    }
    const kv = line.match(/^([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const val = kv[2].trim();
    if (key in cur) continue; // 首值优先
    cur[key] = val;
    if (isMania && key === 'keys') mania[mania.length - 1].keys = parseInt(val, 10) || 0;
  }
  return { general, colours, mania };
}

const RGB = (v: string | undefined, fallback: string): string => {
  if (!v) return fallback;
  const p = v.split(',').map(s => parseInt(s.trim(), 10));
  if (p.length < 3 || p.slice(0, 3).some(n => !Number.isFinite(n))) return fallback;
  const hex = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
  return `#${hex(p[0])}${hex(p[1])}${hex(p[2])}`;
};

/** 把 dataURL 解码成图片；@2x 预缩放到 1x 逻辑尺寸（floor），坏图跳过。 */
export async function loadSkin(payload: SkinPayload): Promise<SkinStyle> {
  const byStem = new Map<string, { url: string; is2x: boolean; meta?: { h: number; rows: number } }>();
  for (const [name, url] of Object.entries(payload.images || {})) {
    const lower = name.toLowerCase().replace(/\\/g, '/');
    const stem = lower.replace(/\.(png|jpe?g|webp|bmp|tiff?)$/i, '').replace(/@2x$/i, '');
    if (!stem) continue;
    const is2x = /@2x\./.test(lower);
    const prev = byStem.get(stem);
    if (!prev || (is2x && !prev.is2x)) byStem.set(stem, { url, is2x, meta: payload.imageMeta?.[name] });
  }
  const images = new Map<string, SkinImage>();
  const byBase = new Map<string, SkinImage>();
  await Promise.all([...byStem].map(async ([stem, v]) => {
    const src = new Image();
    src.src = v.url;
    try { await src.decode(); } catch {
      // 少数 Chromium 版本对 dataURL 的 decode() 会 reject；若图已加载完就直接继续，
      // 否则 onload 不会再触发，Promise 会永远挂住导致整份皮肤导入卡死。
      await new Promise<void>(res => {
        if (src.complete) { res(); return; }
        src.onload = () => res(); src.onerror = () => res();
      });
    }
    if (!src.naturalWidth || !src.naturalHeight) return;
    const is2x = v.is2x;
    let w = is2x ? Math.max(1, Math.floor(src.naturalWidth / 2)) : src.naturalWidth;
    let h = is2x ? Math.max(1, Math.floor(src.naturalHeight / 2)) : src.naturalHeight;
    // ★ 超长底纹不能等比压缩：真实皮肤的 NoteImage*L 是 138×39850 这种长条，
    //   1:1 解码 22MB，几十条能把 8GB 机器拖进 GC 抖动；但整张压成 2048 又会把
    //   顶端那 88 行透明 + 52 行圆弧压成几行 —— 长条尾端就变成一刀平切。
    //   正确做法：**只保留顶部一段原始像素**。长条素材的圆角/透明头全在开头，
    //   而渲染时也只会从顶部裁（NoteBodyStyle 1/2），永远用不到后面几万行。
    const MAX_DIM = 2048, MAX_AREA = 4_000_000;
    const MAX_BODY_ROWS = 4096;               // 底纹最多保留的逻辑行数（138×4096 ≈ 2.2MB）
    const extreme = h / Math.max(1, w) > 20;   // 长宽比 > 20 的当底纹处理
    let cropRows: number | undefined;
    let img: HTMLImageElement | HTMLCanvasElement = src;
    const forced = v.meta;
    if (forced) {
      // 主进程已经把 TIFF 长条解成 PNG 并只留顶部 rows 行（浏览器不认 TIFF）。
      // 保持「逻辑高 = 原图高、位图只覆盖顶部 rows 行」的语义，这里不再二次裁剪。
      const scale = is2x ? 0.5 : 1;
      const rows = Math.max(1, Math.round(forced.rows * scale));
      h = Math.max(1, Math.round(forced.h * scale));
      const c = document.createElement('canvas');
      c.width = w; c.height = rows;
      const g = c.getContext('2d');
      if (g) { g.imageSmoothingEnabled = true; g.drawImage(src, 0, 0, w, rows); img = c; }
      cropRows = rows;
    } else if (extreme && h > MAX_BODY_ROWS) {
      const rows = MAX_BODY_ROWS;
      const srcRowPx = Math.max(1, Math.round(rows * (src.naturalHeight / Math.max(1, h))));
      const c = document.createElement('canvas');
      c.width = w; c.height = rows;
      const g = c.getContext('2d');
      if (g) {
        g.imageSmoothingEnabled = true;
        g.drawImage(src, 0, 0, src.naturalWidth, srcRowPx, 0, 0, w, rows);
        img = c;
        cropRows = rows;
      }
    } else {
      if (w > MAX_DIM) { const s = MAX_DIM / w; w = MAX_DIM; h = Math.max(1, Math.round(h * s)); }
      if (h > MAX_DIM) {
        if (extreme) h = MAX_DIM;
        else { const s = MAX_DIM / h; h = MAX_DIM; w = Math.max(1, Math.round(w * s)); }
      }
      if (w * h > MAX_AREA) { const s = Math.sqrt(MAX_AREA / (w * h)); w = Math.max(1, Math.round(w * s)); h = Math.max(1, Math.round(h * s)); }
      // @2x 预缩放成 1x 位图：后续每帧 drawImage 不必再做半尺寸采样，帧率更稳
      if (is2x || w !== src.naturalWidth || h !== src.naturalHeight) {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const g = c.getContext('2d');
        if (g) { g.imageSmoothingEnabled = true; g.drawImage(src, 0, 0, w, h); img = c; }
      }
    }
    const ent: SkinImage = { img, is2x: v.is2x, w, h, cropRows };
    images.set(stem, ent);
    const base = stem.split('/').pop() || stem;
    if (!byBase.has(base)) byBase.set(base, ent);
    // 动画帧（官方 mania-note1L-0 / key1-0 等）默认取第一帧：额外注册去掉 -N 的 stem
    const noFrame = stem.replace(/-\d+$/, '');
    if (noFrame !== stem) {
      if (!images.has(noFrame)) images.set(noFrame, ent);
      const nb = noFrame.split('/').pop() || noFrame;
      if (!byBase.has(nb)) byBase.set(nb, ent);
    }
  }));
  const ini = parseSkinIni(payload.iniText || '');
  return {
    name: payload.name || 'skin',
    images, byBase,
    mania: ini.mania,
    general: ini.general,
    colours: ini.colours,
    imageCount: images.size,
  };
}

/** 取字段：优先 KeyN（列专属），再 Key（逗号列表 / 单值） */
function listField(sec: Section, key: string, keys: number, fallback: number): number[] {
  const k = key.toLowerCase();
  const listVal = sec[k];
  const parts = listVal ? listVal.split(',').map(s => parseFloat(s.trim())) : [];
  const out: number[] = [];
  for (let i = 0; i < keys; i++) {
    const per = parseFloat(sec[`${k}${i}`]);
    if (Number.isFinite(per)) out.push(per);
    else if (parts.length) {
      const v = parts[Math.min(i, parts.length - 1)];
      out.push(Number.isFinite(v) ? v : fallback);
    } else out.push(fallback);
  }
  return out;
}

const numField = (sec: Section, key: string, fallback: number): number => {
  const v = parseFloat(sec[key.toLowerCase()]);
  return Number.isFinite(v) ? v : fallback;
};
const boolField = (sec: Section, key: string, fallback: boolean): boolean => {
  const v = sec[key.toLowerCase()];
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes)$/i.test(v.trim());
};

/** ini 里的图片路径 → stem（去引号/扩展名/@2x，反斜杠转正斜杠，小写） */
function stemField(sec: Section, key: string, fallback: string): string {
  const v = (sec[key.toLowerCase()] ?? '').trim();
  // `LightingN: none` / `StageLight: none` 在 osu! 里是「关掉这个素材」，不是「用默认素材」 ——
  // 返回空串让 findSkinImage 直接给 null（否则会误用皮肤里恰好存在的同名默认图）
  if (/^none$/i.test(v)) return '';
  if (!v) return fallback;
  const clean = v.replace(/^["']|["']$/g, '').replace(/\\/g, '/')
    .replace(/\.(png|jpe?g|webp|bmp|tiff?)$/i, '').replace(/@2x$/i, '').toLowerCase();
  return clean || fallback;
}

/** 默认素材名：最外列与偶数列 note1 / key1，奇数列 note2 / key2 */
const layoutOf = (i: number, keys: number) => (i === 0 || i === keys - 1 || i % 2 === 0) ? 1 : 2;
const defaultNote = (i: number, keys: number) => `mania-note${layoutOf(i, keys)}`;
const defaultKey = (i: number, keys: number) => `mania-key${layoutOf(i, keys)}`;

/** 按当前谱面键数解析成渲染用的扁平样式（O(keys)，切难度时重算一次即可） */
export function skinForKeys(skin: SkinStyle, keys: number): ResolvedSkin {
  const sec = skin.mania.find(m => m.keys === keys)?.sec
    ?? skin.mania.find(m => m.keys === 0)?.sec
    ?? skin.mania[skin.mania.length - 1]?.sec
    ?? {};
  const laneColors: string[] = [];
  const laneLights: string[] = [];
  const noteStems: string[] = [];
  const headStems: string[] = [];
  const lnBodyStems: string[] = [];
  const lnTailStems: string[] = [];
  const keyStems: string[] = [];
  const keyDownStems: string[] = [];
  for (let i = 0; i < keys; i++) {
    const n = i + 1;
    laneColors.push(RGB(sec[`colour${n}`] ?? skin.colours[`colour${n}`] ?? skin.colours[`color${n}`], i % 2 ? '#222236' : '#1e1e30'));
    laneLights.push(RGB(sec[`colourlight${n}`], '#4a4a68'));
    const def = defaultNote(i, keys);
    const note = stemField(sec, `noteimage${i}`, def);
    noteStems.push(note);
    // LN 三段：官方是 NoteImage{i}H / L / T；很多皮肤只给 L + T，头复用普通音符图
    headStems.push(stemField(sec, `noteimage${i}h`, `${def}h`));
    lnBodyStems.push(stemField(sec, `noteimage${i}l`, `${def}l`));
    lnTailStems.push(stemField(sec, `noteimage${i}t`, `${def}t`));
    const kd = defaultKey(i, keys);
    keyStems.push(stemField(sec, `keyimage${i}`, kd));
    keyDownStems.push(stemField(sec, `keyimage${i}d`, `${kd}d`));
  }
  const pick = (k: string, fallback: string) => stemField(sec, k, fallback);
  return {
    laneColors, laneLights,
    columnWidth: listField(sec, 'columnwidth', keys, 40).map(v => Math.max(6, v)),
    columnSpacing: listField(sec, 'columnspacing', keys, 0).map(v => Math.max(0, v)),
    columnLineWidth: listField(sec, 'columnlinewidth', keys, 1),
    columnStart: numField(sec, 'columnstart', Math.max(0, (480 - keys * 40) / 2)),
    hitPosition: Math.min(480, Math.max(120, numField(sec, 'hitposition', 402))),
    noteStems, headStems, lnBodyStems, lnTailStems, keyStems, keyDownStems,
    stageLeft: pick('stageleft', 'mania-stage-left'),
    stageRight: pick('stageright', 'mania-stage-right'),
    stageBottom: pick('stagebottom', 'mania-stage-bottom'),
    stageHint: pick('stagehint', 'mania-stage-hint'),
    stageLight: pick('stagelight', 'mania-stage-light'),
    lightingN: pick('lightingn', 'lightingn'),
    lightingL: pick('lightingl', 'lightingl'),
    lightingNWidth: listField(sec, 'lightingnwidth', keys, 0).map(v => Math.max(0, v)),
    lightingLWidth: listField(sec, 'lightinglwidth', keys, 0).map(v => Math.max(0, v)),
    colourHold: RGB(sec['colourhold'] ?? '', '#ffffff'),
    judgeLine: boolField(sec, 'judgementline', true),
    keysUnderNotes: boolField(sec, 'keysundernotes', true),
    upsideDown: boolField(sec, 'upsidedown', false),
    // 缺省按「从顶裁剪」(1)：与 OsuSkinMaker 一致，也让 138×39850 这类超长底纹
    // 只取顶部一段真实像素，而不是把整张压成一条纯色（0=拉伸 / 1=从顶 / 2=从底）
    noteBodyStyle: Math.max(0, Math.min(2, Math.round(numField(sec, 'notebodystyle', 1)))),
    widthForNoteHeightScale: numField(sec, 'widthfornoteheightscale', 0),
  };
}

/** 精确 stem → 退到 basename；stem 可带 -0 动画帧后缀，逐级剥离 */
export function findSkinImage(skin: SkinStyle, stem: string): SkinImage | null {
  if (!stem) return null;
  const s = stem.toLowerCase().replace(/\\/g, '/').replace(/@2x$/i, '');
  const direct = skin.images.get(s);
  if (direct) return direct;
  // 官方默认素材常带 -0 / -1 动画帧，皮肤只提供单张时按 stem 前缀再找一次
  let candidate = s;
  for (let i = 0; i < 3; i++) {
    const hit = skin.images.get(candidate);
    if (hit) return hit;
    const m = candidate.match(/^(.*)-\d+$/);
    if (!m) break;
    candidate = m[1];
  }
  const base = s.split('/').pop() || s;
  return skin.byBase.get(base) ?? skin.byBase.get(base.replace(/-\d+$/, '')) ?? null;
}

/** 依次尝试多个 stem（例如 LN 头：专用 H 图 → 普通音符图） */
export function findSkinImageAny(skin: SkinStyle, stems: (string | undefined)[]): SkinImage | null {
  for (const s of stems) {
    if (!s) continue;
    const hit = findSkinImage(skin, s);
    if (hit) return hit;
  }
  return null;
}

export interface LaneLayout {
  x: number[];        // 每列左边界（CSS 像素）
  width: number[];    // 每列宽（CSS 像素）
  total: number;      // 舞台总宽（CSS 像素）
  unit: number;       // x480 单位 → CSS 像素
  judgeY: number;     // 判定线 y（= viewTop + HitPosition × unit）
  offsetY: number;    // Y(y) = offsetY + y*unit（y 为 x480 单位，从游玩区顶部算）
  refW: number;       // 音符图高度换算用的参考宽度（x480）
  // ---- 固定比例的游玩区（letterbox 之后的位置，CSS 像素）----
  viewW: number;      // 游玩区宽（x480 单位，按谱面键数/皮肤列宽算定）
  viewH: number;      // 游玩区高，恒为 480 单位
  viewLeft: number;
  viewTop: number;
  viewRight: number;
  viewBottom: number;
  stageW: number;     // 舞台宽（x480 单位）
}

/**
 * x480 坐标下降式列布局。
 *
 * ★ 关键：游玩区取**固定比例**（宽 = 舞台宽 + 留白，高恒 480 单位），
 *   再按 min(w/viewW, h/viewH) 等比缩放进小窗并居中（letterbox）。
 *   这样拖动小窗只改变缩放，**不会拉扁/拉长游玩区** —— 旧实现让 unit 同时受
 *   宽和高约束（且以宽度为主），窗口一变形状就失真，判定线位置也跟着漂。
 *
 * 判定线严格按 osu! 语义：HitPosition 是「从游玩区顶部算起的 x480 坐标」，
 * 于是 judgeY = viewTop + HitPosition × unit；旧实现从画布底部倒推，
 * 遇到 HitPosition=454 这类低判定线皮肤就贴到窗口下沿、接收器被切掉。
 */
export function laneLayout(keys: number, w: number, h: number, rs: ResolvedSkin | null): LaneLayout {
  const widths = rs ? rs.columnWidth : new Array(keys).fill(40);
  const spaces = rs ? rs.columnSpacing : new Array(keys).fill(0);
  let stageW = 0;
  for (let i = 0; i < keys; i++) stageW += widths[i] + (i < keys - 1 ? spaces[i] : 0);
  stageW = Math.max(24, stageW);

  // 左右留白：按舞台宽的 16%，并保证游玩区至少 300 单位宽（≈ 0.625 竖屏比例），
  // 否则 4K 默认列宽（160 单位）会得到一条过窄的竖条。
  const pad = Math.max(16, Math.min(64, Math.round(stageW * 0.16)));
  const viewW = Math.max(stageW + pad * 2, 300);
  const viewH = 480;

  const unit = Math.max(0.05, Math.min(w / viewW, h / viewH));
  const viewLeft = (w - viewW * unit) / 2;
  const viewTop = (h - viewH * unit) / 2;
  const viewRight = viewLeft + viewW * unit;
  const viewBottom = viewTop + viewH * unit;

  // 舞台水平居中于游玩区（ColumnStart 只作参考：它按 16:9 的 853 单位宽设计，
  // 直接套到竖屏会把舞台推到画外）
  const stageLeft = viewLeft + ((viewW - stageW) / 2) * unit;
  const x: number[] = [];
  const wp: number[] = [];
  let cx = stageLeft;
  for (let i = 0; i < keys; i++) {
    x.push(cx);
    wp.push(Math.max(2, widths[i] * unit));
    cx += (widths[i] + (i < keys - 1 ? spaces[i] : 0)) * unit;
  }

  const hitPos = Math.max(60, Math.min(480, rs ? rs.hitPosition : 402));
  const judgeY = viewTop + hitPos * unit;
  const offsetY = viewTop;
  const posW = widths.filter(v => v > 0);
  const refW = rs && rs.widthForNoteHeightScale > 0
    ? rs.widthForNoteHeightScale
    : Math.min(...posW) || 40;
  return {
    x, width: wp, total: stageW * unit, unit, judgeY, offsetY, refW,
    viewW, viewH, viewLeft, viewTop, viewRight, viewBottom, stageW,
  };
}

/** 频谱 timing 线颜色：绿线绿、红线红、红+绿橙（与预览小窗、长图共用同一套语义） */
export function lineColor(type: LineType | undefined, sv?: boolean): string {
  const t: LineType = type ?? (sv === false ? 'red' : 'both');
  return t === 'green' ? '#3cc83c' : t === 'red' ? '#ef4444' : '#f59e0b';
}

/**
 * 接收器（KeyImage）矩形：宽 = 列宽，高 = **图片自身高度 × 0.625**（x768 → x480），
 * 底边贴游玩区下沿。
 *
 * ★ 这里不是「按宽高比等比缩放」——osu!mania 的皮肤素材是按 **x768** 坐标系画的，
 *   而游玩区只有 480 单位高，所以要乘 480/768 = 0.625（= 除以 1.6）。
 *   fengpengGG/OsuSkinMaker_New 的 `drawKeys()` 用的正是 `ent.h * scale / 1.6`，
 *   宽度则直接拉伸到列宽，不做等比 —— 之前按 `imgH/imgW × 列宽` 算出来的高度
 *   偏大约 14%，圆环被拉成竖椭圆，判定线也就压不准。
 *
 * 例：真实皮肤 `Orbs\key` = 100×284，列宽 73 单位 → 高 284×0.625 = 177.5 单位（2.43 倍列宽）。
 *   该图的可见圆环位于 y 145~247，换算后环底几乎正好落在 HitPosition=454 的判定线上。
 */
export function receptorRect(layout: LaneLayout, col: number, imgW: number, imgH: number) {
  const w = layout.width[col];
  const MULT_FILE = 0.625;   // x768 → x480
  const h = Math.max(2, (imgH > 0 ? imgH : Math.max(1, imgW)) * MULT_FILE * layout.unit);
  return { x: layout.x[col], y: layout.viewBottom - h, w, h };
}
