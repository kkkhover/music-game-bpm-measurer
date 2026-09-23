// ===== 谱面 Timing 解析器：把任意游戏谱面/文本文件转成软件可读配置 =====
// 支持格式（按扩展名/内容识别）：
//   .json  → 软件自身导出的配置（{offset, points:[{beatIndex,bpm,sv,svRate,timeSec}]}）
//            或 Phigros(RPE) / ADOFAI / vivid·stasis 谱面 JSON
//   .osu   → osu! 谱面 [TimingPoints] 段（红线 BPM + 绿线 SV）
//   .mc    → Malody 谱面 JSON（time 数组 + effect 下落速度）
//   .aff   → Arcaea 谱面 timing(...) 行
//   .txt   → 通用文本：每行「时间,BPM」（时间 ms 或 s 自动识别），也兼容上面各种 JSON 导出文件
// 读取优化（v0.7.21）：去 BOM / 统一换行；osu / Arcaea / txt / Phigros 导入写入绝对时间 timeSec；
//                     txt 时间单位按整份文件判定；osu 首条红线不再重复；开头绿线（SV）不再丢失。
// 返回软件配置（globalOffset + rawPoints），解析失败返回 null。

export interface ParsedTimingConfig {
  offset: number;          // 秒
  // timeSec：红线绝对时间（秒，v0.7.18 起的权威位置值）；缺省则由 beatIndex + 上一段 BPM 推算
  points: { beatIndex: number; bpm: number; meter?: number; sv?: boolean; svRate?: number; timeSec?: number }[];
}

/** 文本规范化（读取优化）：去掉 UTF-8 BOM + 统一换行为 \n（兼容 CRLF / CR / 尾随空白） */
function normalizeText(content: string): string {
  let s = content;
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1); // BOM
  return s.replace(/\r\n?/g, '\n');
}

/** 毫秒 → 秒（保留 6 位小数，避免亚毫秒精度丢失） */
function msToSec(ms: number): number {
  return Math.round((ms / 1000) * 1e6) / 1e6;
}

/** 按扩展名/内容解析任意谱面文件 */
export function parseTimingFile(content: string, fileName = ''): ParsedTimingConfig | null {
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  const text = normalizeText(content); // 读取优化：统一 BOM / 换行

  if (ext === 'json') return parseJsonConfig(text) ?? parseGameJson(text);
  if (ext === 'osu') return parseOsu(text);
  if (ext === 'mc') return parseMalody(text);
  if (ext === 'aff') return parseArcaea(text);
  // .txt 或未知扩展名：按内容特征嗅探（osu timing 行 / Malody / Arcaea / JSON），
  // 全部不匹配才回落「时间,BPM」通用文本 —— 修复"导出 osu 格式 txt 再导入被当两列解析"的错乱
  return sniffText(text);
}

/** 文本内容嗅探：依次识别 osu timing / Malody / Arcaea / 各类 JSON 配置，否则回落通用「时间,BPM」 */
function sniffText(content: string): ParsedTimingConfig | null {
  if (/\[TimingPoints\]/i.test(content) || looksLikeOsuTimingRow(content)) return parseOsu(content);
  if (/"time"\s*:\s*\[/.test(content) && /"bpm"/.test(content)) return parseMalody(content);
  if (/timing\(\s*-?\d/.test(content)) return parseArcaea(content);
  if (content.includes('{')) {
    // 软件自身配置 → Phigros(RPE) / ADOFAI / vivid·stasis（导出文件也要能回读）
    return parseJsonConfig(content) ?? parseGameJson(content) ?? null;
  }
  return parseTxt(content);
}

/** 判断首条有效行是否 osu timing 行（≥5 个逗号字段，前两字段为数字）——区别于「时间,BPM」两列文本 */
function looksLikeOsuTimingRow(content: string): boolean {
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('//') || t.startsWith('#')) continue;
    const parts = t.split(',');
    if (parts.length < 5) return false;
    return isFinite(parseFloat(parts[0])) && isFinite(parseFloat(parts[1]));
  }
  return false;
}

