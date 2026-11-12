import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, Download, Film, Disc3, Music4, Square, Grid3X3, Eye, Palette, Info, RotateCcw, PictureInPicture2 } from 'lucide-react';
import type { OsuDocument } from '../utils/osuBeatmap';
import { firstNoteAtOrAfter } from '../utils/osuBeatmap';
import { buildSvTimeline } from '../utils/svTimeline';
import { renderStripPreview } from '../utils/stripPreview';
import { fillVisibleNoteIndices } from '../utils/noteViewport';
import { fillAutoPlayState, ensureAutoPlayState, type AutoPlayState } from '../utils/autoPlay';
import {
  loadSkin, skinForKeys, findSkinImage, findSkinImageAny, laneLayout, receptorRect,
  type SkinStyle, type SkinPayload, type SkinImage, type ResolvedSkin, type LaneLayout,
} from '../utils/osuSkin';
import { osuPxPerSec, osuSpeedLabel, SS_MIN, SS_MAX, SS_DEFAULT } from '../utils/osuScroll';
import { recSizePerMinute } from '../utils/settings';
import { safeFileName } from '../utils/exportName';
import { stepClock, newClock } from '../utils/previewClock';
import type { PatchPoint } from '../utils/osuPatch';
import type { PreviewCommand } from '../utils/previewBridge';

// 默认配色沿用 fengpengGG / om_Beatmap_Preview_Generator 的 preview_generator.py；
// 导入皮肤后由其 skin.ini [Mania] 的列色与素材覆盖。
const C = {
  bg: '#141420', panel: '#1c1c2c', line: '#3c3c55',
  col: '#1e1e30', colAlt: '#222236',
  note: '#c8c8eb', ln: '#9696c3', outline: '#5a5a7d',
  grid: '#34344c', red: '#dc3c3c', green: '#3cc83c', both: '#f59e0b',
  pink: '#ff66aa', blue: '#66b2ff', dim: '#8282a0', text: '#e5e7eb',
};

/** 播放控制命令：录制时要「从当前播放头自动开播」，独立窗口要把命令转给主窗口执行 */
export type { PreviewCommand };

export interface PreviewFps { vsync: boolean; limit: number }

interface Props {
  doc: OsuDocument;
  points: PatchPoint[];
  getPlayheadTime: () => number;   // 秒，直接读 App 的 playheadRef（不触发 React 重渲染）
  onClose: () => void;
  /** 帧率：vsync=跟随垂直同步；否则按 limit 限帧（0 = 无限制） */
  fps?: PreviewFps;
  /** 播放控制（录制自动开播 / 停止 / 定位） */
  onCommand?: (cmd: PreviewCommand) => void;
  /** 弹成独立窗口（内嵌模式下显示按钮；独立窗口里传 undefined） */
  onDetach?: () => void;
  /** 独立窗口模式：铺满窗口、标题栏拖动整个 OS 窗口、不用内嵌的缩放手柄 */
  detached?: boolean;
  /** 录制分辨率短边像素（480 / 720 / 1080），缺省 720 */
  recHeight?: number;
  /** 录制帧率（30 / 60 / 120），缺省 60 */
  recFps?: number;
  /** 录制视频码率（kbps），缺省 2000 */
  recKbps?: number;
  /** 录制音频流（主窗口的 masterGain → MediaStreamDestination）。
   *  独立窗口没有音频图，拿不到就只录画面。 */
  getAudioStream?: () => MediaStream | null;
  /** 主窗口的播放状态。传了它，暂停那一刻就**精确**锁死画面（不用等播放头"看起来不动"）；
   *  不传（或独立窗口还没收到）则退回停滞检测，最多多走一帧。 */
  playing?: boolean;
  /** 音频总时长（毫秒）。录制在这一刻停 —— 谱面 durationMs 只到「最后一个音符 + 2s」，
   *  照它停会把音乐尾巴切掉，完整录制就"不完整"了。 */
  audioMs?: number;
  /** 节拍器是否混进录制音轨（主窗口设置 settings.recordMetronome） */
  recordMetronome?: boolean;  /** 切换「节拍器入录」：内嵌模式直接改设置，独立窗口把消息转给主窗口 */
  onRecordMetronomeChange?: (v: boolean) => void;
  /** 录制开始 / 结束：主窗口据此临时关掉频谱的「跟随播放头」，
   *  否则录制期间视口会满屏乱翻（录的是小窗，但眼睛受罪、还白白吃性能）。 */
  onRecordingChange?: (on: boolean) => void;
}

interface WinState { x: number; y: number; w: number; h: number }
const WIN_KEY = 'bpm.preview.win.v2';
const SS_KEY = 'bpm.preview.ss.v2';
/** 记住上次用的皮肤来源（文件夹 / .osk）。下次打开预览、或弹出独立窗口时直接按它重读。 */
const SKIN_KEY = 'bpm.preview.skin.v1';
const MIN_W = 180;
const MIN_H = 200;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const DPR_CAP = 1.5;

/**
 * 录制参数（默认值；实际值来自设置面板「预览录制」，见 settings.ts 的 recHeight/recFps/recKbps）：
 * - 分辨率按**短边**定：竖屏小窗 → 短边是宽；横屏 → 短边是高。长边按小窗比例算，上限 16:9。
 * - 码率默认 2000 kbps（旧版硬编码 3.3 Mbps，用户反馈文件太大）；预览画面纯色块多，
 *   2000 kbps 的 H.264 看不出压缩痕。音频固定 128 kbps。
 */
const REC_DEF_HEIGHT = 720;
const REC_DEF_FPS = 60;
const REC_DEF_KBPS = 2000;
const REC_AUDIO_KBPS = 128;
const REC_MAX_MS = 30 * 60 * 1000; // 安全上限：半小时自动停，避免一直挂着录满内存

function loadWin(): WinState {
  try {
    const s = JSON.parse(localStorage.getItem(WIN_KEY) || 'null');
    if (s && Number.isFinite(s.w) && Number.isFinite(s.h)) {
      return {
        w: clamp(s.w, MIN_W, 1600),
        h: clamp(s.h, MIN_H, 1600),
        x: clamp(s.x ?? 0, 0, Math.max(0, window.innerWidth - 100)),
        y: clamp(s.y ?? 0, 0, Math.max(0, window.innerHeight - 100)),
      };
    }
  } catch { /* 坏配置用默认值 */ }
  const w = 320, h = 560;
  return { w, h, x: Math.max(12, window.innerWidth - w - 24), y: 88 };
}

function loadSS(): number {
  try {
    const v = Number(localStorage.getItem(SS_KEY));
    if (Number.isFinite(v) && v >= SS_MIN && v <= SS_MAX) return v;
  } catch { /* ignore */ }
  return SS_DEFAULT;
}

/** 上次用的皮肤来源。返回的路径可能已经失效（皮肤被删/移动），加载时再给提示。 */
function loadSkinSource(): { path: string; name: string } | null {
  try {
    const s = JSON.parse(localStorage.getItem(SKIN_KEY) || 'null');
    if (s && typeof s.path === 'string' && s.path) return { path: s.path, name: String(s.name || '') };
  } catch { /* ignore */ }
  return null;
}

const api = () => (window as any).electronAPI;

