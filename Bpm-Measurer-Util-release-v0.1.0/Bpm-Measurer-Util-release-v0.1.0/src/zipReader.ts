// ===== 极简 ZIP 读取器（.osz 谱面包）=====
// .osz 就是 zip；只支持 osu! 实际会用到的 stored(0) / deflate(8)，零第三方依赖。
// 放在独立模块里是为了能脱离 Electron 单独做真实 .osz 回归测试。
import zlib from 'zlib';

export interface ZipEntry { name: string; data: Buffer }

export function readZip(buf: Buffer, keepPaths = false): ZipEntry[] {
  const out: ZipEntry[] = [];
  let eocd = -1;
  const min = Math.max(0, buf.length - 65558);
  for (let i = buf.length - 22; i >= min; i--) {
    if (i >= 0 && buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 .osz（找不到 ZIP 结尾）');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const rawName = buf.toString('utf8', off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;
    // 防目录穿越：.osz 默认只取文件名；皮肤 .osk 需要保留一级相对路径（skin.ini 会引用子目录）
    const clean = rawName.replace(/\\/g, '/');
    const name = keepPaths
      ? clean.split('/').filter(s => s && s !== '.' && s !== '..').join('/')
      : clean.split('/').pop() || '';
    if (!name || rawName.endsWith('/')) continue;
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) continue;
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(start, start + compSize);
    try {
      const data = method === 0 ? Buffer.from(comp) : method === 8 ? zlib.inflateRawSync(comp) : null;
      if (data) out.push({ name, data });
    } catch { /* 单个坏条目跳过，不影响其余谱面 */ }
  }
  return out;
}
