// ===== 导出文件名清洗 =====
//
// 「另存为」的默认名来自谱面标题（`preview-${doc.title}.mp4`）。osu 谱面标题里经常带
// `:` `*` `?` `"` 这类字符，例如
//     Kou! - A.O.Earea_of_effect  的 displayName / 某些包的标题写成  A.O.E:area_of_effect
// 在 Windows 上冒号是**保留字符**，默认名一填进系统对话框就弹「文件名无效」，
// 用户点确定也没用，PNG 长图 / 画面、MP4、WebM 全部导不出来。
//
// 所以：所有落盘的文件名先过这里。只清洗**最后一段**，前面的目录原样保留。

/** Windows / macOS / Linux 都不接受（或会出问题）的字符 + C0 控制字符 */
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g;
/** 单段文件名上限 255（NTFS/ext4 都是），长标题 + 后缀容易撞，这里留足余量 */
const MAX_BASE = 150;

/**
 * 清洗文件名（可含路径）。
 * - `:` → `_`（保留可读性：`A.O.E:area` → `A.O.E_area`）
 * - 结尾的空格与点去掉（Windows 不允许创建这种文件）
 * - 超长时截断，但保住扩展名
 * - 清洗完空掉时给 `preview`，绝不返回空串
 */
export function safeFileName(full: string): string {
  const cut = Math.max(full.lastIndexOf('/'), full.lastIndexOf('\\'));
  const dir = cut >= 0 ? full.slice(0, cut + 1) : '';
  let base = cut >= 0 ? full.slice(cut + 1) : full;
  base = base.replace(ILLEGAL, '_');
  base = base.replace(/[\s.]+$/, '');
  if (base.length > MAX_BASE) {
    const dot = base.lastIndexOf('.');
    const ext = dot > 0 && base.length - dot <= 8 ? base.slice(dot) : '';
    base = base.slice(0, MAX_BASE - ext.length) + ext;
  }
  return dir + (base || 'preview');
}
