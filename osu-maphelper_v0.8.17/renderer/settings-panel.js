/* ============================================================================
   设置独立窗口
   ── 三件事 ──
   ① 各窗口独立透明度：主窗口读 config.window.opacity，每个 panel 读
      config.panels[id].opacity（主进程每 0.5s 同步一次到真实窗口）
   ② 频谱/声谱参数：与「BPM 测速助手」的设置项一一对应（配色/FFT/灵敏度/
      对数刻度/峰值/倒转/波形色/渲染倍率/节拍线延迟），写进 config.visual，
      viz 窗口下一轮轮询就应用 —— 两边看起来完全一致。
   ③ 节拍线延迟「跟随 BPM 测速助手」（v0.8.5）：侧栏与软件是两个独立程序，
      软件的值存在它自己的 localStorage 里。勾上跟随后主进程会去读软件设置
      （src/bpmSettings.mjs），把校准好的延迟直接拿来用，滑条转为只读。
   ★ v0.8.9：每个滑条右侧新增数字输入框，可直接输入数值（与滑条双向同步）。
   ============================================================================ */
(function () {
    'use strict';
    const { $, saveCfg, post, startPoll, togglePin } = window.S;
    // ★ v0.8.16：代码里动态拼接的文案也走 i18n（缺省退回中文）
    const tt = (k, d, vars) => (window.I18N ? window.I18N.t(k, vars) : d);

    $('btn-pin').addEventListener('click', () => togglePin('settings'));

    // ---- 声谱配色方案（id / 中文名 / 分类），与软件 SPEC_PALETTES 对齐 ----
    const PALETTES = [
        ['au', 'AU 蓝青', 'single'], ['neon', '霓虹', 'single'], ['heat', '热力', 'single'],
        ['gray', '灰度', 'single'], ['psy', '紫粉', 'single'],
        ['spectrum', '完整色阶', 'scale'], ['classic', '经典紫红', 'scale'], ['ocean', '海洋青蓝', 'scale'],
        ['ember', '余烬火焰', 'scale'], ['toxic', '毒液绿', 'scale'], ['rose', '玫瑰粉紫', 'scale'],
        ['candy', '糖果', 'scale'], ['midnight', '午夜霓虹', 'scale'], ['lava', '熔岩', 'scale'],
        ['forest', '森林', 'scale'], ['sakura', '樱花', 'scale'], ['citrus', '柑橘', 'scale'],
        ['foobar', '经典·foobar', 'band'], ['fire', '火焰', 'band'], ['ice', '冰霜', 'band'],
        ['rainbow', '彩虹', 'band'], ['neonB', '霓虹分段', 'band'], ['sunset', '日落', 'band'],
        ['fbclassic', 'foobar 七色', 'band'], ['warm', '暖频', 'band'], ['cool', '冷频', 'band'],
        ['violet', '紫罗兰', 'band'], ['gold', '黑金', 'band'], ['miami', '迈阿密', 'band'],
        ['custom', '自定义三色', 'band']
    ];
    const CAT_NAME = { single: '纯色渐变', scale: '完整色阶', band: '三分频' };

    // 填充配色下拉（按分类分组）
    (function fillPalettes() {
        const sel = $('cfg-palette');
        const groups = { single: [], scale: [], band: [] };
        for (const [id, name, cat] of PALETTES) groups[cat].push({ id, name });
        for (const cat of ['single', 'scale', 'band']) {
            const og = document.createElement('optgroup');
            og.label = CAT_NAME[cat];
            for (const p of groups[cat]) {
                const o = document.createElement('option');
                o.value = p.id;
                o.textContent = p.name;
                og.appendChild(o);
            }
            sel.appendChild(og);
        }
    })();

    // ---- 各窗口透明度行：pid === 'main' 时走 window.opacity，其余走 panels[pid].opacity ----
    // ★ v0.8.4：timing 窗口已合并进 viz，不再单列一行
    const OPACITY_ROWS = [
        ['main', 'op-main'], ['viz', 'op-viz'], ['map', 'op-map'],
        ['backup', 'op-backup'], ['settings', 'op-settings'], ['log', 'op-log']
    ];

    /** 读某行当前透明度 */
    function readOpacity(cfg, pid) {
        if (pid === 'main') return cfg.window && cfg.window.opacity !== undefined ? cfg.window.opacity : 1;
        const p = (cfg.panels && cfg.panels[pid]) || {};
        return p.opacity !== undefined ? p.opacity : 1;
    }

    /** 写某行透明度 */
    function writeOpacity(pid, v) {
        if (pid === 'main') saveCfg({ window: { opacity: v } });
        else saveCfg({ panels: { [pid]: { opacity: v } } });
    }

    // ---- 通用滑条绑定：range 滑条 + 数字输入框 双向同步，改动即落盘 ----
    // numScale：数字框与滑条真实值之间的换算（透明度数字框用百分比 → 100；其余 1）
    // fmt：把真实值格式化成 <b> 回显文本；patchFn：把真实值写进 config
    function bindSlider(id, valId, numId, numScale, fmt, patchFn) {
        const el = $(id);
        const lbl = $(valId);
        const num = $(numId);
        const toNum = (v) => Math.round(v * numScale * 1000) / 1000; // 保留 3 位小数
        const toVal = (n) => n / numScale;
        const apply = (v) => {
            lbl.textContent = fmt(v);
            patchFn(v);
        };

        el.addEventListener('input', (e) => {
            const v = Number(e.target.value);
            if (num && document.activeElement !== num) num.value = String(toNum(v));
            apply(v);
        });
        if (num) {
            num.addEventListener('change', (e) => {
                let v = toVal(Number(e.target.value));
                if (!Number.isFinite(v)) return;
                const mn = Number(el.min), mx = Number(el.max);
                if (Number.isFinite(mn) && Number.isFinite(mx)) v = Math.max(mn, Math.min(mx, v));
                el.value = String(v);
                apply(v);
            });
        }
        return el;
    }

    function bindOpacityRows() {
        for (const [pid, sliderId] of OPACITY_ROWS) {
            bindSlider(
                sliderId,
                sliderId + '-val',
                sliderId + '-num',
                100,
                (v) => Math.round(v * 100) + '%',
                (v) => writeOpacity(pid, v)
            );
        }
    }
    bindOpacityRows();

    // ---- 频谱/声谱数值滑条（滑条 + 数字输入双向） ----
    bindSlider('cfg-sensitivity', 'sensitivity-val', 'cfg-sensitivity-num', 1, (v) => String(v), (v) => saveCfg({ visual: { sensitivity: v } }));
    bindSlider('cfg-logbase', 'logbase-val', 'cfg-logbase-num', 1, (v) => String(v), (v) => saveCfg({ visual: { logBase: v } }));
    bindSlider('cfg-peak', 'peak-val', 'cfg-peak-num', 1, (v) => v.toFixed(2), (v) => saveCfg({ visual: { peakThreshold: v } }));
    bindSlider('cfg-renderscale', 'renderscale-val', 'cfg-renderscale-num', 1, (v) => v.toFixed(2), (v) => saveCfg({ visual: { renderScale: v } }));
    // 节拍线延迟：跟随时滑条只读（理论上不触发 input），仍留一道保险
    bindSlider('cfg-delay', 'delay-val', 'cfg-delay-num', 1, (v) => v + 'ms', (v) => {
        if (!$('cfg-delay-follow').checked) saveCfg({ visual: { beatLineDelayMs: v } });
    });
    bindSlider('cfg-osmax', 'osmax-val', 'cfg-osmax-num', 1, (v) => v + 'ms', (v) => saveCfg({ visual: { osuFollowExtrapMs: v } }));

    // ---- 节拍线延迟「跟随 BPM 测速助手」（v0.8.5）----
    $('cfg-delay-follow').addEventListener('change', (e) => {
        const on = !!e.target.checked;
        $('cfg-delay').disabled = on;
        $('cfg-delay-num').disabled = on;
        saveCfg({ visual: { beatLineDelayFollowSoftware: on } });
    });

    // 「重新读取」：让主进程忽略缓存重读一次软件设置（在软件里刚拖完延迟时点一下）
    $('btn-bpm-reload').addEventListener('click', () => {
        const btn = $('btn-bpm-reload');
        btn.disabled = true;
        $('delay-src').textContent = tt('delaySrcReloading', '节拍线延迟来源：正在重读软件设置…');
        post('/api/bpm-settings', {})
            .catch(() => { $('delay-src').textContent = tt('delaySrcFail', '节拍线延迟来源：读取失败（服务未响应）'); })
            .finally(() => { btn.disabled = false; });
    });

    // ---- ★ v0.8.16：界面语言（修 Bug 1：多语言没有全软件统一、侧栏没有语言更改）----
    // 侧栏默认「跟随软件」：直接采用 BPM 测速助手里选的语言。
    // 取消勾选后可用下拉单独为侧栏指定语言。
    // 语言代码列表与 renderer/i18n.js 的 LANGS 一致（zh/en/ja/ko/fr/de/es/ru/pt）。
    $('cfg-lang-follow').addEventListener('change', (e) => {
        const on = !!e.target.checked;
        $('cfg-lang').disabled = on;
        saveCfg({ visual: { langFollow: on } });
    });
    $('cfg-lang').addEventListener('change', (e) => {
        saveCfg({ visual: { lang: e.target.value } });
    });
    // 「重新读取」：与节拍线延迟的同款按钮 —— 在软件里刚改完语言时点一下，立即生效
    $('btn-lang-reload').addEventListener('click', () => {
        const btn = $('btn-lang-reload');
        btn.disabled = true;
        $('lang-src').textContent = window.I18N ? window.I18N.t('langSourceReading') : '语言来源：读取中…';
        post('/api/bpm-settings', {})
            .catch(() => { $('lang-src').textContent = window.I18N ? window.I18N.t('langReadFail') : '语言来源：读取失败'; })
            .finally(() => { btn.disabled = false; });
    });

    $('cfg-fft').addEventListener('change', (e) => saveCfg({ visual: { fftSize: Number(e.target.value) } }));
    $('cfg-palette').addEventListener('change', (e) => saveCfg({ visual: { palette: e.target.value } }));
    $('cfg-peakcolor').addEventListener('input', (e) => saveCfg({ visual: { peakColor: e.target.value } }));
    $('cfg-wavecolor').addEventListener('input', (e) => saveCfg({ visual: { waveColor: e.target.value } }));
    $('cfg-invert').addEventListener('change', (e) => saveCfg({ visual: { invert: !!e.target.checked } }));
    $('cfg-showwave').addEventListener('change', (e) => saveCfg({ visual: { showWaveform: !!e.target.checked } }));
    $('cfg-showspec').addEventListener('change', (e) => saveCfg({ visual: { showSpectrogram: !!e.target.checked } }));

    // ---- v0.8.7：跟随 osu! 的播放头平滑 / 兜底帧率 / 帧率诊断 ----
    $('cfg-ossmooth').addEventListener('change', (e) => {
        const on = !!e.target.checked;
        $('cfg-osmax').disabled = !on;
        $('cfg-osmax-num').disabled = !on;
        saveCfg({ visual: { osuFollowSmooth: on } });
    });
    $('cfg-fallbackfps').addEventListener('change', (e) => saveCfg({ visual: { fallbackFps: Number(e.target.value) } }));
    $('cfg-framestat').addEventListener('change', (e) => saveCfg({ visual: { showFrameStat: !!e.target.checked } }));
    // 自定义三色：一次改动就把三色整组写回（viz 侧是数组比较）
    for (const id of ['cfg-c1', 'cfg-c2', 'cfg-c3']) {
        $(id).addEventListener('input', () => {
            saveCfg({ visual: { custom: [$('cfg-c1').value, $('cfg-c2').value, $('cfg-c3').value] } });
        });
    }

    // ---- 轮询回显（正在操作的控件不回显，避免和用户抢滑条/输入框）----
    function render(s) {
        const cfg = s.config || {};
        const v = cfg.visual || {};

        for (const [pid, sliderId] of OPACITY_ROWS) {
            const el = $(sliderId);
            const num = $(sliderId + '-num');
            const cur = readOpacity(cfg, pid);
            if (document.activeElement !== el) el.value = String(cur);
            if (document.activeElement !== num) num.value = String(Math.round(cur * 100));
            $(sliderId + '-val').textContent = Math.round(cur * 100) + '%';
        }

        const setVal = (id, val) => {
            const el = $(id);
            if (el && document.activeElement !== el) el.value = String(val);
        };
        const setPair = (rangeId, numId, val, numVal) => {
            setVal(rangeId, val);
            setVal(numId, numVal !== undefined ? numVal : val);
        };

        setPair('cfg-sensitivity', 'cfg-sensitivity-num', v.sensitivity !== undefined ? v.sensitivity : 75);
        $('sensitivity-val').textContent = String(v.sensitivity !== undefined ? v.sensitivity : 75);
        setPair('cfg-logbase', 'cfg-logbase-num', v.logBase !== undefined ? v.logBase : 50);
        $('logbase-val').textContent = String(v.logBase !== undefined ? v.logBase : 50);
        setPair('cfg-peak', 'cfg-peak-num', v.peakThreshold !== undefined ? v.peakThreshold : 0.5);
        $('peak-val').textContent = (v.peakThreshold !== undefined ? v.peakThreshold : 0.5).toFixed(2);
        setPair('cfg-renderscale', 'cfg-renderscale-num', v.renderScale !== undefined ? v.renderScale : 1);
        $('renderscale-val').textContent = (v.renderScale !== undefined ? v.renderScale : 1).toFixed(2);
        // 节拍线延迟：v.beatLineDelayMs 已是主进程算好的「生效值」（跟随时 = 软件里的值）
        const delayMs = v.beatLineDelayMs !== undefined ? v.beatLineDelayMs : 30;
        setPair('cfg-delay', 'cfg-delay-num', delayMs);
        $('delay-val').textContent = delayMs + 'ms';

        // 跟随状态与来源回显（跟随时滑条只读）
        const bd = s.bpmDelay || {};
        const follow = bd.follow !== false;
        const fc = $('cfg-delay-follow');
        if (document.activeElement !== fc) fc.checked = follow;
        $('cfg-delay').disabled = follow;
        $('cfg-delay-num').disabled = follow;
        if (follow) {
            const hasSw = bd.softwareMs !== null && bd.softwareMs !== undefined;
            $('delay-src').textContent = hasSw
                ? tt('delaySrcApp', `节拍线延迟来源：BPM 测速助手（当前 ${bd.softwareMs}ms）`, { n: bd.softwareMs })
                : tt('delaySrcNoSw', `节拍线延迟来源：跟随软件，但读不到软件设置（暂用侧栏的 ${bd.manualMs !== undefined ? bd.manualMs : delayMs}ms）`, { n: bd.manualMs !== undefined ? bd.manualMs : delayMs })
                    + (bd.error ? ' · ' + bd.error : '');
        } else {
            $('delay-src').textContent = tt('delaySrcManual', `节拍线延迟来源：侧栏手动设置（${bd.manualMs !== undefined ? bd.manualMs : delayMs}ms），未跟随软件`, { n: bd.manualMs !== undefined ? bd.manualMs : delayMs });
        }
        setVal('cfg-fft', String(v.fftSize || 1024));
        setVal('cfg-palette', v.palette || 'spectrum');

        const custom = Array.isArray(v.custom) && v.custom.length === 3 ? v.custom : ['#ff2222', '#ff2222', '#ff2222'];
        setVal('cfg-c1', custom[0]);
        setVal('cfg-c2', custom[1]);
        setVal('cfg-c3', custom[2]);

        const pc = $('cfg-peakcolor');
        if (document.activeElement !== pc) pc.value = v.peakColor || '#ffee00';
        const wc = $('cfg-wavecolor');
        if (document.activeElement !== wc) wc.value = v.waveColor || '#a855f7';
        const iv = $('cfg-invert');
        if (document.activeElement !== iv) iv.checked = !!v.invert;
        const sw = $('cfg-showwave');
        if (document.activeElement !== sw) sw.checked = v.showWaveform !== false;
        const ss = $('cfg-showspec');
        if (document.activeElement !== ss) ss.checked = v.showSpectrogram !== false;

        // ---- v0.8.7 跟随 osu! 与帧率回显 ----
        const osm = $('cfg-ossmooth');
        if (document.activeElement !== osm) osm.checked = v.osuFollowSmooth !== false;
        const em = v.osuFollowExtrapMs !== undefined ? v.osuFollowExtrapMs : 200;
        setPair('cfg-osmax', 'cfg-osmax-num', em);
        $('osmax-val').textContent = em + 'ms';
        $('cfg-osmax').disabled = v.osuFollowSmooth === false;
        $('cfg-osmax-num').disabled = v.osuFollowSmooth === false;
        const fbf = $('cfg-fallbackfps');
        if (document.activeElement !== fbf) fbf.value = String(v.fallbackFps !== undefined ? v.fallbackFps : 33);
        const fst = $('cfg-framestat');
        if (document.activeElement !== fst) fst.checked = v.showFrameStat === true;

        // ---- ★ v0.8.16 语言：跟随开关 + 下拉回显 + 来源说明 ----
        const lg = s.lang || {};
        const langFollow = lg.follow !== false;
        const lf = $('cfg-lang-follow');
        if (document.activeElement !== lf) lf.checked = langFollow;
        const langSel = $('cfg-lang');
        if (langSel) {
            // 跟随时下拉展示"软件当前语言"，但仍禁用（避免用户误以为可以单独改）
            const shown = langFollow
                ? (lg.effective || 'zh')
                : (lg.manualLang || 'zh');
            if (document.activeElement !== langSel) langSel.value = shown;
            langSel.disabled = langFollow;
        }
        const langSrc = $('lang-src');
        if (langSrc && window.I18N) {
            const T = window.I18N;
            const native = T.langNative;
            if (langFollow) {
                const sw = lg.softwareLang;
                langSrc.textContent = sw
                    ? T.t('langFromApp', { lang: native(sw) })
                    : T.t('langReadFail') + (lg.error ? ' · ' + lg.error : '');
            } else {
                langSrc.textContent = T.t('langManual');
            }
        }
    }

    startPoll(render, 300);
})();
