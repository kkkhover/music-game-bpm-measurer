// ============================================================================
// timing 编辑核心 —— 纯函数，不碰文件系统（写盘由调用方做）
// 抽出来的原因：这是"改谱面"最关键的一步，必须能被自动化测试单独覆盖，
//              而不是埋在 app 的闭包里靠手动点界面验证。
// ============================================================================
import { parseOsu, serializeOsu } from './osuFile.mjs';

/**
 * 四舍五入保留指定小数位（与 Python round_half_up 一致，抵消浮点误差）。
 * 照搬主软件 utils/osuExport.ts 的 roundHalfUp —— 绿线 SV 必须与主软件算出同一个值。
 */
export function roundHalfUp(x, digits = 2) {
    const factor = 10 ** digits;
    return Math.floor(Number(x) * factor + 0.5 + 1e-9) / factor;
}

/**
 * 派生整数拍号 —— **必须与 renderer/viz.js 的 `_deriveBeatIndex` 保持同一算法**：
 *   首条红线 = 0；其后每条 = 上一条 + max(1, round(Δt / 上一段拍长))。
 * 主进程（新增红线要"落在下一拍"）和渲染进程（画拍号/节拍线）各用一份，
 * 两边算出的编号必须一致，否则界面上会出现"编号串位"。
 *
 * @param {{time:number,bpm:number}[]} reds 已按 time 升序的红线
 * @returns {number[]} 与 reds 等长的拍号数组（同时会写回 reds[i].beatIndex）
 */
export function deriveBeatIndex(reds) {
    const out = [];
    let bi = 0;
    for (let i = 0; i < reds.length; i++) {
        if (i > 0) {
            const prev = reds[i - 1];
            const beatDur = 60 / (prev.bpm || 120); // 秒
            bi += Math.max(1, Math.round((reds[i].time - prev.time) / 1000 / beatDur));
        } else {
            bi = 0;
        }
        reds[i].beatIndex = bi;
        out.push(bi);
    }
    return out;
}

/** anchorMs 落在哪一段（= time <= anchorMs 的最后一条红线） */
function sectionIndexAt(reds, timeMs) {
    let idx = 0;
    for (let i = 0; i < reds.length; i++) {
        if (reds[i].time <= timeMs) idx = i;
        else break;
    }
    return idx;
}

/**
 * 计划「新增红线」的位置 —— **严格落在上一条红线的下一拍**（拍号 = src 拍号 + 1）。
 *
 * 为什么不能简单地 src.time + 一拍：当"上一段的一拍"刚好越过后面的红线时，
 * 新红线会被排到**再下一条**之后，此时它的编号由后面那条红线反推（≠ src+1），
 * 整串编号串位，而且会和已有红线挤在一起。
 * → 这里先按 src 的拍长算出候选时间；若被后面的红线占住，就顺延到那条之后继续找空位。
 *
 * @param {{time:number,bpm:number,meter?:number}[]} reds 现有红线（按 time 升序）
 * @param {number} anchorMs  锚点时间（播放头/双击位置，只用来决定从哪一条红线往后数）
 * @param {number} [bpmHint] 指定新红线的 BPM（>0 生效，否则继承 src 的 BPM）
 * @returns {{time:number,bpm:number,meter:number,srcIndex:number,srcBeatIndex:number}}
 */
export function planAddRedLine(reds, anchorMs = 0, bpmHint) {
    const list = (reds || []).slice().sort((a, b) => a.time - b.time);
    const hint = Number(bpmHint) > 0 ? Number(bpmHint) : 0;

    if (!list.length) {
        const bpm = hint || 120;
        return { time: Math.max(0, Math.round(Number(anchorMs) || 0)), bpm, meter: 4, srcIndex: -1, srcBeatIndex: 0 };
    }

    deriveBeatIndex(list); // 先编好号（顺带写回 beatIndex）
    let i = sectionIndexAt(list, Math.max(0, Math.round(Number(anchorMs) || 0)));
    let src = list[i];
    let timeMs = 0;

    for (let guard = 0; guard <= list.length; guard++) {
        const beatMs = 60000 / (src.bpm || 120); // 上一段一拍长（毫秒）
        const t = Math.round(src.time + beatMs); // 下一拍的绝对时间
        const next = list[i + 1];
        if (!next || t < next.time) { timeMs = t; break; } // 有空位 → 就是它
        if (i + 1 >= list.length) { timeMs = t; break; } // 已经是最后一条 → 直接挂后面
        i += 1; // 下一拍被后面的红线占了 → 顺延到那一条之后继续找
        src = list[i];
    }

    return {
        time: timeMs,
        bpm: hint || src.bpm,
        meter: src.meter || 4,
        srcIndex: i,
        srcBeatIndex: src.beatIndex
    };
}

