// ===== osu! 皮肤文件读取（主进程，纯 Node，可脱离 Electron 做回归测试）=====
//
// 参考 fengpengGG/OsuSkinMaker_New 的「皮肤根目录 + skin.ini 指定路径」扫描方案，
// 但针对本软件的竖屏实时预览做了三处关键修正：
//
//  1. 旧实现按「文件名关键字」过滤素材（/mania|note|key|stage|hit/），
//     皮肤里 `NoteImage0: Orbs\izquierda` 这类自定义路径会被整批丢弃 → 音符全变默认色块。
//     现在改为「先解析 skin.ini 引用了哪些 stem，再按 stem 精确取图（@2x 优先）」。
//  2. 用户可能选到 osu! 的 Songs 库（上千个谱面文件夹）。旧实现会递归读几百张无关 PNG
//     进内存并卡死；现在先定位 skin.ini 所在的**具体皮肤目录**，找不到就给明确错误。
//  3. 只列目录、按需读文件，单张 / 总量 / 数量三重上限，8GB 内存机器不会爆。
//
// 【许可】该仓库根目录没有 LICENSE，本文件是独立编写的 TypeScript 实现，不复制其代码。
import fs from 'fs';
import path from 'path';
import { readZip } from './zipReader.js';
import { probeImage, tiffToPng } from './imageDecode.js';

const IMG_EXT = /\.(png|jpe?g|webp|bmp|tiff?)$/i;
const MAX_FILES = 120;
const MAX_BYTES = 10 * 1024 * 1024;
/** 普通精灵单张上限（超过基本是误放的背景图） */
const MAX_SINGLE = 2 * 1024 * 1024;
/** 超长底纹（LN body，长宽比 > 20）单张上限 —— 真实皮肤里这类素材能到 20MB+ */
const MAX_BODY_SINGLE = 24 * 1024 * 1024;
/** 超长底纹只保留顶部这么多行（与渲染层 osuSkin 的 MAX_BODY_ROWS 保持一致） */
const BODY_ROWS = 4096;
/** 嗅探文件头时最多读这么多字节（PNG 的 IHDR / TIFF 的 IFD 都在开头） */
const HEAD_BYTES = 128 * 1024;

export interface SkinEntry { name: string; data: Buffer }
export interface SkinPayload {
  name: string;
  iniText: string;
  images: Record<string, string>;
  count: number;
  note?: string;
  matched?: number;
  error?: string;
  /** 主进程改写过像素的素材（如 TIFF 转 PNG 后只留顶部几行）：
   *  键是 payload.images 里的原始文件名，h 是原图完整高度、rows 是实际保留行数。
   *  渲染层据此保持「逻辑高度 = 原图高度、位图只覆盖顶部 rows 行」的语义。 */
  imageMeta?: Record<string, { h: number; rows: number }>;
  /** 皮肤来源（用户选的文件夹或 .osk 绝对路径）：渲染进程把它存进 localStorage，
   *  下次打开预览 / 另开独立预览窗口时按这个路径**直接重新读取**，不用再让用户选一遍。 */
  srcPath?: string;
  /** 文件夹皮肤实际命中的皮肤目录（选的是 osu! Songs 库时会自动下钻一层） */
  skinRoot?: string;
}

/** skin.ini 里「值是素材路径」的字段。其余字段（颜色/数值/开关）一律不当路径。 */
const PATH_KEY = /^(noteimage|keyimage|stage(left|right|bottom|hint|light)|lighting|warningarrow|hit\d|comboburst|scorebar|menu-|pause-|play-|fail-|barline)/i;

/** 把 ini 值规范化成 stem：去引号、去扩展名、去 @2x、反斜杠转正斜杠、全小写 */
export function toStem(v: string): string {
  return v.trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\\/g, '/')
    .replace(/\.(png|jpe?g|webp|bmp|tiff?)$/i, '')
    .replace(/@2x$/i, '')
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase();
}