// ---------- JSON（软件自身格式）----------
function parseJsonConfig(content: string): ParsedTimingConfig | null {
  try {
    const cfg = JSON.parse(content);
    if (typeof cfg.offset !== 'number' || !Array.isArray(cfg.points)) return null;
    const points = cfg.points
      .filter((p: any) => typeof p.beatIndex === 'number' && typeof p.bpm === 'number' && p.bpm > 0)
      .map((p: any) => ({
        beatIndex: Math.max(0, p.beatIndex),
        bpm: Math.round(p.bpm * 100) / 100,
        sv: p.sv !== false,
        svRate: p.svRate && p.svRate > 0 ? p.svRate : 0,
        // 红线绝对时间（v0.7.18）：保留它才能让红线位置独立（改 BPM 不挪动）
        timeSec: typeof p.timeSec === 'number' && isFinite(p.timeSec) ? p.timeSec : undefined,
      }));
    if (points.length === 0) return null;
    return { offset: cfg.offset, points };
  } catch { return null; }
}

// ---------- osu!：解析 [TimingPoints] 段 ----------
function parseOsu(content: string): ParsedTimingConfig | null {
  // 兼容两种输入：完整 .osu 谱面（[TimingPoints] 节）/ 纯 timing 行文本（软件导出的 osu 格式 txt）。
  // 必须用「整行 == [TimingPoints]」定位节标题——导出 txt 的注释头里也含 [TimingPoints] 字样，
  // 用 indexOf 会命中注释行导致正文被错误截断
  const lines = content.split(/\r?\n/);
  const markerIdx = lines.findIndex((l) => l.trim() === '[TimingPoints]');
  let body = markerIdx === -1 ? content : lines.slice(markerIdx + 1).join('\n');
  const sectionEnd = body.search(/\[[A-Za-z]+\]/); // 遇到下一个节停止（如 [HitObjects]）
  if (sectionEnd !== -1) body = body.slice(0, sectionEnd);

  interface Raw { offsetMs: number; beatLength: number; uninherited: boolean; meter: number }
  const raw: Raw[] = [];
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('//') || t.startsWith('[')) continue;
    const parts = t.split(',');
    if (parts.length < 2) continue;
    const offsetMs = parseFloat(parts[0]);
    const beatLength = parseFloat(parts[1]);
    if (!isFinite(offsetMs) || !isFinite(beatLength) || beatLength === 0) continue;
    // uninherited：第 7 字段（索引6）；缺省=红线（uninherited=1）
    const uninherited = parts.length >= 7 ? parseInt(parts[6]) === 1 : beatLength > 0;
    // ★ v0.8.17：meter（拍号）= 第 3 字段（索引2），如 4=4/4、3=3/4；缺省/非法回退 4
    const meter = parts.length >= 3 ? parseInt(parts[2]) : 4;
    raw.push({ offsetMs, beatLength, uninherited, meter: isFinite(meter) && meter > 0 ? meter : 4 });
  }
  if (raw.length === 0) return null;
  raw.sort((a, b) => a.offsetMs - b.offsetMs);

  // 全局 offset = 第一个点（红线或绿线最早时刻；用第一个红线的时刻作为全局 offset）
  const firstRed = raw.find(r => r.uninherited);
  if (!firstRed) return null;
  const offsetSec = firstRed.offsetMs / 1000;

  // 红线 → beatIndex/bpm/timeSec；绿线 → 挂到最近红线的 svRate
  // timeSec = 该红线在文件里的绝对时间（秒）→ 导入后位置 100% 精确，导出可原样还原
  const points: { beatIndex: number; bpm: number; sv?: boolean; svRate?: number; timeSec?: number }[] = [];
  let lastRed = firstRed;
  let lastIndex = 0;
  let lastTimeMs = firstRed.offsetMs;
  // BUG 修复：首条红线之前出现的绿线（很多谱面开头就是一条 SV 线，如 0ms 处的 -100）
  // 之前会被静默丢弃 → 先缓存，等第一条红线入列后再挂上去，保证段内 SV 完整
  let pendingSv: number | null = null;

  for (const r of raw) {
    if (r.uninherited) {
      const bpm = Math.round((60000 / Math.max(1e-6, r.beatLength)) * 100) / 100;
      const pt: { beatIndex: number; bpm: number; meter?: number; sv?: boolean; svRate?: number; timeSec?: number } = {
        beatIndex: r === firstRed ? 0 : lastIndex, // 占位，下面按分支重算
        bpm,
        meter: r.meter, // ★ v0.8.17：从谱面读回拍号
        sv: true,
        timeSec: msToSec(r.offsetMs),
      };
      if (r === firstRed) {
        // 第一条红线 = 起点锚点（beatIndex 0，时间由 offset 决定），避免重复推入
        pt.beatIndex = 0;
        if (pendingSv !== null) { pt.svRate = Math.round(pendingSv * 100) / 100; pendingSv = null; }
      } else {
        const secPerBeat = 60 / (60000 / Math.max(1e-6, lastRed.beatLength));
        const beatDiff = (r.offsetMs - lastTimeMs) / 1000 / secPerBeat;
        lastIndex = lastIndex + beatDiff;
        pt.beatIndex = lastIndex;
        if (pendingSv !== null) { pt.svRate = Math.round(pendingSv * 100) / 100; pendingSv = null; }
      }
      points.push(pt);
      lastRed = r;
      lastTimeMs = r.offsetMs;
    } else {
      // 绿线：SV multiplier = -100 / beatLength（负数）
      const svRate = -100 / r.beatLength;
      if (isFinite(svRate) && svRate > 0) {
        if (points.length > 0) {
          const lastPoint = points[points.length - 1];
          lastPoint.sv = true;
          lastPoint.svRate = Math.round(svRate * 100) / 100;
        } else {
          pendingSv = svRate; // 尚无红线 → 先缓存
        }
      }
    }
  }
  if (points.length === 0) return null;
  return { offset: offsetSec, points };
}