/**
 * 根据编辑请求构造新的 timing 列表。
 *
 * @param {object} parsed  readOsu/parseOsu 的结果
 * @param {object} payload
 *   - mode: 'redlines'（只改红线 BPM，绿线原样保留）
 *         | 'replace' （整段替换）
 *   - points: [{time, bpm}] 或完整 timing point 列表
 * @returns {object[]} 新的 timing 点（未改动的点会保留原对象，从而保住 raw 原文精度）
 */
export function buildTimingPoints(parsed, payload = {}) {
    const originals = parsed.timingPoints;

    if (payload.mode === 'redlines') {
        // 只改红线 BPM：绿线一条都不动
        const edits = Array.isArray(payload.points) ? payload.points : [];
        const byTime = new Map(edits.map((p) => [Math.round(Number(p.time)), p]));

        return originals.map((p) => {
            if (!p.uninherited) return p; // 绿线原样保留
            const e = byTime.get(Math.round(p.time));
            if (!e) return p;

            const bpm = Number(e.bpm);
            if (!(bpm > 0)) return p;

            // BPM 实际没变 → 返回原对象，让原始文本行照抄（零改动）
            const oldBpm = 60000 / p.beatLength;
            if (Math.abs(bpm - oldBpm) < 1e-6) return p;

            return {
                time: p.time,
                bpm,
                uninherited: true,
                meter: e.meter !== undefined ? Number(e.meter) : p.meter,
                volume: e.volume !== undefined ? Number(e.volume) : p.volume,
                effects: p.effects
            };
        });
    }

    // ★ v0.8.10 修复"导出不完整"：merge = 磁盘绿线原样保留（raw 保真），
    //   红线整体替换为编辑后的列表。原来的 'redlines' 模式只能在"磁盘已有红线"
    //   上改 BPM——用户新增的、或拖动过时间的红线在磁盘上找不到同时间点，
    //   会被整个丢掉（导出文件里只剩一两条红线的根因）。
    if (payload.mode === 'merge') {
        const edits = Array.isArray(payload.points) ? payload.points : [];
        // ★ v0.8.17：原谱面红线按时间建索引 —— 红线也要继承原谱面的 sampleSet/volume/effects
        //   （kiai、omit-first-barline 等段落特效不能丢，否则替换后谱面行为改变）。
        const origRedByTime = new Map();
        for (const o of originals) {
            if (o.uninherited) {
                const k = Math.round(Number(o.time) || 0);
                if (!origRedByTime.has(k)) origRedByTime.set(k, o);
            }
        }
        const reds = edits
            .map((e) => {
                const bpm = Number(e.bpm);
                if (!(bpm > 0)) return null; // 无效 BPM 的点直接丢弃
                const t = Math.max(0, Math.round(Number(e.time) || 0));
                const o = origRedByTime.get(t);
                return {
                    time: t,
                    bpm,
                    uninherited: true,
                    meter: e.meter !== undefined ? Number(e.meter) : (o && Number(o.meter) > 0 ? Number(o.meter) : 4),
                    sampleSet: o ? Number(o.sampleSet) : 0,
                    sampleIndex: o ? Number(o.sampleIndex) : 0,
                    volume: e.volume !== undefined ? Number(e.volume) : (o ? Number(o.volume) : 100),
                    effects: o ? Number(o.effects) : 0
                };
            })
            .filter(Boolean);
        if (!reds.length) return originals.slice(); // 没有有效红线 → 原样返回（上层自行判断）

        // 红线按时间升序（编辑列表理论上已有序，这里兜底，保证 baseBpm 取的是"第一条"）
        reds.sort((a, b) => a.time - b.time);

        // ★ v0.8.10 修正：绿线**不是**无脑 1.0×，而是
        //     SV = 基准BPM / 当前BPM（四舍五入两位）——BPM 变快时 SV<1 反向减速，
        //     从而让"下落/流速"在 BPM 改变后仍与基准段一致。
        //   公式与字段完全照搬主软件 utils/osuExport.ts（svValueOf + green = -100 / SV），
        //   基准 BPM 也照搬 App.tsx：取第一条（时间最早）红线的 BPM。
        const baseBpm = Number(payload.baseBpm) > 0 ? Number(payload.baseBpm) : reds[0].bpm;

        // ★ v0.8.17 修复"导出 timing 替换后无法正常使用"：
        //   旧写法把绿线的 sampleSet/sampleIndex/volume/effects 全部写死（1/0/72/0），
        //   而原谱面的绿线往往带着 kiai（effects bit0=1）或 omit-first-barline（bit3=8）、
        //   以及自定义的 sampleSet/volume。写死会把这些**段落特效与音色全丢掉**，
        //   替换进谱面后 kiai 段落消失、绿线行为与原谱不一致。
        //   → 现在：绿线**继承原谱面同一时间点绿线**的 sampleSet/sampleIndex/volume/effects/meter，
        //     只有 beatLength（SV）重新计算。原谱面该时间点没有绿线时才用默认值。
        //   原绿线按时间建索引（同一时间可能多条绿线，取第一条作为继承模板）。
        const origGreenByTime = new Map();
        for (const o of originals) {
            if (!o.uninherited) {
                const k = Math.round(Number(o.time) || 0);
                if (!origGreenByTime.has(k)) origGreenByTime.set(k, o);
            }
        }

        const out = [];
        for (const r of reds) {
            out.push(r);
            // SV 为 0/负/非数时退回 1.0（等价于不变速），避免写出非法 beatLength
            const svRaw = roundHalfUp(baseBpm / r.bpm, 2);
            const sv = svRaw > 0 ? svRaw : 1;
            const g = origGreenByTime.get(r.time);
            out.push({
                time: r.time,
                beatLength: -100 / sv,
                uninherited: false,
                // ★ 绿线的 sampleSet/sampleIndex/volume/effects/meter 继承原谱面；无则用合理默认
                meter: g && Number(g.meter) > 0 ? Number(g.meter) : (Number(r.meter) > 0 ? Number(r.meter) : 4),
                sampleSet: g ? Number(g.sampleSet) : 0,
                sampleIndex: g ? Number(g.sampleIndex) : 0,
                volume: g ? Number(g.volume) : 100,
                effects: g ? Number(g.effects) : 0
            });
        }
        return out;
    }

    // 整段替换：能对上原时间的点，若 BPM 未变则沿用原对象（保住精度）
    const list = Array.isArray(payload.points) ? payload.points : [];
    return list.map((p) => {
        const t = Math.round(Number(p.time) || 0);
        const isRed = p.uninherited !== undefined ? !!p.uninherited : p.bpm !== undefined && p.sv === undefined;
        const orig = originals.find((o) => Math.round(o.time) === t && o.uninherited === isRed);
        if (orig && p.bpm !== undefined && Math.abs(Number(p.bpm) - 60000 / orig.beatLength) < 1e-6) {
            return orig;
        }
        return {
            time: t,
            bpm: p.bpm,
            beatLength: p.beatLength,
            uninherited: isRed,
            sv: p.sv,
            meter: p.meter,
            volume: p.volume,
            effects: p.effects
        };
    });
}