/** 从 skin.ini 正文收集所有被引用的素材 stem（含 [Mania] 各段）。 */
export function stemsFromIni(iniText: string): Set<string> {
  const out = new Set<string>();
  for (const raw of iniText.split(/\r\n|\n|\r/)) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;
    const kv = line.match(/^([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    if (!PATH_KEY.test(kv[1])) continue;
    const v = kv[2].trim();
    if (!v || /^none$/i.test(v)) continue;
    // 颜色 / 纯数字 / 布尔不会被当成路径：字段白名单已挡掉大部分，这里再挡一次
    if (/^\d+([,.]\d+)*$/.test(v)) continue;
    const s = toStem(v);
    if (s && s.length < 160) out.add(s);
  }
  return out;
}

/** 默认素材前缀：即使 ini 没写，也要收下官方默认名的图片（限量）。 */
const DEFAULT_PREFIX = /^(mania-|lighting[nl]|lighting-|hit\d|hit-|key\d|note\d|stage-)/i;

interface IdxFile { rel: string; abs?: string; data?: Buffer; size: number }

/** 只列名字，不读内容：root + ≤2 层子目录，目录数 / 文件数双上限 */
function indexFolder(root: string): IdxFile[] {
  const out: IdxFile[] = [];
  let dirs = 0;
  const walk = (dir: string, prefix: string, depth: number) => {
    if (++dirs > 80 || out.length > 2500) return;
    let items: fs.Dirent[];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of items) {
      if (out.length > 2500) return;
      const rel = (prefix ? `${prefix}/${d.name}` : d.name).toLowerCase();
      const abs = path.join(dir, d.name);
      if (d.isFile()) {
        if (!IMG_EXT.test(d.name) && !/^skin\.ini$/i.test(d.name)) continue;
        let size = 0;
        try { size = fs.statSync(abs).size; } catch { continue; }
        out.push({ rel, abs, size });
      } else if (d.isDirectory() && depth < 2) {
        walk(abs, rel, depth + 1);
      }
    }
  };
  walk(root, '', 0);
  return out;
}

/**
 * 定位真正的皮肤目录。
 * - 目录自带 skin.ini → 直接用；
 * - 否则在 ≤2 层内找（Songs 库里内嵌皮肤的情形），命中唯一一个就自动采用；
 * - 找不到 → 返回明确错误，绝不递归读上千个谱面文件夹的图片。
 */
export function locateSkinRoot(src: string): { root?: string; auto?: boolean; note?: string; error?: string } {
  let st: fs.Stats;
  try { st = fs.statSync(src); } catch { return { error: '皮肤路径不存在' }; }
  if (!st.isDirectory()) return { error: '请选择皮肤文件夹或 .osk 文件' };
  if (fs.existsSync(path.join(src, 'skin.ini'))) return { root: src };

  let top: fs.Dirent[] = [];
  try { top = fs.readdirSync(src, { withFileTypes: true }); } catch (e) { return { error: `无法读取目录：${String(e)}` }; }
  const subDirs = top.filter(d => d.isDirectory());
  const found: string[] = [];
  // 深度 1：只做 existsSync，上千个目录也就几十毫秒
  for (const d of subDirs) {
    const p = path.join(src, d.name);
    if (fs.existsSync(path.join(p, 'skin.ini'))) found.push(p);
    if (found.length > 8) break;
  }
  // 深度 2：大目录（Songs 库）只扫「名字像皮肤」的目录 + 少量普通目录。
  // 必须把候选目录先按优先级排队再计数，否则中文名目录排在 240 名之后会被漏掉。
  if (found.length === 0) {
    const likely = /skin|改|皮肤|mania|osu/i;
    const priority = subDirs.filter(d => likely.test(d.name));
    const rest = subDirs.filter(d => !likely.test(d.name));
    const queue = subDirs.length > 300 ? [...priority, ...rest.slice(0, 120)] : subDirs;
    let scanned = 0;
    for (const d of queue) {
      if (scanned++ > 240 || found.length > 8) break;
      const p = path.join(src, d.name);
      let inner: fs.Dirent[] = [];
      try { inner = fs.readdirSync(p, { withFileTypes: true }); } catch { continue; }
      for (const e of inner) {
        if (!e.isDirectory()) continue;
        const q = path.join(p, e.name);
        if (fs.existsSync(path.join(q, 'skin.ini'))) { found.push(q); if (found.length > 8) break; }
      }
    }
  }
  if (found.length >= 1) {
    return {
      root: found[0], auto: true,
      note: `已自动定位皮肤目录「${path.basename(found[0])}」${found.length > 1 ? `（共找到 ${found.length} 个，采用第一个）` : ''}`,
    };
  }
  return {
    error: subDirs.length > 100
      ? `所选目录里有 ${subDirs.length} 个子文件夹但没有 skin.ini，看起来是歌曲库而不是皮肤目录。请直接选择 osu! 安装目录下 Skins/ 里的具体皮肤文件夹，或拖入 .osk 文件。`
      : '所选目录及其子目录里都没有 skin.ini，无法识别为 osu! 皮肤。请选择含 skin.ini 的皮肤文件夹或 .osk 文件。',
  };
}

/** 只读文件头（不把 20MB 的底纹整个读进来再决定要不要） */
function readHead(abs: string, size: number): Buffer {
  const n = Math.min(size, HEAD_BYTES);
  let fd = -1;
  try {
    fd = fs.openSync(abs, 'r');
    const b = Buffer.alloc(n);
    const r = fs.readSync(fd, b, 0, n, 0);
    return b.subarray(0, r);
  } catch { return Buffer.alloc(0); } finally { if (fd >= 0) try { fs.closeSync(fd); } catch { /* ignore */ } }
}

/** 从「索引 + stem 集合」组装图片 payload，大小写不敏感、@2x 优先。 */
function assemble(entries: IdxFile[], iniText: string, name: string, note?: string): SkinPayload {
  const byRel = new Map<string, IdxFile>();
  for (const e of entries) if (!/skin\.ini$/i.test(e.rel)) byRel.set(e.rel, e);

  const wanted = new Set<string>(stemsFromIni(iniText));
  // 官方默认素材：按文件名前缀补齐（限量，避免把 200 张 combo-*.png 全读进来）
  for (const rel of byRel.keys()) {
    if (wanted.size > 400) break;
    const base = rel.split('/').pop() || rel;
    if (DEFAULT_PREFIX.test(base)) wanted.add(rel.replace(IMG_EXT, ''));
  }

  const images: Record<string, string> = {};
  const imageMeta: Record<string, { h: number; rows: number }> = {};
  let total = 0, matched = 0;
  const take = (rel: string, e: IdxFile) => {
    if (images[rel] || total >= MAX_BYTES || matched >= MAX_FILES) return;
    if (e.size <= 0) return;
    // 先只看文件头：判断真实格式与长宽比，避免把不需要的大图读进内存
    const head = e.data ?? readHead(e.abs!, e.size);
    const probe = probeImage(head);
    const extreme = probe.w > 0 && probe.h / Math.max(1, probe.w) > 20;
    if (e.size > (extreme ? MAX_BODY_SINGLE : MAX_SINGLE)) return;
    let data: Buffer;
    try { data = e.data ?? fs.readFileSync(e.abs!); } catch { return; }

    // ★ .png 不等于 PNG：真实皮肤里有 22.7MB 的 TIFF 长条面身（138×40000，无压缩）。
    //   浏览器 <img> 完全不认 TIFF，所以这里解成 RGBA 再编回 PNG，并且只取顶部几行
    //   （超长底纹的圆角/描边都在开头，渲染时也只从顶部裁）→ 22MB 变十几 KB。
    if (probe.kind === 'tiff') {
      const conv = tiffToPng(data, BODY_ROWS);
      if (!conv) return;                       // 不支持的 TIFF（Tiled/LZW/调色板）直接跳过
      images[rel] = `data:image/png;base64,${conv.png.toString('base64')}`;
      if (conv.cropped) imageMeta[rel] = { h: conv.srcH, rows: conv.h };
      total += conv.png.length;
      matched++;
      return;
    }
    const mime = probe.kind ? probe.mime : `image/${(path.extname(rel).slice(1).toLowerCase().replace('jpg', 'jpeg') || 'png')}`;
    images[rel] = `data:${mime};base64,${data.toString('base64')}`;
    total += data.length;
    matched++;
  };

  // ini 引用优先（自定义路径如 Orbs\izquierda 在这里命中）
  for (const stem of wanted) {
    if (matched >= MAX_FILES || total >= MAX_BYTES) break;
    const exts = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff'];
    const cands = [`${stem}@2x`, stem];
    for (const c of cands) {
      let hit = false;
      for (const x of exts) {
        const e = byRel.get(c + x);
        if (e) { take(c + x, e); hit = true; }
      }
      if (hit) break; // @2x 存在就不再取 1x
    }
  }
  return { name, iniText, images, count: matched, note, matched, imageMeta };
}

/** 皮肤文件夹 / .osk → 渲染进程可直接消费的 payload */
export function buildSkinPayload(src: string): SkinPayload {
  if (/\.osk$/i.test(src)) {
    let entries: SkinEntry[];
    try { entries = readZip(fs.readFileSync(src), true); } catch (e) { return { error: `无法解压 .osk：${String(e)}`, srcPath: src } as SkinPayload; }
    const idx: IdxFile[] = entries.map(e => ({ rel: e.name.toLowerCase().replace(/\\/g, '/'), data: e.data, size: e.data.length }));
    const ini = entries.find(e => /(^|\/)skin\.ini$/i.test(e.name));
    return {
      ...assemble(idx, ini ? ini.data.toString('utf8') : '', path.basename(src).replace(/\.osk$/i, '')),
      srcPath: src,
    };
  }
  const loc = locateSkinRoot(src);
  if (loc.error || !loc.root) return { error: loc.error || '未找到皮肤目录', srcPath: src } as SkinPayload;
  const iniPath = path.join(loc.root, 'skin.ini');
  let iniText = '';
  try { iniText = fs.readFileSync(iniPath, 'utf8'); } catch { /* 没有 ini 也能用默认样式 */ }
  return {
    ...assemble(indexFolder(loc.root), iniText, path.basename(loc.root), loc.note),
    srcPath: src,
    skinRoot: loc.root,
  };
}

/** 皮肤路径是否还能用（记住的皮肤被删/移动时给出可读提示，而不是白屏或异常） */
export function skinPathExists(src: string): boolean {
  try { return fs.existsSync(src); } catch { return false; }
}
