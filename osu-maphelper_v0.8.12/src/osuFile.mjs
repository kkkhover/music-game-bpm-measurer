// ============================================================================
// .osu 文件模块 —— 快速读取 / 编辑 / 安全写回
//
// 设计原则（很重要）：
//   ① **只动 [TimingPoints]**，其余段落逐行原样保留（含注释、空行、字段顺序、
//      缩进、BOM、换行符风格）—— 避免把谱面改坏
//   ② **原子写**：先写 .tmp 再 rename 覆盖，中途断电/崩溃不会写出半个文件
//   ③ 写之前由调用方负责备份（见 backup.mjs 的 backupBeforeWrite）
//
// 为什么不做"全量序列化"：osu!stable 的 .osu 有很多字段（[Events] 断点、故事板、
// [Colours]、[HitObjects] 的 slider 路径）用现成解析器重写容易产生细微差异，
// 而谱师对这些差异非常敏感。只替换一个段落是最小侵入面的做法。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** 段落头：[Section] */
const SECTION_RE = /^\[([A-Za-z]+)\]\s*$/;

/**
 * 解析 .osu
 * @returns {{
 *   ok:boolean, error?:string, eol:string, bom:boolean,
 *   lines:string[], sections:{name:string,startLine:number,endLine:number}[],
 *   timingPoints:object[], rawTimingLines:string[], header:object
 * }}
 */
export function parseOsu(content) {
    if (typeof content !== 'string') return { ok: false, error: '内容不是字符串' };

    const bom = content.charCodeAt(0) === 0xfeff;
    const body = bom ? content.slice(1) : content;

    // 换行符风格：CRLF 还是 LF（写回时保持一致，避免整文件 diff）
    const crlf = (body.match(/\r\n/g) || []).length;
    const lfOnly = (body.match(/(?<!\r)\n/g) || []).length;
    const eol = crlf >= lfOnly ? '\r\n' : '\n';

    const lines = body.split(/\r\n|\n|\r/);

    // 定位所有段落
    const sections = [];
    let cur = null;
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(SECTION_RE);
        if (m) {
            if (cur) cur.endLine = i - 1;
            cur = { name: m[1], startLine: i, endLine: lines.length - 1 };
            sections.push(cur);
        }
    }

    const tp = sections.find((s) => s.name === 'TimingPoints');
    const timingPoints = [];
    const rawTimingLines = [];

    if (tp) {
        for (let i = tp.startLine + 1; i <= tp.endLine; i++) {
            const raw = lines[i];
            const t = raw.trim();
            if (!t || t.startsWith('//')) continue;
            const parts = t.split(',');
            if (parts.length < 2) continue;

            const time = Number(parts[0]);
            const beatLength = Number(parts[1]);
            if (!Number.isFinite(time) || !Number.isFinite(beatLength)) continue;

            const uninherited = parts.length >= 7 ? Number(parts[6]) !== 0 : beatLength > 0;
            timingPoints.push({
                lineIndex: i,
                time, // 毫秒
                beatLength,
                meter: parts[2] !== undefined ? Number(parts[2]) : 4,
                sampleSet: parts[3] !== undefined ? Number(parts[3]) : 0,
                sampleIndex: parts[4] !== undefined ? Number(parts[4]) : 0,
                volume: parts[5] !== undefined ? Number(parts[5]) : 100,
                uninherited,
                effects: parts[7] !== undefined ? Number(parts[7]) : 0,
                // bpm / sv 只是为了方便展示与编辑派生的**视图**，不参与写回；
                // 这里保持 double 全精度（不做 round），否则与 beatLength 反算会引入误差
                bpm: uninherited ? 60000 / beatLength : 0,
                sv: uninherited ? 1 : -100 / beatLength,
                raw
            });
        }
    }

    // 头部信息（只读，用于展示）
    const general = readKeyValues(lines, sections, 'General');
    const metadata = readKeyValues(lines, sections, 'Metadata');
    const difficulty = readKeyValues(lines, sections, 'Difficulty');
    const editor = readKeyValues(lines, sections, 'Editor');

    return {
        ok: true,
        eol,
        bom,
        lines,
        sections,
        timingPoints,
        rawTimingLines,
        header: {
            audioFilename: general.AudioFilename || '',
            previewTime: Number(general.PreviewTime) || 0,
            title: metadata.Title || '',
            artist: metadata.Artist || '',
            creator: metadata.Creator || '',
            version: metadata.Version || '',
            beatmapId: metadata.BeatmapID || '',
            beatmapSetId: metadata.BeatmapSetID || '',
            cs: Number(difficulty.CircleSize) || 0,
            od: Number(difficulty.OverallDifficulty) || 0,
            ar: Number(difficulty.ApproachRate) || 0,
            hp: Number(difficulty.HPDrainRate) || 0,
            bookmarks: editor.Bookmarks || '',
            editorDistance: Number(editor.DistanceSpacing) || 0
        }
    };
}

