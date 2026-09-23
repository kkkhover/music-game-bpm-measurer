/* ============================================================================
   可视化模块 —— 频谱 / 声谱 / 时间轴（红线拖动改 timing）
   ============================================================================
   【本文件是完全对齐 BPM 测速助手渲染方案的移植版】
   参考来源（逐行对照，改动只在与侧栏数据模型的对接处）：
     · components/Visualizer.tsx       —— 四层布局 + 绘制 + 交互
     · utils/spectrogramPrecompute.ts  —— 原生 FFT 预计算（hop = fftSize/4）
     · utils/settings.ts               —— spectrogramColor 配色 + 默认值

   ── 布局（与软件一致，别再改）────────────────────────────────────────────
     总高 H，底部留 TIMELINE_HEIGHT(40px) 做时间轴：
       availableH = H - 40
       waveH      = floor(availableH * 0.5)   ← 波形在上
       specH      = availableH - waveH        ← 声谱在下
     四层 canvas（自底向上）：
       ① viz-wave     : top=0        height=waveH   波形（min/max 柱）
       ② viz-spec     : top=waveH    height=specH   声谱（FFT 瀑布图）
       ③ viz-overlay  : top=0        height=H       刻度尺 + 红线 + 蓝线（收鼠标）
       ④ viz-playhead : top=0        height=H       播放头（AU 式局部重绘）
     ★ 踩过的坑：曾经四层全被设成同尺寸且都 top:0，于是声谱层把波形整个盖住，
       下半屏是死黑区 —— 表现为"声谱只占上面一半，下面一大片黑"。
       画布必须**按层给尺寸/位置**（_applySizes 里做），不能一套尺寸铺满。

   ── 声谱渲染管线（与软件一致）────────────────────────────────────────────
     优先用 Chromium 原生 FFT（OfflineAudioContext + AnalyserNode +
     ScriptProcessorNode 流式抓取 getFloatFrequencyData，量化成 Uint8 dB），
     比 JS 手写 FFT 快一个数量级；预计算未完成/失败时回退 JS radix-2 FFT。
     绘制时做**双线性插值**（频率方向相邻 bin + 时间方向相邻列），AU 风格平滑。

   ── 交互（复刻软件三种拖动）──────────────────────────────────────────────
     · offset  拖第 0 条红线（起点锚点）→ 改全局 offset（所有红线整体平移）
     · redline 拖某条红线 → 直接改这条红线的绝对时间戳（红线位置独立）
     · bpm     抓某条蓝线 → 改该段 BPM（= 拍数×60 / 时间差）
     · 波形/声谱区拖动 = 平移时间轴；单击 = 跳转播放位置（侧栏无法控制 osu!，
       所以 seek 只本地生效，不发给主进程）
   拖动**只改内存 timing 状态**（主进程 memTiming），由「导入谱面」统一写回 .osu。

   ── 数据约定 ──────────────────────────────────────────────────────────────
     getState() 返回：
       { time: 播放头秒数,
         duration: 总时长（秒）,
         timingPoints: [{ time: **秒**, bpm, beatIndex? }] }
     ★ 红线时间统一用**秒**（osu 的 timing 是毫秒，由 viz-panel 负责 ÷1000）。
       beatIndex 由本文件派生（首条=0，其后累加 max(1, round(Δt/上一段拍长))），
       与软件的 recalculateTiming 一致 —— 只用于显示编号，不参与定位。
   ============================================================================ */

