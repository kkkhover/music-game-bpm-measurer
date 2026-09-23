// ============================================================================
// 编排层 —— 把 tosu / 路径探测 / .osu 读写 / 定时备份 串成一个状态机
//
// 数据流：
//   tosu HTTP API ──(每 pollMs 毫秒)──▶ 实时播放位置 + GameState + 谱面文件名
//                                          │
//                                          ├─▶ 拼出 .osu 绝对路径（paths.mjs）
//                                          │      │
//                                          │      └─▶ 读文件 → 解析红线（osuFile.mjs，按 mtime 缓存）
//                                          │
//                                          └─▶ 备份调度器（backup.mjs）定时把当前 .osu 存一份
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, saveConfig, getExportDir } from './config.mjs';
import { createTosuClient, detectTosuPort, GameState, EDITOR_STATES } from './tosu.mjs';
import { findOsuInstallDir, findSongsDir, findOsuProcess, resolveBeatmapPath } from './paths.mjs';
import { readOsu, extractRedLines } from './osuFile.mjs';
import { applyTimingToText, deriveBeatIndex, planAddRedLine } from './timingEdit.mjs';
import { createBackupManager } from './backup.mjs';
import { readBpmSettings, readBpmLang, SUPPORTED_LANGS } from './bpmSettings.mjs';

function round(v, digits) {
    const f = Math.pow(10, digits);
    return Math.round(v * f) / f;
}

/**
 * 节拍线延迟的「生效值」—— 决定侧栏频谱上的红蓝拍线画在哪。
 *
 * 侧栏与 BPM 测速助手 是两个独立程序，设置各存各的：
 *   · 软件 → 自己的 localStorage（读取实现见 src/bpmSettings.mjs）
 *   · 侧栏 → 本目录 config.json
 * 所以这里做一层「跟随」：默认取软件里校准过的值；读不到软件设置、或用户
 * 主动关掉跟随时，才退回侧栏自己的手动值 —— 数值上始终与软件一致。
 */
function bpmDelayState() {
    const cfg = loadConfig();
    const v = cfg.visual || {};
    const follow = v.beatLineDelayFollowSoftware !== false; // 默认跟随软件
    const manualMs = Number.isFinite(v.beatLineDelayMs) ? Math.round(v.beatLineDelayMs) : 30;

    const read = readBpmSettings();
    const raw = read.ok && read.settings ? read.settings.beatLineDelayMs : null;
    const softwareMs = Number.isFinite(raw) ? Math.round(raw) : null;

    // 跟随时用软件值；软件读不到（从未运行过 / 文件被压缩）就退回手动值，绝不留空
    const effectiveMs = follow && softwareMs !== null ? softwareMs : manualMs;

    return {
        follow,       // 是否跟随软件
        manualMs,     // 侧栏自己的值
        softwareMs,   // 软件里的值（读不到 = null）
        effectiveMs,  // 实际生效值
        source: follow && softwareMs !== null ? 'software' : 'sidebar',
        dir: read.dir,        // 软件设置目录（排查用）
        ok: read.ok,
        error: read.error || null
    };
}

/**
 * ★ v0.8.16：界面语言的「生效值」（修 Bug 1：多语言没有全软件统一、侧栏没有语言更改）。
 *
 * 和节拍线延迟同一个思路 —— 侧栏默认直接采用 BPM 测速助手里选的语言：
 *   · 跟随（默认）：读软件 localStorage 的 lang 字段；
 *     读不到（软件从未运行 / 值被压缩掉）→ 退回侧栏自己的设置，并带上 error 说明。
 *   · 不跟随：用侧栏 config.json 里单独指定的语言。
 * 前端（renderer/i18n.js）只负责按这个值渲染文案，不做任何持久化。
 */