// ---------- Malody（.mc，JSON）----------
function parseMalody(content: string): ParsedTimingConfig | null {
  try {
    const chart = JSON.parse(content);
    const timeArr = chart?.time;
    if (!Array.isArray(timeArr) || timeArr.length === 0) return null;
    // beat: [a, b, c] → beatIndex；真实语义「值 = a + b/c，单位是拍，a 就是拍号」。
    // （实测真实谱面 [2,0,8] = 第 2 拍；旧实现再 ×4 会把 2 当成「第 2 小节」放大成第 8 拍，差 4 倍）
    const toBeatIndex = (b: number[]): number => {
      const [a, num = 0, den = 1] = b;
      return a + num / Math.max(1, den);
    };
    const points = timeArr
      .filter((p: any) => Array.isArray(p.beat) && typeof p.bpm === 'number' && p.bpm > 0)
      .map((p: any) => ({
        beatIndex: toBeatIndex(p.beat),
        bpm: Math.round(p.bpm * 100) / 100,
        sv: true,
        svRate: 0,
      }));
    if (points.length === 0) return null;
    // 首点归一化到 0
    const first = points[0].beatIndex;
    points.forEach(p => { p.beatIndex = Math.max(0, p.beatIndex - first); });
    // 读取优化：① effect 数组（下落速度）→ 各点的 svRate；② 尾部特殊音符（type=1）的 offset → 全局 offset（Malody 为负毫秒）
    const effArr = Array.isArray(chart?.effect) ? chart.effect : [];
    const effMap = new Map<number, number>();
    for (const e of effArr) {
      if (Array.isArray(e?.beat) && typeof e?.scroll === 'number' && e.scroll > 0) {
        effMap.set(toBeatIndex(e.beat), Math.round(e.scroll * 100) / 100);
      }
    }
    if (effMap.size > 0) {
      points.forEach(p => {
        const v = effMap.get(p.beatIndex);
        if (typeof v === 'number' && v > 0) p.svRate = v;
      });
    }
    let offset = 0;
    if (Array.isArray(chart?.note)) {
      const special = chart.note.find((n: any) => n && n.type === 1 && typeof n.offset === 'number');
      if (special) offset = Math.abs(special.offset) / 1000; // Malody offset 与 osu 反号（负毫秒）
    }
    return { offset, points };
  } catch { return null; }
}