function readKeyValues(lines, sections, name) {
    const out = {};
    const s = sections.find((x) => x.name === name);
    if (!s) return out;
    for (let i = s.startLine + 1; i <= s.endLine; i++) {
        const line = lines[i];
        if (!line) continue;
        const idx = line.indexOf(':');
        if (idx <= 0) continue;
        out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    return out;
}

/**
 * 用新的 timingPoints 替换 [TimingPoints] 段落，其余原样保留。
 *
 * 保真策略（这是本模块最关键的逻辑）：
 *   ① 未被改动的点 → 直接沿用原始文本行（raw），保证 osu! 那种
 *      `272.72727272727272727272727273` 的超长精度不丢（重新格式化只能用
 *      17 位有效数字表示同一个 double，字节上就不再一致）
 *   ② 段落内的空行（前导/尾部）与 `//` 注释行原样保留，不破坏排版
 *   ③ 段落外的所有行完全不动
 *
 * @param {object} parsed parseOsu 的返回值
 * @param {{time:number,beatLength?:number,bpm?:number,uninherited?:boolean,meter?:number,volume?:number,sv?:number,raw?:string}[]} newPoints
 *        毫秒时间 + 二选一（beatLength 或 bpm）；带 raw 且数值未变的点会原样输出
 * @returns {string} 新的 .osu 文本
 */
export function serializeOsu(parsed, newPoints) {
    if (!parsed.ok) throw new Error('parse 未成功，无法序列化');

    const lines = [...parsed.lines];
    const tp = parsed.sections.find((s) => s.name === 'TimingPoints');
    if (!tp) throw new Error('该谱面没有 [TimingPoints] 段落');

    const origSectionLines = lines.slice(tp.startLine + 1, tp.endLine + 1);

    // 统计前导 / 尾部空行，保留原始排版
    let lead = 0;
    while (lead < origSectionLines.length && origSectionLines[lead].trim() === '') lead++;
    let tail = 0;
    while (
        tail < origSectionLines.length - lead &&
        origSectionLines[origSectionLines.length - 1 - tail].trim() === ''
    ) {
        tail++;
    }
    // 注释行（osu! 支持 // 注释）
    const comments = origSectionLines
        .slice(lead, origSectionLines.length - tail)
        .filter((l) => l.trim().startsWith('//'));

    // 按时间排序（红线绿线混排时必须时间升序；同时间红线在前）
    const sorted = [...newPoints].sort(
        (a, b) => {
            const ta = Math.round(Number(a.time) || 0);
            const tb = Math.round(Number(b.time) || 0);
            if (ta !== tb) return ta - tb;
            const ua = a.uninherited !== undefined ? !!a.uninherited : !(a.sv !== undefined && a.sv !== 1);
            const ub = b.uninherited !== undefined ? !!b.uninherited : !(b.sv !== undefined && b.sv !== 1);
            return ua === ub ? 0 : ua ? -1 : 1;
        }
    );

    const rendered = sorted.map((p) => {
        const computed = normalizePoint(p);
        return renderPoint(p, computed);
    });

    const body = [
        ...origSectionLines.slice(0, lead), // 前导空行
        ...rendered,
        ...comments, // 注释
        ...origSectionLines.slice(origSectionLines.length - tail) // 尾部空行
    ];

    const merged = [
        ...lines.slice(0, tp.startLine + 1),
        ...body,
        ...lines.slice(tp.endLine + 1)
    ];

    const text = merged.join(parsed.eol);
    return (parsed.bom ? '\ufeff' : '') + text;
}

/**
 * 归一化一条 timing point：补默认字段，bpm↔beatLength 互转。
 *
 * beatLength 与 bpm 同时存在时的取舍（关键）：
 *   · 两者互相吻合（相对误差 < 1e-9）→ 用原始 beatLength（原样保真）
 *   · 明显不吻合 → 说明调用方**显式改了 BPM**，以 bpm 为准
 *     （否则 UI 传 {…原点, bpm: 新值} 时，残留的旧 beatLength 会让改动被忽略）
 */
function normalizePoint(p) {
    const uninherited = p.uninherited !== undefined ? !!p.uninherited : p.sv === undefined || p.sv === 1;

    const hasBL = Number.isFinite(Number(p.beatLength));
    const hasBpm = Number.isFinite(Number(p.bpm)) && Number(p.bpm) > 0;

    let beatLength;
    if (hasBL && hasBpm) {
        const fromBpm = 60000 / Number(p.bpm);
        const bl = Number(p.beatLength);
        const rel = Math.abs(fromBpm - bl) / Math.max(1e-12, Math.abs(bl));
        beatLength = rel < 1e-9 ? bl : fromBpm;
    } else if (hasBL) {
        beatLength = Number(p.beatLength);
    } else if (hasBpm) {
        beatLength = 60000 / Number(p.bpm);
    } else if (!uninherited) {
        // 绿线：SV 倍率 → beatLength = -100 / sv
        const sv = Number(p.sv) > 0 ? Number(p.sv) : 1;
        beatLength = -100 / sv;
    } else {
        beatLength = 500; // 兜底 120BPM
    }

    return {
        time: Math.round(Number(p.time) || 0),
        beatLength,
        meter: p.meter !== undefined ? Number(p.meter) : 4,
        sampleSet: p.sampleSet !== undefined ? Number(p.sampleSet) : 0,
        sampleIndex: p.sampleIndex !== undefined ? Number(p.sampleIndex) : 0,
        volume: p.volume !== undefined ? Number(p.volume) : 100,
        uninherited,
        effects: p.effects !== undefined ? Number(p.effects) : 0
    };
}

/**
 * 输出一条 timing 行。
 * 若该点携带 raw 且所有字段与重新计算的结果一致 → 原样返回 raw（保精度、保排版）。
 */
function renderPoint(original, computed) {
    if (original && typeof original.raw === 'string') {
        const same =
            Math.round(Number(original.time) || 0) === computed.time &&
            Number(original.beatLength) === computed.beatLength &&
            Number(original.meter) === computed.meter &&
            Number(original.sampleSet) === computed.sampleSet &&
            Number(original.sampleIndex) === computed.sampleIndex &&
            Number(original.volume) === computed.volume &&
            !!original.uninherited === computed.uninherited &&
            Number(original.effects) === computed.effects;
        if (same) return original.raw;
    }
    return formatPoint(computed);
}

/** 输出成 osu timing 行：time,beatLength,meter,sampleSet,sampleIndex,volume,uninherited,effects */
function formatPoint(p) {
    return [
        p.time,
        formatNum(p.beatLength),
        p.meter,
        p.sampleSet,
        p.sampleIndex,
        p.volume,
        p.uninherited ? 1 : 0,
        p.effects
    ].join(',');
}

/**
 * 数字 → 文本。
 * 用 JS 的 Number→String（最短往返表示，17 位有效数字内保证 double 完全一致），
 * 而不是 toFixed(12)——toFixed 会把 osu! 写出的超长精度截断，
 * 导致"没改过的点"重写后字节不一致。
 */
function formatNum(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '0';
    if (Number.isInteger(n)) return String(n);
    return String(n);
}

function round(v, d) {
    const f = Math.pow(10, d);
    return Math.round(v * f) / f;
}

/** 读谱面文件 */
export function readOsu(filePath) {
    const buf = fs.readFileSync(filePath);
    // osu! 的 .osu 基本都是 UTF-8；带 BOM 的保留在 parseOsu 里处理
    const content = buf.toString('utf8');
    const parsed = parseOsu(content);
    return {
        ...parsed,
        path: filePath,
        size: buf.length,
        mtime: fs.statSync(filePath).mtimeMs,
        hash: sha1(content)
    };
}

/**
 * 原子写回：先写同目录 .tmp，再 rename 覆盖。
 * 只允许写 .osu 文件。
 */
export function writeOsuAtomic(filePath, content) {
    if (!/\.osu$/i.test(filePath)) throw new Error('拒绝写入非 .osu 文件：' + filePath);
    const dir = path.dirname(filePath);
    const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
    try {
        fs.writeFileSync(tmp, content, 'utf8');
        fs.renameSync(tmp, filePath); // Windows 上 Node 的 rename 覆盖已存在文件
    } catch (e) {
        try {
            if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
        } catch {
            /* ignore */
        }
        throw e;
    }
    return { size: fs.statSync(filePath).size, mtime: fs.statSync(filePath).mtimeMs };
}

export function sha1(text) {
    return crypto.createHash('sha1').update(text, 'utf8').digest('hex');
}

/**
 * 从谱面里取出"红线"（uninherited）列表，转成我们 UI 用的格式。
 */
export function extractRedLines(parsed) {
    return parsed.timingPoints
        .filter((p) => p.uninherited)
        .map((p) => ({
            time: p.time,
            bpm: round(60000 / p.beatLength, 4),
            beatLength: p.beatLength,
            meter: p.meter,
            volume: p.volume,
            effects: p.effects
        }))
        .sort((a, b) => a.time - b.time);
}
