// ===== 皮肤素材格式嗅探 + TIFF → PNG 转换（主进程，纯 Node）=====
//
// 为什么需要这个文件：
//   真实皮肤里确实存在「扩展名是 .png、内容其实是 TIFF」的素材。
//   典型样本：`隠(なばり) 杏珠(あんじゅ)/mania/holdbody.png`
//   —— 22.7MB，TIFF 小端、138×40000、8bit RGBA、**无压缩**、单条 strip。
//   osu! 自己用 GDI+/ImageSharp 解码，TIFF 能读；Chromium 的 <img> **完全不支持 TIFF**，
//   于是面身（LN body）在预览里永远不显示。
//   这里把 TIFF 解成像素再重新编成 PNG，浏览器就能吃；顺便只取**顶部若干行**
//   （超长底纹的圆角/描边全在开头，渲染时也只从顶部裁），22MB 原始像素 → 几百 KB。
//
// 支持范围（够用即可，遇到不支持的一律返回 null 让上层跳过，绝不抛异常）：
//   · TIFF：小端/大端、无压缩(1) / Deflate(8,32946)、RGB(2) / 灰度(0,1)、
//           Strip 存储、SamplesPerPixel 1/3/4、BitsPerSample 8 或 16、Predictor 1/2
//   · 嗅探：PNG / JPEG / GIF / BMP / WebP / TIFF
// 不支持：Tiled TIFF、LZW/JPEG 压缩、调色板(3)、CMYK、16bit 浮点。
import zlib from 'zlib';

export type ImageKind = 'png' | 'jpeg' | 'gif' | 'bmp' | 'webp' | 'tiff' | null;

export interface ImageProbe {
  kind: ImageKind;
  /** image/* 的 mime（dataURL 用）；嗅探不出来就是 image/png 兜底 */
  mime: string;
  w: number;
  h: number;
}

const MIME: Record<string, string> = {
  png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif',
  bmp: 'image/bmp', webp: 'image/webp', tiff: 'image/tiff',
};

/** 只看文件头，判断真实格式与尺寸（不需要读完整个文件；读前 64KB 足够） */
export function probeImage(buf: Buffer): ImageProbe {
  if (!buf || buf.length < 16) return { kind: null, mime: 'image/png', w: 0, h: 0 };
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { kind: 'png', mime: MIME.png, w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    const j = jpegSize(buf);
    return { kind: 'jpeg', mime: MIME.jpeg, w: j.w, h: j.h };
  }
  // GIF: "GIF8"
  if (buf.toString('latin1', 0, 4) === 'GIF8') {
    return { kind: 'gif', mime: MIME.gif, w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  }
  // BMP: "BM"
  if (buf[0] === 0x42 && buf[1] === 0x4d) {
    return { kind: 'bmp', mime: MIME.bmp, w: buf.readInt32LE(18), h: Math.abs(buf.readInt32LE(22)) };
  }
  // WebP: "RIFF"…"WEBP"
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    return { kind: 'webp', mime: MIME.webp, w: 0, h: 0 };
  }
  // TIFF: "II*\0" / "MM\0*"
  if ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) ||
      (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a)) {
    const t = readTiffHeader(buf);
    return { kind: 'tiff', mime: MIME.tiff, w: t?.w ?? 0, h: t?.h ?? 0 };
  }
  return { kind: null, mime: 'image/png', w: 0, h: 0 };
}

/** JPEG 的尺寸在 SOF 段里，逐段跳过去找 */
function jpegSize(b: Buffer): { w: number; h: number } {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1];
    const len = b.readUInt16BE(i + 2);
    // SOF0..SOF15（去掉 DHT/JPG/DAC 这三个非 SOF）
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
    }
    if (len <= 0) break;
    i += 2 + len;
  }
  return { w: 0, h: 0 };
}

// ---------- TIFF ----------

interface TiffTag { type: number; count: number; /** 值（当 count*size <= 4 时为内联值） */ value: number; off: number }

function readTiffHeader(buf: Buffer): { w: number; h: number } | null {
  const t = parseIfd(buf);
  if (!t) return null;
  return { w: t.width, h: t.height };
}

interface TiffInfo {
  le: boolean; width: number; height: number;
  bits: number[]; samples: number; compression: number; photometric: number;
  predictor: number; planar: number;
  strips: { off: number; bytes: number }[]; rowsPerStrip: number;
}