// ---------- Arcaea（.aff）：timing(offsetMs,bpm,ts); 行 ----------
function parseArcaea(content: string): ParsedTimingConfig | null {
  const lines = content.split('\n');
  const reds: { offsetMs: number; bpm: number }[] = [];
  for (const line of lines) {
    const m = line.match(/timing\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,/);
    if (m) {
      const offsetMs = parseFloat(m[1]);
      const bpm = parseFloat(m[2]);
      if (isFinite(offsetMs) && isFinite(bpm) && bpm > 0) reds.push({ offsetMs, bpm });
    }
  }
  if (reds.length === 0) return null;
  reds.sort((a, b) => a.offsetMs - b.offsetMs);
  const offsetSec = msToSec(reds[0].offsetMs);
  // timeSec：保留每条红线的绝对时间 → 位置精确、导出可还原
  const points: { beatIndex: number; bpm: number; sv: boolean; svRate: number; timeSec: number }[] = [
    { beatIndex: 0, bpm: reds[0].bpm, sv: true, svRate: 0, timeSec: msToSec(reds[0].offsetMs) },
  ];
  let last = reds[0], lastIndex = 0;
  for (let i = 1; i < reds.length; i++) {
    const secPerBeat = 60 / last.bpm;
    lastIndex += (reds[i].offsetMs - last.offsetMs) / 1000 / secPerBeat;
    points.push({ beatIndex: lastIndex, bpm: reds[i].bpm, sv: true, svRate: 0, timeSec: msToSec(reds[i].offsetMs) });
    last = reds[i];
  }
  return { offset: offsetSec, points };
}

// ---------- 其他音游 JSON 谱面（本软件导出的 Phigros RPE / ADOFAI / vivid·stasis）----------
// BUG 修复：这几种格式以前无法回读（导出后导入直接失败），现在补上读取
function parseGameJson(content: string): ParsedTimingConfig | null {
  let cfg: any;
  try { cfg = JSON.parse(content); } catch { return null; }
  if (!cfg || typeof cfg !== 'object') return null;

  // ① Phigros（Re:PhiEdit / RPE）：meta.offset(ms) + BPMList[{ bpm, startBeat, startTimeSec }]
  if (Array.isArray(cfg.BPMList) && cfg.BPMList.length > 0) {
    const list = cfg.BPMList.filter((b: any) => typeof b?.bpm === 'number' && b.bpm > 0);
    if (list.length === 0) return null;
    const offsetSec = typeof cfg.meta?.offset === 'number' ? msToSec(cfg.meta.offset) : 0;
    const points = list.map((b: any, i: number) => ({
      beatIndex: typeof b.startBeat === 'number' ? b.startBeat : i * 4,
      bpm: Math.round(b.bpm * 100) / 100,
      sv: true,
      svRate: 0,
      // BPMList 自带 startTimeSec（秒，绝对时间）→ 用它保证红线位置精确
      timeSec: typeof b.startTimeSec === 'number' && isFinite(b.startTimeSec) ? Math.round(b.startTimeSec * 1e6) / 1e6 : undefined,
    }));
    return { offset: offsetSec, points };
  }

  // ② ADOFAI：settings.bpm / settings.offset(ms) + actions(SetSpeed.beatsPerMinute, floor=拍)
  if (cfg.settings && Array.isArray(cfg.actions) && typeof cfg.settings.bpm === 'number') {
    const offsetSec = typeof cfg.settings.offset === 'number' ? msToSec(cfg.settings.offset) : 0;
    const points: { beatIndex: number; bpm: number; sv: boolean; svRate: number }[] = [
      { beatIndex: 0, bpm: Math.round(cfg.settings.bpm * 100) / 100, sv: true, svRate: 0 },
    ];
    for (const a of cfg.actions) {
      if (a?.eventType === 'SetSpeed' && a.speedType === 'Bpm' && typeof a.beatsPerMinute === 'number') {
        points.push({
          beatIndex: typeof a.floor === 'number' ? a.floor : points[points.length - 1].beatIndex + 1,
          bpm: Math.round(a.beatsPerMinute * 100) / 100,
          sv: true,
          svRate: 0,
        });
      }
    }
    return { offset: offsetSec, points };
  }

  // ③ vivid/stasis：offset(秒) + timingPoints[{ beat, bpm }] + events(speed → svRate)
  if (Array.isArray(cfg.timingPoints) && cfg.timingPoints.length > 0 && typeof cfg.formatVersion === 'number') {
    const tp = cfg.timingPoints.filter((p: any) => typeof p?.bpm === 'number' && p.bpm > 0);
    if (tp.length === 0) return null;
    const offsetSec = typeof cfg.offset === 'number' ? cfg.offset : 0;
    const points: { beatIndex: number; bpm: number; sv: boolean; svRate: number }[] = tp.map((p: any, i: number) => ({
      beatIndex: typeof p.beat === 'number' ? p.beat : i * 4,
      bpm: Math.round(p.bpm * 100) / 100,
      sv: true,
      svRate: 0,
    }));
    // events 里的 speed 值 = 绿线倍速 → 回填到同拍的红线
    if (Array.isArray(cfg.events)) {
      const svMap = new Map<number, number>();
      for (const ev of cfg.events) {
        if (ev?.eventType === 'speed' && typeof ev.value === 'number' && ev.value > 0) {
          svMap.set(Math.round((typeof ev.beat === 'number' ? ev.beat : 0) * 1000) / 1000, Math.round(ev.value * 100) / 100);
        }
      }
      points.forEach(p => {
        const v = svMap.get(Math.round(p.beatIndex * 1000) / 1000);
        if (typeof v === 'number') p.svRate = v;
      });
    }
    return { offset: offsetSec, points };
  }

  return null;
}

