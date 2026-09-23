/* ============================================================================
   频谱声谱 + 变速段落 —— 合并窗口逻辑（v0.8.4）

   ★ 本窗口 = 原「频谱 / 声谱」窗口 + 原「红线 timing」窗口 合并成一个窗口：
       · 上半：频谱声谱（viz.js，四层画布：波形 / 声谱 / overlay / 播放头）
       · 下半 ①：变速段落选项卡 —— 每段一张卡片（拍索引 / BPM / 起始时间），
                  横向铺开、最底部一条左右滑条、向右无限收纳
       · 下半 ②：全局起始偏移（offset）· 变速段落编号（◀ n/N ▶）· 添加变速段落

   · 数据源：主进程 state.memTiming.redLines（多窗口共享的内存 timing）
     —— 时间单位是**毫秒**（osu 规范），交给 viz 前统一 ÷1000 转成秒。
   · 卡片输入 / 红线拖动 / 双击空白 → POST /api/timing/edit（主进程改内存，立即回传快照）
   · ①↔频谱双向联动：
       点频谱里的红线  → 选中它，并把 ① 的横向列表滚到对应卡片（高亮）
       点卡片         → 频谱里高亮那条红线
       双击卡片       → 频谱滚动到该红线居中（不改播放位置，对齐软件 v0.7.21）
       播放中         → ① 自动跟着播放头所在的段滚动（未手动选中时）
   · 快捷键（对齐软件）：
       Space 本地试听播放/暂停 · ←→ ±1s（Shift ±5s）· Alt+←→ 上/下一段
       +/− 缩放 · Ctrl+Z 撤销 · Ctrl+Shift+Z / Ctrl+Y 重做
       Ctrl+O 重新载入音频 · Ctrl+S 导出 timing（存时间戳文件） · Delete 删除选中段落
   ============================================================================ */