/**
 * 生成新的 .osu 文本，并做**安全校验**：
 * 除 [TimingPoints] 外的内容必须逐行完全一致，否则判定为失败（拒绝写入）。
 *
 * @returns {{ok:boolean, text?:string, redCount?:number, greenCount?:number, total?:number, error?:string}}
 */
export function applyTimingToText(parsed, payload = {}) {
    if (!parsed || !parsed.ok) return { ok: false, error: '谱面解析失败，拒绝写入' };

    const newPoints = buildTimingPoints(parsed, payload);
    if (newPoints.length === 0) return { ok: false, error: '拒绝写入空 timing' };

    let text;
    try {
        text = serializeOsu(parsed, newPoints);
    } catch (e) {
        return { ok: false, error: '序列化失败: ' + e.message };
    }

    // ---- 安全校验：重新解析输出，逐行比对 [TimingPoints] 之外的区域 ----
    const check = parseOsu(text);
    const tpOld = parsed.sections.find((s) => s.name === 'TimingPoints');
    const tpNew = check.sections.find((s) => s.name === 'TimingPoints');

    if (!tpNew) return { ok: false, error: '安全校验未通过：输出里找不到 [TimingPoints]' };

    const headOld = parsed.lines.slice(0, tpOld.startLine);
    const headNew = check.lines.slice(0, tpNew.startLine);
    const tailOld = parsed.lines.slice(tpOld.endLine + 1);
    const tailNew = check.lines.slice(tpNew.endLine + 1);

    const headSame = headOld.join('\n') === headNew.join('\n');
    const tailSame = tailOld.join('\n') === tailNew.join('\n');

    if (!headSame || !tailSame) {
        return {
            ok: false,
            error:
                `安全校验未通过：除 [TimingPoints] 外的内容发生了变化` +
                `（前段${headSame ? '一致' : '不一致'} / 后段${tailSame ? '一致' : '不一致'}），已中止写入`
        };
    }

    // 时间戳必须严格递增（同一时间允许多条：红线在前、绿线在后）
    for (let i = 1; i < check.timingPoints.length; i++) {
        if (check.timingPoints[i].time < check.timingPoints[i - 1].time) {
            return { ok: false, error: `安全校验未通过：第 ${i + 1} 条时间戳早于上一条，拒绝写入` };
        }
    }

    const redCount = check.timingPoints.filter((p) => p.uninherited).length;
    const greenCount = check.timingPoints.length - redCount;

    return { ok: true, text, redCount, greenCount, total: check.timingPoints.length };
}