// ---------- 通用文本：每行「时间,BPM」（也支持空格/Tab/分号分隔；时间单位按整份文件判定）----------
function parseTxt(content: string): ParsedTimingConfig | null {
  const rows: { timeMs: number; bpm: number }[] = [];
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('//') || t.startsWith('#') || t.startsWith('[')) continue;
    const nums = t.split(/[,;\s]+/).map(Number).filter(n => isFinite(n));
    if (nums.length < 2) continue;
    const timeVal = nums[0];
    const bpm = nums[1];
    if (timeVal < 0 || bpm <= 0 || bpm > 10000) continue;
    rows.push({ timeMs: timeVal, bpm: Math.round(bpm * 100) / 100 }); // 先原样存，单位统一在下面判定
  }
  if (rows.length === 0) return null;

  // 时间单位判定（读取优化：按整份文件统一判定，不再逐行猜）
  //  · 最大时间 > 1000 → 毫秒（毫秒谱面很常见；秒制谱面基本不会超过 1000s）
  //  · 最大时间 ≤ 1000 → 秒（若是毫秒，说明整首不到 1 秒，不可能）
  const maxT = Math.max(...rows.map(r => r.timeMs));
  const isMs = maxT > 1000;
  if (!isMs) rows.forEach(r => { r.timeMs = r.timeMs * 1000; });

  rows.sort((a, b) => a.timeMs - b.timeMs);
  const offsetSec = msToSec(rows[0].timeMs);
  const points: { beatIndex: number; bpm: number; sv: boolean; svRate: number; timeSec: number }[] = [
    { beatIndex: 0, bpm: rows[0].bpm, sv: true, svRate: 0, timeSec: offsetSec },
  ];
  let last = rows[0], lastIndex = 0;
  for (let i = 1; i < rows.length; i++) {
    const secPerBeat = 60 / last.bpm;
    lastIndex += (rows[i].timeMs - last.timeMs) / 1000 / secPerBeat;
    points.push({ beatIndex: lastIndex, bpm: rows[i].bpm, sv: true, svRate: 0, timeSec: msToSec(rows[i].timeMs) });
    last = rows[i];
  }
  return { offset: offsetSec, points };
}