(function () {
    'use strict';
    const { $, post, startPoll, togglePin, saveCfg } = window.S;

    let last = null;
    let viz = null;
    let audioCtx = null;
    let audioBufKey = '';
    let decodedAudio = null;
    let audioLoading = false;
    let audioFailedKey = '';
    let loggedGeom = '';

    // ---- 本地试听（侧栏无法控制 osu! 播放，所以自己放一份音频）----
    const preview = { src: null, startedAt: 0, offset: 0, playing: false };

    // ---- 音频控制：音乐音量 / 音乐变速 / 节拍器音量 / 节拍器开关（标题栏那一条）----
    // 默认值与 src/config.mjs 的 DEFAULT_CONFIG.audio 保持一致；存 config.audio，重启保持
    const AU_DEFAULT = { musicVolume: 80, metroVolume: 60, metroOn: false, rate: 1 };
    let au = { ...AU_DEFAULT };
    let auInit = false;      // 是否已从 config 读过一次（首次读完后以本地为准）
    let musicGain = null;    // 音乐音量节点：src → musicGain → destination
    let metroGain = null;    // 节拍器音量节点：osc → metroGain → destination
    let metroTimer = null;   // 节拍器调度定时器（仅试听中运行）
    // 节拍器游标：按"内容时间"推进，跨段时跳到下一段的第 0 拍（那条红线本身）
    const metro = { secIdx: -1, beat: 0, nextAt: 0 };

    // osu! 播放位置是否在推进 —— 用于"制谱器一按播放，本窗口频谱就要跟随"
    let osuPrevTime = 0;
    let osuAdvancingUntil = 0;

    /* ==================== 跟随 osu! 的播放头平滑（v0.8.7）====================
     *
     * 【要解决的问题 —— 实测数据】
     *   跟着 osu! 走时，页面 rAF 有 179/s、_drawPlayhead 也画了 179 次/s，
     *   但其中只有 **10 次**画的是新位置（位置变化间隔中位 100ms、P95 200ms），
     *   单次位移中位 10.9px —— 肉眼看到的就是"一顿一顿 / 像被锁了帧"。
     *   也就是说：不是画不动，而是**没有新数据**。
     *
     * 【数据为什么这么慢】
     *   osu! 播放位置要经过两跳才到渲染进程：
     *     tosu 读内存（用户机器 POLL_RATE=150ms）→ 主进程轮询（pollMs=100ms）
     *   → 渲染进程看到的 time 天生就是 100~150ms 一跳的离散值。
     *   而"单独运行/本地试听"时时间是 WebAudio 时钟给的，天然连续 ——
     *   这正是用户观察到的"单独跑正常、跟随游戏就被限制"。
     *
     * 【办法】本地外推（时间平滑）
     *   把每个新样本当成锚点，样本之间用本地单调时钟按实测速率往前推。
     *   外推量封顶 EXTRAP_MAX（默认 150ms，≈一个轮询周期），所以：
     *     · 正常情况下推进量与真实时间 1:1 → 下一个样本几乎正好落在预测点上，
     *       不会出现"追上再往回跳"的抖动；
     *     · 一旦 osu! 暂停 / 卡住，外推不会跑飞（封顶 + 见 osuAdvancing() 兜底）。
     *
     * 【必须保留的原行为】暂停时不外推
     *   osu! 停止播放后 time 不再变化。若继续外推，播放头会一直往前飘。
     *   这里靠已有的 osuAdvancing()（最后一次变化后 600ms 内算在走）判断：
     *   判为"已停"就立刻回到 raw 值、并把速率清零。
     * ======================================================================= */
    // v0.8.7：是否在标题栏显示帧率诊断（config.visual.showFrameStat）
    let showFrameStat = false;

    const osuSmooth = {
        on: true,           // 总开关（config.visual.osuFollowSmooth）
        maxMs: 400,         // 外推封顶（config.visual.osuFollowExtrapMs）
        samples: [],        // ★ v0.8.8：最近若干个 { t, v }（t=到达时刻秒，v=原始时间秒）
        sps: 0,             // 样本到达间隔的指数平均（秒），用来定"外推封顶"该给多大
        rate: 0,            // 最小二乘拟合出的推进速率（秒/秒，正常播放 ≈ 1.00）
        raw: null,          // 最近一次拿到的原始 time（秒）
        lastAt: 0,          // 最近一次样本到达的本地时刻（秒）
        disp: 0,            // ★ v0.8.8：真正输出的"显示位置"（秒）—— 自己积分推进，见 PLL 说明
        lastFrame: 0        // 上一帧的本地时刻（秒），用来求帧间隔
    };

    /**
     * 用本地时钟把"离散的 osu! 时间"平滑成连续值。
     * @param {number} raw 本次从主进程拿到的原始播放位置（秒）
     * @param {number} now performance.now()
     */
    function smoothOsuTime(raw, now) {
        if (!osuSmooth.on) return raw;

        // ---------- ① 收样本进窗口（★ 不再重设位置） ----------
        const t = now / 1000;
        const S = osuSmooth.samples;
        if (osuSmooth.raw === null || Math.abs(raw - osuSmooth.raw) > 1e-9) {
            if (osuSmooth.raw !== null) {
                const dv = raw - osuSmooth.raw;
                const dtw = t - osuSmooth.lastAt;
                // 样本间隔 EMA（真实环境 ≈ tosu POLL_RATE = 0.15s），后面用来定外推封顶
                if (dtw > 0.005 && dtw < 2) {
                    osuSmooth.sps = osuSmooth.sps ? osuSmooth.sps * 0.7 + dtw * 0.3 : dtw;
                }
                // seek 判据（倒放 / 跳段 / 切谱）：这类大跳绝不能外推，窗口作废
                if (dv < 0 || dtw <= 0 || Math.abs(dv) > Math.max(0.4, dtw * 2.5)) S.length = 0;
            } else {
                S.length = 0;
            }
            S.push({ t, v: raw });
            if (S.length > 8) S.shift();
            osuSmooth.raw = raw;
            osuSmooth.lastAt = t;
        }

        // ---------- ② 最小二乘拟合 v = a·t + b ----------
        //   为什么不用单点 dv/dtWall：主进程 100ms 轮询与 tosu 150ms 更新不同步，
        //   样本到达间隔在 0.1/0.2s 之间跳，单点估出的速率在 0.75~1.5 之间乱跳 ——
        //   v0.8.7 每 0.15s 就把位置拽回一次，实测 20.2 次/秒回退，正是"一抽一抽"。
        //   8 个点一起拟合，抖动被平均掉，a 稳定在 1.00 附近。
        let a = osuSmooth.rate, b = null;
        if (S.length >= 3) {
            let n = 0, st = 0, sv = 0, stt = 0, stv = 0;
            for (const s of S) { n++; st += s.t; sv += s.v; stt += s.t * s.t; stv += s.t * s.v; }
            const den = n * stt - st * st;
            if (Math.abs(den) > 1e-9) {
                a = (n * stv - st * sv) / den;
                b = (sv - a * st) / n;
            }
        }
        // 离谱估值（样本太少 / 时刻几乎重合）→ 沿用上一次速率，别把播放头带飞
        if (!Number.isFinite(a) || a < 0 || a > 2.2) a = osuSmooth.rate;
        osuSmooth.rate = a;
        if (b === null) { osuSmooth.disp = raw; osuSmooth.lastFrame = t; return raw; }

        // ---------- ③ 目标位置 = 回归线外推；样本断太久就冻结 ----------
        //   封顶取 max(配置值, 3×样本间隔)：tosu 150ms 抖动到 300ms 都算"还没到"，
        //   不该冻结（v0.8.7 固定 200ms 封顶，而实测最大样本间隔 212ms → 会误冻一下再跳）
        // 0（或没配置）→ 用自动值 = 3×实测样本间隔
        const capMs = Number.isFinite(osuSmooth.maxMs) && osuSmooth.maxMs > 0 ? osuSmooth.maxMs : 0;
        const capS = Math.max(capMs / 1000, osuSmooth.sps * 3);
        const tEff = Math.min(t, osuSmooth.lastAt + capS);
        const target = b + a * tEff;

        // ---------- ④ PLL：disp 自己走，再用 target 缓慢校正相位 ----------
        //   位置不再被样本"重设"，所以永远不会因为外推超前而倒退；
        //   小误差只表现为轻微加减速（时间常数 120ms），肉眼看不出来。
        const dt = Math.min(0.1, Math.max(0, t - osuSmooth.lastFrame));
        osuSmooth.lastFrame = t;
        osuSmooth.disp += a * dt;
        const err = target - osuSmooth.disp;
        if (Math.abs(err) > 0.25) {
            osuSmooth.disp = target;            // 大误差 = seek / 切谱 → 直接吸附
        } else {
            osuSmooth.disp += err * Math.min(1, dt / 0.12);
        }
        return osuSmooth.disp;
    }

    /** osu! 停了 / 切到别的时间基准时，把平滑器复位（避免下次跟随从旧锚点开始） */
    function resetOsuSmooth() {
        osuSmooth.samples.length = 0;
        osuSmooth.raw = null;
        osuSmooth.rate = 0;
        osuSmooth.sps = 0;
        osuSmooth.lastAt = 0;
        osuSmooth.lastFrame = 0;
    }

    // ---- 撤销/重做（快照 = 内存红线数组）----
    // ★ v0.8.10 修正「Ctrl+Z 存太多、快捷键用不了」：
    //   旧实现只在"快照签名相同 + 400ms"时才合并。可**拖动红线时每一次移动都会改状态**，
    //   签名次次不同 → 一次 2 秒的拖动能塞进上百步；期间红线被拖到"盖住下一段"的
    //   中间状态也各记一步。结果：Ctrl+Z 一次只退回几毫秒的位移（看着像没反应），
    //   要按几十次才回到拖动前，栈里还全是无效状态。
    //   修法：按**动作 key** 合并（同一条红线的连续拖动 / 同一个输入框的连续改值
    //   = 一步），滑动窗口 600ms；再叠一层"与栈顶相同就丢弃"（杜绝空步）。
    const undoStack = [];
    const redoStack = [];
    const UNDO_LIMIT = 50;      // 最多存 50 步（旧版 200，绝大多数是无效中间态）
    const UNDO_MERGE_MS = 600;  // 同一动作在这个窗口内继续发生 → 合并成一步
    let lastUndoAt = 0;
    let lastUndoKey = '';

    // ---- ① 变速段落卡片状态 ----
    let cardEls = [];        // 卡片 DOM 列表（下标 = 段落下标）
    let cardsSig = '';       // 卡片 DOM 的重建签名（数据没变就不重建，避免打断输入）
    let selectedIdx = -1;    // 当前选中的段落（与频谱里高亮的红线同步）
    let lastCurIdx = -2;     // 上一轮"播放头所在段"
    let lastSelIdx = -2;     // 上一轮"选中段"
    let lastFollowIdx = -2;  // 上一轮自动跟随滚过的段

    // 自动翻页开关的本地覆盖：刚点完的一小段时间内以本地为准。
    // 原因：config 是**异步落盘**的，刚点完时下一轮轮询可能还拿到旧值，
    // 会把这个开关弹回去（看起来像"点了没反应"）。{ on, until }
    let afOverride = null;

    const HINT_DEFAULT = '点/双击频谱红线 → 跳到对应段落卡片 · 双击卡片 → 频谱居中';

    // 置顶按钮（点击切换；高亮状态由 state.js 轮询主进程真实状态回显）
    $('btn-pin').addEventListener('click', () => {
        togglePin('viz');
    });

    /* ======================= 本地试听 ======================= */

    function stopPreview() {
        if (preview.src) {
            try { preview.src.onended = null; preview.src.stop(); } catch { /* 已停 */ }
            try { preview.src.disconnect(); } catch { /* 已断开 */ }
            preview.src = null;
        }
        preview.playing = false;
        stopMetro(); // 音乐停了节拍器也停
    }

    function previewNow() {
        if (!preview.playing || !audioCtx) return preview.offset;
        // ★ 必须乘 au.rate：playbackRate 改过之后，内容时间推进速度随之变化。
        //   不乘的话"变速播放时，播放头位置与标题栏时间显示会整体跑偏"。
        return preview.offset + (audioCtx.currentTime - preview.startedAt) * au.rate;
    }

    /** 建/更新音频节点图。音乐走 musicGain、节拍器走 metroGain，各自独立音量 */
    function ensureAudioGraph() {
        if (!audioCtx) return;
        if (!musicGain) {
            musicGain = audioCtx.createGain();
            musicGain.connect(audioCtx.destination);
        }
        if (!metroGain) {
            metroGain = audioCtx.createGain();
            metroGain.connect(audioCtx.destination);
        }
        musicGain.gain.value = au.musicVolume / 100;
        metroGain.gain.value = au.metroVolume / 100;
    }

    function startPreview(atSec) {
        if (!decodedAudio || !audioCtx) return;
        stopPreview();
        if (audioCtx.state === 'suspended') audioCtx.resume();
        ensureAudioGraph();
        const dur = decodedAudio.duration;
        const off = Math.max(0, Math.min(atSec, Math.max(0, dur - 0.02)));
        const src = audioCtx.createBufferSource();
        src.buffer = decodedAudio;
        // ★ 变速不变调：playbackRate 只改速度，preservesPitch 保持音高
        //   （Chromium 里 preservesPitch 默认就是 true，显式写出来表明意图）
        src.playbackRate.value = au.rate;
        src.preservesPitch = true;
        src.connect(musicGain);
        src.start(0, off);
        preview.src = src;
        preview.offset = off;
        preview.startedAt = audioCtx.currentTime;
        preview.playing = true;
        src.onended = () => {
            if (preview.src === src) { preview.src = null; preview.playing = false; stopMetro(); }
        };
        // 节拍器跟着这次播放重新对齐拍点
        metroSeek(off);
        if (au.metroOn) startMetro();
        flashHint(`本地试听中 @ ${fmtSec(off)}（${au.rate}× · 空格暂停）`);
    }

    function togglePreview() {
        if (!decodedAudio) { flashHint('还没载入音频'); return; }
        if (preview.playing) { stopPreview(); flashHint('试听已暂停'); }
        else startPreview(currentTime());
    }

    /**
     * 当前"侧栏时间基准"：
     *   ① 本地试听中  → 试听内容时间（自己放的那份音乐）
     *   ② osu! 正在走 → **一律跟随 osu!**（制谱器一按播放，频谱/播放头必须跟上）
     *   ③ 其余情况    → 本地定位点（用户用 ←→ 或点时间轴定位过）
     *
     * ★ 第 ② 条修的就是"制谱器开始播放时小窗频谱没有跟随"：
     *   原实现只要 preview.offset > 0 就永远返回它，于是"按过一次 ←→ 之后，
     *   制谱器再按播放，侧栏频谱就再也不跟随了"（offset 是静态值，永远不会变）。
     */
    function currentTime() {
        if (preview.playing) return previewNow();
        if (!osuAdvancing() && preview.offset > 0) return preview.offset;
        const raw = last && last.player ? last.player.time : 0;
        // ★ v0.8.7：跟随 osu! 时把 100~150ms 一跳的离散时间**平滑成连续时间**。
        //   为什么必须平滑：数据两跳（tosu POLL_RATE + 主进程 pollMs）都是 100ms 量级，
        //   直接返回 raw 会让播放头每秒只前进 10 次（实测），看着就是"锁帧"。
        //   osu! 已停 → 直接给 raw，并把平滑器复位（否则播放头会按旧速率一直往前飘）。
        // ★ v0.8.8：不再"一停就直接返回 raw" —— 那样会在 osuAdvancing 的 600ms
        //   判定边界上把平滑外推的位置**猛地拽回** raw（又是一次可见回退）。
        //   现在交给平滑器自己处理：样本断了 → 目标冻结 → disp 平滑收敛停住，
        //   全程不倒车；真的切了谱面 / 换了时间基准才显式 resetOsuSmooth()。
        return smoothOsuTime(raw, performance.now());
    }

    /** osu! 的播放位置是否正在推进（600ms 内动过就算"在走"） */
    function osuAdvancing() {
        return Date.now() < osuAdvancingUntil;
    }

    function fmtSec(sec) {
        const s = Math.max(0, sec);
        const m = Math.floor(s / 60);
        return `${m}:${(s % 60).toFixed(2).padStart(5, '0')}`;
    }

    /** 标题栏时间显示用的格式：分:秒.毫秒（例 1:23.456） */
    function fmtTimeMs(sec) {
        const s = Math.max(0, sec);
        const m = Math.floor(s / 60);
        return `${m}:${(s % 60).toFixed(3).padStart(6, '0')}`;
    }

    /* ======================= 节拍器 ======================= */

    /** 当前红线（单位毫秒）—— 节拍器按它排拍 */
    function metroReds() {
        return last && last.memTiming && last.memTiming.redLines ? last.memTiming.redLines : [];
    }

    function stopMetro() {
        if (metroTimer) { clearInterval(metroTimer); metroTimer = null; }
        metro.secIdx = -1;
        metro.beat = 0;
        metro.nextAt = 0;
    }

    /** 把游标对齐到"内容时间 tc 之后的下一个拍点" */
    function metroSeek(tc) {
        const reds = metroReds();
        metro.secIdx = -1;
        metro.beat = 0;
        metro.nextAt = 0;
        if (!reds.length) return;
        let i = 0;
        for (let k = 0; k < reds.length; k++) {
            if (reds[k].time / 1000 <= tc + 1e-6) i = k;
            else break;
        }
        metro.secIdx = i;
        const cur = reds[i];
        const t0 = cur.time / 1000;
        const beatLen = 60 / (cur.bpm || 120);
        metro.beat = Math.max(0, Math.ceil((tc - t0) / beatLen - 1e-6));
        metro.nextAt = t0 + metro.beat * beatLen;
    }

    /** 游标前进一个拍；跨段时切到下一段的第 0 拍（即那条红线本身） */
    function metroAdvance() {
        const reds = metroReds();
        const cur = reds[metro.secIdx];
        if (!cur) return false;
        const beatLen = 60 / (cur.bpm || 120);
        metro.beat += 1;
        let t = cur.time / 1000 + metro.beat * beatLen;
        const next = reds[metro.secIdx + 1];
        if (next && t >= next.time / 1000 - 1e-6) {
            metro.secIdx += 1;
            metro.beat = 0;
            t = next.time / 1000;
        }
        metro.nextAt = t;
        return true;
    }

    /** 排一声"嗒"：重拍（每小节第一拍/段落起点）用更高更响的音 */
    function metroClick(when, accent) {
        if (!audioCtx || !metroGain) return;
        const osc = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        osc.type = 'square';
        osc.frequency.value = accent ? 1720 : 1180;
        // 指数斜坡不能从 0 起，用 1e-4 近似静音
        g.gain.setValueAtTime(0.0001, when);
        g.gain.exponentialRampToValueAtTime(accent ? 1 : 0.55, when + 0.001);
        g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
        osc.connect(g);
        g.connect(metroGain);
        osc.start(when);
        osc.stop(when + 0.06);
    }

    /**
     * 调度心跳（30ms 一次）：向 audioCtx 预排 250ms 听感时间内的拍点。
     * 先在"内容时间"轴上推进，再按 au.rate 折算成听感时间 —— 变速播放也能对上拍。
     */
    function metroTick() {
        if (!au.metroOn || !audioCtx || !preview.playing) return;
        const reds = metroReds();
        if (!reds.length) return;
        const tc = previewNow();
        // 游标明显落后（改过变速/跳过）→ 重新对齐
        if (metro.nextAt < tc - 0.5) metroSeek(tc);
        let guard = 0;
        while (metro.nextAt < tc + 0.25 * au.rate && guard++ < 64) {
            const sec = reds[metro.secIdx];
            const meter = Math.max(1, sec && sec.meter ? Number(sec.meter) : 4);
            const when = audioCtx.currentTime + (metro.nextAt - tc) / au.rate;
            if (when >= audioCtx.currentTime) metroClick(when, metro.beat % meter === 0);
            if (!metroAdvance()) break;
        }
    }

    function startMetro() {
        if (metroTimer) return;
        metroTimer = setInterval(metroTick, 30);
    }

    /* ======================= 撤销 / 重做 ======================= */

    function snapshotOf(s) {
        if (!s || !s.memTiming || !s.memTiming.redLines) return null;
        return s.memTiming.redLines.map((r) => ({ time: r.time, bpm: r.bpm, meter: r.meter }));
    }

    const snapSig = (arr) => arr.map((r) => r.time + ':' + r.bpm).join('|');

    /**
     * 记一步撤销点。
     * @param {string} [key] 动作标识（如 'redline:3' / 'bpm:2' / 'offset'）。
     *   同一个 key 在 UNDO_MERGE_MS 内重复发生 → 合并成一步（保留这一串动作的**第一个**快照，
     *   也就是动作开始前的状态）。传空/null 表示"永远单独记一步"（添加/删除这类离散动作）。
     */
    function pushUndo(key) {
        const snap = snapshotOf(last);
        if (!snap) return;
        const sig = snapSig(snap);

        // ① 与栈顶一样 → 这一步不会产生任何可见变化，直接丢弃（杜绝"按了没反应"的空步）
        const top = undoStack[undoStack.length - 1];
        if (top && snapSig(top) === sig) return;

        // ② 同一动作的连续发生（拖红线 / 连着改同一个输入框）→ 合并，只保留最早的快照
        const now = Date.now();
        if (key && key === lastUndoKey && now - lastUndoAt < UNDO_MERGE_MS) {
            lastUndoAt = now; // 滑动窗口：一直在动就一直算同一步
            return;
        }

        undoStack.push(snap);
        if (undoStack.length > UNDO_LIMIT) undoStack.shift();
        redoStack.length = 0;
        lastUndoKey = key || '';
        lastUndoAt = now;
    }

    /** 一次动作彻底结束（撤销/重做/切谱）后清掉合并上下文，避免跨动作被误合并 */
    function resetUndoMerge() {
        lastUndoKey = '';
        lastUndoAt = 0;
    }

    function doUndo() {
        if (!undoStack.length) { flashHint('没有可撤销的操作'); return; }
        const cur = snapshotOf(last);
        const prev = undoStack.pop();
        if (cur) redoStack.push(cur);
        resetUndoMerge();
        post('/api/timing/edit', { type: 'replace', redLines: prev }).then(() => {
            flashHint(`已撤销（还可撤销 ${undoStack.length} 步）`);
        });
    }

    function doRedo() {
        if (!redoStack.length) { flashHint('没有可重做的操作'); return; }
        const cur = snapshotOf(last);
        const next = redoStack.pop();
        if (cur) undoStack.push(cur);
        resetUndoMerge();
        post('/api/timing/edit', { type: 'replace', redLines: next }).then(() => {
            flashHint(`已重做（还可重做 ${redoStack.length} 步）`);
        });
    }

    /* ======================= 音频载入 ======================= */

    async function loadAudioIfNeeded(bm, force) {
        const path = bm && bm.audioPath ? bm.audioPath : '';
        if (!path) {
            if (decodedAudio) {
                decodedAudio = null;
                audioBufKey = '';
                audioFailedKey = '';
                stopPreview();
                viz.clearAudio();
                $('viz-status').textContent = (window.I18N ? window.I18N.t('noAudio') : '无音频');
            }
            return;
        }
        if (force) { audioBufKey = ''; audioFailedKey = ''; }
        if (audioBufKey === path) return;
        if (audioFailedKey === path) return;
        if (audioLoading) return;
        audioLoading = true;
        $('viz-status').textContent = (window.I18N ? window.I18N.t('decoding') : '解码中…');
        try {
            const r = await fetch('/api/audio', { cache: 'no-store' });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const buf = await r.arrayBuffer();
            if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const decoded = await audioCtx.decodeAudioData(buf.slice(0));
            decodedAudio = decoded;
            audioBufKey = path;
            audioFailedKey = '';
            stopPreview();
            viz.setAudio(decoded, path);
            $('viz-status').textContent = bm.audioName || (window.I18N ? window.I18N.t('loaded') : '已载入');
        } catch (e) {
            audioFailedKey = path;
            $('viz-status').textContent = (window.I18N ? window.I18N.t('decodeFailed') : '解码失败');
        } finally {
            audioLoading = false;
        }
    }

    /** 把 config.visual 的所有可视化项同步给 viz（键名与 config 一一对应） */
    function applyVisual(cfgVisual) {
        const v = cfgVisual || {};
        viz.setVisual({
            fftSize: v.fftSize,
            sensitivity: v.sensitivity,
            palette: v.palette,
            custom: v.custom,
            logBase: v.logBase,
            peakThreshold: v.peakThreshold,
            peakColor: v.peakColor,
            invert: v.invert,
            waveColor: v.waveColor,
            renderScale: v.renderScale,
            beatLineDelayMs: v.beatLineDelayMs,
            showWaveform: v.showWaveform,
            showSpectrogram: v.showSpectrogram,
            // v0.8.7：rAF 停摆时的保底帧率（33=30fps / 60 / 120 / -1=跟随屏幕刷新率）
            fallbackFps: v.fallbackFps,
            autoFollow: afOverride && Date.now() < afOverride.until ? afOverride.on : v.autoFollow
        });

        // ---- v0.8.7：跟随 osu! 的播放头平滑参数（不经过 viz，直接更新本地平滑器）----
        //   默认开：数据本身就是 100~150ms 一跳，不平滑必然一顿一顿。
        osuSmooth.on = v.osuFollowSmooth !== false;
        const em = Number(v.osuFollowExtrapMs);
        osuSmooth.maxMs = Number.isFinite(em) ? Math.max(0, Math.min(400, em)) : 200;
        if (!osuSmooth.on) resetOsuSmooth();
        // 帧率诊断开关（默认关；排障时打开，能一眼看出是不是 rAF 停摆）
        showFrameStat = v.showFrameStat === true;
    }

    function initViz() {
        if (viz) return;
        viz = new window.Viz({
            container: $('viz-container'),
            getState: () => {
                const t = currentTime();
                // 主进程下发的 memTiming（多窗口共享的编辑状态）
                const reds = last && last.memTiming ? last.memTiming.redLines : [];
                // ★ osu 的 timing 时间是毫秒，viz 内部统一用秒
                const timingPoints = reds.map((r) => ({
                    time: r.time / 1000,
                    bpm: r.bpm,
                    beatLength: r.beatLength,
                    meter: r.meter,
                    uninherited: true
                }));
                const duration = last && last.player.audioLength ? last.player.audioLength / 1000 : 0;
                return { time: t, duration, timingPoints };
            },
            onEditTiming: handleEdit,
            // 频谱里选中/拖动红线 → 同步到 ① 的卡片
            onSelect: onVizSelect
        });
        applyVisual(last && last.config ? last.config.visual : null);

        const measure = () => {
            const c = $('viz-container');
            const r = c.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
                viz.setSize(r.width, r.height);
                // 只打一次几何日志，方便排查"哪一层多大"（排障用，不刷屏）
                const key = `${viz.width}x${viz.height}`;
                if (loggedGeom !== key) {
                    loggedGeom = key;
                    console.log(
                        `[viz] 容器 ${viz.width}x${viz.height} / 波形层 ${viz.waveHeight}px / 声谱层 ${viz.specHeight}px(top=${viz.specTop}) / 时间轴 ${viz.height - viz.contentBottom}px / dpr=${viz._dpr()}`
                    );
                }
            }
        };
        measure();
        if (window.ResizeObserver) {
            new ResizeObserver(measure).observe($('viz-container'));
        } else {
            window.addEventListener('resize', measure);
        }
        viz.refresh();
        viz.start();
        // 调试/自动化测试用的把手（只读引用，不影响任何逻辑）
        // ui_contract 与实机 CDP 测试靠它拿到真实 Viz 实例做断言
        window.__vizDebug = viz;
    }

    /* ======================= 编辑动作 ======================= */

    /** 统一的编辑请求：成功后立刻把主进程回传的权威红线刷回本窗口 */
    function postEdit(body, okMsg) {
        return post('/api/timing/edit', body).then((r) => {
            if (r && r.ok && r.redLines) {
                if (last && last.memTiming) last.memTiming.redLines = r.redLines;
                // 主进程可能重排/归一化过 → 强制重建卡片
                cardsSig = '';
                if (viz) viz.refresh();
                renderSections();
                if (okMsg) flashHint(okMsg);
            } else if (r && !r.ok) {
                flashHint(r.error || '编辑失败');
                cardsSig = '';
                renderSections();
            }
            return r;
        });
    }

    // 红线拖动/双击空白 → 主进程内存编辑（本地跟手由 viz 内部处理）
    function handleEdit(edit) {
        if (edit.type === 'seek') {
            // 侧栏控制不了 osu! 播放 → 当作"设置本地起播点"
            preview.offset = Math.max(0, edit.time || 0);
            return;
        }
        // 拖红线 / 拖蓝线（改 BPM）会连续触发几十次编辑 → 按「类型+下标」合并成一步撤销。
        // 添加/删除是离散动作，传空 key → 各记一步，不合并。
        const mergeKey =
            edit.type === 'add' || edit.type === 'delete'
                ? ''
                : edit.type + ':' + (edit.redIndex === undefined ? '' : edit.redIndex);
        pushUndo(mergeKey); // 任何一次编辑动作前记一步撤销点
        postEdit({
            type: edit.type,
            offsetMs: edit.offsetMs,
            redIndex: edit.redIndex,
            timeMs: edit.timeMs,
            bpm: edit.bpm
        });
    }

    /* ======================= ① 变速段落卡片 ======================= */

    function flashHint(msg) {
        const el = $('sec-note');
        if (!el) return;
        el.textContent = msg;
        el.dataset.flash = '1';
        clearTimeout(flashHint._t);
        flashHint._t = setTimeout(() => {
            el.dataset.flash = '';
            el.textContent = HINT_DEFAULT;
        }, 2400);
    }

    /** 一段 → 一张卡片（横向排列；拍索引 / BPM / 起始时间 都能就地改） */
    function cardHtml(sec) {
        const i = sec.index;
        const title = '单击=选中并在频谱里高亮 · 双击=频谱滚到这条红线居中';
        return `<div class="sec-card${sec.anchor ? ' anchor' : ''}" data-i="${i}" title="${title}">
            <div class="sc-top">
                <span class="sc-no">${sec.anchor ? '起点锚点' : '#' + (i + 1)}</span>
                <span class="sc-beat">拍 ${sec.beatIndex} · 拍号 <input class="f-meter" type="number" step="1" min="1" max="7" value="${sec.meter}" title="拍号（每小节几拍，1~7，分母固定为 4 分音符）" />/4</span>
                ${sec.anchor ? '' : '<button class="sc-del" title="删除这个变速段落">✕</button>'}
            </div>
            <div class="sc-f">
                <span>拍索引</span>
                <input class="f-beat" type="number" step="1" min="1" value="${sec.beatIndex}"
                    ${sec.anchor
                        ? 'disabled title="起点锚点的拍索引固定为 0（它由全局 offset 决定）"'
                        : 'title="改拍索引 → 按上一段的 BPM 把这条红线推到对应的那一拍上"'} />
                <span>BPM</span>
                <input class="f-bpm" type="number" step="0.01" min="1" value="${Number(sec.bpm).toFixed(2)}"
                    title="BPM 只决定它下方蓝线（节拍线）的间距，不决定下一条红线位置" />
                <span>起始时间</span>
                <input class="f-time" type="number" step="0.001" min="0" value="${sec.time.toFixed(3)}"
                    title="${sec.anchor ? '起点锚点的时间就是全局 offset（与右侧 ② 同一个值）' : '直接写这条红线的绝对时间戳（秒）'}" />
            </div>
        </div>`;
    }

    function buildCards(secs) {
        const strip = $('sec-strip');
        if (!secs.length) {
            strip.innerHTML = '<div class="empty">暂无数据</div>';
            cardEls = [];
            return;
        }
        strip.innerHTML = secs.map(cardHtml).join('');
        cardEls = Array.prototype.slice.call(strip.querySelectorAll('.sec-card'));
        for (const el of cardEls) bindCard(el, Number(el.dataset.i));
    }

    function bindCard(el, i) {
        // 卡片内输入框：不要冒泡（否则会触发卡片单击选中 / 全局快捷键）
        for (const inp of el.querySelectorAll('input')) {
            inp.addEventListener('click', (e) => e.stopPropagation());
            inp.addEventListener('dblclick', (e) => e.stopPropagation());
            inp.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') e.target.blur();
                e.stopPropagation();
            });
        }
        const beat = el.querySelector('.f-beat');
        if (beat && !beat.disabled) beat.addEventListener('change', () => editBeatIndex(i, Number(beat.value)));
        const bpm = el.querySelector('.f-bpm');
        bpm.addEventListener('change', () => editBpm(i, Number(bpm.value)));
        const time = el.querySelector('.f-time');
        time.addEventListener('change', () => editTime(i, Number(time.value)));
        const meter = el.querySelector('.f-meter');
        if (meter) meter.addEventListener('change', () => editMeter(i, Number(meter.value)));

        const del = el.querySelector('.sc-del');
        if (del) del.addEventListener('click', (e) => { e.stopPropagation(); deleteSection(i); });

        el.addEventListener('click', (e) => {
            if (e.target.closest('input') || e.target.closest('.sc-del')) return;
            if (viz) viz.selectRed(i);           // 频谱里高亮这条红线（onSelect 会回灌状态）
            else onVizSelect(i);
        });
        el.addEventListener('dblclick', (e) => {
            if (e.target.closest('input') || e.target.closest('.sc-del')) return;
            if (viz) viz.jumpToRed(i);           // 频谱滚动到该红线居中（不改播放位置）
            flashHint(`频谱已跳到${i === 0 ? '起点锚点' : '第 ' + (i + 1) + ' 段'}`);
        });
    }

    /** 把第 i 张卡片滚到可视区中间（横向滑条联动） */
    function scrollCardIntoView(i, behavior) {
        const strip = $('sec-strip');
        const el = cardEls[i];
        if (!strip || !el) return;
        const cr = el.getBoundingClientRect();
        const sr = strip.getBoundingClientRect();
        // 卡片中心 与 视区中心 的差值（用 rect 算，避免 offsetParent 依赖）
        const delta = cr.left - sr.left - (sr.width - cr.width) / 2;
        const target = Math.max(0, strip.scrollLeft + delta);
        if (Math.abs(delta) < 2) return;    // 已经居中，别白滚
        if (behavior === 'smooth') strip.scrollTo({ left: target, behavior: 'smooth' });
        else strip.scrollLeft = target;
    }

    /** 当前"播放头所在段"下标（时间基准 = 试听位置 / osu! 播放头） */
    function curSectionIndex(secs) {
        const t = currentTime();
        let idx = -1;
        for (let i = 0; i < secs.length; i++) {
            if (secs[i].time <= t + 1e-6) idx = i; else break;
        }
        return idx;
    }

    /**
     * 标题栏的"当前 BPM"（v0.8.8）：播放头落在哪条红线之后，就显示那一段的 BPM。
     * 没有数据 / 播放头还没走到第一条红线 → 显示 "—"。
     */
    function updateTitleBpm(secs) {
        const el = $('pt-bpm');
        if (!el) return;
        const cur = curSectionIndex(secs);
        el.textContent = cur >= 0 ? Number(secs[cur].bpm).toFixed(2) : '—';
    }

    /** 每轮轮询：重建/刷新卡片、② 区数字、标题栏 BPM */
    function renderSections() {
        if (!viz) return;
        const secs = viz.getSections();

        // ① 卡片：数据变了才重建（签名里不含"选中态"，避免点一下卡片就把 DOM 重建掉）
        const sig = (last && last.memTiming && last.memTiming.path ? last.memTiming.path : '') +
            '|' + secs.map((s) => `${s.time.toFixed(3)}:${s.bpm}:${s.beatIndex}:${s.meter}`).join('|');
        if (sig !== cardsSig) {
            cardsSig = sig;
            buildCards(secs);
            lastCurIdx = -2;
            lastSelIdx = -2;
        }
        $('sec-count').textContent = secs.length;

        updateTitleBpm(secs);
        updateCardStates(secs);
        updateSideZone(secs);
        updateOffsetInput(secs);

        // ★ v0.8.8：取消"卡片随播放头自动切换 / 自动横向滚动"。
        //   用户反馈：跟随谱面播放时卡片会自己滑来滑去并不断变换高亮，干扰编辑。
        //   现在只保留手动交互：单击卡片=选中、双击卡片=频谱居中、Alt+←→=上/下一段。
        //   （scrollCardIntoView / lastFollowIdx 保留未删，将来若要恢复自动跟随可直接接回）
    }

    function updateCardStates(secs) {
        // ★ v0.8.8：不再计算"播放头所在段"，也不再给它加高亮（.cur）——
        //   那同样是一种"跟随切换"：卡片会随播放不停变换高亮。
        //   现在只有用户手动选中的高亮（.sel）。
        if (selectedIdx === lastSelIdx) return;
        lastSelIdx = selectedIdx;
        cardEls.forEach((el, i) => {
            el.classList.toggle('sel', i === selectedIdx);
            el.classList.remove('cur');
        });
    }

    /** ② 区的段落编号 + 删除按钮可用性 */
    function updateSideZone(secs) {
        const has = selectedIdx >= 0 && selectedIdx < secs.length;
        $('sz-idx').textContent = (has ? selectedIdx + 1 : '—') + ' / ' + secs.length;
        $('sz-del').disabled = !(has && selectedIdx > 0);
    }

    /** ② 区的全局 offset（= 第一条红线的时间）；正在输入时不覆盖 */
    function updateOffsetInput(secs) {
        const inp = $('sz-offset');
        if (document.activeElement === inp) return;
        inp.disabled = !secs.length;
        inp.value = secs.length ? secs[0].time.toFixed(3) : '';
    }

    /* ---------------- 卡片编辑动作 ---------------- */

    function editTime(i, v) {
        if (!Number.isFinite(v) || v < 0) { cardsSig = ''; renderSections(); return; }
        pushUndo('time:' + i); // 同一个输入框连续改 → 合并成一步
        if (i === 0) {
            // 第一条红线的时间 = 全局 Offset → 整体平移
            postEdit({ type: 'offset', offsetMs: Math.round(v * 1000) }, `全局偏移 → ${v.toFixed(3)}s`);
        } else {
            postEdit({ type: 'redline', redIndex: i, timeMs: Math.round(v * 1000) }, `第 ${i + 1} 段 → ${v.toFixed(3)}s`);
        }
    }

    function editBpm(i, v) {
        if (!Number.isFinite(v) || v <= 0) { cardsSig = ''; renderSections(); return; }
        pushUndo('bpm:' + i); // 同一个输入框连续改 → 合并成一步
        postEdit({ type: 'bpm', redIndex: i, bpm: v }, `第 ${i + 1} 段 BPM → ${Number(v).toFixed(2)}`);
    }

    /**
     * 改拍索引 → 按**上一段**的 BPM 把这条红线推到对应那一拍
     * （与软件 handleUpdatePoint('beatIndex') 同一套算法：
     *   newTime = 上一段时间 + Δ拍数 × 上一段拍长，Δ拍数 = 目标拍索引 − 上一段拍索引）
     */
    function editBeatIndex(i, v) {
        const secs = viz ? viz.getSections() : [];
        const prev = secs[i - 1];
        const cur = secs[i];
        if (!prev || !cur) return;
        const beatLen = 60 / (prev.bpm || 120);
        const next = secs[i + 1];
        let delta = Math.round(v - prev.beatIndex);
        if (!Number.isFinite(delta) || delta < 1) {
            flashHint('拍索引至少要落在上一段之后 1 拍');
            cardsSig = '';
            renderSections();
            return;
        }
        // 不能越过下一条红线（否则排序后这条会跑到别人后面去）
        if (next) {
            const maxDelta = Math.max(1, Math.ceil((next.time - prev.time) / beatLen) - 1);
            if (delta > maxDelta) {
                delta = maxDelta;
                flashHint(`拍索引最多只能到 ${prev.beatIndex + maxDelta}（不能越过下一段）`);
            }
        }
        const t = prev.time + delta * beatLen;
        pushUndo('beat:' + i); // 同一个输入框连续改 → 合并成一步
        postEdit({ type: 'redline', redIndex: i, timeMs: Math.round(t * 1000) }, `第 ${i + 1} 段 → 拍索引 ${prev.beatIndex + delta}`)
            .then((r) => {
                // 推到新位置后，让视图跟着滚过去，看得见结果
                if (r && r.ok && viz) {
                    const k = viz.getSections().findIndex((s) => Math.abs(s.time - t) < 0.002);
                    if (k >= 0) viz.selectRed(k, { jump: true });
                }
            });
    }

    function deleteSection(i) {
        if (i === 0) { flashHint('起点锚点不能删除（它是全局 offset）'); return; }
        const secs = viz ? viz.getSections() : [];
        const s = secs[i];
        pushUndo(''); // 删除是离散动作 → 每次单独一步，不合并
        postEdit({ type: 'delete', redIndex: i }, `已删除 ${s ? fmtSec(s.time) : ''} 处的变速段落`);
    }

    /**
     * ★ v0.8.17：改拍号（meter）—— 每小节几拍（4 = 4/4、3 = 3/4）。
     * 只影响小节线分组与节拍器重音，**不改变红线位置**（红线位置仍由 time 决定）。
     */
    function editMeter(i, v) {
        const m = Math.round(Number(v));
        if (!Number.isFinite(m) || m < 1 || m > 7) {
            flashHint('拍号需为 1~7 的整数（与 osu! 一致，最大 7/4 拍）');
            cardsSig = '';
            renderSections();
            return;
        }
        pushUndo('meter:' + i); // 同一个输入框连续改 → 合并成一步
        postEdit({ type: 'meter', redIndex: i, meter: m }, `第 ${i + 1} 段拍号 → ${m}/${m}`);
    }

    function addSection() {
        const t = Math.max(0, currentTime());
        pushUndo(''); // 添加是离散动作 → 每次单独一步，不合并
        postEdit({ type: 'add', timeMs: Math.round(t * 1000) }, `已在 ${fmtSec(t)} 添加变速段落`);
    }

    /** 上/下一个变速段落（② 的 ◀ ▶） */
    function stepSection(delta) {
        const secs = viz ? viz.getSections() : [];
        if (!secs.length) return;
        let i = selectedIdx >= 0 ? selectedIdx + delta : (delta > 0 ? 0 : secs.length - 1);
        i = Math.max(0, Math.min(secs.length - 1, i));
        if (viz) viz.selectRed(i, { jump: true });
        else onVizSelect(i);
    }

    /* ---------------- 频谱 → 卡片（viz 回调） ---------------- */

    function onVizSelect(i) {
        selectedIdx = i;
        if (!viz) return;
        const secs = viz.getSections();
        updateCardStates(secs);
        updateSideZone(secs);
        if (i >= 0) {
            // 需求：频谱里点到哪条红线 → ① 的横向列表就滚到对应那张卡片
            scrollCardIntoView(i, 'smooth');
            lastFollowIdx = i;
        }
    }

    /* ---------------- ② 区 / 标题栏按钮 ---------------- */

    // 全局起始偏移（offset）
    $('sz-offset').addEventListener('change', (e) => {
        const v = Number(e.target.value);
        if (!Number.isFinite(v) || v < 0) { cardsSig = ''; renderSections(); return; }
        pushUndo('offset'); // 连续拖动起点锚点 → 合并成一步
        postEdit({ type: 'offset', offsetMs: Math.round(v * 1000) }, `全局偏移 → ${v.toFixed(3)}s`);
    });
    $('sz-offset').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') e.target.blur();
        e.stopPropagation();
    });

    $('sz-prev').addEventListener('click', () => stepSection(-1));
    $('sz-next').addEventListener('click', () => stepSection(1));
    $('sz-add').addEventListener('click', addSection);
    $('sz-del').addEventListener('click', () => { if (selectedIdx > 0) deleteSection(selectedIdx); });

    // 导出 timing（把内存 timing 导出到时间戳命名的独立文件，不写回 .osu）
    function exportMap() {
        $('sz-import').disabled = true;
        post('/api/timing/export', { mode: 'redlines' }).then((r) => {
            flashHint(r.ok ? `已导出 → ${r.name}（红线 ${r.redCount} 条）` : '导出失败：' + (r.error || ''));
            $('sz-import').disabled = false;
        }).catch(() => { $('sz-import').disabled = false; });
    }
    $('sz-import').addEventListener('click', exportMap);
    // 打开 timing 导出的保存文件夹
    $('sz-open').addEventListener('click', () => post('/api/window/open-folder', { type: 'export' }));

    // 自动翻页跟随开关：状态存进 config.visual.autoFollow，重启后保持
    $('btn-autofollow').addEventListener('click', () => {
        const on = !(viz && viz.autoFollow);
        if (viz) viz.setAutoFollow(on);
        afOverride = { on, until: Date.now() + 1500 };
        $('btn-autofollow').classList.toggle('on', on);
        const v = (last && last.config && last.config.visual) ? last.config.visual : {};
        saveCfg({ visual: { ...v, autoFollow: on } });
        flashHint(on ? '自动翻页：已开启（播放头到 85% 处提前翻页）' : '自动翻页：已关闭');
    });

    /* ============ 标题栏音频控件：音量 / 变速 / 节拍器 / 时间 ============ */

    /** 把 au 的参数落到音频节点与 UI 上（改一处、画面与声音一起更新） */
    function applyAudio() {
        if (musicGain) musicGain.gain.value = au.musicVolume / 100;
        if (metroGain) metroGain.gain.value = au.metroVolume / 100;
        // 正在放的时候改速率：直接改 playbackRate 即可，preservesPitch 保证音调不变
        if (preview.src) {
            preview.src.playbackRate.value = au.rate;
            preview.src.preservesPitch = true;
        }
        $('au-vol').value = String(au.musicVolume);
        $('au-vol-v').textContent = String(Math.round(au.musicVolume));
        $('au-mvol').value = String(au.metroVolume);
        $('au-mvol-v').textContent = String(Math.round(au.metroVolume));
        $('au-rate').value = String(au.rate);
        $('au-metro').classList.toggle('on', !!au.metroOn);
    }

    /** 音频参数存 config.audio（重启后保持） */
    function saveAudio() {
        saveCfg({
            audio: {
                musicVolume: au.musicVolume,
                metroVolume: au.metroVolume,
                metroOn: au.metroOn,
                rate: au.rate
            }
        });
    }

    // 拖动中实时生效（input），松手才落盘（change），避免拖一次写几十遍配置
    $('au-vol').addEventListener('input', (e) => {
        au.musicVolume = Number(e.target.value);
        if (musicGain) musicGain.gain.value = au.musicVolume / 100;
        $('au-vol-v').textContent = String(Math.round(au.musicVolume));
    });
    $('au-vol').addEventListener('change', saveAudio);

    $('au-mvol').addEventListener('input', (e) => {
        au.metroVolume = Number(e.target.value);
        if (metroGain) metroGain.gain.value = au.metroVolume / 100;
        $('au-mvol-v').textContent = String(Math.round(au.metroVolume));
    });
    $('au-mvol').addEventListener('change', saveAudio);

    $('au-rate').addEventListener('change', (e) => {
        au.rate = Number(e.target.value) || 1;
        applyAudio();
        saveAudio();
        // 速率一变，"内容时间 ↔ 听感时间"的映射就变了 → 节拍器游标必须重新对齐
        if (preview.playing) metroSeek(previewNow());
        flashHint(`音乐变速 ${au.rate}×（保持音调不变）`);
    });

    $('au-metro').addEventListener('click', () => {
        au.metroOn = !au.metroOn;
        applyAudio();
        saveAudio();
        if (au.metroOn) {
            if (preview.playing && audioCtx) {
                metroSeek(previewNow());
                startMetro();
            }
            flashHint(preview.playing ? '节拍器：已开启' : '节拍器：已开启（空格开始试听后才会响）');
        } else {
            stopMetro();
            flashHint('节拍器：已关闭');
        }
    });

    // 标题栏时间显示：比 100ms 轮询细一点，看着是连续走的
    setInterval(() => {
        const el = $('au-time');
        if (el) el.textContent = fmtTimeMs(currentTime());
        renderFrameStat();
    }, 60);

    /**
     * v0.8.7 帧率诊断显示。
     * 只在"绘制速率明显掉到刷新率以下"时才变红报警 —— 平时是灰字，不打扰。
     * 重点看两个数：
     *   rAF 高 + 兜底 0  → 环境没在限帧；画面不流畅的原因只能在"数据节奏"（已被平滑修掉）
     *   rAF 低/0 + 兜底>0 → rAF 真停摆，此时**实际帧率 = 兜底帧率**，去设置里调高它
     */
    function renderFrameStat() {
        const el = $('frame-stat');
        if (!el) return;
        if (!showFrameStat) { if (el.style.display !== 'none') el.style.display = 'none'; return; }
        if (el.style.display === 'none') el.style.display = '';
        const fs = viz && viz.frameStat;
        if (!fs) { el.textContent = '帧率 —'; return; }
        const stall = fs.stall || fs.fallback > 0.5;
        el.textContent = `rAF ${fs.raf.toFixed(0)} · 画 ${fs.draw.toFixed(0)}`
            + (fs.fallback > 0.5 ? ` · 兜底 ${fs.fallback.toFixed(0)}` : '')
            + (fs.hidden ? ' · 页面判定为隐藏' : '');
        el.classList.toggle('warn', !!stall);
        el.title = `rAF ${fs.raf.toFixed(1)}/s · 实际绘制 ${fs.draw.toFixed(1)}/s`
            + ` · 兜底定时器接管 ${fs.fallback.toFixed(1)}/s`
            + ` · 页面隐藏=${fs.hidden} · 可见性=${fs.vis}`
            + (stall ? '\n⚠ rAF 已停摆，实际帧率被兜底帧率锁住 → 设置里调高「兜底帧率」' : '');
    }

    // ① 区滚轮 → 横向浏览（否则滚轮默认不动横向列表，滑条只能拖）
    $('sec-strip').addEventListener('wheel', (e) => {
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
            e.preventDefault();
            $('sec-strip').scrollLeft += e.deltaY;
        }
    }, { passive: false });

    /* ======================= 快捷键 ======================= */

    function isTyping(el) {
        const n = el;
        if (!n || !n.tagName) return false;
        const tag = n.tagName.toUpperCase();
        return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || n.isContentEditable === true;
    }

    window.addEventListener('keydown', (e) => {
        const ctrl = e.ctrlKey || e.metaKey;
        const key = (e.key || '').toLowerCase();
        const typing = isTyping(e.target);

        // 撤销 / 重做（输入框内交给浏览器自带行为）
        if (ctrl && !e.shiftKey && key === 'z') {
            if (typing) return;
            e.preventDefault(); doUndo(); return;
        }
        if (ctrl && (key === 'y' || (e.shiftKey && key === 'z'))) {
            if (typing) return;
            e.preventDefault(); doRedo(); return;
        }
        if (typing) return; // 其余快捷键在输入框里不生效

        if (e.code === 'Space') { e.preventDefault(); togglePreview(); return; }
        if (ctrl && key === 'o') { e.preventDefault(); loadAudioIfNeeded(last && last.beatmap, true); flashHint('重新载入音频…'); return; }
        if (ctrl && key === 's') { e.preventDefault(); exportMap(); return; }
        if (e.key === 'Delete' || e.key === 'Backspace') {
            if (selectedIdx > 0) { e.preventDefault(); deleteSection(selectedIdx); }
            return;
        }
        if (e.altKey && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) {
            e.preventDefault();
            stepSection(e.code === 'ArrowLeft' ? -1 : 1);
            return;
        }
        if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
            e.preventDefault();
            const step = e.shiftKey ? 5 : 1;
            const target = Math.max(0, currentTime() + (e.code === 'ArrowLeft' ? -step : step));
            preview.offset = target;
            if (preview.playing) startPreview(target);
            if (viz) viz.jumpToTime(target);
            flashHint(`起播点 ${fmtSec(target)}（空格开始播放）`);
            return;
        }
        if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomBy(1.2); return; }
        if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomBy(1 / 1.2); return; }
    });

    function zoomBy(factor) {
        if (!viz || viz.width <= 0) return;
        const centerT = viz.xToTime(viz.width / 2);
        viz.zoom = Math.max(20, Math.min(2000, viz.zoom * factor));
        viz.scrollLeft = Math.max(0, centerT * viz.zoom - viz.width / 2);
        viz._overlaySig = '';
        viz.jumpToTime(centerT);
    }

    /* ======================= 轮询渲染 ======================= */

    function render(s) {
        const prevBm = last && last.beatmap ? last.beatmap.path : '';
        const curBm = s.beatmap ? s.beatmap.path : '';
        last = s;

        // ★ 判定 osu! 的播放位置是否在推进 —— "制谱器一按播放，本窗口频谱就要跟随"。
        //   只要发现它在走，就把"本地定位点"清掉，让 currentTime() 完全交给 osu!，
        //   否则那个静态的 preview.offset 会把播放头钉死在原地（正是旧版的毛病）。
        const pt = s && s.player ? s.player.time : 0;
        if (Math.abs(pt - osuPrevTime) > 0.002) {
            osuAdvancingUntil = Date.now() + 600;
            osuPrevTime = pt;
            if (!preview.playing && preview.offset > 0) preview.offset = 0;
        }

        // 首次从 config 读一次音频参数；读完就以本地为准，
        // 免得轮询把用户刚拖的滑条弹回去（和自动翻页开关同样的坑）
        if (!auInit && s.config && s.config.audio) {
            auInit = true;
            const a = s.config.audio || {};
            const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
            au = {
                musicVolume: num(a.musicVolume, AU_DEFAULT.musicVolume),
                metroVolume: num(a.metroVolume, AU_DEFAULT.metroVolume),
                metroOn: !!a.metroOn,
                rate: num(a.rate, AU_DEFAULT.rate)
            };
            applyAudio();
        }

        if (!viz) initViz();
        // 谱面切换时重新加载音频（播放头平滑器也要复位：新谱时间轴完全不同）
        if (prevBm !== curBm) { preview.offset = 0; stopPreview(); resetOsuSmooth(); loadAudioIfNeeded(s.beatmap); }
        if (viz) {
            // 每轮都同步设置（设置面板改了立刻生效）并刷新红线/卡片
            applyVisual(s.config ? s.config.visual : null);
            viz.refresh();
            renderSections();
        }
        $('sz-import').disabled = !s.memDirty;
        if (viz) $('btn-autofollow').classList.toggle('on', !!viz.autoFollow);
    }

    startPoll(render, 100);
})();