function readEntryValue(buf: Buffer, le: boolean, entryOff: number): TiffTag {
  const type = le ? buf.readUInt16LE(entryOff + 2) : buf.readUInt16BE(entryOff + 2);
  const count = le ? buf.readUInt32LE(entryOff + 4) : buf.readUInt32BE(entryOff + 4);
  // 内联值（<= 4 字节）直接放在 entry+8，否则是偏移
  const value = le ? buf.readUInt32LE(entryOff + 8) : buf.readUInt32BE(entryOff + 8);
  return { type, count, value, off: entryOff + 8 };
}

/** 读一个 SHORT/LONG 数组（可能内联也可能指向别处） */
function readArray(buf: Buffer, le: boolean, tag: TiffTag, maxItems = 64): number[] {
  const size = tag.type === 3 ? 2 : 4;
  const n = Math.min(tag.count, maxItems);
  const out: number[] = [];
  if (tag.count * size <= 4) {
    for (let i = 0; i < n; i++) {
      out.push(tag.type === 3
        ? (le ? buf.readUInt16LE(tag.off + i * 2) : buf.readUInt16BE(tag.off + i * 2))
        : (le ? buf.readUInt32LE(tag.off + i * 4) : buf.readUInt32BE(tag.off + i * 4)));
    }
    return out;
  }
  const base = tag.value;
  for (let i = 0; i < n; i++) {
    const p = base + i * size;
    if (p + size > buf.length) break;
    out.push(tag.type === 3
      ? (le ? buf.readUInt16LE(p) : buf.readUInt16BE(p))
      : (le ? buf.readUInt32LE(p) : buf.readUInt32BE(p)));
  }
  return out;
}

function parseIfd(buf: Buffer, needStrips = false): (TiffInfo & { width: number; height: number }) | null {
  if (buf.length < 16) return null;
  const le = buf[0] === 0x49;
  const magic = le ? buf.readUInt16LE(2) : buf.readUInt16BE(2);
  if (magic !== 42) return null;
  const ifd = le ? buf.readUInt32LE(4) : buf.readUInt32BE(4);
  if (ifd + 2 > buf.length) return null;
  const n = le ? buf.readUInt16LE(ifd) : buf.readUInt16BE(ifd);
  if (n <= 0 || n > 200) return null;

  const info: TiffInfo = {
    le, width: 0, height: 0, bits: [8], samples: 1, compression: 1, photometric: 1,
    predictor: 1, planar: 1, strips: [], rowsPerStrip: 0xffffffff,
  };
  let stripOffsets: number[] = [];
  let stripBytes: number[] = [];
  for (let i = 0; i < n; i++) {
    const eo = ifd + 2 + i * 12;
    if (eo + 12 > buf.length) break;
    const tag = le ? buf.readUInt16LE(eo) : buf.readUInt16BE(eo);
    const t = readEntryValue(buf, le, eo);
    const one = () => readArray(buf, le, t, 1)[0] ?? 0;
    switch (tag) {
      case 256: info.width = one(); break;
      case 257: info.height = one(); break;
      case 258: info.bits = readArray(buf, le, t, 8); break;
      case 259: info.compression = one() || 1; break;
      case 262: info.photometric = one(); break;
      case 273: stripOffsets = readArray(buf, le, t, 4096); break;
      case 277: info.samples = one() || 1; break;
      case 278: info.rowsPerStrip = one() || 0xffffffff; break;
      case 279: stripBytes = readArray(buf, le, t, 4096); break;
      case 284: info.planar = one() || 1; break;
      case 317: info.predictor = one() || 1; break;
      default: break;
    }
  }
  if (!info.width || !info.height) return null;
  if (needStrips) {
    const cnt = Math.min(stripOffsets.length, stripBytes.length);
    for (let i = 0; i < cnt; i++) info.strips.push({ off: stripOffsets[i], bytes: stripBytes[i] });
  }
  return info;
}