function langState() {
    const cfg = loadConfig();
    const v = cfg.visual || {};
    const follow = v.langFollow !== false; // 默认跟随软件
    const manualLang = SUPPORTED_LANGS.includes(v.lang) ? v.lang : 'zh';

    const read = readBpmSettings();
    const softwareLang = readBpmLang();

    // 跟随时用软件值；软件读不到就退回侧栏值
    const effective = follow && softwareLang ? softwareLang : manualLang;

    return {
        follow,          // 是否跟随软件
        manualLang,      // 侧栏自己指定的语言
        softwareLang,    // 软件里的语言（读不到 = null）
        effective,       // 实际生效语言（前端按它渲染）
        source: follow && softwareLang ? 'software' : 'sidebar',
        ok: read.ok,
        error: read.error || null
    };
}

/**
 * 求 ms 时刻所在的红线 BPM。
 * 用「最后一条 startTime <= ms 的红线」——与 osu! 播放时的取法一致。
 */
function currentBpmAt(timingPoints, ms) {
    let bpm = 0;
    for (const p of timingPoints) {
        if (!p.uninherited) continue;
        if (p.time <= ms) bpm = p.bpm;
        else break;
    }
    if (!bpm) {
        const first = timingPoints.find((p) => p.uninherited);
        bpm = first ? first.bpm : 0;
    }
    return round(bpm, 3);
}