// ---- 独立模块作用域：暴露全局 Viz，供各 panel 调用 ----
(function () {
    'use strict';

    const TIMELINE_HEIGHT = 40; // 底部时间轴高度（像素，与软件一致）
    const RULER_H = 22;         // 顶部时间刻度尺高度（刻度竖线由此往下画）
    const RULER_TARGET_PX = 80; // 刻度尺标签的目标间距（像素）

    // ---- 渲染心跳兜底参数（见 start()）----
    // rAF 超过这个时长没回调就认为它"失联"（正常 60Hz≈16.7ms，留足抖动余量）。
    const RAF_STALL_MS = 120;
    // ★ v0.8.7：兜底定时器的间隔从「写死 33ms(≈30fps)」改成**可调**。
    //   原因：33ms 这个数字会**直接变成用户看到的帧率**——一旦环境里 rAF 真的停摆
    //   （被游戏独占全屏盖住 / 驱动不派帧），画面就被这个定时器锁死在 30fps，
    //   而"锁 30"正是用户报的现象。默认仍是 33ms（与旧版行为一致、最省 CPU），
    //   但在设置面板里可以选 60 / 120 / 跟随屏幕刷新率。
    //   取值含义见 setVisual() 的 fallbackFps：0 或未设 = 默认 33ms；
    //   负数 = 跟随屏幕刷新率（-1 → 每帧一次）。
    const FALLBACK_INTERVAL_DEFAULT_MS = 33;

    // 时间刻度步长候选（秒）
    const STEP_SECS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

    /* ========================================================================
       § 声谱配色（移植 BPM 测速助手 utils/settings.ts 的 spectrogramColor）
       ======================================================================== */

    // ---- 完整色阶方案（多级渐变，val 驱动；每项 t=色标位置 0-1）----
    const SCALES = {
        spectrum: [
            { t: 0.00, rgb: [0, 0, 0] }, { t: 0.25, rgb: [45, 0, 102] },
            { t: 0.40, rgb: [106, 0, 179] }, { t: 0.55, rgb: [200, 0, 160] },
            { t: 0.70, rgb: [255, 0, 34] }, { t: 0.85, rgb: [255, 85, 0] },
            { t: 1.00, rgb: [255, 238, 0] }
        ],
        classic: [
            { t: 0.00, rgb: [0, 0, 0] }, { t: 0.20, rgb: [80, 0, 80] },
            { t: 0.40, rgb: [160, 0, 160] }, { t: 0.60, rgb: [255, 0, 0] },
            { t: 0.80, rgb: [255, 120, 0] }, { t: 1.00, rgb: [255, 240, 0] }
        ],
        ocean: [
            { t: 0.00, rgb: [0, 0, 0] }, { t: 0.25, rgb: [0, 0, 90] },
            { t: 0.50, rgb: [0, 60, 220] }, { t: 0.75, rgb: [0, 180, 255] },
            { t: 1.00, rgb: [230, 255, 255] }
        ],
        ember: [
            { t: 0.00, rgb: [0, 0, 0] }, { t: 0.25, rgb: [60, 0, 0] },
            { t: 0.50, rgb: [200, 0, 0] }, { t: 0.75, rgb: [255, 80, 0] },
            { t: 0.90, rgb: [255, 200, 0] }, { t: 1.00, rgb: [255, 255, 255] }
        ],
        toxic: [
            { t: 0.00, rgb: [0, 0, 0] }, { t: 0.25, rgb: [0, 60, 20] },
            { t: 0.50, rgb: [0, 180, 60] }, { t: 0.75, rgb: [80, 255, 120] },
            { t: 1.00, rgb: [220, 255, 120] }
        ],
        rose: [
            { t: 0.00, rgb: [0, 0, 0] }, { t: 0.25, rgb: [70, 0, 90] },
            { t: 0.50, rgb: [220, 0, 140] }, { t: 0.75, rgb: [255, 80, 180] },
            { t: 1.00, rgb: [255, 210, 235] }
        ],
        candy: [
            { t: 0.00, rgb: [0, 0, 0] }, { t: 0.20, rgb: [20, 0, 80] },
            { t: 0.40, rgb: [120, 0, 160] }, { t: 0.60, rgb: [255, 40, 180] },
            { t: 0.80, rgb: [255, 200, 60] }, { t: 1.00, rgb: [255, 255, 255] }
        ],
        midnight: [
            { t: 0.00, rgb: [0, 0, 0] }, { t: 0.25, rgb: [0, 10, 90] },
            { t: 0.50, rgb: [200, 0, 120] }, { t: 0.75, rgb: [130, 40, 220] },
            { t: 1.00, rgb: [0, 220, 255] }
        ],
        lava: [
            { t: 0.00, rgb: [0, 0, 0] }, { t: 0.25, rgb: [70, 0, 0] },
            { t: 0.50, rgb: [220, 30, 0] }, { t: 0.75, rgb: [255, 140, 20] },
            { t: 1.00, rgb: [255, 255, 255] }
        ],
        forest: [
            { t: 0.00, rgb: [0, 0, 0] }, { t: 0.25, rgb: [0, 40, 20] },
            { t: 0.50, rgb: [0, 130, 60] }, { t: 0.75, rgb: [0, 220, 150] },
            { t: 1.00, rgb: [230, 255, 245] }
        ],
        sakura: [
            { t: 0.00, rgb: [0, 0, 0] }, { t: 0.25, rgb: [60, 0, 80] },
            { t: 0.50, rgb: [220, 60, 150] }, { t: 0.75, rgb: [255, 150, 210] },
            { t: 1.00, rgb: [255, 240, 250] }
        ],
        citrus: [
            { t: 0.00, rgb: [0, 0, 0] }, { t: 0.25, rgb: [60, 25, 0] },
            { t: 0.50, rgb: [220, 110, 0] }, { t: 0.75, rgb: [255, 200, 0] },
            { t: 1.00, rgb: [255, 250, 180] }
        ]
    };

    // ---- 多色分段方案的三段色 [低频, 中频, 高频] ----
    const MULTI_COLORS = {
        foobar: ['#4a0080', '#ff4500', '#1a0a1a'],
        fire: ['#2a0010', '#ff5000', '#ffec00'],
        ice: ['#001a4a', '#00aaff', '#ffffff'],
        rainbow: ['#6a00a8', '#00aa44', '#ffaa00'],
        neonB: ['#ff00aa', '#00ffff', '#aaff00'],
        sunset: ['#2d0066', '#ff8000', '#ffec70'],
        fbclassic: ['#3d0080', '#20cccc', '#ffd700'],
        warm: ['#8a0000', '#ff6000', '#ffe000'],
        cool: ['#002060', '#00c0ff', '#ffffff'],
        violet: ['#2d0066', '#8a2be2', '#ff77ff'],
        gold: ['#402000', '#d4af37', '#ffee80'],
        miami: ['#2d0050', '#ff2d95', '#00ffff']
    };

    function hexToRgbArr(hex) {
        const m = String(hex || '').replace('#', '');
        const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
        const n = parseInt(full, 16);
        if (isNaN(n)) return [128, 128, 128];
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }

    function interpStops(stops, f) {
        if (f <= stops[0].t) return stops[0].rgb;
        for (let i = 0; i < stops.length - 1; i++) {
            if (f <= stops[i + 1].t) {
                const span = stops[i + 1].t - stops[i].t;
                const t = span > 0 ? (f - stops[i].t) / span : 0;
                return [
                    Math.round(stops[i].rgb[0] + (stops[i + 1].rgb[0] - stops[i].rgb[0]) * t),
                    Math.round(stops[i].rgb[1] + (stops[i + 1].rgb[1] - stops[i].rgb[1]) * t),
                    Math.round(stops[i].rgb[2] + (stops[i + 1].rgb[2] - stops[i].rgb[2]) * t)
                ];
            }
        }
        return stops[stops.length - 1].rgb;
    }

    /**
     * 频谱配色映射：val∈[0,1] 信号强度 + freqNorm∈[0,1] 频率位置 → [r,g,b]
     *  · 单色方案：只由 val 决定
     *  · 完整色阶：SCALES 多级渐变（val<0.06 噪声门限涂黑）
     *  · 三分频 / custom：freqNorm 定位段色，val 决定亮度（gamma 0.55 对比度增强）
     *  · 峰值增强：超过 peakThreshold 向 peakColor 陡峭过渡 + 额外提亮 25%
     */
    function spectrogramColor(val, freqNorm, palette, custom, peakThreshold, peakColor) {
        const v = Math.max(0, Math.min(1, val));
        const f = Math.max(0, Math.min(1, freqNorm));

        // 单色方案（只由 val 决定）
        const single = {
            neon: () => { if (v < 0.5) { const t = v / 0.5; return [t * 90, 0, t * 160]; } const t = (v - 0.5) / 0.5; return [90 + t * 165, t * 60, 160 + t * 95]; },
            heat: () => { if (v < 0.33) { const t = v / 0.33; return [t * 200, 0, 0]; } if (v < 0.66) { const t = (v - 0.33) / 0.33; return [200, t * 160, 0]; } const t = (v - 0.66) / 0.34; return [255, 160 + t * 95, t * 255]; },
            gray: () => { const g = Math.round(v * 255); return [g, g, g]; },
            psy: () => { if (v < 0.5) { const t = v / 0.5; return [t * 80, 0, t * 130]; } const t = (v - 0.5) / 0.5; return [80 + t * 175, t * 40, 130 + t * 125]; },
            au: () => { if (v < 0.5) { const t = v / 0.5; return [t * 25, t * 140, 45 + t * 210]; } const t = (v - 0.5) / 0.5; return [25 + t * 230, 140 + t * 115, 255 - t * 70]; }
        };
        if (palette in single) return single[palette]();

        // 完整色阶方案（val<0.06 噪声门限涂黑）
        if (palette in SCALES) {
            if (v < 0.06) return [0, 0, 0];
            return interpStops(SCALES[palette], v);
        }

        // 多色分段方案：在 [0, 0.5, 0.85, 1] 色标间插值（低/中/高 + 高频顶端亮白）
        let stops;
        if (palette === 'custom' && custom && custom.length === 3) {
            stops = [
                { t: 0, rgb: hexToRgbArr(custom[0]) },
                { t: 0.5, rgb: hexToRgbArr(custom[1]) },
                { t: 0.85, rgb: hexToRgbArr(custom[2]) },
                { t: 1, rgb: [255, 255, 255] }
            ];
        } else if (palette in MULTI_COLORS) {
            const c = MULTI_COLORS[palette];
            stops = [
                { t: 0, rgb: hexToRgbArr(c[0]) },
                { t: 0.5, rgb: hexToRgbArr(c[1]) },
                { t: 0.85, rgb: hexToRgbArr(c[2]) },
                { t: 1, rgb: [255, 255, 255] }
            ];
        } else {
            return single.au();
        }

        const base = interpStops(stops, f);

        // 对比度增强：gamma 提升中高段亮度（弱信号更暗、层次分明）
        const boosted = Math.pow(v, 0.55);
        const darkness = (1 - boosted) * 0.92;
        // 峰值增强：超过阈值后向 peakColor 陡峭过渡
        const th = Math.max(0.3, Math.min(0.98, peakThreshold || 0.8));
        const peakT = th >= 0.99 ? 0 : Math.max(0, Math.min(1, (v - th) / (1 - th)));
        const sharp = Math.pow(peakT, 0.6);
        const peak = hexToRgbArr(peakColor || '#ffffff');
        const pr = base[0] + (peak[0] - base[0]) * sharp;
        const pg = base[1] + (peak[1] - base[1]) * sharp;
        const pb = base[2] + (peak[2] - base[2]) * sharp;
        const peakLighten = sharp * 0.25; // 峰值额外提亮
        const dark2 = Math.max(0, darkness - peakLighten);
        return [
            Math.round(pr * (1 - dark2)),
            Math.round(pg * (1 - dark2)),
            Math.round(pb * (1 - dark2))
        ];
    }

    /* ========================================================================
       § FFT：原生预计算（对齐 spectrogramPrecompute.ts）+ JS 回退
       ======================================================================== */
    const DB_MIN = -120;      // 量化下限（Uint8=0）
    const DB_RANGE = 120;     // 量化范围（Uint8=255 对应 0dB）
    const DEFAULT_FLOOR = 100; // 默认显示阈值 dB（低于此值显示为黑）

    function dbToU8(db) {
        const v = Math.round(((db - DB_MIN) / DB_RANGE) * 255);
        return v < 0 ? 0 : v > 255 ? 255 : v;
    }
    /** 反量化 + 直接映射到 0~1 显示强度（(db+floor)/floor 等价变换） */
    function u8ToVal(v, floor) {
        floor = floor || DEFAULT_FLOOR;
        return (v / 255) * (DB_RANGE / floor) + ((DB_MIN + floor) / floor);
    }
    /** 频谱列步进：fftSize/4，即 75% 窗重叠（AU 风格）。ScriptProcessor 限制 256~16384 */
    function hopFor(fftSize) {
        return Math.max(256, Math.min(16384, fftSize / 4));
    }

    /**
     * 整曲频谱预计算（Chromium 原生 FFT）。
     * 失败/不支持时返回 null（调用方回退 JS FFT）。
     */
    async function precomputeSpectrogram(buffer, fftSize) {
        try {
            const sampleRate = buffer.sampleRate;
            const totalSamples = buffer.length;
            const ctx = new OfflineAudioContext(1, totalSamples, sampleRate);
            const src = ctx.createBufferSource();
            src.buffer = buffer;
            const analyser = ctx.createAnalyser();
            analyser.fftSize = fftSize;
            analyser.smoothingTimeConstant = 0; // 关闭时域平滑，保留每块精确频谱
            src.connect(analyser);
            const hop = hopFor(fftSize);
            const processor = ctx.createScriptProcessor(hop, 1, 1);
            analyser.connect(processor);
            processor.connect(ctx.destination); // 必须连到 destination 才会被处理
            const cols = [];
            const bins = analyser.frequencyBinCount;
            const tmp = new Float32Array(bins);
            processor.onaudioprocess = () => {
                analyser.getFloatFrequencyData(tmp);
                const q = new Uint8Array(bins);
                for (let b = 0; b < bins; b++) q[b] = dbToU8(tmp[b]);
                cols.push(q);
            };
            src.start(0);
            await ctx.startRendering();
            if (cols.length === 0) return null;
            const out = { data: cols, hop, fftSize };
            // ★ v0.8.11：渲染完必须**显式拆掉离线音频图**，否则每换一张谱面就多占一份内存。
            //   实测（隔离 A/B，120s 音频）：不清理时每次预计算净增 **≈44MB 且强制 GC 也不回落**；
            //   加上下面这段后不再增长。44MB ≈ 整曲 AudioBuffer(21MB) + 离线渲染缓冲(21MB)。
            //   机理：src.buffer 指向整曲 AudioBuffer，proc.onaudioprocess 又闭包住 analyser/tmp/cols，
            //   整条图连同音频一起被钉住；null 掉这些引用后，图就能被回收。
            //   （渲染已结束，这里断开节点不会影响已抓到的 cols）
            processor.onaudioprocess = null;
            try { processor.disconnect(); } catch (e) { /* 已断开则忽略 */ }
            try { analyser.disconnect(); } catch (e) { /* 同上 */ }
            try { src.disconnect(); } catch (e) { /* 同上 */ }
            src.buffer = null; // 关键：松开整曲音频
            return out;
        } catch (e) {
            return null;
        }
    }

    // JS FFT 回退（radix-2，原地）
    function computeFFT(re, im) {
        const n = re.length;
        for (let i = 1, j = 0; i < n; i++) {
            let bit = n >> 1;
            for (; j & bit; bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j) {
                [re[i], re[j]] = [re[j], re[i]];
                [im[i], im[j]] = [im[j], im[i]];
            }
        }
        for (let len = 2; len <= n; len <<= 1) {
            const ang = (-2 * Math.PI) / len;
            const wr = Math.cos(ang);
            const wi = Math.sin(ang);
            for (let i = 0; i < n; i += len) {
                let cr = 1, ci = 0;
                for (let k = 0; k < len / 2; k++) {
                    const a = i + k, b = i + k + len / 2;
                    const tr = re[b] * cr - im[b] * ci;
                    const ti = re[b] * ci + im[b] * cr;
                    re[b] = re[a] - tr; im[b] = im[a] - ti;
                    re[a] += tr; im[a] += ti;
                    const ncr = cr * wr - ci * wi;
                    ci = cr * wi + ci * wr; cr = ncr;
                }
            }
        }
    }

    function getHann(n) {
        const w = new Float32Array(n);
        for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
        return w;
    }

    /* ========================================================================
       § Viz 主类
       ======================================================================== */
    class Viz {
        /**
         * @param {object} opts
         *   container     承载 canvas 的 DOM 元素
         *   getState      返回 { time:秒, duration:秒, timingPoints:[{time:秒,bpm}] }
         *   onEditTiming  编辑回调 { type:'offset'|'redline'|'bpm'|'seek', ... }
         *   onSelect      选中红线回调 (index) —— 编辑栏用它联动
         */
        constructor(opts) {
            this.container = opts.container;
            this.getState = opts.getState;
            this.onEditTiming = opts.onEditTiming || (() => {});
            this.onSelect = opts.onSelect || (() => {});

            this.audio = null;
            this.audioKey = '';

            this.zoom = 100; // 像素/秒
            this.scrollLeft = 0;

            this.dragging = null;
            this.panState = null;

            this.specCache = new Map();
            this.fftSize = 1024;      // 与软件默认一致（1K ≈ 43Hz 分辨率）
            this.sensitivity = 75;    // 显示灵敏度 dB 阈值
            this._paletteName = 'spectrum';
            this._specCustom = ['#ff2222', '#ff2222', '#ff2222'];
            this._specLogBase = 50;   // 频率轴对数底（1=线性）
            this._peakThreshold = 0.5;
            this._peakColor = '#ffee00';
            this._specInvert = false;
            this._waveColor = '#a855f7';
            this._renderScale = 1;
            this._beatLineDelaySec = 30 / 1000; // 红线节拍线延迟（默认 30ms，与软件一致）

            // 原生 FFT 预计算数据
            this.specData = null;
            this._specPreToken = 0;
            // ★ v0.8.12：频谱预计算的调度状态 —— 必须**串行 + 只保留最新**。
            //   一次预计算 = 整曲 OfflineAudioContext + 整曲渲染输出（10 分钟谱 ≈ 300MB）。
            //   旧实现每次 setAudio 都无条件起一个、而离线渲染无法取消（只用 token 拦结果）
            //   → 实测 10 次快速连切时**并发 10 个整曲渲染**，进程 +1.6GB，停手后 20 多秒才回落。
            this._specRunning = false;   // 是否已有一次离线渲染在跑
            this._specPending = null;    // 待跑的最新任务 { buffer, token }

            this._specRaf = null;

            // 平移复用缓存
            this._waveLast = null;
            this._specLast = null;
            this._tmpCanvas = null;

            // ---- 性能：查找表（LUT）----
            // 对齐软件《性能诊断报告》的 P0-2 / P0-3：
            //   ① 颜色 LUT：把 spectrogramColor 的结果预先算成 256×256 表（val × 频率），
            //      逐像素从"100+ 次浮点运算"降到"1 次数组查表"。
            //   ② 频率映射 LUT：log(y)→bin 的换算只与行号有关、与列无关，预先算好复用。
            // 调色板/峰值参数变 → 重建颜色表；高度/FFT/对数底/倒转变 → 重建频率表。
            this._colorLUT = null;
            this._colorLUTKey = '';
            this._binLUT = null;
            this._binLUTKey = '';

            // ---- 交互节流（对齐软件：mousemove 可能远高于刷新率，每帧最多处理一次）----
            this._panRaf = null;
            this._panMouseX = 0;
            this._wheelRaf = null;
            this._wheelAcc = 0;
            this._wheelAnchorX = 0;

            // ---- 渲染心跳兜底（见 start()）----
            // rAF 依赖 Chromium 的"页面可见"判定：侧栏挂着被 osu! 全屏盖住时，
            // 某些驱动 / 独占全屏下 rAF 会被完全暂停（不是降频是停摆）。
            // 这里记下 rAF 最近一次回调的时刻，失联就用定时器接管绘制。
            this._fallbackTimer = null;
            this._lastRafAt = 0;
            // v0.8.7：兜底定时器间隔（毫秒），可被 config.visual.fallbackFps 覆盖
            this._fallbackMs = FALLBACK_INTERVAL_DEFAULT_MS;

            // ---- 帧率诊断（v0.8.7）----
            // 只做统计，不参与绘制。每 500ms 结算一次，发布到 this.frameStat，
            // 供面板显示"rAF 多少帧 / 兜底定时器是否接手"——用来区分
            // "画不出来"（帧率低）和 "没数据可画"（位置不推进）这两种完全不同的毛病。
            this._statRaf = 0;              // 窗口内 rAF 回调次数
            this._statDrawRaf = 0;          // 窗口内 rAF 驱动的绘制次数
            this._statDrawFallback = 0;     // 窗口内 兜底定时器 驱动的绘制次数
            this._statAt = 0;               // 窗口起点
            this.frameStat = null;          // { raf, draw, fallback, stall, at }

            // ---- 自动翻页跟随（需求 4：播放头将超出窗口时自动渲染下一段频谱）----
            this.autoFollow = true;

            // ---- 选中的红线（编辑栏联动；-1 = 未选中）----
            this.selectedIndex = -1;

            // overlay 重绘签名：内容没变就跳过（refresh 每 100ms 调一次，别白画）
            this._overlaySig = '';

            // 派生红线（秒 + 拍号），由 getState 重建
            this._reds = [];
            this._lastLayoutKey = '';

            this._buildCanvases();
            this._bind();
        }

        _buildCanvases() {
            this.container.classList.add('viz-wrap');
            this.container.innerHTML = '';
            const mk = (cls) => {
                const c = document.createElement('canvas');
                c.className = cls;
                this.container.appendChild(c);
                return c;
            };
            this.waveCanvas = mk('viz-wave');
            this.specCanvas = mk('viz-spec');
            this.overlayCanvas = mk('viz-overlay');
            this.playheadCanvas = mk('viz-playhead');
            this.width = 0;
            this.height = 0;
            this._layout();
        }

        // ---------- 尺寸 / 布局 ----------

        /** 渲染缩放比：设备像素比 × 用户渲染倍率（性能优先可 <1，清晰优先可 >1） */
        _dpr() {
            const base = window.devicePixelRatio || 1;
            const s = this._renderScale > 0 ? this._renderScale : 1;
            return Math.max(0.5, Math.min(3, base * s));
        }

        // ---------- 查找表（LUT）：性能核心 ----------

        /**
         * 颜色查找表：256 级强度 × 256 级频率位置 → 打包好的 0xAABBGGRR。
         * 把 spectrogramColor 里那些"每像素重复算"的东西（多段色标插值、Math.pow gamma、
         * 峰值过渡、hex 解析）全部预算好，逐像素只剩一次数组查表。
         * 键 = 调色板 + 自定义三色 + 峰值阈值 + 峰值色；这些变了才重建。
         */
        _ensureColorLUT() {
            const key = `${this._paletteName}|${this._specCustom.join(',')}|${this._peakThreshold}|${this._peakColor}`;
            if (this._colorLUT && this._colorLUTKey === key) return this._colorLUT;
            const lut = new Uint32Array(256 * 256);
            for (let vq = 0; vq < 256; vq++) {
                const val = vq / 255;
                const row = vq << 8;
                for (let fq = 0; fq < 256; fq++) {
                    const [r, g, b] = spectrogramColor(val, fq / 255, this._paletteName, this._specCustom, this._peakThreshold, this._peakColor);
                    lut[row | fq] = (255 << 24) | (b << 16) | (g << 8) | r;
                }
            }
            this._colorLUT = lut;
            this._colorLUTKey = key;
            return lut;
        }

        /**
         * 频率映射查找表：每一行 y 对应的 bin 浮点位置（b0/b1/bFrac）与频率归一化量化值。
         * log(y) 映射只与行号有关、与列无关 —— 原来每像素算一次 Math.pow，现在算一次用一整屏。
         * 键 = bin 数 + 行数 + 对数底 + 是否倒转。
         */
        _ensureBinLUT(numBins, fullHeight, base) {
            const key = `${numBins}|${fullHeight}|${base}|${this._specInvert ? 1 : 0}`;
            if (this._binLUT && this._binLUTKey === key) return this._binLUT;
            const b0 = new Int32Array(fullHeight);
            const b1 = new Int32Array(fullHeight);
            const bf = new Float32Array(fullHeight);
            const fq = new Uint8Array(fullHeight);
            for (let y = 0; y < fullHeight; y++) {
                const yNorm = this._specInvert ? 1 - y / fullHeight : y / fullHeight;
                // bin 浮点位置（对数/线性刻度映射）
                const binF = base <= 1
                    ? yNorm * (numBins - 1)
                    : ((Math.pow(base, yNorm) - 1) / (base - 1)) * (numBins - 1);
                const a = Math.floor(binF);
                b0[y] = a;
                b1[y] = Math.min(numBins - 1, a + 1);
                bf[y] = binF - a;
                fq[y] = numBins > 1 ? Math.round((a / (numBins - 1)) * 255) : 0;
            }
            this._binLUT = { b0, b1, bf, fq };
            this._binLUTKey = key;
            return this._binLUT;
        }

        /** 计算四层的高度/位置（与软件完全一致：内容区上下各占一半） */
        _layout() {
            const av = Math.max(0, this.height - TIMELINE_HEIGHT);
            this.waveHeight = Math.floor(av * 0.5);
            this.specHeight = av - this.waveHeight;
            this.specTop = this.waveHeight;
            this.contentBottom = this.waveHeight + this.specHeight; // 内容区底边 = 时间轴顶边
            this.timelineTop = this.contentBottom;
        }

        setSize(w, h) {
            if (w <= 0 || h <= 0) return;
            const changed = Math.floor(w) !== this.width || Math.floor(h) !== this.height;
            this.width = Math.floor(w);
            this.height = Math.floor(h);
            this._layout();
            this._applySizes();
            if (changed) {
                this._waveLast = null;
                this._specLast = null;
                this._fullRedraw();
            }
        }

        /**
         * 【关键】按层给每块画布设置尺寸与位置。
         * 波形层只占上半区、声谱层从 waveHeight 开始只占下半区；
         * overlay / playhead 覆盖整高（它们要跨区画线和播放头）。
         */
        _applySizes() {
            const dpr = this._dpr();
            this._sizeLayer(this.waveCanvas, this.width, this.waveHeight, 0, dpr);
            this._sizeLayer(this.specCanvas, this.width, this.specHeight, this.specTop, dpr);
            this._sizeLayer(this.overlayCanvas, this.width, this.height, 0, dpr);
            this._sizeLayer(this.playheadCanvas, this.width, this.height, 0, dpr);
            // 尺寸变 → 画布被清空 → 下一次 _drawOverlay 必须真画（否则签名相同会跳过，留下空白）
            this._overlaySig = '';
        }

        _sizeLayer(c, w, h, top, dpr) {
            c.style.top = top + 'px';
            c.style.width = w + 'px';
            c.style.height = h + 'px';
            const dw = Math.max(1, Math.floor(w * dpr));
            const dh = Math.max(1, Math.floor(h * dpr));
            // 只在尺寸真变了才重设 —— 否则每帧清空画布会破坏"平移复用"
            if (c.width !== dw) c.width = dw;
            if (c.height !== dh) c.height = dh;
        }

        timeToX(t) { return t * this.zoom - this.scrollLeft; }
        xToTime(x) { return (x + this.scrollLeft) / this.zoom; }

        _duration() {
            if (this.audio) return this.audio.duration;
            const st = this.getState();
            return st && st.duration ? st.duration : 0;
        }

        // ---------- 红线数据（含派生拍号）----------

        /** 从 getState 重建红线列表（时间统一成秒，并派生整数拍号） */
        _redsFromState() {
            const st = this.getState() || {};
            const pts = (st.timingPoints || []).filter((p) => p.uninherited !== false);
            const reds = pts
                .map((p) => ({
                    time: Number(p.time) || 0,
                    bpm: Number(p.bpm) || 120,
                    // 拍号（meter）只用于卡片显示；主进程 memTiming 里带着，透传过来
                    meter: Number(p.meter) > 0 ? Number(p.meter) : 4
                }))
                .sort((a, b) => a.time - b.time);
            this._deriveBeatIndex(reds);
            return reds;
        }

        /**
         * 派生整数拍号（与软件 recalculateTiming 一致）：
         * 首条红线 = 0；其后每条 = 上一条 + max(1, round(Δt / 上一段拍长))。
         * 只用于显示编号（红线/蓝线标签），不参与定位 —— 红线位置永远以 time 为准。
         */
        _deriveBeatIndex(reds) {
            let bi = 0;
            for (let i = 0; i < reds.length; i++) {
                if (i > 0) {
                    const prev = reds[i - 1];
                    const beatDur = 60 / (prev.bpm || 120);
                    bi += Math.max(1, Math.round((reds[i].time - prev.time) / beatDur));
                } else {
                    bi = 0;
                }
                reds[i].beatIndex = bi;
            }
        }

        // ---------- 音频载入 ----------
        setAudio(buffer, key) {
            this.audio = {
                buffer,
                duration: buffer.duration,
                sampleRate: buffer.sampleRate,
                rawData: buffer.getChannelData(0)
            };
            this.audioKey = key;
            this.specCache.clear();
            this._waveLast = null;
            this._specLast = null;
            this._overlaySig = '';
            this._initialFollowed = false; // 换歌后重新对准播放头一次
            // 后台预计算原生 FFT 频谱（★ v0.8.12：交给调度器 → 串行 + 只保留最新）
            this.specData = null;
            this._specPending = { buffer, token: ++this._specPreToken };
            this._scheduleSpecPrecompute();
            this._fullRedraw();
        }

        clearAudio() {
            if (this.audio) {
                this.audio = null;
                this.audioKey = '';
                this.specCache.clear();
                this.specData = null;
                this._specPending = null; // 已排队/待跑的任务一并作废
                this._specPreToken++;
                this._overlaySig = '';
                this._initialFollowed = false;
                this._fullRedraw();
            }
        }

        /**
         * 频谱预计算调度：**同一时刻只允许一次整曲离线渲染在跑**，排队中的会被最新的覆盖。
         *
         * 为什么必须这样（v0.8.12 实测数据）：
         *   · 一次预计算要建「整曲长度」的 OfflineAudioContext 并渲染到底 —— 10 分钟谱面
         *     光是渲染输出就是 ~106MB，加上它钉住的整曲 PCM，单次 ≈300MB；
         *   · 旧实现里 setAudio 每次都无条件起一个新的，而离线渲染**无法取消**
         *     （token 只是不让旧结果写回状态，渲染本身照样跑完）；
         *   · 结果：快速连切 10 张 → 探针数出 **并发峰值 10**，进程内存 802MB → 2382MB（+1580MB），
         *     且停手时还有 7 个没跑完、残留 1180MB；
         *   · 串行 + 覆盖之后并发恒为 1（最多"1 个在跑 + 1 个待跑"），中间被跳过的谱面
         *     连渲染都不会开始，也就不会钉住它们的整曲 PCM。
         *
         * 语义：running 时只记录 pending（后到的覆盖先到的）；每次跑完再取最新的那份。
         * 期间若又换了谱面/改了参数，token 会对不上 → 这份已过期的结果直接丢弃。
         */
        _scheduleSpecPrecompute() {
            if (this._specRunning || !this._specPending) return; // 在跑 → 跑完会自动来取最新的
            const job = this._specPending;
            this._specPending = null;
            this._specRunning = true;
            precomputeSpectrogram(job.buffer, this.fftSize).then((data) => {
                if (job.token === this._specPreToken) {
                    this.specCache.clear();
                    this.specData = data;
                    this._specLast = null;
                    this._drawSpectrogram();
                }
            }).catch(() => { /* precomputeSpectrogram 内部已兜底；失败就保持 specData=null 走 JS FFT */ })
              .then(() => {
                  this._specRunning = false;
                  this._scheduleSpecPrecompute(); // 有新任务在等 → 接着算最新的那份
              });
        }

        /**
         * 应用可视化设置（键名与 config.visual 一一对应）。
         * 改了频谱参数必须清列缓存：缓存键只有 sampleIdx，
         * 不清的话"改了配色/对数刻度却不生效"（命中旧参数的缓存列）。
         */
        setVisual(cfg = {}) {
            let needRedraw = false;
            let needSpecRecompute = false;

            if (cfg.fftSize && cfg.fftSize !== this.fftSize) {
                this.fftSize = cfg.fftSize;
                this.specCache.clear();
                this.specData = null;
                this._specLast = null;
                needRedraw = true;
                needSpecRecompute = true;
            }
            if (Number.isFinite(cfg.sensitivity) && cfg.sensitivity !== this.sensitivity) {
                this.sensitivity = cfg.sensitivity; this.specCache.clear(); this._specLast = null; needRedraw = true;
            }
            if (cfg.palette && cfg.palette !== this._paletteName) {
                this._paletteName = cfg.palette; this.specCache.clear(); this._specLast = null; needRedraw = true;
            }
            if (Array.isArray(cfg.custom) && cfg.custom.join(',') !== this._specCustom.join(',')) {
                this._specCustom = cfg.custom.slice(0, 3); this.specCache.clear(); this._specLast = null; needRedraw = true;
            }
            if (Number.isFinite(cfg.logBase) && cfg.logBase !== this._specLogBase) {
                this._specLogBase = cfg.logBase; this.specCache.clear(); this._specLast = null; needRedraw = true;
            }
            if (Number.isFinite(cfg.peakThreshold) && cfg.peakThreshold !== this._peakThreshold) {
                this._peakThreshold = cfg.peakThreshold; this.specCache.clear(); this._specLast = null; needRedraw = true;
            }
            if (cfg.peakColor && cfg.peakColor !== this._peakColor) {
                this._peakColor = cfg.peakColor; this.specCache.clear(); this._specLast = null; needRedraw = true;
            }
            if (cfg.waveColor && cfg.waveColor !== this._waveColor) {
                this._waveColor = cfg.waveColor; this._waveLast = null; needRedraw = true;
            }
            if (cfg.invert !== undefined && !!cfg.invert !== this._specInvert) {
                this._specInvert = !!cfg.invert; this.specCache.clear(); this._specLast = null; needRedraw = true;
            }
            if (Number.isFinite(cfg.renderScale) && cfg.renderScale !== this._renderScale) {
                this._renderScale = cfg.renderScale;
                // 渲染倍率变了 → 画布设备尺寸变 → 平移复用与列缓存全部作废
                this._waveLast = null; this._specLast = null; this.specCache.clear();
                this._applySizes();
                needRedraw = true;
            }
            if (Number.isFinite(cfg.beatLineDelayMs)) {
                const sec = cfg.beatLineDelayMs / 1000;
                if (Math.abs(sec - this._beatLineDelaySec) > 1e-9) { this._beatLineDelaySec = sec; needRedraw = true; }
            }
            if (cfg.showWaveform !== undefined) this._showWaveform = !!cfg.showWaveform;
            if (cfg.showSpectrogram !== undefined) this._showSpectrogram = !!cfg.showSpectrogram;
            // 自动翻页跟随（需求 4 的按钮状态持久化在 config.visual.autoFollow）
            if (cfg.autoFollow !== undefined) this.setAutoFollow(cfg.autoFollow);
            // ★ v0.8.7：兜底心跳帧率（rAF 停摆时才生效的"保底帧率"）
            if (cfg.fallbackFps !== undefined) this.setFallbackFps(cfg.fallbackFps);

            if (needSpecRecompute && this.audio) {
                // ★ v0.8.12：走同一个调度器 —— 拖动 fftSize 滑条会连续触发，同样不能叠着跑
                this._specPending = { buffer: this.audio.buffer, token: ++this._specPreToken };
                this._scheduleSpecPrecompute();
            }
            if (needRedraw) this._fullRedraw();
        }

        // ---------- 绘制 ----------
        _fullRedraw() {
            this._drawWaveform();
            this._drawSpectrogram();
            this._drawOverlay();
        }

        _getTmp(w, h) {
            let tmp = this._tmpCanvas;
            if (!tmp) { tmp = document.createElement('canvas'); this._tmpCanvas = tmp; }
            if (tmp.width !== w) tmp.width = w;
            if (tmp.height !== h) tmp.height = h;
            return tmp;
        }

        _drawWaveform() {
            const c = this.waveCanvas;
            const ctx = c.getContext('2d');
            const dpr = this._dpr();
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            const waveHeight = this.waveHeight;
            if (this.width <= 0 || waveHeight <= 0) return;

            if (!this.audio || this._showWaveform === false) {
                ctx.fillStyle = '#0a0a0a';
                ctx.fillRect(0, 0, this.width, waveHeight);
                return;
            }

            const drawColumns = (x0, x1) => {
                const s0 = Math.max(0, Math.floor(x0));
                const s1 = Math.min(this.width, Math.ceil(x1));
                if (s1 <= s0) return;
                const raw = this.audio.rawData;
                const sr = this.audio.sampleRate;
                const step = Math.max(1, Math.ceil(sr / this.zoom));
                const centerY = waveHeight / 2;
                const amp = waveHeight / 2;
                ctx.beginPath();
                ctx.strokeStyle = this._waveColor;
                ctx.lineWidth = 1;
                for (let x = s0; x < s1; x++) {
                    const t = this.xToTime(x);
                    const idx = Math.floor(t * sr);
                    if (idx < 0 || idx >= raw.length) continue;
                    let mn = 1, mx = -1;
                    const end = Math.min(idx + step, raw.length);
                    const stride = Math.max(1, Math.floor((end - idx) / 10));
                    for (let i = idx; i < end; i += stride) {
                        const v = raw[i];
                        if (v < mn) mn = v;
                        if (v > mx) mx = v;
                    }
                    if (mn > mx) { mn = 0; mx = 0; }
                    ctx.moveTo(x, centerY + mn * amp);
                    ctx.lineTo(x, centerY + mx * amp);
                }
                ctx.stroke();
            };

            const last = this._waveLast;
            const same = last && last.zoom === this.zoom && last.waveColor === this._waveColor && last.w === this.width && last.h === waveHeight;
            const dx = last ? Math.round(last.scrollLeft - this.scrollLeft) : 0;

            if (same && dx !== 0 && Math.abs(dx) < this.width) {
                // 平移复用：旧内容整体平移 dx，只重绘露出的边缘条
                const tmp = this._getTmp(c.width, c.height);
                const tctx = tmp.getContext('2d');
                tctx.clearRect(0, 0, tmp.width, tmp.height);
                tctx.drawImage(c, 0, 0);
                ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, dx, 0, this.width, waveHeight);
                if (dx > 0) { ctx.fillStyle = '#0a0a0a'; ctx.fillRect(0, 0, dx, waveHeight); drawColumns(0, dx); }
                else { ctx.fillStyle = '#0a0a0a'; ctx.fillRect(this.width + dx, 0, -dx, waveHeight); drawColumns(this.width + dx, this.width); }
            } else {
                ctx.fillStyle = '#0a0a0a';
                ctx.fillRect(0, 0, this.width, waveHeight);
                ctx.beginPath();
                ctx.strokeStyle = '#1a1a1a';
                ctx.lineWidth = 1;
                ctx.moveTo(0, waveHeight / 2);
                ctx.lineTo(this.width, waveHeight / 2);
                ctx.stroke();
                drawColumns(0, this.width);
            }
            this._waveLast = { zoom: this.zoom, scrollLeft: this.scrollLeft, waveColor: this._waveColor, w: this.width, h: waveHeight };
        }

        _drawSpectrogram() {
            const c = this.specCanvas;
            const ctx = c.getContext('2d');
            const dpr = this._dpr();
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            const specHeight = this.specHeight;
            if (this.width <= 0 || specHeight <= 0) return;

            if (!this.audio || this._showSpectrogram === false) {
                ctx.fillStyle = '#000';
                ctx.fillRect(0, 0, this.width, specHeight);
                return;
            }

            const fullWidth = Math.floor(this.width * dpr);
            const fullHeight = Math.floor(specHeight * dpr);
            const raw = this.audio.rawData;
            const sr = this.audio.sampleRate;
            const n = this.fftSize;
            const numBins = n / 2;
            const base = this._specLogBase;
            const hann = getHann(n);
            const re = new Float32Array(n);
            const im = new Float32Array(n);
            const specData = this.specData;
            // ★ FFT 归一化系数 2/N —— 与软件 audioUtils.computeFFT 一致。
            //   不做归一化的话 |X| 能到 N/4（≈+48dB），
            //   代入 val=(db+sens)/sens 会直接顶到 1 → 整块饱和成亮黄（踩过）。
            const fftScale = 2 / n;

            // ---- 查找表（每次重绘前确保是最新的；参数变了才真重建）----
            const colorLUT = this._ensureColorLUT();
            const binLUT = this._ensureBinLUT(numBins, fullHeight, base);
            const B0 = binLUT.b0, B1 = binLUT.b1, BF = binLUT.bf, FQ = binLUT.fq;
            // u8ToVal(v, sens) 的线性部分拆成两个常量，省掉每像素一次函数调用
            const sens = this.sensitivity;
            const u8K = (DB_RANGE / sens) / 255;
            const u8B = (DB_MIN + sens) / sens;
            // 颜色表索引：((val*255)|0)<<8 | 频率量化
            const VQ = 255;

            // 计算 [x0, x1)（CSS 像素）区间的频谱列并写入画布
            const drawSpecRegion = (x0, x1) => {
                const px0 = Math.max(0, Math.floor(x0 * dpr));
                const px1 = Math.min(fullWidth, Math.ceil(x1 * dpr));
                if (px1 <= px0) return;
                const colW = px1 - px0;
                const idata = ctx.createImageData(colW, fullHeight);
                const buf = new Uint32Array(idata.data.buffer);
                for (let px = 0; px < colW; px++) {
                    const t = this.xToTime((px0 + px) / dpr);
                    if (t < 0 || t >= this.audio.duration) continue;
                    const sampleIdx = Math.floor(t * sr);
                    if (sampleIdx < 0 || sampleIdx + n >= raw.length) continue;

                    let col = this.specCache.get(sampleIdx);
                    if (!col) {
                        // 优先用原生 FFT 预计算列（零 FFT 计算）；否则回退 JS FFT
                        let preCol0 = null;
                        let preCol1 = null;
                        let preFrac = 0;
                        if (specData && specData.data.length > 0) {
                            const blockF = sampleIdx / specData.hop;
                            const b0 = Math.floor(blockF);
                            preCol0 = specData.data[b0] ?? null;
                            preCol1 = specData.data[b0 + 1] ?? preCol0;
                            preFrac = blockF - b0;
                        }
                        col = new Uint32Array(fullHeight);
                        if (preCol0) {
                            for (let y = 0; y < fullHeight; y++) {
                                const a = B0[y], c = B1[y], f = BF[y];
                                // 双线性插值：先频率方向（两列各自），再时间方向（相邻列混合）
                                const vF0 = preCol0[a] * (1 - f) + preCol0[c] * f;
                                const vF1 = preCol1[a] * (1 - f) + preCol1[c] * f;
                                const vv = vF0 * (1 - preFrac) + vF1 * preFrac;
                                // 反量化 → 0~1 显示强度（等价 u8ToVal，展开成两次乘加）
                                let val = vv * u8K + u8B;
                                if (val < 0) val = 0; else if (val > 1) val = 1;
                                col[y] = colorLUT[(((val * VQ) | 0) << 8) | FQ[y]];
                            }
                        } else {
                            for (let i = 0; i < n; i++) { re[i] = raw[sampleIdx + i] * hann[i]; im[i] = 0; }
                            computeFFT(re, im);
                            for (let y = 0; y < fullHeight; y++) {
                                const a = B0[y], c = B1[y], f = BF[y];
                                const mag = (Math.sqrt(re[a] * re[a] + im[a] * im[a]) * (1 - f)
                                    + Math.sqrt(re[c] * re[c] + im[c] * im[c]) * f) * fftScale;
                                const db = 20 * Math.log10(mag + 1e-9);
                                let val = (db + sens) / sens;
                                if (val < 0) val = 0; else if (val > 1) val = 1;
                                col[y] = colorLUT[(((val * VQ) | 0) << 8) | FQ[y]];
                            }
                        }
                        this.specCache.set(sampleIdx, col);
                        if (this.specCache.size > 3000) {
                            const k = this.specCache.keys().next().value;
                            if (k !== undefined) this.specCache.delete(k);
                        }
                    }
                    // 缓存列按自然 y 顺序（顶部=低频）；复制到 ImageData 时反转行，
                    // 保证画布顶部显示高频、底部显示低频（与软件方向一致）
                    for (let y = 0; y < fullHeight; y++) {
                        buf[y * colW + px] = col[fullHeight - 1 - y];
                    }
                }
                ctx.putImageData(idata, px0, 0);
            };

            const last = this._specLast;
            // ★ 分两个判据（性能关键）：
            //   colSame —— "列内容"是否可复用。只跟颜色映射/频率映射/行数有关，
            //              **不含 zoom / scrollLeft / 宽度**：缩放平移都不改变任何一列像素，
            //              以前把它们算进 sameParams 导致每次滚轮 zoom 都把整个列缓存清空重算，
            //              缩放时直接卡成 PPT（软件《性能诊断报告》根因 4 同款问题）。
            const colSame = last && last.logBase === base && last.palette === this._paletteName
                && last.custom === this._specCustom.join(',')
                && last.peakThreshold === this._peakThreshold && last.peakColor === this._peakColor
                && last.invert === this._specInvert
                && last.sensitivity === this.sensitivity && last.h === specHeight && last.dpr === dpr;
            if (!colSame) this.specCache.clear();
            // 平移复用还要求参数与视图都一致（否则只能全量重绘）
            const same = colSame && last.zoom === this.zoom && last.w === this.width;
            const dx = last ? Math.round(last.scrollLeft - this.scrollLeft) : 0;

            if (same && dx !== 0 && Math.abs(dx) < this.width) {
                const tmp = this._getTmp(fullWidth, fullHeight);
                const tctx = tmp.getContext('2d');
                tctx.clearRect(0, 0, fullWidth, fullHeight);
                tctx.drawImage(c, 0, 0);
                ctx.drawImage(tmp, 0, 0, fullWidth, fullHeight, dx, 0, this.width, specHeight);
                if (dx > 0) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, dx, specHeight); drawSpecRegion(0, dx); }
                else { ctx.fillStyle = '#000'; ctx.fillRect(this.width + dx, 0, -dx, specHeight); drawSpecRegion(this.width + dx, this.width); }
            } else {
                this._cancelSpecRender();
                ctx.fillStyle = '#000';
                ctx.fillRect(0, 0, this.width, specHeight);
                // ★ 有原生 FFT 预计算列时 → 一次同步画完。
                //   此时每列只是"取列 + 双线性插值"（无 FFT），968 列 ×161px 约十几毫秒，
                //   完全可以同步完成。踩过的坑：改用 requestAnimationFrame 分帧时，
                //   窗口被遮挡 / 不可见（如 screenshot 模式的 show:false 窗口）会被
                //   Chromium 节流甚至完全不触发 → 只画出第一批 60px，右侧全黑，看起来像"没渲染"。
                if (specData && specData.data.length > 0) {
                    drawSpecRegion(0, this.width);
                } else {
                    // 纯 JS FFT 回退 → 分帧渐进渲染（每帧一批列，避免一次性算完整曲 FFT 卡死主线程）
                    const batchPx = 60;
                    let cur = 0;
                    const step = () => {
                        if (cur >= fullWidth) { this._specRaf = null; return; }
                        const next = Math.min(fullWidth, cur + batchPx);
                        drawSpecRegion(cur / dpr, next / dpr);
                        cur = next;
                        this._specRaf = requestAnimationFrame(step);
                    };
                    this._specRaf = requestAnimationFrame(step);
                }
            }
            this._specLast = {
                zoom: this.zoom, scrollLeft: this.scrollLeft, logBase: base, palette: this._paletteName,
                custom: this._specCustom.join(','),
                peakThreshold: this._peakThreshold, peakColor: this._peakColor, invert: this._specInvert,
                sensitivity: this.sensitivity, w: this.width, h: specHeight, dpr
            };
        }

        _cancelSpecRender() {
            if (this._specRaf !== null) { cancelAnimationFrame(this._specRaf); this._specRaf = null; }
        }

        /**
         * 绘制刻度尺 + 红线（段起点）+ 蓝线（节拍线）。
         * 与软件 Visualizer.tsx 的 drawOverlayRegion 一一对应：
         *   ① 时间刻度尺：竖线从 22px 起画到底部，标签在 y=14
         *   ② 红线：2px 实线贯穿内容区，箭头在内容区下方，标该红线的全局拍号
         *   ③ 蓝线：1px（每拍一条，间距 60/BPM），箭头同样，每 4 拍标一次全局拍号
         *   ★ 红蓝重合时先画红后画蓝 —— 蓝线叠在红线上，红线不盖蓝线
         */
        _drawOverlay() {
            const c = this.overlayCanvas;
            const ctx = c.getContext('2d');
            const dpr = this._dpr();
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

            // ★ 重绘签名：refresh() 每 100ms 调一次本函数，内容没变就跳过 ——
            //   否则 96 条红线 + 全部拍线每秒白画 10 遍，白烧 CPU（拖频谱时抢帧）。
            const sig = [
                this.width, this.height, this.zoom.toFixed(3), this.scrollLeft.toFixed(3),
                this._beatLineDelaySec.toFixed(4), this.selectedIndex,
                this._showWaveform === false ? 0 : 1,
                (this._reds || []).map((r) => r.time + ':' + r.bpm + ':' + r.beatIndex).join('|')
            ].join('#');
            if (sig === this._overlaySig) return;
            this._overlaySig = sig;

            ctx.clearRect(0, 0, this.width, this.height);
            if (this.width <= 0 || this.height <= 0) return;

            const delay = this._beatLineDelaySec;
            const reds = this._reds || [];
            const duration = this._duration();
            const startTime = this.xToTime(0);
            const endTime = this.xToTime(this.width);

            // ---- ① 顶部时间刻度尺（铺满整高，含底部时间轴区）----
            ctx.textAlign = 'center';
            const rawStepSec = RULER_TARGET_PX / this.zoom;
            const stepSec = STEP_SECS.find((s) => s >= rawStepSec) || 600;
            const startSec = Math.floor(startTime / stepSec) * stepSec;
            ctx.font = '10px sans-serif';
            for (let sec = startSec; sec <= endTime; sec += stepSec) {
                const x = this.timeToX(sec);
                if (x < -60 || x > this.width + 60) continue;
                ctx.strokeStyle = 'rgba(255,255,255,0.10)';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(x, RULER_H);
                ctx.lineTo(x, this.height);
                ctx.stroke();
                ctx.fillStyle = 'rgba(255,255,255,0.5)';
                const mm = Math.floor(sec / 60);
                const ss = (sec % 60).toFixed(stepSec < 1 ? 1 : 0);
                ctx.fillText(`${mm}:${ss.padStart(stepSec < 1 ? 4 : 2, '0')}`, x, 14);
            }

            if (!reds.length || duration <= 0) return;

            const contentBottom = this.contentBottom;
            const arrowY0 = contentBottom + 6;
            // 段起点时间集合：蓝线编号与红线编号重合时不再标，避免文字叠在一起
            const sectionStartSet = new Set(reds.map((p) => Math.round((p.time + delay) * 1000)));

            // ---- ② 红线（段起点，2px；v0.8.10 按需求取消"选中高亮"，统一样式）----
            ctx.font = 'bold 12px sans-serif';
            for (let i = 0; i < reds.length; i++) {
                const p = reds[i];
                const x = this.timeToX(p.time + delay);
                if (x < -2 || x > this.width + 2) continue;
                ctx.beginPath();
                ctx.strokeStyle = '#ef4444';
                ctx.lineWidth = 2;
                ctx.moveTo(x, 0);
                ctx.lineTo(x, contentBottom);
                ctx.stroke();
                ctx.fillStyle = '#ef4444';
                ctx.beginPath();
                ctx.moveTo(x, arrowY0);
                ctx.lineTo(x - 5, arrowY0 + 8);
                ctx.lineTo(x + 5, arrowY0 + 8);
                ctx.fill();
                ctx.fillText(String(p.beatIndex), x, arrowY0 + 22);
            }

            // ---- ③ 蓝线（节拍线，1px，每拍一条；密度由该段 BPM 决定）----
            for (let i = 0; i < reds.length; i++) {
                const p = reds[i];
                const next = reds[i + 1];
                const sectionEnd = next ? next.time : duration;
                if (sectionEnd < startTime) continue;
                if (p.time > endTime) break;
                const interval = 60 / (p.bpm || 120);
                // 从可见区左边界起算，避免画几万条屏外拍线
                const visibleStart = Math.max(startTime, p.time);
                const startBeatRel = Math.max(1, Math.ceil((visibleStart - p.time) / interval));
                let relIndex = startBeatRel;
                let guard = 0;
                while (guard++ < 20000) {
                    const beatIndex = p.beatIndex + relIndex;
                    const time = p.time + relIndex * interval;
                    if (next && beatIndex >= next.beatIndex) break;
                    if (time > Math.min(endTime, sectionEnd)) break;
                    // 红线节拍线延迟：只偏移拍线的显示位置（刻度尺/频谱/波形不受影响）
                    const x = this.timeToX(time + delay);
                    if (x >= -2 && x <= this.width + 2) {
                        ctx.beginPath();
                        ctx.strokeStyle = 'rgba(0, 242, 255, 0.6)';
                        ctx.lineWidth = 1;
                        ctx.moveTo(x, 0);
                        ctx.lineTo(x, contentBottom);
                        ctx.stroke();
                        ctx.fillStyle = 'rgba(0, 242, 255, 0.8)';
                        ctx.beginPath();
                        ctx.moveTo(x, arrowY0);
                        ctx.lineTo(x - 5, arrowY0 + 8);
                        ctx.lineTo(x + 5, arrowY0 + 8);
                        ctx.fill();
                        // 每 4 拍标一次全局拍号；与红线重合处不标（避免文字重叠）
                        if (relIndex % 4 === 0 && !sectionStartSet.has(Math.round((time + delay) * 1000))) {
                            ctx.fillStyle = '#00f2ff';
                            ctx.fillText(String(beatIndex), x, arrowY0 + 22);
                        }
                    }
                    relIndex++;
                }
            }
        }

        _drawPlayhead() {
            const c = this.playheadCanvas;
            const ctx = c.getContext('2d');
            const dpr = this._dpr();
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, this.width, this.height);
            const st = this.getState();
            const t = st && st.time ? st.time : 0;
            const x = this.timeToX(t);
            if (x < -8 || x > this.width + 8) return;
            // 白色主线 + 顶部青色三角（AU 风格）
            ctx.beginPath();
            ctx.strokeStyle = 'rgba(255,255,255,0.9)';
            ctx.lineWidth = 2;
            ctx.moveTo(x, 0);
            ctx.lineTo(x, this.height);
            ctx.stroke();
            ctx.fillStyle = '#22d3ee';
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x - 5, 8);
            ctx.lineTo(x + 5, 8);
            ctx.closePath();
            ctx.fill();
        }

        // ---------- 渲染循环 ----------
        start() {
            if (this._raf) return;
            this._lastRafAt = performance.now();
            this._statAt = performance.now();
            const loop = () => {
                // 已被 stop() 取消 → 不再续期（否则 stop 之后会被"复活"）
                if (!this._raf) return;
                this._raf = requestAnimationFrame(loop);
                this._lastRafAt = performance.now();
                // ---- 帧率统计（v0.8.7）：只计数，不改变绘制行为 ----
                this._statRaf++;
                this._statDrawRaf++;
                this._tickStat();
                this._drawPlayhead();
                this._followPlayhead();
            };
            this._raf = requestAnimationFrame(loop);

            // ★ 渲染心跳兜底：rAF 只在"页面可见"时才被 Chromium 派发 ——
            //   挂着侧栏切进 osu! 全屏编辑谱面时，窗口被游戏完全盖住，
            //   某些驱动 / 独占全屏下 rAF 会**直接停摆**（播放头定住、
            //   自动翻页失效、频谱看起来"冻住"），正是"频谱预览卡顿、低帧率"。
            //   主进程已关掉遮挡检测与后台节流（尽量不让页面变 hidden），
            //   但一旦环境仍把页面判为不可见，就只剩定时器这条路：
            //   setInterval 受 disable-background-timer-throttling 保护，稳。
            //   仅在 rAF 真失联（超 RAF_STALL_MS 没回调）时才出手，
            //   两者同时活着时不会重复绘制（也就不会浪费一倍 CPU）。
            //   ★ v0.8.7：间隔改成 this._fallbackMs（默认 33ms，可调）——
            //     它就是"rAF 停摆时的实际帧率"，30fps 那个观感就来自这里。
            this._startFallbackTimer();
        }

        /** 按当前 this._fallbackMs 建/重建兜底定时器（改帧率时热更新） */
        _startFallbackTimer() {
            if (this._fallbackTimer !== null) { clearInterval(this._fallbackTimer); this._fallbackTimer = null; }
            if (!this._raf) return; // 没在跑就不用建
            this._fallbackTimer = setInterval(() => {
                if (performance.now() - this._lastRafAt <= RAF_STALL_MS) return;
                this._statDrawFallback++;
                this._tickStat();
                this._drawPlayhead();
                this._followPlayhead();
            }, this._fallbackMs);
        }

        /**
         * 设置兜底帧率（rAF 停摆时的保底绘制帧率）。
         * @param {number} fps 0/未设 = 恢复默认 33ms；>0 = 该帧率；-1 = 跟随屏幕刷新率
         *   （用 Math.max(1, ...) 保证最少 1ms，避免 setInterval(0) 被浏览器夹成 4ms 的歧义）
         */
        setFallbackFps(fps) {
            const f = Number(fps);
            let ms = FALLBACK_INTERVAL_DEFAULT_MS;
            if (f === -1) {
                // 跟随屏幕刷新率 → 每帧一次（Chromium 下 setInterval 最小约 1ms）
                ms = 1;
            } else if (Number.isFinite(f) && f > 0) {
                ms = Math.round(1000 / f);
            }
            ms = Math.max(1, ms);
            if (ms === this._fallbackMs) return;
            this._fallbackMs = ms;
            if (this._raf) this._startFallbackTimer();
        }

        /**
         * 每 500ms 结算一次帧率统计。判据设计（v0.8.7）：
         *   · raf 高 + fallback=0 → rAF 健康，画面不流畅的原因只能在"数据节奏"
         *   · raf ≈0 + fallback 高 → rAF 真停摆，此时实际帧率 = 1000/_fallbackMs
         * 这两种情况的修法完全不同，所以必须能分开看。
         */
        _tickStat() {
            const now = performance.now();
            if (now - this._statAt < 500) return;
            const span = (now - this._statAt) / 1000;
            // rAF 失联时长：绘制时"上次 rAF 回调"距今多久（>RAF_STALL_MS 即视为停摆）
            const stallMs = Math.max(0, now - this._lastRafAt);
            this.frameStat = {
                raf: this._statRaf / span,
                draw: (this._statDrawRaf + this._statDrawFallback) / span,
                fallback: this._statDrawFallback / span,
                stall: stallMs > RAF_STALL_MS,
                hidden: document.hidden,
                vis: document.visibilityState,
                at: now
            };
            this._statRaf = 0;
            this._statDrawRaf = 0;
            this._statDrawFallback = 0;
            this._statAt = now;
        }

        stop() {
            if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
            if (this._fallbackTimer !== null) { clearInterval(this._fallbackTimer); this._fallbackTimer = null; }
            this.frameStat = null;
            this._cancelSpecRender();
            if (this._panRaf !== null) { cancelAnimationFrame(this._panRaf); this._panRaf = null; }
            if (this._wheelRaf !== null) { cancelAnimationFrame(this._wheelRaf); this._wheelRaf = null; }
        }

        // ---------- 交互 ----------
        _bind() {
            const c = this.overlayCanvas;
            c.addEventListener('mousedown', (e) => this._onDown(e));
            c.addEventListener('dblclick', (e) => this._onDblClick(e));
            this._onMove = (e) => this._move(e);
            this._onUp = (e) => this._up(e);
            window.addEventListener('mousemove', this._onMove);
            window.addEventListener('mouseup', this._onUp);
            // ★ 滚轮缩放：rAF 节流（滚轮事件可能远超刷新率）。
            //   累加 deltaY，每帧最多应用一次缩放 —— 与软件 Visualizer 的 panRaf 同思路，
            //   避免"一格滚轮一次全量重绘"把帧率打穿。
            c.addEventListener('wheel', (e) => {
                e.preventDefault();
                const rect = c.getBoundingClientRect();
                this._wheelAnchorX = e.clientX - rect.left;
                this._wheelAcc += (e.deltaY > 0 ? 1 : -1);
                if (this._wheelAcc > 3) this._wheelAcc = 3;
                if (this._wheelAcc < -3) this._wheelAcc = -3;
                if (this._wheelRaf !== null) return;
                this._wheelRaf = requestAnimationFrame(() => {
                    this._wheelRaf = null;
                    const acc = this._wheelAcc;
                    this._wheelAcc = 0;
                    if (!acc) return;
                    const mx = this._wheelAnchorX;
                    const anchorTime = this.xToTime(mx);
                    // 累加量映射到缩放倍数（每格约 1.18）
                    const factor = Math.pow(1.18, acc);
                    this.zoom = Math.max(20, Math.min(2000, this.zoom * factor));
                    this.scrollLeft = Math.max(0, anchorTime * this.zoom - mx);
                    this._fullRedraw();
                });
            }, { passive: false });
        }

        /**
         * 双击：
         *   · 命中红线（±9px，**任意高度**）→ 选中该红线并把视图滚动到它居中（**不改播放位置**）
         *     —— 红线是贯穿上下的竖线，所以在频谱/声谱区双击红线同样要生效
         *   · 未命中红线、且在底部时间轴区 → 在该时间点快捷新增一条红线（继承所在段 BPM）
         */
        _onDblClick(e) {
            const duration = this._duration();
            if (duration <= 0) return;
            const rect = this.overlayCanvas.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            this._layout();
            const reds = this._reds || [];
            if (!reds.length) return;

            // ★ 先在**任意高度**找最近的红线。
            //   原实现开头就是 `if (my <= this.contentBottom) return;`（只响应底部时间轴区），
            //   于是"双击频谱里的那条红线"直接返回、毫无反应 —— 即用户反馈的第 4 条。
            //   红线绘制上本就纵贯波形/声谱区，双击它没有任何理由被高度限制。
            let bestIdx = -1;
            let bestDist = 9;
            for (let i = 0; i < reds.length; i++) {
                const d = Math.abs(this.timeToX(reds[i].time + this._beatLineDelaySec) - mx);
                if (d <= bestDist) { bestDist = d; bestIdx = i; }
            }
            if (bestIdx >= 0) {
                this.selectRed(bestIdx, { jump: true });
                return;
            }

            // 未命中红线：只有底部时间轴区才允许"空白处双击新增红线"
            // （否则在频谱区随手双击都会凭空加一条线）
            if (my <= this.contentBottom) return;
            const timeMs = Math.max(0, Math.round((this.xToTime(mx) - this._beatLineDelaySec) * 1000));
            this.onEditTiming({ type: 'add', timeMs });
        }

        _onDown(e) {
            const duration = this._duration();
            if (duration <= 0) return;
            const rect = this.overlayCanvas.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            this._layout();
            const reds = this._reds || [];
            const delay = this._beatLineDelaySec;

            if (my > this.contentBottom) {
                // 底部时间轴区：按显示位置换算真实时间（扣回节拍线延迟）
                const mouseTime = this.xToTime(mx) - delay;

                // ① 红线优先：抓住红线的箭头顶端/竖线即可左右拖动 → 直接改这条红线的时间戳
                let bestIdx = -1;
                let bestDist = 8; // 命中半径（像素）
                for (let i = 1; i < reds.length; i++) { // i=0 是起点锚点，走 Offset 拖动
                    const d = Math.abs(this.timeToX(reds[i].time + delay) - mx);
                    if (d <= bestDist) { bestDist = d; bestIdx = i; }
                }
                if (bestIdx !== -1) {
                    this.selectRed(bestIdx);
                    this.dragging = { type: 'redline', redIndex: bestIdx, startX: mx, lastTime: reds[bestIdx].time };
                    return;
                }

                // ② 再找最近的拍线（含各段起点）
                let best = null;
                for (let i = 0; i < reds.length; i++) {
                    const p = reds[i];
                    const next = reds[i + 1];
                    const sectionEnd = next ? next.time : duration;
                    if (p.time > mouseTime + 1) break;
                    if (sectionEnd < mouseTime - 1) continue;
                    const interval = 60 / (p.bpm || 120);
                    const beats = Math.round((mouseTime - p.time) / interval);
                    const time = p.time + beats * interval;
                    if (beats < 0) continue;
                    if (next && p.beatIndex + beats >= next.beatIndex) continue;
                    const dist = Math.abs(this.timeToX(time + delay) - mx);
                    if (dist < 15 && (!best || dist < best.dist)) {
                        best = { dist, index: i, beats };
                    }
                }
                if (best) {
                    if (best.beats === 0 && best.index === 0) {
                        // 起点锚点 → 改全局 Offset
                        this.selectRed(0);
                        this.dragging = { type: 'offset', startX: mx, initialVal: reds[0].time };
                    } else if (best.beats === 0) {
                        // 其它红线 → 拖这根红线本身
                        this.selectRed(best.index);
                        this.dragging = { type: 'redline', redIndex: best.index, startX: mx, lastTime: reds[best.index].time };
                    } else {
                        // 蓝线 → 改该段 BPM（同时选中该段红线，编辑栏可对照）
                        this.selectRed(best.index);
                        // ★ v0.8.16 修真 bug（用户报「侧栏的红线可以拖动，但是蓝线不能拖动改变 BPM」）：
                        //   这里原来写的是对象简写 `beats` —— 但 beats 是上面 for 循环里的
                        //   `const beats`，出了循环就不可见，于是这一行抛
                        //   ReferenceError: beats is not defined，整个 mousedown 处理中断：
                        //     · dragging 没被赋值 → 蓝线拖不动；
                        //     · 连后面的 panState 也一起没设（fall-through 被打断）→ 那一按彻底没反应。
                        //   红线走的是上面两个分支（不碰这行），所以表现正是"红线能拖、蓝线不能"。
                        //   正确写法是取候选对象上的 best.beats。
                        this.dragging = { type: 'bpm', redIndex: best.index, beats: best.beats, startX: mx, initialVal: reds[best.index].bpm };
                    }
                    return;
                }
            }
            // 波形/声谱区：按下先不动作，区分"点击跳转"与"拖拽平移"。
            // 顺带记下落点附近有没有红线：抬手时若没拖动过就选中它
            // —— 兑现界面上那句"点频谱红线 → 跳到对应段落卡片"（原来只有底部时间轴区能点中）
            let hitRed = -1;
            let hitDist = 8;
            for (let i = 0; i < reds.length; i++) {
                const d = Math.abs(this.timeToX(reds[i].time + delay) - mx);
                if (d <= hitDist) { hitDist = d; hitRed = i; }
            }
            this.panState = { startX: mx, startScroll: this.scrollLeft, moved: false, hitRed };
        }

        _move(e) {
            if (this.dragging) {
                const rect = this.overlayCanvas.getBoundingClientRect();
                const mx = e.clientX - rect.left;
                const mouseTime = this.xToTime(mx) - this._beatLineDelaySec;
                const d = this.dragging;

                if (d.type === 'offset') {
                    const ms = Math.max(0, Math.round(mouseTime * 1000));
                    this._applyLocalEdit({ type: 'offset', offsetMs: ms });
                    this.onEditTiming({ type: 'offset', offsetMs: ms });
                } else if (d.type === 'redline') {
                    const ms = Math.max(0, Math.round(mouseTime * 1000));
                    d.lastTime = ms / 1000;
                    this._applyLocalEdit({ type: 'redline', redIndex: d.redIndex, timeMs: ms });
                    this.onEditTiming({ type: 'redline', redIndex: d.redIndex, timeMs: ms });
                } else if (d.type === 'bpm') {
                    const reds = this._reds;
                    const p = reds[d.redIndex];
                    if (!p || d.beats === 0) return;
                    const timeDiff = mouseTime - p.time;
                    if (timeDiff <= 0.001) return;
                    const rounded = Math.round(((d.beats * 60) / timeDiff) * 100) / 100;
                    if (rounded > 10 && rounded < 1000) {
                        this._applyLocalEdit({ type: 'bpm', redIndex: d.redIndex, bpm: rounded });
                        this.onEditTiming({ type: 'bpm', redIndex: d.redIndex, bpm: rounded });
                    }
                }
                // 拖拽期间本地立即重绘 → 红/蓝线跟着鼠标走（不等 100ms 轮询）
                this._drawOverlay();
                return;
            }
            if (this.panState) {
                const rect = this.overlayCanvas.getBoundingClientRect();
                this._panMouseX = e.clientX - rect.left;
                const dx = this._panMouseX - this.panState.startX;
                if (!this.panState.moved && Math.abs(dx) < 4) return; // 超过 4px 才算拖拽
                // ★ rAF 节流：mousemove 可能远高于刷新率（游戏鼠标 500~1000Hz），
                //   每帧最多更新一次滚动并重绘 —— 与软件 Visualizer 的 panRafRef 一致。
                if (this._panRaf !== null) return;
                this._panRaf = requestAnimationFrame(() => {
                    this._panRaf = null;
                    if (!this.panState) return;
                    const mx = this._panMouseX;
                    const d = mx - this.panState.startX;
                    if (!this.panState.moved && Math.abs(d) < 4) return;
                    const maxScroll = Math.max(0, this._duration() * this.zoom - this.width);
                    this.scrollLeft = Math.max(0, Math.min(this.panState.startScroll - d, maxScroll));
                    this.panState.moved = true;
                    this._fullRedraw();
                });
            }
        }

        _up(e) {
            if (this.panState && !this.panState.moved && this._duration() > 0) {
                // 按下后没拖动 → 先看落点是否命中了红线：
                //   命中 → 选中它（onSelect 会把 ① 的卡片滚过去并高亮）
                //   否则 → 视为点击跳转播放位置（侧栏控制不了 osu!，交给上层决定怎么用）
                const rect = this.overlayCanvas.getBoundingClientRect();
                const mx = e.clientX - rect.left;
                const hit = this.panState.hitRed;
                if (hit !== undefined && hit >= 0) this.selectRed(hit);
                else this.onEditTiming({ type: 'seek', time: this.xToTime(mx) });
            }
            if (this._panRaf !== null) { cancelAnimationFrame(this._panRaf); this._panRaf = null; }
            this.dragging = null;
            this.panState = null;
        }

        /**
         * 拖拽期间本地乐观更新（红线跟着鼠标走）。
         * 刻意**不排序**：拖拽中保持下标稳定，避免拖过邻线时跳到别的红线上；
         * 主进程会排序，下一轮轮询（refresh）会拿回权威顺序。
         */
        _applyLocalEdit(edit) {
            const reds = this._reds;
            if (!reds || !reds.length) return;
            if (edit.type === 'offset') {
                const delta = edit.offsetMs / 1000 - reds[0].time;
                for (const r of reds) r.time = Math.max(0, r.time + delta);
            } else if (edit.type === 'redline') {
                const r = reds[edit.redIndex];
                if (r) r.time = Math.max(0, edit.timeMs / 1000);
            } else if (edit.type === 'bpm') {
                const r = reds[edit.redIndex];
                if (r) r.bpm = edit.bpm;
            }
            this._deriveBeatIndex(reds);
        }

        /**
         * 每轮轮询调用：从主进程状态同步红线并重绘 overlay。
         * 拖拽中不覆盖本地状态（避免和鼠标打架），松手后自然同步回来。
         */
        refresh() {
            if (!this.dragging) {
                this._reds = this._redsFromState();
                // 主进程可能按时间重排过 → 按"选中时的时间"重新定位选中项，
                // 否则编辑栏会指到别的红线上
                if (this.selectedIndex >= 0 && this._selectedTime !== null && this._selectedTime !== undefined) {
                    let best = -1;
                    let bd = Infinity;
                    this._reds.forEach((r, i) => { const d = Math.abs(r.time - this._selectedTime); if (d < bd) { bd = d; best = i; } });
                    if (best >= 0 && best !== this.selectedIndex) {
                        this.selectedIndex = best;
                        this._overlaySig = '';
                        this.onSelect(this.selectedIndex);
                    }
                }
                if (this.selectedIndex >= this._reds.length) {
                    this.selectedIndex = this._reds.length - 1;
                    this._overlaySig = '';
                    this.onSelect(this.selectedIndex);
                }
            } else if (this.dragging.type === 'redline') {
                // 主进程会按时间重排红线 → 把下标重新对准"正被拖的那条"
                const t = this.dragging.lastTime;
                let best = -1;
                let bd = Infinity;
                this._reds.forEach((r, i) => { const d = Math.abs(r.time - t); if (d < bd) { bd = d; best = i; } });
                if (best >= 0) {
                    this.dragging.redIndex = best;
                    this.selectedIndex = best;
                    this._selectedTime = this._reds[best].time;
                }
            }
            this._drawOverlay();
        }

        /** 当前选中红线（编辑栏读取；未选中返回 null） */
        getSelected() {
            const reds = this._reds || [];
            const i = this.selectedIndex;
            if (i < 0 || i >= reds.length) return null;
            return {
                index: i,
                time: reds[i].time,
                bpm: reds[i].bpm,
                beatIndex: reds[i].beatIndex,
                meter: reds[i].meter || 4,
                total: reds.length
            };
        }

        /**
         * 变速段落列表（① 区域卡片的数据源）。
         * 返回派生好的快照数组，顺序 = 红线按时间排序后的顺序，
         * index 与主进程 memTiming.redLines 的下标一一对应（编辑时用它做 redIndex）。
         */
        getSections() {
            const reds = this._reds || [];
            return reds.map((r, i) => ({
                index: i,
                time: r.time,
                bpm: r.bpm,
                beatIndex: r.beatIndex,
                meter: r.meter || 4,
                anchor: i === 0,
                total: reds.length
            }));
        }

        _followPlayhead() {
            if (this.dragging || this.panState) return;
            const st = this.getState();
            const t = st ? st.time || 0 : 0;
            if (!this._initialFollowed && t > 0 && this.width > 0) {
                this._initialFollowed = true;
                this.scrollLeft = Math.max(0, t * this.zoom - this.width * 0.3);
                this._fullRedraw();
                this._lastTime = t;
                return;
            }
            const playing = Math.abs(t - (this._lastTime || 0)) > 0.002;
            this._lastTime = t;
            if (!playing) return;

            const x = this.timeToX(t);
            if (this.autoFollow) {
                // ★ 需求 4：自动翻页 —— 播放头还没出界（到视区 85% 位置）就提前翻页，
                //   让后面那段时间的频谱/声谱提前渲染出来，观感是"频谱自己流动"。
                const pageAt = this.width * 0.85;
                if (x < 0 || x > pageAt) {
                    this.scrollLeft = Math.max(0, t * this.zoom - this.width * 0.15);
                    this._fullRedraw();
                }
            } else {
                // 关闭自动跟随时：只有真正滑出视区才拉回（暂停时不跟随，可自由平移）
                if (x < 0 || x > this.width) {
                    this.scrollLeft = Math.max(0, t * this.zoom - this.width * 0.3);
                    this._fullRedraw();
                }
            }
        }

        // ---------- 选中 / 跳转（编辑栏联动）----------

        /** 选中第 i 条红线（notify=true 时通知外部编辑栏更新输入框） */
        selectRed(i, opts = {}) {
            const reds = this._reds || [];
            if (i < -1 || i >= reds.length) return;
            const changed = this.selectedIndex !== i;
            this.selectedIndex = i;
            this._selectedTime = i >= 0 ? reds[i].time : null;
            if (changed) {
                this._overlaySig = ''; // 强制重绘（高亮变了）
                this._drawOverlay();
                this.onSelect(i);
            } else if (opts.notify) {
                this.onSelect(i);
            }
            if (opts.jump) this.jumpToRed(i);
        }

        /**
         * 把视图滚动到第 i 条红线居中（**不改播放位置**）。
         * 对齐软件 v0.7.21：卡片双击 → 时间轴滚到该红线位置。
         */
        jumpToRed(i) {
            const reds = this._reds || [];
            const p = reds[i];
            if (!p || this.width <= 0) return;
            const maxScroll = Math.max(0, this._duration() * this.zoom - this.width);
            this.scrollLeft = Math.max(0, Math.min(p.time * this.zoom - this.width / 2, maxScroll));
            this._overlaySig = '';
            this._fullRedraw();
        }

        /** 按时间（秒）把视图滚到居中 */
        jumpToTime(sec) {
            if (this.width <= 0) return;
            const maxScroll = Math.max(0, this._duration() * this.zoom - this.width);
            this.scrollLeft = Math.max(0, Math.min(sec * this.zoom - this.width / 2, maxScroll));
            this._overlaySig = '';
            this._fullRedraw();
        }

        /** 开关自动翻页跟随（需求 4 的按钮） */
        setAutoFollow(on) {
            this.autoFollow = !!on;
            if (this.autoFollow) this._initialFollowed = true; // 手动开时不强制跳回开头
        }
    }

    window.Viz = Viz;
    window.VizSpectrogramColor = spectrogramColor;
})();