async function saveBytes(defaultPath: string, bytes: Uint8Array, filters: { name: string; extensions: string[] }[]) {
  const a = api();
  const name = safeFileName(defaultPath);
  if (!a?.saveBinaryFile) {
    const blob = new Blob([bytes as BlobPart], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const el = document.createElement('a');
    el.href = url; el.download = name; el.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return;
  }
  const r = await a.saveBinaryFile({ defaultPath: name, filters, bytes });
  if (r && !r.ok && r.error) alert(r.error);
}

function paint(ctx: CanvasRenderingContext2D, im: SkinImage, x: number, y: number, w: number, h: number) {
  if (w <= 0 || h <= 0) return;
  ctx.drawImage(im.img, x, y, w, h);
}

/**
 * 接收器（KeyImage）：宽度 = 列宽，高度按图片自身比例，**底边贴判定线**。
 *
 * osu! 的 mania 键图是「竖长列面板」——真实皮肤里 `Orbs\key` 是 100×284，
 * 按列宽 73 单位换算高度 ≈ 207 单位（从判定线往上铺）。旧实现
 * `ki.h * unit / 1.6` 把它压扁成一条细椭圆、还锚在判定线**下方**，
 * 于是画面底部出现被切掉一半的虚线椭圆，判定区域完全错位。
 */
function drawReceptors(g: CanvasRenderingContext2D, layout: LaneLayout, SK: ResolvedSkin, SKIN: SkinStyle) {
  for (let k = 0; k < layout.x.length; k++) {
    const ki = findSkinImageAny(SKIN, [SK.keyStems[k], SK.keyDownStems[k]]);
    if (!ki) continue;
    const q = receptorRect(layout, k, ki.w, ki.h);
    if (q.y + q.h <= layout.viewTop) continue;
    paint(g, ki, q.x, q.y, q.w, q.h);
  }
}

/** 皮肤自带的「按下判定区」素材。
 *
 *  照 fengpengGG/OsuSkinMaker_New 的 `preview.js`（src/js/preview.js:784-852）：
 *   - `StageLight`（mania-stage-light）：按压列的舞台灯，**高 30 个 x480 单位、以判定线为中心**，
 *     宽 = 列宽，并用 `ColourLight{i+1}` 着色（默认 55,255,255）
 *   - `LightingN` / `LightingL`：**逐列**画在「判定线与轨道中心的交点」，
 *     宽 = `LightingNWidth{i}` 或列宽，高按图片自身长宽比；长条列用 LightingL，其余用 LightingN
 *   - 按键靠 `KeyImage{i}D` 换图表示按下
 *  一张 1×1 / 2×2 的占位图在 skin.ini 体系里表示「关掉这个素材」（隠 杏珠 这包的
 *  lightingN/L 与 mania-stage-light 都只有 1×1），必须当成没有，否则会画出一堆小点。
 */
function usableLight(im: SkinImage | null): SkinImage | null {
  if (!im) return null;
  return (im.w <= 2 && im.h <= 2) ? null : im;
}

/** 按 osu! 的 ColourLight 给素材着色（multiply + 保留原 alpha），只在建缓存时做一次 */
function tintedSprite(im: SkinImage, w: number, h: number, tint: string, cache: SpriteCache): HTMLCanvasElement {
  const key = `tint:${tint}`;
  let sub = cache.get(im.img as object);
  if (!sub) { sub = new Map(); cache.set(im.img as object, sub); }
  const sizeKey = `${key}@${Math.round(w)}x${Math.round(h)}`;
  const hit = sub.get(sizeKey);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  const g = c.getContext('2d');
  if (g) {
    g.drawImage(im.img, 0, 0, c.width, c.height);
    if (/^#[0-9a-f]{6}$/i.test(tint)) {
      g.globalCompositeOperation = 'multiply';
      g.fillStyle = tint;
      g.fillRect(0, 0, c.width, c.height);
      g.globalCompositeOperation = 'destination-in';
      g.drawImage(im.img, 0, 0, c.width, c.height);
      g.globalCompositeOperation = 'source-over';
    }
  }
  sub.set(sizeKey, c);
  return c;
}

/** 把皮肤图预缩放到目标宽度，之后每帧 drawImage 不用再做缩放采样（核显上省很多）。
 *  外层 WeakMap 按「图片对象」隔离，避免两张不同素材恰好同尺寸时串图。 */
type SpriteCache = WeakMap<object, Map<string, HTMLCanvasElement>>;
function scaledSprite(im: SkinImage, w: number, h: number, cache: SpriteCache): HTMLCanvasElement {
  let sub = cache.get(im.img);
  if (!sub) { sub = new Map(); cache.set(im.img as object, sub); }
  const key = `${Math.round(w)}x${Math.round(h)}`;
  const hit = sub.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  const g = c.getContext('2d');
  if (g) { g.imageSmoothingEnabled = true; g.drawImage(im.img, 0, 0, c.width, c.height); }
  if (sub.size > 60) sub.clear(); // 改窗宽时旧尺寸自动淘汰，内存不增长
  sub.set(key, c);
  return c;
}

/** 单列在**当前画布尺寸**下用到的全部素材与精灵（画布不变就不用重算） */
interface ColRt {
  noteW: number;
  noteH: number;
  noteSprite: HTMLCanvasElement | null;
  headH: number;
  headSprite: HTMLCanvasElement | null;
  bodyImg: SkinImage | null;
  tailSprite: HTMLCanvasElement | null;
  tailW: number;
  tailH: number;
  /** KeysUnderNotes:0 时每帧要画在音符之上的接收器 */
  rec: { x: number; y: number; w: number; h: number; sprite: HTMLCanvasElement } | null;
  /** KeyImage*D：按下态（自动游玩特效），无此素材时为 null */
  recDown: { x: number; y: number; w: number; h: number; sprite: HTMLCanvasElement } | null;
  /** mania-stage-light：按下时该列的舞台灯（30 单位高、以判定线为中心、ColourLight 着色） */
  stageLight: LightBox | null;
  /** lightingN：普通音符命中光（逐列，判定线与轨道中心交点） */
  hitLight: LightBox | null;
  /** lightingL：长条按住时的光（逐列） */
  holdLight: LightBox | null;
}

/** 一块画布的渲染缓存：布局 + 每列精灵 + 静态层底图 */
interface FrameCache {
  ver: number;            // 皮肤/谱面/设置版本号
  w: number; h: number; dpr: number;
  layout: LaneLayout;
  cols: ColRt[];
  staticCanvas: HTMLCanvasElement | null;
}

/** 一张已经算好位置、可以直接 drawImage 的皮肤图 */
interface LightBox { x: number; y: number; w: number; h: number; sprite: HTMLCanvasElement }

/**
 * LN body 合成：直接移植 fengpengGG/OsuSkinMaker_New 的 `_buildHoldBody`。
 *
 * 以 `k = refW / 图宽` 换算出「整张图按列宽铺开后的高度」`tileH = 图高 × k`：
 * - `tileH` 够高 → 从源图里**裁**一段（`NoteBodyStyle:2` 取底部，其余取顶部）拉满；
 * - `tileH` 不够 → 按 tileH **平铺**（样式 2 从下往上）。
 * 绝不做「先压成固定高度再拉长」—— 蒙皮 `Orbs\noteL` 是 138×39850，走裁剪分支时
 * 原图的竖向渐变与描边都保留；旧做法会把它糊成一块纯色板。
 */
function holdBodySprite(
  im: SkinImage, w: number, h: number, refW: number, style: number, cache: SpriteCache,
): HTMLCanvasElement {
  let sub = cache.get(im.img);
  if (!sub) { sub = new Map(); cache.set(im.img as object, sub); }
  const cw = Math.max(1, Math.round(w));
  const ch = Math.max(1, Math.round(h));
  const key = `H${style}|${cw}x${ch}|${Math.round(refW)}`;
  const hit = sub.get(key);
  if (hit) return hit;

  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  const g = c.getContext('2d');
  if (g) {
    g.imageSmoothingEnabled = true;
    const iw = im.img.width, ih = im.img.height;          // 位图实际像素
    const rowsAvail = im.cropRows ?? im.h;                // 位图覆盖的逻辑行数（超长底纹只留顶部）
    const pxRow = ih / Math.max(1, rowsAvail);            // 逻辑行 → 位图行
    const k = Math.max(0.01, refW / Math.max(1, im.w));
    const tileH = im.h * k;                               // 整张图铺开后占多少逻辑高
    if (style === 0) {
      g.drawImage(im.img, 0, 0, iw, ih, 0, 0, cw, ch);
    } else if (tileH >= ch) {
      // 需要 ch/k 逻辑行；超长底纹只保留了顶部一段，取到头就整段拉伸（极端长条才会遇到）
      const need = Math.min(ch / k, rowsAvail);
      const srcRows = Math.max(1, need * pxRow);
      // NoteBodyStyle 2 = 从底部取；只有整张图都在手里时才可能取底
      const sy = style === 2 && rowsAvail >= im.h ? Math.max(0, ih - srcRows) : 0;
      g.drawImage(im.img, 0, sy, iw, srcRows, 0, 0, cw, ch);
    } else {
      const step = Math.max(1, Math.round(tileH));
      if (style === 2) {
        for (let y = ch - step; y > -step; y -= step) g.drawImage(im.img, 0, 0, iw, ih, 0, y, cw, step);
      } else {
        for (let y = 0; y < ch; y += step) g.drawImage(im.img, 0, 0, iw, ih, 0, y, cw, step);
      }
    }
  }
  if (sub.size > 24) sub.clear(); // 长条高度换档时淘汰，内存不随曲目增长
  sub.set(key, c);
  return c;
}

const BeatmapPreview: React.FC<Props> = ({
  doc, points, getPlayheadTime, onClose, fps, onCommand, onDetach, detached = false,
  recHeight, recFps, recKbps, getAudioStream,
  playing, audioMs, recordMetronome = false, onRecordMetronomeChange, onRecordingChange,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const winRef = useRef<HTMLDivElement>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  /**
   * 每块画布的渲染缓存（屏幕一块、录制 720p 一块，最多 3 块）。
   *
   * ★ 旧实现每帧用「很长的一串字符串」当 key 去 Map 里查静态层，key 里拼了
   *   columnWidth.join / laneColors.join / noteStems.join 等好几条 join —— 每帧
   *   光拼 key 就要几百次字符串操作。现在改为**数字版本号**：皮肤/谱面/设置一变
   *   就把 ver +1，缓存条目对不上就整条重建，查表只比 4 个数字。
   *   同时把「每列该用哪张图、缩放到多大」也一次算好（ColRt），
   *   渲染循环里不再做 findSkinImage + 新建 canvas 的精灵缩放。
   */
  const frameRef = useRef<FrameCache[]>([]);
  const verRef = useRef(0);
  const spriteRef = useRef<SpriteCache>(new WeakMap());
  const [win, setWin] = useState<WinState>(loadWin);
  const dragRef = useRef<{ mode: DragMode; sx: number; sy: number; ox: number; oy: number; ow: number; oh: number } | null>(null);

  const [scrollSpeed, setScrollSpeed] = useState<number>(loadSS); // osu! ScrollSpeed，1~40
  const [ssStr, setSsStr] = useState<string>(() => String(loadSS())); // 直接输入的文本框
  /** 默认 true：BPM 参与流速（osu!mania 真实行为，v=(bpm/基准)×sv）。
   *  橙线（BPM×SV=基准）处流速恒定 —— 这正是作者用绿线补偿 BPM 的目的。 */
  const [bpmScale, setBpmScale] = useState(true);
  const [showGrid, setShowGrid] = useState(true);
  const [showLines, setShowLines] = useState(true);
  /** 自动游玩特效：音符落到判定线就"接上"（键图按下态 + 命中光斑 + 连击数） */
  const [autoFx, setAutoFx] = useState(true);
  const [skin, setSkin] = useState<SkinStyle | null>(null);
  const [skinBusy, setSkinBusy] = useState(false);
  /** 当前皮肤的来源路径（.osk 或皮肤文件夹）：持久化到 localStorage，下次直接重读 */
  const [skinSrc, setSkinSrc] = useState<string | null>(() => loadSkinSource()?.path ?? null);
  const skinSrcRef = useRef<string | null>(skinSrc);
  skinSrcRef.current = skinSrc;
  const [status, setStatus] = useState('');
  const [recording, setRecording] = useState(false);
  const recRef = useRef<{
    recorder: MediaRecorder; ctx: CanvasRenderingContext2D; w: number; h: number;
    stream: MediaStream; startedAt: number; mime: string; ext: string;
    /** 这次录制的目标帧率：渲染循环按它保底，避免录 60fps 却只画 30 帧 */
    fps: number;
    /** 是否在「曲尾」自动停止：仅「完整录制」为 true；普通录制手动停止（想录多久录多久） */
    autoStop: boolean;
  } | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  /** 组件已卸载：卸载时停掉的录制不要再弹「另存为」（用户只是关了预览） */
  const aliveRef = useRef(true);
  const dirtyRef = useRef(true);
  const getTimeRef = useRef(getPlayheadTime);
  getTimeRef.current = getPlayheadTime;
  const cmdRef = useRef(onCommand);
  cmdRef.current = onCommand;
  /** 录制状态回调走 ref：它只被 startRecording/stopRecording 的闭包里调，
   *  走 ref 就不用把回调塞进 useCallback 依赖（否则 App 每次重渲染都会重建录制函数）。 */
  const onRecChangeRef = useRef(onRecordingChange);
  onRecChangeRef.current = onRecordingChange;
  const onRecMetRef = useRef(onRecordMetronomeChange);
  onRecMetRef.current = onRecordMetronomeChange;
  /** 帧率设置（默认跟随垂直同步）。ref 供渲染循环实时读取，改设置会重建循环。 */
  const fpsRef = useRef<PreviewFps>({ vsync: fps?.vsync ?? true, limit: fps?.limit ?? 60 });
  fpsRef.current = { vsync: fps?.vsync ?? true, limit: fps?.limit ?? 60 };
  const fpsOutRef = useRef<HTMLSpanElement>(null);   // 实测帧率显示（不走 React state）
  const fpsStatRef = useRef({ frames: 0, since: 0, value: 0 });
  /** 播放头平滑器（见 renderOnce 里的说明） */
  /** 播放头平滑器（算法见 utils/previewClock.ts） */
  const smoothRef = useRef(newClock());
  /** 播放状态用 ref 给渲染循环读：它每帧都变，放依赖里会把整个循环重建 */
  const playingRef = useRef<boolean | undefined>(playing);
  playingRef.current = playing;
  /** 音频时长也走 ref（渲染循环的 effect 不依赖它，换音频不该重建循环） */
  const audioMsRef = useRef(audioMs);
  audioMsRef.current = audioMs;

  // 改一次 SV → 只重建 O(n) 时间轴（3000 条 < 1ms），下一帧即生效
  const tl = useMemo(() => buildSvTimeline(points, doc.durationMs, { bpmScale }), [points, doc.durationMs, bpmScale]);
  const rs = useMemo<ResolvedSkin | null>(() => skin ? skinForKeys(skin, doc.keyCount) : null, [skin, doc.keyCount]);

  /** 游玩区宽高比（x480 单位）——只由键数/皮肤列宽决定，与窗口大小无关。
   *  小窗自由拉伸，游玩区在画布里按这个比例 letterbox，所以形状不会被拉变。
   *  以小窗报头的数据栏形式显示，便于一眼核对。 */
  const viewAspect = useMemo(() => {
    const l = laneLayout(doc.keyCount, 480, 480, rs);
    return l.viewW / l.viewH;
  }, [doc.keyCount, rs]);

  interface Cfg {
    showGrid: boolean; showLines: boolean; autoFx: boolean; scrollSpeed: number;
    tl: ReturnType<typeof buildSvTimeline>; doc: OsuDocument;
    skin: SkinStyle | null; rs: ResolvedSkin | null;
  }
  const cfgRef = useRef<Cfg>({ showGrid, showLines, autoFx, scrollSpeed, tl, doc, skin, rs });
  // 逐字段赋值：App 每 100ms 推一次 UI 状态时，不制造新对象，也不触发重绘
  cfgRef.current.showGrid = showGrid;
  cfgRef.current.showLines = showLines;
  cfgRef.current.autoFx = autoFx;
  cfgRef.current.scrollSpeed = scrollSpeed;
  cfgRef.current.tl = tl;
  cfgRef.current.doc = doc;
  cfgRef.current.skin = skin;
  cfgRef.current.rs = rs;
  useEffect(() => {
    // 版本号一变，所有画布的 FrameCache 自然失效（含每列精灵与静态层）
    dirtyRef.current = true;
    verRef.current = (verRef.current + 1) % 1_000_000;
    spriteRef.current = new WeakMap();
  }, [showGrid, showLines, autoFx, scrollSpeed, tl, doc, skin, rs]);

  // ---- 小窗拖动 / 八向缩放：直接改 DOM，零 React 重渲染；松手才提交并持久化 ----
  useEffect(() => {
    if (detached) return; // 独立窗口由系统管拖动/缩放
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current, el = winRef.current;
      if (!d || !el) return;
      const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
      if (d.mode === 'move') {
        const x = clamp(d.ox + dx, 0, Math.max(0, window.innerWidth - d.ow));
        const y = clamp(d.oy + dy, 0, Math.max(0, window.innerHeight - d.oh));
        el.style.left = `${x}px`; el.style.top = `${y}px`;
      } else {
        // 缩放：宽高各自跟手（原始方案，想拉多宽多高都行），八个方向都支持。
        // 显示区域的形状不受影响 —— 游玩区在画布里按固定比例 letterbox 居中，
        // 多出来的部分填信箱色，所以自由拉伸也不会把谱面拉扁。
        const maxW = Math.max(MIN_W, window.innerWidth - 8);
        const maxH = Math.max(MIN_H, window.innerHeight - 8);
        const hasW = d.mode.includes('w'), hasE = d.mode.includes('e');
        const hasN = d.mode.includes('n'), hasS = d.mode.includes('s');
        let left = d.ox, top = d.oy, w = d.ow, h = d.oh;
        if (hasE) w = clamp(d.ow + dx, MIN_W, maxW);
        if (hasS) h = clamp(d.oh + dy, MIN_H, maxH);
        if (hasW) {
          w = clamp(d.ow - dx, MIN_W, d.ox + d.ow);       // 左边界不能越过右边界
          left = d.ox + d.ow - w;
          if (left < 0) { w += left; left = 0; }
        }
        if (hasN) {
          h = clamp(d.oh - dy, MIN_H, d.oy + d.oh);
          top = d.oy + d.oh - h;
          if (top < 0) { h += top; top = 0; }
        }
        el.style.left = `${Math.round(left)}px`; el.style.top = `${Math.round(top)}px`;
        el.style.width = `${Math.round(w)}px`; el.style.height = `${Math.round(h)}px`;
      }
    };
    const onUp = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      const el = winRef.current;
      if (!el) return;
      const next: WinState = {
        x: parseFloat(el.style.left) || 0, y: parseFloat(el.style.top) || 0,
        w: parseFloat(el.style.width) || 320, h: parseFloat(el.style.height) || 560,
      };
      try { localStorage.setItem(WIN_KEY, JSON.stringify(next)); } catch { /* 隐私模式忽略 */ }
      setWin(next);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [detached]);

  const startDrag = (mode: DragMode) => (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = {
      mode, sx: e.clientX, sy: e.clientY, ox: win.x, oy: win.y, ow: win.w, oh: win.h,
    };
  };

  useEffect(() => {
    try { localStorage.setItem(SS_KEY, String(scrollSpeed)); } catch { /* ignore */ }
  }, [scrollSpeed]);

  // ---- 画布尺寸：只按容器变化重建位图，DPR 上限 1.5 ----
  useEffect(() => {
    const wrap = wrapRef.current, canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const apply = () => {
      const w = Math.max(120, wrap.clientWidth);
      const h = Math.max(120, wrap.clientHeight);
      const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
      const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw; canvas.height = bh;
        ctxRef.current = null;
        frameRef.current = [];        // 尺寸变了：旧缓存按 (w,h,dpr) 自然对不上，直接清掉省内存
        spriteRef.current = new WeakMap();
        dirtyRef.current = true;
      }
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  /** 静态层：信箱底 / 游玩区 / 列底 / 分隔线 / 舞台 / 接收器 / 判定线。
   *  只在「版本号或画布尺寸」变化时重建（缓存命中判断在 getFrame 里用数字完成）。 */
  const buildStatic = (fc: FrameCache, SK: ResolvedSkin | null, SKIN: SkinStyle | null, liveKeys: boolean) => {
    const { w, h, dpr, layout } = fc;
    const c = document.createElement('canvas');
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    const g = c.getContext('2d', { alpha: false });
    if (!g) return c;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const keys = doc.keyCount;
    const vx = layout.viewLeft, vy = layout.viewTop;
    const vw = layout.viewRight - vx, vh = layout.viewBottom - vy;

    // 信箱区（窗口比例 ≠ 游玩区比例时露出的部分）：比游玩区更暗，一眼能看出显示区域的形状没被拉变
    g.fillStyle = '#0a0a12';
    g.fillRect(0, 0, w, h);

    g.save();
    g.beginPath(); g.rect(vx, vy, vw, vh); g.clip();
    g.fillStyle = C.bg;
    g.fillRect(vx, vy, vw, vh);

    // ---- 列底 + 分隔线（只画在游玩区内）----
    for (let k = 0; k < keys; k++) {
      g.fillStyle = SK ? SK.laneColors[k] : (k % 2 === 0 ? C.col : C.colAlt);
      g.fillRect(layout.x[k], vy, layout.width[k], vh);
    }
    if (SK) {
      // ColumnLineWidth 为 0 时 osu! 不画分隔线；这里保留 1 条极淡线便于分辨列
      g.fillStyle = C.line;
      for (let k = 0; k < keys; k++) {
        const lw = Math.max(0.5, Math.min(6, SK.columnLineWidth[k] * layout.unit));
        g.globalAlpha = SK.columnLineWidth[k] > 0 ? 1 : 0.55;
        g.fillRect(layout.x[k] - lw / 2, vy, lw, vh);
      }
      g.globalAlpha = 1;
      g.fillRect(layout.x[keys - 1] + layout.width[keys - 1] - 0.5, vy, 0.5, vh);
    } else {
      g.fillStyle = C.line;
      for (let k = 0; k < keys; k++) g.fillRect(layout.x[k], vy, 1, vh);
      g.fillRect(layout.x[keys - 1] + layout.width[keys - 1], vy, 1, vh);
    }

    // ---- 舞台：left/right 图按 480 单位高铺满，bottom 贴游玩区下沿 ----
    if (SKIN && SK) {
      const x0 = layout.x[0];
      const right = layout.x[keys - 1] + layout.width[keys - 1];
      const sl = findSkinImage(SKIN, SK.stageLeft);
      const sr = findSkinImage(SKIN, SK.stageRight);
      const sb = findSkinImage(SKIN, SK.stageBottom);
      if (sl) { const sw = (sl.w / Math.max(1, sl.h)) * vh; paint(g, sl, x0 - sw, vy, sw, vh); }
      if (sr) { const sw = (sr.w / Math.max(1, sr.h)) * vh; paint(g, sr, right, vy, sw, vh); }
      if (sb) {
        const bw = right - x0;
        const bh = (sb.h / Math.max(1, sb.w)) * bw;
        paint(g, sb, x0, layout.viewBottom - bh, bw, bh);
      }
    }

    // ---- 接收器：底边贴判定线（osu! 语义），按图片自身比例，绝不压扁 ----
    // autoFx（自动游玩）开着时接收器要能逐帧换按下态，不能烘进静态层 → 留给 drawFrame 画
    if (SKIN && SK && SK.keysUnderNotes && !liveKeys) drawReceptors(g, layout, SK, SKIN);

    // ---- 判定线：JudgementLine:0 时不画（osu! 会隐藏 mania-stage-hint）----
    const showJudge = !SK || SK.judgeLine;
    if (showJudge) {
      const x0 = layout.x[0];
      const totalW = layout.x[keys - 1] + layout.width[keys - 1] - x0;
      const hint = SKIN && SK ? findSkinImage(SKIN, SK.stageHint) : null;
      if (hint) {
        const th = Math.max(2, Math.min(10, (hint.h / Math.max(1, hint.w)) * totalW));
        paint(g, hint, x0, layout.judgeY - th / 2, totalW, th);
      } else {
        g.fillStyle = C.pink;
        g.fillRect(x0, layout.judgeY - 1, totalW, 2);
        g.fillStyle = 'rgba(255,102,170,0.10)';
        g.fillRect(x0, layout.judgeY - 9, totalW, 8);
      }
    }
    g.restore();

    // 游玩区外框：让「显示区域」的固定形状可见
    g.strokeStyle = 'rgba(120,120,160,0.55)';
    g.lineWidth = 1;
    g.strokeRect(vx + 0.5, vy + 0.5, vw - 1, vh - 1);

    return c;
  };
  // 用 ref 转发：渲染循环只建立一次，组件重渲染不会重启它（切谱面时闭包自动刷新）
  const buildStaticRef = useRef(buildStatic);
  buildStaticRef.current = buildStatic;
  /** 每列素材与精灵：画布尺寸/皮肤变了才重算，渲染循环里直接取 */
  const buildCols = (layout: LaneLayout, SK: ResolvedSkin | null, SKIN: SkinStyle | null, keys: number): ColRt[] => {
    const sprites = spriteRef.current;
    const refW = layout.refW * layout.unit;
    const out: ColRt[] = new Array(keys);
    for (let k = 0; k < keys; k++) {
      const noteW = layout.width[k];
      const noteIm = SK && SKIN ? findSkinImage(SKIN, SK.noteStems[k]) : null;
      // 音符高度参考宽固定为 layout.refW（WidthForNoteHeightScale || 最窄正列宽），
      // 所以同一列在固定画布下高是常量 —— 精灵可以提前缩好，每帧只 drawImage。
      const noteH = noteIm ? Math.max(3, (noteIm.h / Math.max(1, noteIm.w)) * refW) : Math.max(4, noteW * 0.62);
      const headIm = SK && SKIN ? findSkinImageAny(SKIN, [SK.headStems[k], SK.noteStems[k]]) : null;
      const headH = headIm ? Math.max(3, Math.round((headIm.h / Math.max(1, headIm.w)) * refW)) : noteH;
      const bodyIm = SK && SKIN ? findSkinImageAny(SKIN, [SK.lnBodyStems[k], `${SK.noteStems[k]}l`]) : null;
      const tailIm = SK && SKIN ? findSkinImageAny(SKIN, [SK.lnTailStems[k], `${SK.noteStems[k]}t`]) : null;
      let tailW = 0, tailH = 0, tailSprite: HTMLCanvasElement | null = null;
      if (tailIm) {
        const kc = refW / Math.max(1, (bodyIm || tailIm).w); // 与源码一致：以 body 图为缩放基准
        tailW = Math.max(1, Math.round(tailIm.w * kc));
        tailH = Math.max(2, Math.round(tailIm.h * kc));
        if (tailH >= 2) tailSprite = scaledSprite(tailIm, tailW, tailH, sprites);
      }
      let rec: ColRt['rec'] = null;
      let recDown: ColRt['recDown'] = null;
      if (SK && SKIN) {
        const ki = findSkinImageAny(SKIN, [SK.keyStems[k], SK.keyDownStems[k]]);
        const kd = findSkinImage(SKIN, SK.keyDownStems[k]);
        // 按下态复用抬起态算出的矩形，避免 KeyImage*D 宽高略有出入时键图整体跳一下
        const sizing = ki || kd;
        if (sizing) {
          const q = receptorRect(layout, k, sizing.w, sizing.h);
          if (q.y + q.h > layout.viewTop) {
            const box = { x: q.x, y: q.y, w: q.w, h: q.h };
            if (ki) rec = { ...box, sprite: scaledSprite(ki, q.w, q.h, sprites) };
            if (kd) recDown = { ...box, sprite: scaledSprite(kd, q.w, q.h, sprites) };
          }
        }
      }
      // ---- 按下判定区的三件皮肤素材（位置/尺寸都按 x480 单位算，再乘 unit）----
      let stageLight: LightBox | null = null;
      let hitLight: LightBox | null = null;
      let holdLight: LightBox | null = null;
      if (SK && SKIN) {
        const sl = usableLight(findSkinImage(SKIN, SK.stageLight));
        if (sl) {
          const lh = 30 * layout.unit;                  // preview.js: 固定 30 单位高
          stageLight = {
            x: layout.x[k], y: layout.judgeY - 15 * layout.unit, w: layout.width[k], h: lh,
            sprite: tintedSprite(sl, layout.width[k], lh, SK.laneLights[k], sprites),
          };
        }
        const perCol = (stem: string, widths: number[]): LightBox | null => {
          const u = usableLight(findSkinImage(SKIN, stem));
          if (!u) return null;
          const wpx = (widths[k] > 0 ? widths[k] : layout.width[k] / layout.unit) * layout.unit;
          const hpx = Math.max(1, Math.round((u.h / Math.max(1, u.w)) * wpx));
          return {
            x: layout.x[k] + (layout.width[k] - wpx) / 2, y: layout.judgeY - hpx / 2, w: wpx, h: hpx,
            sprite: scaledSprite(u, wpx, hpx, sprites),
          };
        };
        hitLight = perCol(SK.lightingN, SK.lightingNWidth);
        holdLight = perCol(SK.lightingL, SK.lightingLWidth);
      }
      out[k] = {
        noteW, noteH,
        noteSprite: noteIm ? scaledSprite(noteIm, noteW, Math.max(1, Math.round(noteH)), sprites) : null,
        headH,
        headSprite: headIm ? scaledSprite(headIm, noteW, Math.max(1, headH), sprites) : null,
        bodyImg: bodyIm, tailSprite, tailW, tailH, rec, recDown, stageLight, hitLight, holdLight,
      };
    }
    return out;
  };

  /** 取该画布尺寸的渲染缓存：只比版本号与 3 个数字，没有任何字符串拼接 */
  const getFrame = (w: number, h: number, dpr: number, SK: ResolvedSkin | null, SKIN: SkinStyle | null, keys: number): FrameCache => {
    const list = frameRef.current;
    const ver = verRef.current;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.ver === ver && e.w === w && e.h === h && e.dpr === dpr) return e;
    }
    const layout = laneLayout(keys, w, h, SK);
    const cols = buildCols(layout, SK, SKIN, keys);
    const fc: FrameCache = { ver, w, h, dpr, layout, cols, staticCanvas: null };
    list.unshift(fc);
    if (list.length > 3) list.length = 3;   // 屏幕 / 录制 720p / 余量
    return fc;
  };
  /**
   * 画布下方的数据条（时间 / BPM / SV / 流速 / 连击）。
   *
   * ★ 为什么不画在画布里：画布 HUD 会压在落下的音符上（左上角几条文字正好盖住轨道），
   *   录出来的视频里也带着这些文字。改成画布**外面**的一行 HTML，既不遮挡，也不进录像。
   *   drawFrame 只往 hudRef 里写值，renderOnce 节流（≈8 次/秒、值变了才写）刷新 DOM ——
   *   120fps 下如果每帧 setState，光是 React 重渲染就够把帧率拉下来。
   */
  const hudRef = useRef({
    t: 0, keys: 4, bpm: 0, base: 0, sv: 1, speed: 1, hitPos: 480, scrollSpeed: SS_DEFAULT, vis: 0, count: 0, combo: 0,
  });
  const hudShownRef = useRef('');
  const hudTimeRef = useRef<HTMLSpanElement>(null);
  const hudMetaRef = useRef<HTMLSpanElement>(null);
  const hudSvRef = useRef<HTMLSpanElement>(null);
  const hudComboRef = useRef<HTMLSpanElement>(null);
  const hudAccRef = useRef<HTMLSpanElement>(null);
  /** 每帧复用的可见音符数组（避免 120Hz 下每秒分配上百个数组） */
  const visScratchRef = useRef<number[]>([]);
  /** 自动游玩特效的每列状态（复用，长度按键数变化时重建） */
  const fxRef = useRef<AutoPlayState>({
    flash: new Float32Array(0), pressed: new Uint8Array(0), held: new Uint8Array(0),
  });

  /**
   * 画一帧。
   * ★ w/h 是**逻辑像素**（画布 CSS 尺寸），录制时会用 720p 尺寸再调一次同一份代码，
   *   所以这里不能读 canvas.width / window 尺寸，一切从 fc 来。
   */
  const drawFrame = (ctx: CanvasRenderingContext2D, fc: FrameCache, tSec: number) => {
    const cfg = cfgRef.current;
    const { tl: L, doc: D, rs: SK, skin: SKIN } = cfg;
    const keys = D.keyCount;
    const { w, h, layout, cols } = fc;
    const pps = osuPxPerSec(layout.unit, cfg.scrollSpeed);
    const nowMs = tSec * 1000;
    const posNow = L.posAt(nowMs);
    // 可见距离 = 游玩区顶部 → 判定线（HitPosition × unit），不是整块画布高：
    // 上下信箱区不属于游玩区，旧算法会把画布多出来的高度也算进去，导致预取过远。
    const viewTopPx = layout.viewTop;
    const viewBotPx = layout.viewBottom;
    const tMax = Math.min(L.timeAtPos(posNow + ((layout.judgeY - viewTopPx) / pps) * 1.03), nowMs + 30000, D.durationMs + 5000);
    const tMin = nowMs - 400;
    const yOf = (tMs: number) => layout.judgeY - (L.posAt(tMs) - posNow) * pps;
    const x0 = layout.x[0];
    const stageRight = layout.x[keys - 1] + layout.width[keys - 1];

    if (!fc.staticCanvas) fc.staticCanvas = buildStaticRef.current(fc, SK, SKIN, cfg.autoFx);
    ctx.drawImage(fc.staticCanvas, 0, 0, w, h);

    // 除 HUD 外一切都裁到游玩区内：音符/LN 不会溢到信箱区
    ctx.save();
    ctx.beginPath();
    ctx.rect(layout.viewLeft, viewTopPx, layout.viewRight - layout.viewLeft, viewBotPx - viewTopPx);
    ctx.clip();

    // 节拍网格：所有拍线合成一条 path，一次 stroke（原来每线一次 beginPath/stroke）
    if (cfg.showGrid) {
      ctx.strokeStyle = C.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const reds = L.reds;
      for (let ri = 0; ri < reds.length; ri++) {
        const r = reds[ri];
        const stop = Math.min(tMax, reds[ri + 1]?.tMs ?? tMax);
        if (stop < tMin) continue;
        if (r.tMs > tMax) break;
        const beatMs = 60000 / Math.max(1, r.bpm || L.baseBpm);
        let t = r.tMs + Math.ceil((tMin - r.tMs) / beatMs) * beatMs;
        for (; t <= stop; t += beatMs) {
          const y = yOf(t);
          if (y < viewTopPx - 2 || y > viewBotPx) continue;
          ctx.moveTo(x0, y); ctx.lineTo(stageRight, y);
        }
      }
      ctx.stroke();
    }

    // 红/绿 timing 线：按 3 色分组批量描边；标签限流（高 SV 谱面一屏上百条绿线，
    // 每条 fillText 是掉帧主因）→ 最多 6 个、且彼此间隔 ≥ 22px。
    if (cfg.showLines) {
      const groups: Record<'red' | 'green' | 'both', number[]> = { red: [], green: [], both: [] };
      const labels: { y: number; text: string; color: string }[] = [];
      const ms = L.markers;
      let lastLabelY = -100;
      for (let mi = L.markerIndexAt(tMin); mi < ms.length; mi++) {
        const m = ms[mi];
        if (m.tMs > tMax) break;
        const pair = ms[mi + 1];
        const isBoth = m.kind === 'red' && pair && pair.kind === 'green' && pair.tMs - m.tMs <= 1;
        if (isBoth) mi++;
        const y = yOf(m.tMs);
        if (y < viewTopPx - 2 || y > viewBotPx) continue;
        const kind = isBoth ? 'both' : m.kind;
        groups[kind].push(y);
        if (labels.length < 6 && y - lastLabelY >= 22) {
          const color = kind === 'both' ? C.both : kind === 'red' ? C.red : C.green;
          labels.push({ y, color, text: isBoth
            ? `${Math.round(m.bpm || 0)} BPM · SV ${(pair?.sv || 1).toFixed(2)}x`
            : m.kind === 'red' ? `${Math.round(m.bpm || 0)} BPM` : `SV ${(m.sv || 1).toFixed(2)}x` });
          lastLabelY = y;
        }
      }
      const strokeGroup = (ys: number[], color: string, width: number) => {
        if (!ys.length) return;
        ctx.strokeStyle = color; ctx.lineWidth = width;
        ctx.beginPath();
        for (const y of ys) { ctx.moveTo(x0, y); ctx.lineTo(stageRight, y); }
        ctx.stroke();
      };
      strokeGroup(groups.green, C.green, 1.5);
      strokeGroup(groups.red, C.red, 2);
      strokeGroup(groups.both, C.both, 2);
      if (labels.length) {
        ctx.font = '10px monospace';
        for (const l of labels) {
          ctx.fillStyle = l.color;
          ctx.fillText(l.text, x0 + 3, Math.max(11, l.y - 4));
        }
      }
    }

    // 音符：按最长 LN 回看 + endMs 判定，高流速下长条不会提前消失
    const notes = D.notes;
    const vis = visScratchRef.current;
    const visN = fillVisibleNoteIndices(notes, tMin, tMax, 900, vis);
    const sprites = spriteRef.current;
    const refW = layout.refW * layout.unit;
    const bodyStyle = SK ? SK.noteBodyStyle : 1;

    // ---- 自动游玩：算出每列「是否按下 / 命中闪光 / 长条按住」----
    // 规则见 utils/autoPlay.ts：普通音符点一下（命中前 55ms 按下、命中后 45ms 松开），
    // 长条一直按到尾巴；没有任何音符落在时间窗里 → 这一列保持抬起态。
    // （旧实现把「已过判定线且还在可见列表里的」都算成按下，可见列表按最长 LN 回看，
    //   于是空段里按键也一直亮着 —— 就是"没有 note 也有按下特效"。）
    const autoFx = cfg.autoFx;
    const fx = fxRef.current;
    if (autoFx) fillAutoPlayState(notes, vis, visN, nowMs, keys, fx);
    else ensureAutoPlayState(fx, keys);

    // KeysUnderNotes:1：接收器在音符之下 —— 静态层不再烘（autoFx 时要逐帧换图），这里按列画
    if (autoFx && SK && SKIN && SK.keysUnderNotes) {
      for (let k = 0; k < keys; k++) {
        const cr = cols[k];
        const r = (fx.pressed[k] && cr.recDown) ? cr.recDown : cr.rec;
        if (r) ctx.drawImage(r.sprite, r.x, r.y, r.w, r.h);
      }
    }

    // 无皮肤时把方块合并成 3 条 path（普通音符 / LN body / LN 头），各一次 fill
    type Rect = { x: number; y: number; w: number; h: number };
    const plain: Rect[] = [];
    const bodies: Rect[] = [];
    const heads: Rect[] = [];

    for (let vi = 0; vi < visN; vi++) {
      const i = vis[vi];
      const col = notes.column[i];
      const cr = cols[col];
      const colX = layout.x[col];
      const noteW = cr.noteW;
      const noteH = cr.noteH;
      const isLn = notes.isLn[i] === 1;
      const yStart = yOf(notes.timeMs[i]);                 // 头：靠判定线一侧（y 较大）
      const yEnd = isLn ? yOf(notes.endMs[i]) : yStart - 9; // 尾：屏幕上方（y 较小）

      // 自动游玩：普通音符过了判定线就算接掉，不再往下画（否则会漏到判定线下方，像"漏键"）
      if (autoFx && !isLn && nowMs > notes.timeMs[i]) continue;

      // 垂直剔除（游玩区之外）
      if (!isLn) {
        if (yStart - noteH > viewBotPx + 2 || yStart < viewTopPx - 2) continue;
      } else {
        if (yStart < viewTopPx - 2 && yEnd < viewTopPx - 2) continue;
        if (yStart > viewBotPx + 2 && yEnd > viewBotPx + 2) continue;
      }

      let painted = false;
      if (cr.noteSprite || cr.bodyImg || cr.headSprite) {
        if (isLn) {
          const headH = cr.headH;
          // 长条不越过判定线：按住中的 LN 头已过线，整条都裁在判定线处，
          // 否则会一路铺到游玩区底部把接收器盖住。
          const lineBot = Math.min(viewBotPx, layout.judgeY);
          const headBot = Math.min(lineBot, yStart);
          // 参考软件 `_draw()`：头是「底边贴 HitPosition」，而 body 的底边钉在**头的中心**
          // `headCxY = hitY - headH/2`。所以头有半个身子露在 body 下方，看着才是「圆头 + 一根身体」。
          const headMid = headBot - headH / 2;
          const bodyTop = Math.max(viewTopPx, yEnd);
          const bodyBot = Math.min(lineBot, headMid);
          const lnLen = Math.max(1, headMid - yEnd);

          // 1) body：按整条 LN 的**全长**分桶缓存（下落过程长度不变，一路命中），
          //    绘制时只取视口裁出来的那段源行，不整体缩放 —— 细节不会被二次压缩。
          if (cr.bodyImg && bodyBot - bodyTop > 0.5) {
            const bucket = Math.min(1600, Math.max(64, Math.ceil(lnLen / 32) * 32));
            const sp = holdBodySprite(cr.bodyImg, noteW, bucket, refW, bodyStyle, sprites);
            const kY = sp.height / lnLen;
            const sy = Math.min(sp.height - 1, Math.max(0, (bodyTop - yEnd) * kY));
            const srcH = Math.max(1, Math.min(sp.height - sy, (bodyBot - bodyTop) * kY));
            ctx.drawImage(sp, 0, sy, sp.width, srcH, colX, bodyTop, noteW, bodyBot - bodyTop);
            painted = true;
          }
          // 2) 头：底边贴住起点时间，盖在 body 之上
          if (cr.headSprite && headBot > viewTopPx - headH) {
            ctx.drawImage(cr.headSprite, colX, headBot - headH, noteW, headH);
            painted = true;
          }
          // 3) 尾帽：矩形**中心**锚在尾端（源码 `ty = Y(lnTop) - tailH/2`），并垂直翻转倒扣
          if (cr.tailSprite && cr.tailH >= 2) {
            const tw = cr.tailW, th = cr.tailH;
            if (yEnd - th / 2 < viewBotPx && yEnd + th / 2 > viewTopPx) {
              const tx = colX + (noteW - tw) / 2;
              const ty = yEnd - th / 2;
              ctx.save();
              ctx.translate(tx, ty + th);
              ctx.scale(1, -1);
              ctx.drawImage(cr.tailSprite, 0, 0, tw, th);
              ctx.restore();
              painted = true;
            }
          }
        } else if (cr.noteSprite) {
          ctx.drawImage(cr.noteSprite, colX, yStart - noteH, noteW, noteH);
          painted = true;
        }
      }
      if (!painted) {
        if (isLn) {
          const bodyTop = Math.max(viewTopPx, yEnd);
          const bodyBottom = Math.min(viewBotPx, yStart);
          bodies.push({ x: colX + 1, y: bodyTop, w: Math.max(2, noteW - 2), h: Math.max(1, bodyBottom - bodyTop) });
          const hh = Math.min(noteH, Math.max(3, bodyBottom - bodyTop));
          heads.push({ x: colX + 1, y: Math.min(viewBotPx, yStart) - hh, w: Math.max(2, noteW - 2), h: hh });
        } else {
          plain.push({ x: colX + 1, y: yStart - noteH, w: Math.max(2, noteW - 2), h: noteH });
        }
      }
    }
    const fillRects = (arr: Rect[], fill: string, stroke?: string) => {
      if (!arr.length) return;
      ctx.beginPath();
      for (const q of arr) ctx.rect(q.x, q.y, q.w, q.h);
      ctx.fillStyle = fill; ctx.fill();
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
    };
    fillRects(bodies, C.ln, C.outline);
    fillRects(heads, C.note);
    fillRects(plain, C.note, C.outline);

    // ---- 自动游玩：按下判定区的效果全部来自皮肤素材（真混合，不叠加自制图形）----
    // 顺序照 preview.js：舞台灯（ColourLight 着色、30 单位高）→ 逐列 lightingN / lightingL
    // 没有音符的列（fx.pressed=0）一样都不画 —— 和游戏里手离开键盘的静默状态一致。
    if (autoFx) {
      const lit = (r: LightBox | null) => { if (r) ctx.drawImage(r.sprite, r.x, r.y, r.w, r.h); };
      for (let k = 0; k < keys; k++) {
        if (fx.pressed[k]) lit(cols[k].stageLight);
      }
      for (let k = 0; k < keys; k++) {
        if (fx.held[k]) lit(cols[k].holdLight || cols[k].hitLight);
        // 刚命中：按下窗（45ms）+ 命中光淡出（240ms）期间画 LightingN
        else if (fx.pressed[k] || fx.flash[k] > 0) lit(cols[k].hitLight);
      }
    }

    // KeysUnderNotes:0 时接收器画在音符之上（静态层里画的那份被盖住也无妨，图注重点是层级）。
    // 自动游玩开着且该列正被按下 → 换 KeyImage*D（按下态）；没有 *D 素材就保持抬起态。
    if (SK && SKIN && !SK.keysUnderNotes) {
      for (let k = 0; k < keys; k++) {
        const cr = cols[k];
        const r = (autoFx && fx.pressed[k] && cr.recDown) ? cr.recDown : cr.rec;
        if (r) ctx.drawImage(r.sprite, r.x, r.y, r.w, r.h);
      }
    }
    ctx.restore();

    // ---- 数据栏：不再画在画布上，而是写进 hudRef，由 renderOnce 节流刷到画布下方的 HTML 条 ----
    // 画布内不再有任何 HUD 文字：落下的音符不会被文字压住，录制出来的视频也干干净净。
    const st = L.stateAt(nowMs);
    const hud = hudRef.current;
    hud.t = tSec;
    hud.keys = keys;
    hud.bpm = st.bpm;
    hud.base = L.baseBpm;
    hud.sv = st.sv;
    hud.speed = st.speed;
    hud.hitPos = SK ? SK.hitPosition : 480;
    hud.scrollSpeed = cfg.scrollSpeed;
    hud.vis = visN;
    hud.count = notes.count;
    hud.combo = autoFx ? firstNoteAtOrAfter(notes, nowMs) : 0;
  };
  const drawFrameRef = useRef(drawFrame);
  drawFrameRef.current = drawFrame;
  const getFrameRef = useRef(getFrame);
  getFrameRef.current = getFrame;

  /**
   * 把「画布下方的数据条」画进录制画面。
   * captureStream 只录画布，而数据条是 HTML 元素（不进录像），所以录屏时手动画上，
   * 文字格式与 flushHud 一致、颜色沿用预览配色。hud 是 hudRef.current 的最新值（本帧刚算好）。
   */
  const drawRecHud = (ctx: CanvasRenderingContext2D, w: number, h: number, hud: typeof hudRef.current) => {
    const line1 = `${hud.t.toFixed(2)}s   ${hud.keys}K · ${Math.round(hud.bpm)} BPM · 基准 ${Math.round(hud.base)}`;
    const line2 = `SV ${hud.sv.toFixed(2)}x · 流速 ${Math.round(hud.speed * 100)}% · 可视 ${osuSpeedLabel(hud.scrollSpeed, hud.speed, hud.hitPos)}`;
    const combo = hud.combo > 0 ? `${hud.combo}x` : '';
    // 底部留一条与数据条同色的分隔线 + 深色底，和预览界面观感一致
    const barH = 30;
    const barY = h - barH;
    ctx.fillStyle = C.panel;
    ctx.fillRect(0, barY, w, barH);
    ctx.strokeStyle = C.line;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, barY + 0.5); ctx.lineTo(w, barY + 0.5); ctx.stroke();
    ctx.font = '10px monospace';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = C.text;
    ctx.fillText(line1, 8, barY + 12);
    ctx.fillStyle = C.green;
    ctx.fillText(line2, 8, barY + 24);
    if (combo) {
      ctx.fillStyle = C.text;
      ctx.fillText(combo, w - 8 - ctx.measureText(combo).width, barY + 12);
      ctx.fillStyle = C.dim;
      ctx.fillText('100.00%', w - 8 - ctx.measureText('100.00%').width, barY + 24);
    }
  };

  // ---- 渲染循环：帧率由设置决定（垂直同步 / 指定挡位 / 无限制） ----
  useEffect(() => {
    let stopped = false;
    let raf = 0;
    let timer = 0;
    let lastT = -1;
    let lastFrameAt = 0;
    fpsStatRef.current = { frames: 0, since: performance.now(), value: 0 };

    /** 播放头平滑（算法与坑都写在 utils/previewClock.ts 顶部） */
    const smoothTime = (raw: number, now: number): number =>
      stepClock(smoothRef.current, raw, now, playingRef.current);

    /**
     * 把 hudRef 里的值刷到画布下方的数据条。
     * 节流 120ms 且「显示字符串没变就不写 DOM」—— 120fps 下大部分帧数值一样，
     * 这样每秒最多 8 次 textContent 赋值，肉眼足够跟手，也不占主线程。
     */
    let hudFlushedAt = 0;
    const flushHud = (now: number) => {
      if (now - hudFlushedAt < 120) return;
      hudFlushedAt = now;
      const h = hudRef.current;
      const key = `${h.t.toFixed(2)}|${Math.round(h.bpm)}|${Math.round(h.base)}|${h.sv.toFixed(2)}|${Math.round(h.speed * 100)}|${Math.round(h.scrollSpeed)}|${h.combo}`;
      if (key === hudShownRef.current) return;
      hudShownRef.current = key;
      if (hudTimeRef.current) hudTimeRef.current.textContent = `${h.t.toFixed(2)}s`;
      if (hudMetaRef.current) hudMetaRef.current.textContent = `${h.keys}K · ${Math.round(h.bpm)} BPM · 基准 ${Math.round(h.base)}`;
      if (hudSvRef.current) {
        hudSvRef.current.textContent =
          `SV ${h.sv.toFixed(2)}x · 流速 ${Math.round(h.speed * 100)}% · 可视 ${osuSpeedLabel(h.scrollSpeed, h.speed, h.hitPos)}`;
      }
      if (hudComboRef.current) hudComboRef.current.textContent = h.combo > 0 ? `${h.combo}x` : '';
      if (hudAccRef.current) hudAccRef.current.textContent = h.combo > 0 ? '100.00%' : '';
    };

    const renderOnce = (now: number): boolean => {
      const canvas = canvasRef.current;
      if (!canvas) return false;
      let ctx = ctxRef.current;
      if (!ctx) { ctx = canvas.getContext('2d', { alpha: false }); ctxRef.current = ctx; }
      if (!ctx) return false;
      const tSec = smoothTime(getTimeRef.current(), now);
      const timeMoved = Math.abs(tSec - lastT) > 0.0005;
      if (!dirtyRef.current && !timeMoved) return false;
      const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const cfg = cfgRef.current;
      const fc = getFrameRef.current(
        canvas.width / dpr, canvas.height / dpr, dpr,
        cfg.rs, cfg.skin, cfg.doc.keyCount,
      );
      drawFrameRef.current(ctx, fc, tSec);
      lastT = tSec;
      dirtyRef.current = false;
      lastFrameAt = now;

      // 录制：同一帧按 720p 再画一遍到离屏画布（captureStream 只认这块画布的实际绘制）
      const rec = recRef.current;
      if (rec) {
        rec.ctx.setTransform(1, 0, 0, 1, 0, 0);
        const rfc = getFrameRef.current(rec.w, rec.h, 1, cfg.rs, cfg.skin, cfg.doc.keyCount);
        drawFrameRef.current(rec.ctx, rfc, tSec);
        // 把画布下方的数据条（时间 / BPM / SV / 流速 / 连击）也画进录制画面：
        // 数据条是 HTML 元素、不进 captureStream，录屏时它本来不会出现，这里手动画上。
        drawRecHud(rec.ctx, rec.w, rec.h, hudRef.current);
        // 停止时机：
        //   - 普通录制（autoStop=false）→ 手动停止，不因播到曲尾自动停，想录多久录多久；
        //   - 完整录制（autoStop=true）→ 录到曲尾自动停（优先用**音频**时长，谱面 durationMs
        //     只到「最后音符 + 2s」，照它停会把音乐尾巴切掉）。
        const endMs = audioMs && audioMs > 1000 ? audioMs : cfg.doc.durationMs;
        if (rec.autoStop && tSec * 1000 >= endMs) stopRecordingRef.current('end');
        // 安全兜底：无论哪种录制，超过上限都强制停，避免一直挂着录满内存。
        if (now - rec.startedAt > REC_MAX_MS) stopRecordingRef.current('end');
      }

      flushHud(now);

      // 实测帧率（每 500ms 刷新一次显示，不走 React 渲染）
      const stat = fpsStatRef.current;
      stat.frames++;
      if (now - stat.since >= 500) {
        stat.value = Math.round((stat.frames * 1000) / (now - stat.since));
        stat.frames = 0; stat.since = now;
        if (fpsOutRef.current) fpsOutRef.current.textContent = `${stat.value} fps`;
      }
      return true;
    };

    const loopRaf = (now: number) => {
      if (stopped) return;
      const f = fpsRef.current;
      let interval = f.vsync ? 0 : (f.limit > 0 ? 1000 / f.limit : 0);
      // 录制时至少按录制帧率画：导出视频不该被界面上的帧率挡位拖成"重复帧"
      const recNow = recRef.current;
      if (recNow) {
        const need = 1000 / Math.max(1, Math.min(240, recNow.fps));
        if (interval > need) interval = need;
      }
      // 限帧：到点才画（-1ms 容差，避免 16.67ms 的抖动导致奇数帧被吃掉一半帧率）
      if (interval > 0 && now - lastFrameAt < interval - 1) { raf = requestAnimationFrame(loopRaf); return; }
      renderOnce(now);
      raf = requestAnimationFrame(loopRaf);
    };

    // 无限制：rAF 只能跟到屏幕刷新率，要"更高"必须换成事件循环定时器（setTimeout 0）
    const loopTimer = () => {
      if (stopped) return;
      renderOnce(performance.now());
      timer = window.setTimeout(loopTimer, 0);
    };

    const f = fpsRef.current;
    if (!f.vsync && f.limit === 0) loopTimer();
    else raf = requestAnimationFrame(loopRaf);
    return () => {
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
      if (timer) window.clearTimeout(timer);
    };
  }, [fps?.vsync, fps?.limit]);

  // ---- 皮肤：导入 / 记住 / 重置 ----
  /** 把 payload 变成可渲染的皮肤，并记住来源路径（下次自动重读） */
  const applySkinPayload = useCallback(async (payload: SkinPayload | null, remember: boolean) => {
    if (!payload) return false;
    if ((payload as any).error) { setStatus(`皮肤导入失败：${(payload as any).error}`); return false; }
    if (!payload.count) { setStatus(`未读到素材：${payload.note || '请确认 skin.ini 与图片在同一目录'}`); return false; }
    const loaded = await loadSkin(payload);
    setSkin(loaded);
    const src = (payload as any).srcPath as string | undefined;
    if (remember && src) {
      setSkinSrc(src);
      try { localStorage.setItem(SKIN_KEY, JSON.stringify({ path: src, name: loaded.name })); } catch { /* ignore */ }
    }
    setStatus(`${payload.note ? payload.note + ' · ' : ''}已载入「${loaded.name}」${loaded.imageCount} 张素材`);
    return true;
  }, []);

  const importSkin = useCallback(async () => {
    const a = api();
    if (!a?.openSkin) { setStatus('当前环境不支持皮肤导入'); return; }
    setSkinBusy(true);
    setStatus('正在读取皮肤…');
    try {
      const payload: SkinPayload = await a.openSkin();
      if (!payload) { setStatus('已取消'); return; }
      await applySkinPayload(payload, true);
    } catch (e) {
      setStatus(`皮肤解析失败：${String(e)}`);
    } finally {
      setSkinBusy(false);
    }
  }, [applySkinPayload]);

  /** 重置成默认皮肤（无皮肤 = 内置方块样式），并忘掉记住的路径 */
  const resetSkin = useCallback(() => {
    setSkin(null);
    setSkinSrc(null);
    try { localStorage.removeItem(SKIN_KEY); } catch { /* ignore */ }
    setStatus('已恢复默认皮肤');
  }, []);

  // 挂载时按记住的路径静默重载皮肤（预览重开 / 独立窗口都走这条，用户不用再选一次）
  useEffect(() => {
    const saved = loadSkinSource();
    if (!saved) return;
    const a = api();
    if (!a?.loadSkinPath) return;
    let alive = true;
    (async () => {
      setSkinBusy(true);
      try {
        const payload = await a.loadSkinPath(saved.path);
        if (!alive) return;
        if ((payload as any)?.error) {
          setStatus(`上次的皮肤读不到了：${(payload as any).error}（可重新导入）`);
          setSkinSrc(null);
          try { localStorage.removeItem(SKIN_KEY); } catch { /* ignore */ }
          return;
        }
        await applySkinPayload(payload, false);
      } catch (e) {
        if (alive) setStatus(`皮肤重载失败：${String(e)}`);
      } finally {
        if (alive) setSkinBusy(false);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- 导出：当前画面 PNG ----
  const exportFrame = useCallback(async () => {
    const c = canvasRef.current;
    if (!c) return;
    const bin = atob(c.toDataURL('image/png').split(',')[1]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    setStatus('正在保存当前画面…');
    await saveBytes(`preview-${doc.title || 'beatmap'}-frame.png`, bytes, [{ name: 'PNG Image', extensions: ['png'] }]);
    setStatus('当前画面已导出');
  }, [doc.title]);

  // ---- 导出：整曲长图 ----
  const exportStrip = useCallback(async () => {
    setStatus('正在渲染整曲长图…（大谱面约 1~3 秒）');
    await new Promise(r => setTimeout(r, 30));
    const off = document.createElement('canvas');
    try {
      const res = renderStripPreview(off, doc, cfgRef.current.tl);
      const bin = atob(off.toDataURL('image/png').split(',')[1]);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      await saveBytes(`preview-${doc.title || 'beatmap'}-full.png`, bytes, [{ name: 'PNG Image', extensions: ['png'] }]);
      setStatus(`整曲长图已导出（${res.width}×${res.height}）`);
    } catch (e) {
      setStatus(`长图导出失败：${String(e)}`);
    } finally {
      off.width = 0; off.height = 0;
    }
  }, [doc]);

  // ---- 录制：分辨率 / 帧率 / 码率都来自设置面板（MP4，不支持则回退 WebM） ----
  /** 本次录制要用的参数（设置面板改了立即生效，不必重开预览） */
  const recCfg = () => ({
    height: Math.max(240, Math.min(2160, Math.round(recHeight ?? REC_DEF_HEIGHT))),
    fps: Math.max(1, Math.min(240, Math.round(recFps ?? REC_DEF_FPS))),
    kbps: Math.max(200, Math.min(60000, Math.round(recKbps ?? REC_DEF_KBPS))),
  });

  /** 录制画布尺寸：**短边**取设置值（竖屏小窗时短边是宽），长边按小窗比例算、上限 16:9 */
  const recordSize = () => {
    const { height: short } = recCfg();
    const longCap = Math.round((short * 16) / 9);
    const wrap = wrapRef.current;
    const w0 = wrap?.clientWidth || 320;
    const h0 = wrap?.clientHeight || 560;
    const a = w0 / Math.max(1, h0);
    let rw: number, rh: number;
    if (a >= 1) { rh = short; rw = Math.min(longCap, Math.round(short * a)); }
    else { rw = short; rh = Math.min(longCap, Math.round(short / a)); }
    // H.264 要求宽高为偶数
    rw -= rw % 2; rh -= rh % 2;
    return { w: Math.max(240, rw), h: Math.max(240, rh) };
  };

  const stopRecording = useCallback((_reason?: string) => {
    const rec = recRef.current;
    if (!rec) return;
    recRef.current = null;
    setRecording(false);
    onRecChangeRef.current?.(false); // 恢复「跟随播放头」
    // 停止录制就把播放也停下：用户点"停止"多半是录完了，不想画面继续跑
    cmdRef.current?.({ type: 'pause' });
    try { rec.recorder.stop(); } catch { /* 已经停了 */ }
  }, []);
  const stopRecordingRef = useRef(stopRecording);
  stopRecordingRef.current = stopRecording;

  /**
   * 开始录制。
   * @param fromHead true = **完整录制**：把播放头摆到 0 再开录，一直录到曲尾自动停（导出名带 -full）；
   *                 false = 从当前播放头位置开始（默认）。
   */
  const startRecording = useCallback(async (fromHead = false) => {
    if (recRef.current) return;
    if (typeof MediaRecorder === 'undefined') { setStatus('当前环境不支持录制'); return; }
    // 完整录制的第一帧必须画在 0 秒：否则 captureStream 头一帧会闪一下当前所在位置
    const startT = fromHead ? 0 : Math.max(0, getTimeRef.current());
    /** 录制启动时的节拍器开关（录制中途再改也不会改已经录进去的那段，状态文字按启动时算） */
    const inclClick = !!recordMetronome;
    const { w, h } = recordSize();
    const recCanvas = document.createElement('canvas');
    recCanvas.width = w; recCanvas.height = h;
    const rctx = recCanvas.getContext('2d', { alpha: false });
    if (!rctx) { setStatus('录制初始化失败'); return; }
    // 先画一帧，否则 captureStream 第一帧是空白
    rctx.setTransform(1, 0, 0, 1, 0, 0);
    try {
      const c = cfgRef.current;
      const fc0 = getFrameRef.current(w, h, 1, c.rs, c.skin, c.doc.keyCount);
      drawFrameRef.current(rctx, fc0, startT);
      drawRecHud(rctx, w, h, hudRef.current); // 首帧也带上数据条，避免录像开头闪一下没 HUD
    } catch { /* 首帧失败不致命 */ }

    // ---- 音轨：主窗口的录制混音总线 → MediaStreamDestination ----
    // 这条流里默认只有音乐；用户在工具条上打开「节拍器」时，节拍器会经一个
    // 可开关的 GainNode 汇入同一条总线（见 App.tsx 的 clickRecGain），所以录制端
    // 永远是「一条音轨」，不需要考虑多音轨混合。
    // 独立预览窗口没有音频图，getAudioStream 拿不到 → 只录画面（状态栏会写"无声"）。
    let audioTracks: MediaStreamTrack[] = [];
    try {
      const as = getAudioStream?.();
      audioTracks = as ? as.getAudioTracks().filter(t => t.readyState === 'live') : [];
    } catch { audioTracks = []; }
    const hasAudio = audioTracks.length > 0;

    // ★ MIME 必须显式声明音频 codec，否则浏览器会**静默丢掉音轨**（mp4 里只剩画面，
    //   用户以为录上了声音）。所以有音轨时只在「带音频 codec」的列表里挑；
    //   一个都不支持（极少见）才退回纯视频，并把状态栏改成"无音频"，不撒谎。
    const MIME_AUDIO = [
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2', // H.264 + AAC（Chromium 的 mp4 muxer）
      'video/mp4;codecs=avc1,mp4a.40.2',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
    ];
    const MIME_VIDEO = [
      'video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1', 'video/mp4',
      'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm',
    ];
    const support = (m: string) => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } };
    let withAudio = hasAudio;
    let mime = hasAudio ? MIME_AUDIO.find(support) : undefined;
    if (!mime) { withAudio = false; mime = MIME_VIDEO.find(support); }
    if (!mime) { setStatus('当前环境不支持 MP4/WebM 编码'); return; }
    const ext = mime.includes('mp4') ? 'mp4' : 'webm';

    const { fps: recFpsVal, kbps } = recCfg();
    let stream: MediaStream;
    try { stream = recCanvas.captureStream(recFpsVal); } catch { setStatus('画布录制不可用'); return; }
    // 把音轨挂到同一条流上：MediaRecorder 只吃一个流，音视频必须在同一流里
    if (withAudio) for (const t of audioTracks) stream.addTrack(t);

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, {
        mimeType: mime,
        videoBitsPerSecond: kbps * 1000,
        audioBitsPerSecond: REC_AUDIO_KBPS * 1000,
      });
    } catch {
      try { recorder = new MediaRecorder(stream); } catch { setStatus('录制启动失败'); return; }
    }
    chunksRef.current = [];
    recorder.ondataavailable = e => { if (e.data.size) chunksRef.current.push(e.data); };
    recorder.onstop = async () => {
      // 只停视频轨：音轨是主窗口共享的那条，停了以后就再也录不进声音了
      stream.getVideoTracks().forEach(t => t.stop());
      for (const t of audioTracks) { try { stream.removeTrack(t); } catch { /* ignore */ } }
      const blob = new Blob(chunksRef.current, { type: mime });
      chunksRef.current = [];
      if (!aliveRef.current) return; // 关闭预览时顺带停的录制：不落盘、不打扰
      if (!blob.size) { setStatus('录制为空（可能没开始播放）'); return; }
      const mb = blob.size / 1048576;
      setStatus(`正在保存录制（${mb.toFixed(1)} MB）…`);
      const base = `preview-${doc.title || 'beatmap'}${fromHead ? '-full' : ''}.${ext}`;
      await saveBytes(base, new Uint8Array(await blob.arrayBuffer()),
        [{ name: ext === 'mp4' ? 'MP4 Video' : 'WebM Video', extensions: [ext] }]);
      setStatus(`录制已导出（${mb.toFixed(1)} MB · ${w}×${h} · ${ext}${withAudio ? ' · 含音频' : ' · 无音频'}${withAudio && inclClick ? ' + 节拍器' : ''}）`);
    };

    try { recorder.start(1000); } catch { setStatus('录制启动失败'); return; }
    recRef.current = { recorder, ctx: rctx, w, h, stream, startedAt: performance.now(), mime, ext, fps: recFpsVal, autoStop: fromHead };
    setRecording(true);
    onRecChangeRef.current?.(true); // 录制期间关掉频谱的「跟随播放头」

    /* ★ 用 recordFrom 而不是旧的 seek + play：
     *   旧实现先发 seek，App 的 handleSeek 会 stop() → cancelAnimationFrame 把播放循环干掉；
     *   紧接着的 play() 又把 isPlaying 设回 true，两次 setState 在同一个批处理里被折叠成
     *   "一直是 true" → 播放循环的 effect 不重建 → 声音在放，播放头/录制画面却冻死。
     *   （播放中按「录制」必中，暂停时按反而正常。）
     *   现在交给 App 一次处理：位置直接改；正在播就换声源（循环不动）、暂停中就开播。 */
    cmdRef.current?.({ type: 'recordFrom', t: startT });
    const mbPerMin = recSizePerMinute(kbps).toFixed(0);
    setStatus(`${fromHead ? '完整录制中' : '录制中'} ${w}×${h} ${recFpsVal}fps · ${(kbps / 1000).toFixed(1)}Mbps${withAudio ? (inclClick ? ' · 含节拍器' : '') : ' · 无声（独立窗口无音频）'}（每分钟 ≈ ${mbPerMin}MB）`);
  }, [doc.title, recHeight, recFps, recKbps, getAudioStream, recordMetronome]);

  const toggleRecord = useCallback(() => {
    if (recRef.current) stopRecording();
    else void startRecording(false);
  }, [startRecording, stopRecording]);

  /** 完整录制：从头录到曲尾（到结尾由渲染循环自动停） */
  const recordFull = useCallback(() => {
    if (recRef.current) return;
    void startRecording(true);
  }, [startRecording]);

  /** 节拍器入录开关：只影响录制音轨，扬声器里永远听得到 */
  const toggleRecMetronome = useCallback(() => {
    onRecMetRef.current?.(!recordMetronome);
  }, [recordMetronome]);

  useEffect(() => () => {
    aliveRef.current = false;
    onRecChangeRef.current?.(false); // 卸载（关预览）时别把「跟随播放头」永久留在关掉的状态
    const rec = recRef.current;
    if (rec) { try { rec.recorder.stop(); } catch { /* noop */ } }
  }, []);

  const panelStyle: React.CSSProperties = detached
    ? { width: '100%', height: '100%', background: C.panel, borderColor: C.line }
    : { left: win.x, top: win.y, width: win.w, height: win.h,
        background: C.panel, borderColor: C.line, boxShadow: '0 10px 36px rgba(0,0,0,0.65)' };

  /** 独立窗口里标题栏要能拖动整个 OS 窗口（无边框窗口的拖拽区域） */
  const dragRegion = detached ? ({ WebkitAppRegion: 'drag' } as any) : undefined;
  const noDragRegion = detached ? ({ WebkitAppRegion: 'no-drag' } as any) : undefined;

  return (
    // 无遮罩、无背景虚化：小窗直接浮在频谱层之上，频谱整幅重绘时不再触发全屏合成
    <div ref={winRef}
         className={`${detached ? 'absolute inset-0' : 'fixed z-[80] rounded-xl border shadow-2xl'} flex flex-col overflow-hidden`}
         style={panelStyle}>
      {/* 头部 = 拖拽把手（内嵌：拖小窗；独立窗口：拖整个软件窗口） */}
      <div onMouseDown={detached ? undefined : startDrag('move')}
           className="flex items-center gap-2 px-3 py-2 border-b shrink-0 cursor-move select-none"
           style={{ borderColor: C.line, ...dragRegion }}>
        <Eye size={15} color={C.pink} />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-black truncate" style={{ color: C.text }}>
            {doc.title || doc.displayName} <span style={{ color: C.dim }}>· {doc.keyCount}K</span>
          </div>
          <div className="text-[9px] font-mono truncate" style={{ color: C.dim }}>
            {detached ? '独立预览窗口 · 可拖到软件窗口外' : '谱面预览 · 拖动主进度条定位'}
          </div>
        </div>
        {onDetach && !detached && (
          <button onClick={onDetach} style={noDragRegion}
                  className="p-1 rounded hover:bg-white/10" title="弹出独立窗口（可以拖到软件窗口外面）" >
            <PictureInPicture2 size={14} color={C.blue} />
          </button>
        )}
        <button onClick={onClose} style={noDragRegion} className="p-1 rounded hover:bg-white/10" title={detached ? '关闭窗口' : '关闭'}>
          <X size={15} />
        </button>
      </div>

      {/* 竖屏画布：画布内只有谱面本身，没有任何文字（落下的音符不会被压住，录像也干净） */}
      <div ref={wrapRef} className="flex-1 min-h-0 relative">
        <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
      </div>

      {/* 数据条：放在画布**下方**，值由渲染循环节流写入（不走 React），不遮挡预览 */}
      <div className="shrink-0 px-2.5 pt-1 border-t text-[9px] font-mono leading-[1.55] select-none"
           style={{ borderColor: C.line, background: C.panel }}>
        <div className="flex items-baseline gap-1.5">
          <span ref={hudTimeRef} className="shrink-0 font-bold" style={{ color: C.text }}>0.00s</span>
          <span ref={hudMetaRef} className="min-w-0 truncate" style={{ color: C.blue }} />
          <span ref={hudComboRef} className="ml-auto shrink-0 font-black" style={{ color: C.text }} />
        </div>
        <div className="flex items-baseline gap-1.5">
          <span ref={hudSvRef} className="min-w-0 truncate" style={{ color: C.green }} />
          <span ref={hudAccRef} className="ml-auto shrink-0" style={{ color: C.dim }} />
        </div>
        {doc.mode !== 3 && <div style={{ color: C.pink }}>非 osu!mania 谱面：仅作参考</div>}
      </div>

      {/* 控制条（窄窗：两行，无进度条） */}
      <div className="shrink-0 px-2.5 py-2 border-t space-y-1.5" style={{ borderColor: C.line, ...noDragRegion }}>
        <div className="flex items-center gap-1.5 flex-wrap text-[10px]" style={{ color: C.dim }}>
          <button onClick={importSkin} disabled={skinBusy}
                  className="flex items-center gap-1 px-1.5 py-1 rounded bg-white/5 hover:bg-white/10"
                  style={{ color: skin ? C.green : C.text }} title="导入 osu! 皮肤文件夹（含 skin.ini）或 .osk">
            <Palette size={12} /> {skinBusy ? '读取中' : skin ? '换皮肤' : '导入皮肤'}
          </button>
          {/* 重置成默认皮肤 + 忘掉记住的皮肤（下次打开预览不再套皮肤） */}
          <button onClick={resetSkin} disabled={!skin && !skinSrc}
                  className="flex items-center gap-1 px-1.5 py-1 rounded hover:bg-white/10 disabled:opacity-30"
                  style={{ color: C.dim }} title="恢复默认皮肤（并清除记住的皮肤）">
            <RotateCcw size={11} /> 默认
          </button>
          <span className="ml-0.5" title="osu!mania ScrollSpeed">SS</span>
          <input
            type="number" min={SS_MIN} max={SS_MAX} step={1}
            value={ssStr}
            onChange={e => setSsStr(e.target.value)}
            onBlur={() => {
              const v = Math.round(Number(ssStr));
              const c = Number.isFinite(v) ? clamp(v, SS_MIN, SS_MAX) : scrollSpeed;
              setSsStr(String(c));
              if (c !== scrollSpeed) setScrollSpeed(c);
            }}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            className="w-11 bg-black/40 border rounded px-1 py-0.5 text-[10px] font-mono text-center focus:outline-none"
            style={{ borderColor: C.line, color: C.text }}
            title={`osu!mania ScrollSpeed：直接输入 ${SS_MIN}~${SS_MAX}，回车或失焦生效`}
          />
          <label className="flex items-center gap-0.5 cursor-pointer"
                 title="BPM 参与流速：v=(BPM/基准BPM)×SV。osu!mania 里谱面内 BPM 一改流速就变，作者会用绿线 SV=原BPM/新BPM 补偿 —— 勾上这里，橙线处流速才会保持 100%。取消勾选只看纯 SV。">
            <input type="checkbox" checked={bpmScale} onChange={e => setBpmScale(e.target.checked)} /> BPM</label>
          <label className="flex items-center gap-0.5 cursor-pointer"><Grid3X3 size={11} />
            <input type="checkbox" checked={showGrid} onChange={e => setShowGrid(e.target.checked)} /> 网格</label>
          <label className="flex items-center gap-0.5 cursor-pointer">
            <input type="checkbox" checked={showLines} onChange={e => setShowLines(e.target.checked)} /> 线</label>
          <label className="flex items-center gap-0.5 cursor-pointer"
                 title="自动游玩特效：音符落到判定线就自动「接上」—— 键图换成按下态（KeyImage*D）、判定线起命中光斑、右上角显示连击。取消勾选回到纯预览（音符直接穿下去）。">
            <input type="checkbox" checked={autoFx} onChange={e => setAutoFx(e.target.checked)} /> 打击</label>
        </div>
        <div className="flex items-center gap-1 flex-wrap text-[10px]" style={{ color: C.dim }}>
          <button onClick={exportFrame} className="flex items-center gap-1 px-1.5 py-1 rounded bg-white/5 hover:bg-white/10" style={{ color: C.text }}>
            <Download size={11} /> 画面</button>
          <button onClick={exportStrip} className="flex items-center gap-1 px-1.5 py-1 rounded bg-white/5 hover:bg-white/10" style={{ color: C.text }}>
            <Download size={11} /> 长图</button>
          {/* 一键录制：从当前播放头位置自动开播，720p60 MP4 */}
          <button onClick={toggleRecord} className="flex items-center gap-1 px-1.5 py-1 rounded hover:bg-white/10"
                  style={{ color: recording ? C.red : C.text }}
                  title={`点一下就从当前进度开始自动播放并录制：${recCfg().height}p · ${recCfg().fps}fps · ${(recCfg().kbps / 1000).toFixed(1)}Mbps · 含音乐（分辨率/码率/帧率在设置里调）`}>
            {recording ? <Square size={11} /> : <Film size={11} />} {recording ? '停止' : '录制'}</button>
          {/* 完整录制：从头（0 秒）一直录到曲尾，自动停止并导出 xxx-full.mp4 */}
          <button onClick={recordFull} disabled={recording}
                  className="flex items-center gap-1 px-1.5 py-1 rounded hover:bg-white/10 disabled:opacity-30"
                  style={{ color: C.text }}
                  title="从头完整录制：把播放头摆到 0 秒再开录，一直录到曲尾自动停（文件名带 -full）">
            <Disc3 size={11} /> 完整录制</button>
          {/* 节拍器是否混进录制音轨（扬声器里始终能听到，只控制录不录） */}
          <button onClick={toggleRecMetronome}
                  className="flex items-center gap-1 px-1.5 py-1 rounded hover:bg-white/10"
                  style={{ color: recordMetronome ? C.green : C.dim }}
                  title={recordMetronome
                    ? '节拍器会一起录进视频（扬声器里也听得到）· 点击关闭'
                    : '节拍器只给你自己听，不录进视频 · 点击打开'}>
            <Music4 size={11} /> 节拍器{recordMetronome ? '入录' : ''}</button>
          <span ref={fpsOutRef} className="font-mono shrink-0" style={{ color: C.dim, minWidth: 34 }}>— fps</span>
          {status && <span className="truncate max-w-full" style={{ color: C.blue }}>{status}</span>}
          <span className="ml-auto shrink-0 font-mono" title="游玩区固定宽高比（x480 单位）：拖窗口只会改变倍率，不会把这个形状拉变">
            游玩区 {viewAspect.toFixed(2)} : 1
          </span>
        </div>
        <div className="flex items-start gap-1 text-[9px] leading-tight" style={{ color: C.dim }}>
          <Info size={10} className="shrink-0 mt-0.5" />
          <span>落速按 osu!mania：(BPM ÷ 基准BPM) × SV，再折成 480 单位 / (13720 ÷ (SS×流速)) ms。谱面内改 BPM 会改变流速，作者用绿线 SV 补偿后橙线处流速恒为 100%。SS 即游戏内 ScrollSpeed；皮肤按 skin.ini 的 x480 坐标、@2x 优先级与 H/L/T 长条素材渲染。</span>
        </div>
      </div>

      {/* 八向缩放手柄（内嵌模式）：宽高各自自由拖动，上/下/左/右都能拉，游玩区在画布内 letterbox，形状不变 */}
      {!detached && (
        <>
          {RESIZE_HANDLES.map(h => (
            <div key={h.mode} onMouseDown={startDrag(h.mode)}
                 data-resize={h.mode}
                 className="absolute z-10"
                 style={{ ...h.style, cursor: h.cursor }}
                 title="拖动自由调整小窗大小（宽高独立，游玩区比例不变）" />
          ))}
        </>
      )}
    </div>
  );
};

type DragMode = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** 内嵌小窗的 8 个缩放手柄：四条边 + 四个角，全部可拖（宽高各自独立，没有比例锁定）。
 *  上边/上角只占很薄的一条，避免把标题栏右侧的「弹出/关闭」按钮挡住。 */
const RESIZE_HANDLES: { mode: DragMode; cursor: string; style: React.CSSProperties }[] = [
  { mode: 'n',  cursor: 'ns-resize',   style: { left: 26, right: 26, top: 0, height: 4 } },
  { mode: 's',  cursor: 'ns-resize',   style: { left: 8, right: 8, bottom: 0, height: 5 } },
  { mode: 'w',  cursor: 'ew-resize',   style: { top: 8, bottom: 8, left: 0, width: 5 } },
  { mode: 'e',  cursor: 'ew-resize',   style: { top: 8, bottom: 8, right: 0, width: 5 } },
  { mode: 'nw', cursor: 'nwse-resize', style: { left: 0, top: 0, width: 10, height: 10 } },
  { mode: 'ne', cursor: 'nesw-resize', style: { right: 0, top: 0, width: 9, height: 9 } },
  { mode: 'sw', cursor: 'nesw-resize', style: { left: 0, bottom: 0, width: 12, height: 12 } },
  { mode: 'se', cursor: 'nwse-resize', style: { right: 0, bottom: 0, width: 14, height: 14,
      background: 'linear-gradient(135deg, transparent 50%, rgba(255,255,255,0.35) 50%)' } },
];

// App 播放时每 100ms 会重渲染一次；memo 后预览组件只在自身 props 变化时更新，
// rAF 循环始终读 ref，视口切换不会连带重建时间轴 / 皮肤。
export default React.memo(BeatmapPreview);