export function createApp() {
    const cfg = loadConfig();

    // ---- tosu 客户端 ----
    let tosuPort = cfg.tosu.port;
    let tosu = createTosuClient({ host: cfg.tosu.host, port: tosuPort });

    // ---- osu! 路径（懒探测，避免每次轮询都跑 PowerShell）----
    let osuInstallDir = cfg.osu.installDir || '';
    let songsDir = cfg.osu.songsDir || '';
    let osuProc = null;

    // ---- 当前谱面 ----
    let beatmapPath = '';
    let beatmap = null; // readOsu 的结果
    let beatmapHash = '';
    let lastStatCheck = 0;

    // ---- 内存 timing 编辑状态（多窗口共享，上移到主进程）----
    // 红线拖动 / 列表编辑 只改这里，点「导入」才写回磁盘。
    // 因为频谱窗口和红线列表窗口是不同渲染进程，状态必须放主进程才能同步。
    let memTiming = null; // { path, redLines:[{time,bpm,beatLength,meter}] }
    let memDirty = false; // 是否有未导入的修改

    // ---- 实时状态 ----
    let live = {
        connected: false,
        tosuUp: false,
        state: 'unknown',
        isEditor: false,
        time: 0,
        timingPoints: [],
        redCount: 0,
        greenCount: 0,
        audioLength: 0,
        bpmRange: '',
        title: '',
        artist: '',
        difficulty: '',
        md5: '',
        lastError: ''
    };

    let events = []; // 最近的日志（给 UI 看）

    function pushLog(msg) {
        const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`;
        events.unshift(line);
        if (events.length > 60) events.length = 60;
    }

    // ---- 备份管理器 ----
    const backup = createBackupManager({
        getSource: () => beatmapPath,
        getLabel: () => beatmapLabel(),
        onLog: pushLog
    });

    /** 备份用的谱面标识：优先 Artist - Title [Version]，退回文件夹名 */
    function beatmapLabel() {
        if (beatmap && beatmap.ok) {
            const h = beatmap.header;
            if (h.artist || h.title) {
                return `${h.artist || '?'} - ${h.title || '?'}${h.version ? ' [' + h.version + ']' : ''}`;
            }
        }
        if (beatmapPath) return path.basename(path.dirname(beatmapPath));
        // 没有打开任何谱面 → 返回空串（**不要**返回 'unknown'）。
        // 快照里是 backup.status(beatmapLabel())，而 status() 会走
        // listBackups() → dirFor() → fs.mkdirSync()，于是每次快照都会在
        // backups\ 下凭空建出一个叫 unknown 的空文件夹。返回空串即短路掉它。
        return '';
    }

    /**
     * 探测 osu! 环境（安装目录 / Songs / 进程），带节流。
     * ★ v0.8.10 性能：findOsuProcess 里的 PowerShell 改成了异步（execFile），
     *   这里再加 in-flight 守卫防止并发堆积——同步部分（配置缓存检查）立刻返回，
     *   慢的进程探测在后台完成后再写入缓存，主进程全程不阻塞。
     */
    let lastEnvProbe = 0;
    let envProbing = false;
    function probeEnv(force = false) {
        const now = Date.now();
        if (envProbing) return;
        if (!force && now - lastEnvProbe < 5000) return;
        lastEnvProbe = now;
        envProbing = true;
        (async () => {
            try {
                if (!osuInstallDir || !fs.existsSync(path.join(osuInstallDir, 'osu!.exe'))) {
                    osuInstallDir = findOsuInstallDir();
                }
                if (!songsDir && osuInstallDir) {
                    songsDir = findSongsDir(osuInstallDir);
                }
                osuProc = await findOsuProcess();
            } catch (e) {
                live.lastError = '环境探测失败: ' + e.message;
            } finally {
                envProbing = false;
            }
        })();
    }

    /** 载入/刷新当前谱面（按 mtime 缓存，最多每秒查一次） */
    function syncBeatmap(force = false) {
        if (!beatmapPath) {
            beatmap = null;
            beatmapHash = '';
            return false;
        }
        const now = Date.now();
        if (!force && now - lastStatCheck < 1000) return false;
        lastStatCheck = now;

        let st;
        try {
            st = fs.statSync(beatmapPath);
        } catch {
            beatmap = null;
            beatmapHash = '';
            return false;
        }
        if (!force && beatmap && beatmap.mtime === st.mtimeMs && beatmap.size === st.size) {
            return false; // 没变，不用重读
        }

        try {
            const prev = beatmapPath;
            beatmap = readOsu(beatmapPath);
            if (beatmapHash !== beatmap.hash) {
                beatmapHash = beatmap.hash;
                if (prev !== beatmapPath) {
                    backup.resetHistory();
                    pushLog(`切换谱面：${path.basename(beatmapPath)}`);
                }
            }
            return true;
        } catch (e) {
            live.lastError = '读取谱面失败: ' + e.message;
            return false;
        }
    }

    /** 解析 tosu 给的相对路径 → 绝对路径 */
    function resolvePath(location) {
        probeEnv();
        const p = resolveBeatmapPath(location, songsDir, osuInstallDir);
        return p && fs.existsSync(p) ? p : '';
    }

    /**
     * 定位当前谱面的音频文件绝对路径。
     * 音频文件名来自 .osu 的 [General] AudioFilename（header.audioFilename），
     * 与 .osu 在同一文件夹。找不到返回 ''。
     */
    function resolveAudioPath() {
        if (!beatmap || !beatmap.ok || !beatmap.header.audioFilename) return '';
        const dir = path.dirname(beatmapPath);
        const full = path.join(dir, beatmap.header.audioFilename);
        return fs.existsSync(full) ? full : '';
    }

    /** 一次刷新：拉 tosu + 同步谱面 */
    async function refresh() {
        try {
            const st = await tosu.getState();
            if (!st) {
                // tosu 在跑但 osu! 没开，或者 tosu 没开
                live.tosuUp = await tosu.isTosuUp();
                live.connected = false;
                live.state = 'unknown';
                live.isEditor = false;
                return;
            }

            live.tosuUp = true;
            live.connected = true;
            live.state = st.state;
            live.isEditor = st.isEditor;
            live.time = st.time;
            live.timingPoints = st.timingPoints;
            live.redCount = st.redCount;
            live.greenCount = st.greenCount;
            live.audioLength = st.audioLength;
            live.bpmRange = st.bpmRange;
            live.title = st.title;
            live.artist = st.artist;
            live.difficulty = st.difficulty;
            live.md5 = st.md5;
            live.lastError = '';

            // 谱面路径变化 → 重新解析
            if (st.fileLocation) {
                const resolved = resolvePath(st.fileLocation);
                if (resolved && resolved !== beatmapPath) {
                    beatmapPath = resolved;
                    syncBeatmap(true);
                } else if (!resolved && !beatmapPath) {
                    // 解析不出来，先记着候选路径方便诊断
                    beatmapPath = '';
                }
            }
            syncBeatmap();
        } catch (e) {
            live.lastError = '刷新失败: ' + e.message;
        }
    }

    /** 给 UI 的快照 */
    function snapshot() {
        const cfgNow = loadConfig();
        // ★ v0.8.5：节拍线延迟跟随软件 —— 在下发的 config 里把它换成「生效值」，
        //   这样 viz（画拍线）和设置面板（回显）都自动拿到同一个数，不用各自再算。
        //   ⚠ 必须**克隆**：直接改 cfgNow 会污染 loadConfig() 的缓存对象，
        //   进而让 saveConfig 把「软件的值」当成用户设置写进 config.json。
        const bpmDelay = bpmDelayState();
        // ★ v0.8.16：语言同理 —— 把「生效语言」写进下发的 config，各窗口统一按它渲染。
        //   同样必须克隆，避免污染 loadConfig() 的缓存对象。
        const lang = langState();
        const cfgOut = {
            ...cfgNow,
            visual: { ...cfgNow.visual, beatLineDelayMs: bpmDelay.effectiveMs, lang: lang.effective, langFollow: lang.follow }
        };
        const reds = beatmap && beatmap.ok ? extractRedLines(beatmap) : [];
        // 把 tosu 的 timing（编辑器内存里的真实 timing）与磁盘文件对比
        const memRedTimes = live.timingPoints.filter((p) => p.uninherited).map((p) => p.time);

        // 同步内存编辑状态：谱面切换时从磁盘快照
        if (beatmapPath) {
            if (!memTiming || memTiming.path !== beatmapPath) {
                memTiming = { path: beatmapPath, redLines: reds.map((r) => ({ ...r })) };
                memDirty = false;
            } else if (!memDirty && beatmap && beatmap.ok) {
                // 无未导入修改时，跟随磁盘（外部改动 / Ctrl+S 后静默同步）
                const diskSig = reds.map((r) => r.time + ':' + r.bpm).join('|');
                const memSig = memTiming.redLines.map((r) => r.time + ':' + r.bpm).join('|');
                if (diskSig !== memSig) {
                    memTiming.redLines = reds.map((r) => ({ ...r }));
                }
            }
        } else {
            memTiming = null;
            memDirty = false;
        }

        return {
            tosu: {
                up: live.tosuUp,
                port: tosuPort,
                connected: live.connected,
                state: live.state,
                isEditor: live.isEditor,
                stateLabel: stateLabel(live.state)
            },
            player: {
                time: live.time, // 秒
                audioLength: live.audioLength, // 毫秒
                bpmRange: live.bpmRange,
                // 当前所在红线的 BPM（用编辑器内存里的 timing 算，最准）
                currentBpm: currentBpmAt(live.timingPoints, live.time * 1000)
            },
            osu: {
                running: !!osuProc,
                pid: osuProc ? osuProc.pid : 0,
                installDir: osuInstallDir,
                songsDir
            },
            beatmap: beatmapPath
                ? {
                      path: beatmapPath,
                      exists: true,
                      label: beatmapLabel(),
                      fileName: path.basename(beatmapPath),
                      size: beatmap ? beatmap.size : 0,
                      mtime: beatmap ? beatmap.mtime : 0,
                      header: beatmap && beatmap.ok ? beatmap.header : null,
                      redLines: reds,
                      redCount: reds.length,
                      greenCount: beatmap && beatmap.ok ? beatmap.timingPoints.filter((p) => !p.uninherited).length : 0,
                      memRedCount: memRedTimes.length,
                      // 磁盘文件红线数 vs 编辑器内存红线数
                      inSync: reds.length === memRedTimes.length,
                      // 音频文件（供频谱/声谱解码）
                      audioPath: resolveAudioPath(),
                      audioName: beatmap && beatmap.ok && beatmap.header ? beatmap.header.audioFilename : ''
                  }
                : null,
            backup: backup.status(beatmapLabel()),
            config: cfgOut,
            // 节拍线延迟的来源信息（设置面板用它显示「跟随中 / 手动」+ 软件当前值）
            bpmDelay,
            // ★ v0.8.16：语言的来源信息（设置面板用它显示语言来源 + 软件当前语言）
            lang,
            // 内存 timing 编辑状态（多窗口共享；拖动/列表编辑改这里，导入才写盘）
            memTiming: memTiming ? { path: memTiming.path, redLines: memTiming.redLines } : null,
            memDirty,
            events,
            error: live.lastError
        };
    }

    function stateLabel(s) {
        const map = {
            menu: '主菜单',
            edit: '制谱器（编辑中）',
            selectEdit: '选歌（制谱入口）',
            selectPlay: '选歌',
            selectDrawings: '选歌（故事板）',
            play: '游戏中',
            resultScreen: '结算',
            busy: '载入中'
        };
        return map[s] || s;
    }

    // ---------------------------------------------------------------- 动作 ---

    /** 手动备份一次 */
    function backupNow() {
        const r = backup.backupNow('manual');
        pushLog(r.ok ? `手动备份成功：${r.name}` : `手动备份跳过（${r.reason}）`);
        return r;
    }

    /** 从内存 timing 取一份纯数据快照（返回给渲染进程，供编辑栏即时回显） */
    function redLinesSnapshot() {
        if (!memTiming) return [];
        return memTiming.redLines.map((r) => ({
            time: r.time, bpm: r.bpm, beatLength: r.beatLength, meter: r.meter
        }));
    }

    /** 找到 timeMs 落在哪一段（返回该段下标，用于新增红线时继承 BPM） */
    function sectionIndexAt(reds, timeMs) {
        let idx = 0;
        for (let i = 0; i < reds.length; i++) {
            if (reds[i].time <= timeMs) idx = i; else break;
        }
        return idx;
    }

    /**
     * 内存编辑（红线拖动 / 编辑栏输入 / 快捷添加删除），不写盘。
     * @param {object} edit
     *   type: 'offset'  | 整体平移（改第 0 条红线的时间 = 全局 offset）
     *         'redline' | 改某条红线的绝对时间戳
     *         'bpm'     | 改某条红线的 BPM
     *         'add'     | 在 timeMs 处新增一条红线（默认继承所在段的 BPM）
     *         'delete'  | 删除第 redIndex 条红线（保底留 1 条）
     * 返回里带上最新的 redLines 快照，渲染进程可即时刷新编辑栏（不必等下一轮轮询）。
     */
    function editTiming(edit = {}) {
        if (!memTiming || !memTiming.redLines.length) return { ok: false, error: '无内存 timing' };
        const reds = memTiming.redLines;

        if (edit.type === 'offset') {
            const delta = (edit.offsetMs || 0) - reds[0].time;
            reds.forEach((r) => (r.time = Math.max(0, Math.round(r.time + delta))));
        } else if (edit.type === 'redline') {
            if (edit.redIndex < 0 || edit.redIndex >= reds.length) return { ok: false, error: '下标越界' };
            reds[edit.redIndex].time = edit.timeMs || 0;
            reds.sort((a, b) => a.time - b.time);
        } else if (edit.type === 'bpm') {
            if (edit.redIndex < 0 || edit.redIndex >= reds.length) return { ok: false, error: '下标越界' };
            reds[edit.redIndex].bpm = edit.bpm;
            reds[edit.redIndex].beatLength = 60000 / edit.bpm;
        } else if (edit.type === 'meter') {
            // ★ v0.8.17：改拍号（每小节几拍）——只影响小节线/节拍器分组，不改红线位置
            if (edit.redIndex < 0 || edit.redIndex >= reds.length) return { ok: false, error: '下标越界' };
            const m = Math.round(Number(edit.meter));
            if (!Number.isFinite(m) || m < 1 || m > 7) return { ok: false, error: '拍号需为 1~7 的整数（与 osu! 一致，最大 7/4 拍）' };
            reds[edit.redIndex].meter = m;
        } else if (edit.type === 'add') {
            // ★ v0.8.10 修正：新增红线**严格按拍编号**落在「上一条红线的下一拍」
            //   （拍号 = src 拍号 + 1），实现见 timingEdit.planAddRedLine：
            //   候选时间被后面的红线占住时顺延，保证编号不串位、不与已有红线重叠。
            //   edit.timeMs 只作为"从哪条红线往后数"的锚点，不是新增红线的最终时间。
            const plan = planAddRedLine(reds, edit.timeMs, Number(edit.bpm));
            reds.push({
                time: plan.time,
                bpm: plan.bpm,
                beatLength: 60000 / plan.bpm,
                meter: plan.meter
            });
            reds.sort((a, b) => a.time - b.time);
        } else if (edit.type === 'delete') {
            if (reds.length <= 1) return { ok: false, error: '至少保留 1 条红线' };
            if (edit.redIndex < 0 || edit.redIndex >= reds.length) return { ok: false, error: '下标越界' };
            reds.splice(edit.redIndex, 1);
        } else if (edit.type === 'replace') {
            // 整表替换（撤销/重做用）：redLines = [{time, bpm}]
            const list = Array.isArray(edit.redLines) ? edit.redLines : null;
            if (!list || !list.length) return { ok: false, error: '红线列表为空' };
            const next = list
                .map((r) => ({
                    time: Math.max(0, Math.round(Number(r.time) || 0)),
                    bpm: Number(r.bpm) > 0 ? Number(r.bpm) : 120,
                    meter: Number(r.meter) > 0 ? Number(r.meter) : 4
                }))
                .sort((a, b) => a.time - b.time);
            next.forEach((r) => { r.beatLength = 60000 / r.bpm; });
            memTiming.redLines = next;
        } else {
            return { ok: false, error: '未知编辑类型' };
        }
        memDirty = true;
        return { ok: true, redLines: redLinesSnapshot() };
    }

    /** 清空未导入的修改（恢复到磁盘状态） */
    function resetMemTiming() {
        memDirty = false;
        memTiming = null; // 下次 snapshot 会从磁盘重新快照
    }

    // ★ v0.8.10：原「把编辑后的 timing 直接写回谱面 .osu」的 applyTiming 已按需求**整个移除**——
    //   直接覆盖谱面文件的方法太危险也太复杂。现在 timing 的唯一出口是上面的 exportTiming()：
    //   导出到时间戳命名的独立文件，由用户手动导入。

    /** 导出文件名的安全化：去掉路径非法字符（与 backup.mjs 的 safeFolderName 一致） */
    function safeExportName(name) {
        return (name || 'beatmap')
            .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
            .replace(/\.+$/, '')
            .trim()
            .slice(0, 80) || 'beatmap';
    }

    /** 导出文件名的时间戳：年-月-日-时-分-秒（无补零，含秒避免同一分钟撞名） */
    function exportStamp(d = new Date()) {
        return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}-${d.getHours()}-${d.getMinutes()}-${d.getSeconds()}`;
    }

    /**
     * 把编辑后的 timing 导出成一个**独立文件**（时间戳命名），保存到「保存文件夹」，
     * **不写回谱面 .osu** —— 用户拿到文件后手动导入（osu! 编辑器 File→Import timing points，
     * 或自行复制 [TimingPoints] 段）。
     *
     * 导出后**不清 memDirty**：磁盘 .osu 确实还没变，dirty 语义保持不变，
     * 用户可反复导出多个时间戳版本（每次点一下就是一个新文件）。
     *
     * @param {object} payload { points }——省略 points 时用内存 memTiming 的状态
     *   ★ v0.8.16：**已删掉 payload.mode 参数**（原审计 P3-7）。它自 v0.8.10 起就是死参数：
     *     前端一直传 mode:'redlines'，但函数内部恒用 'merge'，传什么都没用 →
     *     留着只会误导调用者以为可以切模式。现在前端也不再传了。
     */
    function exportTiming(payload = {}) {
        if (!beatmapPath || !beatmap) return { ok: false, error: '没有已载入的谱面' };
        if (!beatmap.ok) return { ok: false, error: '谱面解析失败，拒绝导出' };

        // 若调用方没给 points，就从内存 memTiming 取（拖动/列表编辑后的导出路径）。
        // ★ v0.8.10：一律走 'merge' 模式 —— 红线整体替换为编辑后的列表，
        //   且每条红线后派生一条绿线：SV = 基准BPM / 当前BPM（基准 = 第一条红线的 BPM），
        //   使 BPM 改变时流速保持不变（照搬主软件 utils/osuExport.ts）。
        //   原来的 'redlines' 模式只能改"磁盘已有红线"的 BPM，用户新增的、
        //   拖动过时间的红线在磁盘上找不到同时间点会被整个丢掉（导出只剩一两条的根因）。
        let points = Array.isArray(payload.points) ? payload.points : null;
        if (!points && memTiming && memTiming.redLines.length) {
            points = memTiming.redLines.map((r) => ({ time: r.time, bpm: r.bpm, meter: r.meter }));
        }

        const result = applyTimingToText(beatmap, { mode: 'merge', points });
        if (!result.ok) return { ok: false, error: result.error };

        // 导出目录（config.export.dir 为空则用 <数据根>\exports）
        const dir = getExportDir();
        try {
            fs.mkdirSync(dir, { recursive: true });
        } catch (e) {
            return { ok: false, error: '无法创建导出目录：' + e.message };
        }

        // 文件名 = 谱面标识 + 时间戳（年-月-日-时-分-秒）；同秒冲突加 -2/-3
        const base = safeExportName(beatmapLabel());
        const stamp = exportStamp();
        let name = `${base}-${stamp}.osu`;
        let target = path.join(dir, name);
        let n = 1;
        while (fs.existsSync(target)) {
            n++;
            name = `${base}-${stamp}-${n}.osu`;
            target = path.join(dir, name);
        }

        try {
            fs.writeFileSync(target, result.text, 'utf8');
        } catch (e) {
            return { ok: false, error: '导出写入失败: ' + e.message };
        }

        pushLog(
            `timing 已导出：${name}（红线 ${result.redCount} 条 / 绿线 ${result.greenCount} 条 / 共 ${result.total} 条）`
        );
        return {
            ok: true,
            path: target,
            name,
            dir,
            redCount: result.redCount,
            greenCount: result.greenCount,
            total: result.total
        };
    }

    // ---------------------------------------------------------------- 环境 ---
    function rescan() {
        probeEnv(true);
        syncBeatmap(true);
        pushLog(`重新探测：osu! 安装目录=${osuInstallDir || '未找到'}，Songs=${songsDir || '未找到'}`);
        return { installDir: osuInstallDir, songsDir };
    }

    /** 读取当前谱面的音频文件字节（供渲染进程 decodeAudioData 做频谱/声谱） */
    function readAudio() {
        const p = resolveAudioPath();
        if (!p) return null;
        try {
            return { ok: true, path: p, name: path.basename(p), size: fs.statSync(p).size, data: fs.readFileSync(p) };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    }

    async function init() {
        // tosu 端口自适应
        const found = await detectTosuPort(cfg.tosu.port);
        if (found && found !== tosuPort) {
            tosuPort = found;
            tosu.setPort(found);
            saveConfig({ tosu: { port: found } });
            pushLog(`自动识别到 tosu 端口 ${found}`);
        }
        probeEnv(true);
        backup.start();
        pushLog(`启动完成：osu! 目录=${osuInstallDir || '未找到'}，tosu=${tosuPort}`);
        return snapshot();
    }

    return {
        init,
        refresh,
        snapshot,
        backupNow,
        exportTiming,
        editTiming,
        resetMemTiming,
        rescan,
        readAudio,
        /** 强制重读 BPM 测速助手的设置（忽略缓存）—— 设置面板「重新读取」按钮用 */
        syncBpmSettings() {
            return readBpmSettings(true);
        },
        pushLog,
        get pollMs() {
            return loadConfig().tosu.pollMs;
        },
        get backupManager() {
            return backup;
        }
    };
}