// ---------- PNG 编码（只用 zlib，无第三方依赖）----------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** RGBA8 原始像素 → PNG。rowFilter 一律 0（无滤波），交给 zlib 压即可 */
export function encodePngRGBA(w: number, h: number, rgba: Buffer): Buffer {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // filter method
  ihdr[12] = 0;  // no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export interface TiffConvertResult {
  png: Buffer;
  /** 输出位图的实际宽高（可能只保留了顶部 maxRows 行） */
  w: number; h: number;
  /** 原图完整高度（用于让渲染层知道「这张底纹原本多长」） */
  srcH: number;
  /** 是否被截断（只取了顶部 maxRows 行） */
  cropped: boolean;
}

/**
 * TIFF → PNG。`maxRows` 限制输出高度（超长底纹只取顶部，圆角/描边都在那里）。
 * 任何不支持的情形返回 null，由调用方跳过这张图。
 */
export function tiffToPng(buf: Buffer, maxRows = 4096): TiffConvertResult | null {
  const info = parseIfd(buf, true);
  if (!info) return null;
  if (info.planar !== 1) return null;                       // 分离平面：不支持
  if (!info.strips.length) return null;                     // Tiled TIFF：不支持
  const comp = info.compression;
  if (comp !== 1 && comp !== 8 && comp !== 32946) return null; // 只认无压缩 / Deflate
  const bits = info.bits[0];
  if (bits !== 8 && bits !== 16) return null;
  if (info.photometric !== 0 && info.photometric !== 1 && info.photometric !== 2) return null;

  const { width, height } = info;
  const samples = info.samples >= 4 ? 4 : info.samples >= 3 ? 3 : 1;
  const bytesPerSample = bits / 8;
  const rowBytes = width * samples * bytesPerSample;
  const rowsWant = Math.min(height, Math.max(1, Math.floor(maxRows)));

  // 逐 strip 取出「原始行」，拼到 rowsWant 行为止
  const out = Buffer.alloc(width * rowsWant * 4);
  let rowOut = 0;      // 已写入目标图的行数（<= rowsWant）
  let rowDone = 0;     // 已消费的源图行数（用于定位后续 strip 的剩余行数）
  for (const st of info.strips) {
    if (rowOut >= rowsWant) break;
    if (st.off < 0 || st.off >= buf.length) break;
    const chunkData = buf.subarray(st.off, Math.min(buf.length, st.off + st.bytes));
    let data: Buffer;
    if (comp === 1) {
      data = chunkData;
    } else {
      try { data = zlib.inflateSync(chunkData); } catch { return null; }
    }
    const stripRows = Math.min(
      Math.floor(data.length / Math.max(1, rowBytes)),
      info.rowsPerStrip,
      Math.max(0, height - rowDone),
    );
    // Predictor 2：同一行内按通道做水平差分累加
    const usePredictor = info.predictor === 2;
    for (let r = 0; r < stripRows && rowOut < rowsWant; r++) {
      let row = data.subarray(r * rowBytes, (r + 1) * rowBytes);
      if (usePredictor) {
        row = Buffer.from(row); // 不污染原 buffer
        const step = samples * bytesPerSample;
        for (let x = step; x < row.length; x++) row[x] = (row[x] + row[x - step]) & 0xff;
      }
      // 写入 RGBA 目标行
      const dst = rowOut * width * 4;
      if (samples === 1) {
        const src8 = bits === 16 ? 1 : 0; // 16bit 取高字节
        const invert = info.photometric === 0; // WhiteIsZero
        for (let x = 0; x < width; x++) {
          const raw = row[x * bytesPerSample + src8];
          const v = invert ? 255 - raw : raw;
          const o = dst + x * 4;
          out[o] = v; out[o + 1] = v; out[o + 2] = v; out[o + 3] = 255;
        }
      } else {
        for (let x = 0; x < width; x++) {
          const so = x * samples * bytesPerSample;
          const o = dst + x * 4;
          if (bits === 8) {
            out[o] = row[so]; out[o + 1] = row[so + 1]; out[o + 2] = row[so + 2];
            out[o + 3] = samples >= 4 ? row[so + 3] : 255;
          } else {
            out[o] = row[so]; out[o + 1] = row[so + 2]; out[o + 2] = row[so + 4];
            out[o + 3] = samples >= 4 ? row[so + 6] : 255;
          }
        }
      }
      rowOut++;
    }
    rowDone += stripRows;
  }
  if (rowOut === 0) return null;
  const png = encodePngRGBA(width, rowOut, out);
  return { png, w: width, h: rowOut, srcH: height, cropped: rowOut < height };
}
