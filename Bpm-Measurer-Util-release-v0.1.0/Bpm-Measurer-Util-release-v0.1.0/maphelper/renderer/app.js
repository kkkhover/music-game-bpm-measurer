/* ============================================================================
   侧栏 UI 逻辑
   · 100ms 轮询 /api/state 拿实时数据（本地回环，开销可忽略）
   · 红线列表只在「谱面变化 / 红线数变化 / 编辑模式切换」时重建，避免每帧重排
   · 当前所在红线高亮用轻量的 class 切换
   · 新增：频谱/声谱/时间轴（viz.js）、音频解码、透明度滑条、备份目录、导入按钮、
     面板拖拽重排
   ============================================================================ */
const $ = (id) => document.getElementById(id);

let last = null;
let listSig = ''; // 列表签名，变了才重建
let editMode = false;
let dirty = new Map(); // time -> newBpm

// ---- 可视化 ----
let viz = null;
let audioCtx = null;
let audioBufKey = ''; // 已解码音频的谱面路径标识
let decodedAudio = null; // 解码后的 AudioBuffer

// ---- 内存中的 timing 编辑状态（拖动红线后暂存，导入时写回）----
// 结构与 beatmap.redLines 一致，但可被拖动修改
let memTiming = null; // { redLines: [...], greenLines: [...] }

// 面板布局只应用一次（首次拿到 config 时）
let layoutApplied = false;

/* ---------------------------------------------------------------- 工具 --- */
function fmtTime(sec) {
    if (!isFinite(sec)) return '--:--.---';
    const neg = sec < 0;
    sec = Math.abs(sec);
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.floor((sec * 1000) % 1000);
    return `${neg ? '-' : ''}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

function fmtMs(ms) {
    if (!ms || ms <= 0) return '—';
    return fmtTime(ms / 1000).slice(0, 5);
}

function fmtCountdown(ts) {
    if (!ts) return '—';
    const d = Math.max(0, ts - Date.now());
    const s = Math.round(d / 1000);
    if (s < 60) return `${s} 秒后`;
    return `${Math.floor(s / 60)} 分 ${s % 60} 秒后`;
}

function fmtSize(b) {
    if (!b) return '0 B';
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1024 / 1024).toFixed(2) + ' MB';
}

function setOn(el, on) {
    el.classList.toggle('on', !!on);
}

function fmtBpm(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return '';
    return String(Math.round(n * 100) / 100);
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/* ---------------------------------------------------------------- 音频 --- */
/** 谱面切换时（音频路径变化）重新解码音频 */
let audioFailedKey = ''; // 解码失败的音频路径（避免每 100ms 重试）
let audioLoading = false; // 正在解码中（防止并发重复 fetch）
async function loadAudioIfNeeded(bm) {
    const path = bm && bm.audioPath ? bm.audioPath : '';
    if (!path) {
        if (decodedAudio) {
            decodedAudio = null;
            audioBufKey = '';
            audioFailedKey = '';
            viz.clearAudio();
            $('viz-status').textContent = '无音频';
        }
        return;
    }
    if (audioBufKey === path) return; // 已解码同一个文件
    if (audioFailedKey === path) return; // 已失败过，不重复重试
    if (audioLoading) return; // 正在解码，等这轮结束

    audioLoading = true;
    $('viz-status').textContent = '解码中…';
    try {
        const r = await fetch('/api/audio', { cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const buf = await r.arrayBuffer();
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const decoded = await audioCtx.decodeAudioData(buf.slice(0));
        decodedAudio = decoded;
        audioBufKey = path;
        audioFailedKey = '';
        viz.setAudio(decoded, path);
        $('viz-status').textContent = bm.audioName || '已载入';
    } catch (e) {
        audioFailedKey = path;
        $('viz-status').textContent = '解码失败';
        console.warn('[audio]', e.message);
    } finally {
        audioLoading = false;
    }
}

/* ---------------------------------------------------------------- 渲染 --- */
function render(s) {
    last = s;

    // --- 状态胶囊 ---
    setOn($('pill-tosu'), s.tosu.up && s.tosu.connected);
    setOn($('pill-osu'), s.osu.running);
    $('pill-state').textContent = s.tosu.connected ? s.tosu.stateLabel : s.tosu.up ? '等待 osu!' : '未连接 tosu';
    setOn($('pill-state'), s.tosu.isEditor);

    // --- 实时位置 ---
    $('time-main').textContent = s.tosu.connected ? fmtTime(s.player.time) : '--:--.---';
    $('cur-bpm').textContent = s.player.currentBpm ? s.player.currentBpm.toFixed(2) : '—';
    $('audio-len').textContent = s.player.audioLength ? fmtMs(s.player.audioLength) : '—';
    $('bpm-range').textContent = fmtBpm(s.player.bpmRange) ? `BPM ${fmtBpm(s.player.bpmRange)}` : '';
    const pct = s.player.audioLength > 0 ? Math.min(100, (s.player.time * 1000 * 100) / s.player.audioLength) : 0;
    $('bar-fill').style.width = pct + '%';

    // --- 谱面 ---
    const bm = s.beatmap;
    if (bm) {
        const h = bm.header || {};
        const name = h.artist || h.title ? `${h.artist || '?'} - ${h.title || '?'}${h.version ? ' [' + h.version + ']' : ''}` : bm.label;
        $('map-name').textContent = name;
        $('map-name').title = name;
        $('map-file').textContent = bm.fileName;
        $('map-file').title = bm.path;
        $('stat-red').textContent = bm.redCount;
        $('stat-green').textContent = bm.greenCount;
        const syncEl = $('stat-sync');
        syncEl.textContent = bm.inSync ? '同步' : `${bm.redCount}/${bm.memRedCount}`;
        syncEl.className = bm.inSync ? 'ok' : 'warn';
        syncEl.title = bm.inSync
            ? '磁盘文件的红线数与编辑器内存中的一致'
            : '磁盘文件红线数 vs 编辑器内存红线数 —— 若不一致，说明编辑器里有未保存的改动，或外部改过文件';
        $('path-hint').textContent = bm.path;
    } else {
        $('map-name').textContent = s.tosu.up ? '等待 osu! 打开制谱器…' : '未连接 tosu';
        $('map-file').textContent = '';
        $('stat-red').textContent = '0';
        $('stat-green').textContent = '0';
        $('stat-sync').textContent = '—';
        $('stat-sync').className = '';
        $('path-hint').textContent = s.osu.installDir ? `osu! 目录：${s.osu.installDir}` : '未找到 osu! 安装目录';
    }

    // --- 内存 timing 状态：谱面变化时从磁盘快照重置 ---
    syncMemTiming(s);

    // --- 红线列表 ---
    renderList(s);

    // 卡片标题上的红线计数
    $('red-count').textContent = bm ? bm.redLines.length : 0;

    // --- 备份 ---
    const bk = s.backup;
    $('bk-next').textContent = bk.enabled ? fmtCountdown(bk.nextRunAt) : '已停用';
    $('bk-count').textContent = bk.count;
    $('bk-size').textContent = fmtSize(bk.usageBytes);
    $('bk-dir').textContent = bk.dir + (bk.lastError ? `  ⚠ ${bk.lastError}` : '');
    $('bk-latest').innerHTML = bk.latest.map((f) => `<div>${f.name} · ${fmtSize(f.size)}</div>`).join('');

    // 配置输入框（非聚焦时才覆盖，避免打字被打断）
    syncInput('cfg-interval', bk.intervalMinutes);
    syncInput('cfg-keep', bk.keepCount);
    if (document.activeElement !== $('cfg-enabled')) $('cfg-enabled').checked = bk.enabled;
    // 备份目录
    syncInput('cfg-bkdir', bk.dir === '' ? '' : bk.dir);

    // 透明度
    const op = s.config.window.opacity !== undefined ? s.config.window.opacity : 1;
    if (document.activeElement !== $('cfg-opacity')) $('cfg-opacity').value = op;
    $('opacity-val').textContent = Math.round(op * 100) + '%';

    // --- 日志 ---
    $('log').innerHTML = s.events.map((e) => `<div>${escapeHtml(e)}</div>`).join('');

    // --- 音频解码（谱面切换时）---
    loadAudioIfNeeded(bm);

    // --- 面板布局（首次应用 config 里的顺序）---
    applyLayoutOnce(s);
}

/** 首次拿到 config 后，按 layout.order 重排面板（仅一次） */
function applyLayoutOnce(s) {
    if (layoutApplied) return;
    const order = (s.config && s.config.layout && s.config.layout.order) || [];
    layoutApplied = true;
    if (!order.length) return;

    const root = $('app-root');
    const cards = [...root.querySelectorAll(':scope > .card')];
    const panelIds = cards.map((c) => c.dataset.panel);

    // 配置完整性校验：保存的 order 必须覆盖当前所有面板。
    // 不完整说明是旧版本的配置（比如还没有 viz/settings 面板时存的），直接忽略，
    // 用 HTML 里的默认顺序 —— 避免面板被排到奇怪的位置。
    const valid = order.filter((id) => panelIds.includes(id));
    if (valid.length !== panelIds.length) return;

    const byPanel = new Map(cards.map((c) => [c.dataset.panel, c]));
    for (const id of order) {
        const c = byPanel.get(id);
        if (c) root.appendChild(c); // append 已存在的元素 = 移动
    }
}

function syncInput(id, val) {
    const el = $(id);
    if (document.activeElement !== el && el.value !== String(val)) el.value = val;
}

/** 谱面变化时，把磁盘红线/绿线快照进内存编辑状态 */
function syncMemTiming(s) {
    const bm = s.beatmap;
    if (!bm) {
        memTiming = null;
        return;
    }
    // 首次载入该谱面：从磁盘快照
    if (!memTiming || memTiming.path !== bm.path) {
        memTiming = {
            path: bm.path,
            mtime: bm.mtime,
            redLines: bm.redLines.map((r) => ({ ...r }))
        };
        return;
    }
    // 磁盘文件被外部改了（比如用户在 osu! 里 Ctrl+S 保存）：
    // 若我们本地没有未导入的修改，就静默跟随磁盘；有修改则保留用户的编辑（以用户为准）
    if (dirty.size === 0 && bm.mtime !== memTiming.mtime) {
        memTiming.mtime = bm.mtime;
        memTiming.redLines = bm.redLines.map((r) => ({ ...r }));
        listSig = '';
        viz && viz.refresh();
    }
}

/* ---------------------------------------------------------------- 可视化 --- */
function initViz() {
    if (viz) return;
    viz = new window.Viz({
        container: $('viz-container'),
        getState: () => {
            const t = last ? last.player.time : 0;
            const reds = memTiming ? memTiming.redLines : [];
            // 转成 viz 需要的格式（time 毫秒 + bpm + uninherited）
            const timingPoints = reds.map((r) => ({
                time: r.time,
                bpm: r.bpm,
                beatLength: r.beatLength,
                uninherited: true
            }));
            // duration：无音频时用 tosu 报的总时长（毫秒→秒），供时间轴画蓝线用
            const duration = last && last.player.audioLength ? last.player.audioLength / 1000 : 0;
            return { time: t, duration, timingPoints };
        },
        onEditTiming: handleVizEdit
    });

    // 测量容器尺寸并同步给 viz（容器是固定高度 220px，宽度随窗口）
    const measure = () => {
        const c = $('viz-container');
        const r = c.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
            viz.setSize(r.width, r.height);
        }
    };
    // 先测一次，再用 ResizeObserver 跟踪变化
    measure();
    if (window.ResizeObserver) {
        new ResizeObserver(measure).observe($('viz-container'));
    } else {
        window.addEventListener('resize', measure);
    }

    viz.start();
}

/** viz 拖动红线/蓝线的回调：只改内存 memTiming，不写文件 */
function handleVizEdit(edit) {

    if (edit.type === 'offset') {
        // 第 0 条红线时间改为 offsetMs，其余红线整体平移
        const reds = memTiming.redLines;
        if (!reds.length) return;
        const delta = edit.offsetMs - reds[0].time;
        reds.forEach((r) => (r.time = Math.max(0, Math.round(r.time + delta))));
        dirty.set('__offset', edit.offsetMs);
        listSig = '';
    } else if (edit.type === 'redline') {
        const reds = memTiming.redLines;
        if (edit.redIndex < 0 || edit.redIndex >= reds.length) return;
        reds[edit.redIndex].time = edit.timeMs;
        // 保持时间升序
        reds.sort((a, b) => a.time - b.time);
        dirty.set('__redline_' + edit.redIndex, edit.timeMs);
        listSig = '';
    } else if (edit.type === 'bpm') {
        const reds = memTiming.redLines;
        if (edit.redIndex < 0 || edit.redIndex >= reds.length) return;
        reds[edit.redIndex].bpm = edit.bpm;
        reds[edit.redIndex].beatLength = 60000 / edit.bpm;
        dirty.set(reds[edit.redIndex].time, edit.bpm);
        listSig = '';
    } else if (edit.type === 'seek') {
        // 点击跳转：仅提示（osu! 的播放位置由 osu! 控制，无法从侧栏 seek）
        return;
    }

    viz.refresh();
    updateApplyBar();
    // 触发一次列表重渲染（用 last 快照）
    if (last) renderList(last);
}

/* ---------------------------------------------------------------- 红线列表 --- */
function renderList(s) {
    const bm = s.beatmap;
    const reds = memTiming ? memTiming.redLines : bm ? bm.redLines : [];
    const sig = `${bm ? bm.path : ''}|${reds.length}|${editMode}|${dirty.size}`;

    if (sig !== listSig) {
        listSig = sig;
        const wrap = $('tp-list');
        if (!reds.length) {
            wrap.innerHTML = `<div class="empty">${bm ? '该谱面没有红线 timing' : '暂无数据'}</div>`;
        } else {
            const rows = reds
                .map((r, i) => {
                    const bpmCell = editMode
                        ? `<input type="number" step="0.01" min="1" data-time="${r.time}" value="${r.bpm}" />`
                        : r.bpm.toFixed(2);
                    const isDirty = dirty.has(r.time) ? ' dirty' : '';
                    return `<div class="tp-row${isDirty}" data-time="${r.time}" data-idx="${i}">
                        <span class="idx">${i + 1}</span>
                        <span class="t">${fmtMs(r.time)}</span>
                        <span class="b">${bpmCell}</span>
                        <span class="bars">${r.meter || 4}/4</span>
                    </div>`;
                })
                .join('');
            wrap.innerHTML = `<div class="tp-row head"><span class="idx">#</span><span class="t">时间</span><span class="b">BPM</span><span class="bars">拍号</span></div>${rows}`;
        }
        bindInputs();
    }

    // 高亮当前红线（轻量）
    const curMs = s.player.time * 1000;
    let activeTime = null;
    for (const r of reds) {
        if (r.time <= curMs) activeTime = r.time;
        else break;
    }
    const rows = $('tp-list').querySelectorAll('.tp-row[data-time]');
    for (const row of rows) {
        const isCur = activeTime !== null && Number(row.dataset.time) === activeTime;
        row.classList.toggle('cur', isCur);
        if (isCur && editMode === false) {
            const wrap = $('tp-list');
            const rt = row.offsetTop;
            const rb = rt + row.offsetHeight;
            if (rt < wrap.scrollTop + 22 || rb > wrap.scrollTop + wrap.clientHeight) {
                wrap.scrollTop = rt - wrap.clientHeight / 2 + row.offsetHeight / 2;
            }
        }
    }

    updateApplyBar();
}

function bindInputs() {
    for (const inp of $('tp-list').querySelectorAll('input[type=number]')) {
        inp.addEventListener('input', () => {
            const t = Number(inp.dataset.time);
            const v = Number(inp.value);
            if (!memTiming) return;
            const orig = (memTiming.redLines.find((r) => r.time === t) || {}).bpm;
            if (!isFinite(v) || v <= 0) return;
            // 改内存
            const r = memTiming.redLines.find((r) => r.time === t);
            if (r) {
                r.bpm = v;
                r.beatLength = 60000 / v;
            }
            if (Math.abs(v - orig) < 1e-6) dirty.delete(t);
            else dirty.set(t, v);
            inp.closest('.tp-row').classList.toggle('dirty', dirty.has(t));
            viz && viz.refresh();
            updateApplyBar();
        });
        inp.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') importTiming();
        });
    }
}

function updateApplyBar() {
    const n = dirty.size;
    $('btn-apply').disabled = n === 0;
    $('apply-info').textContent = n === 0 ? '未修改' : `已改 ${n} 条（导入后写回）`;
}

/* ---------------------------------------------------------------- 操作 --- */
/**
 * 「导入」按钮：把内存里编辑好的 timing 覆盖写回 .osu 的 [TimingPoints] 段落。
 * 其余（音符/设计/SV 等）一律不动。
 */
async function importTiming() {
    if (!dirty.size || !memTiming) return;
    const points = memTiming.redLines.map((r) => ({ time: r.time, bpm: r.bpm }));
    $('btn-apply').disabled = true;
    $('apply-info').textContent = '导入中…';
    try {
        const r = await fetch('/api/timing', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: 'redlines', points })
        }).then((x) => x.json());

        if (r.ok) {
            dirty.clear();
            listSig = '';
            $('apply-info').textContent = `已导入 ${r.redCount} 条红线`;
        } else {
            $('apply-info').textContent = '失败：' + r.error;
        }
    } catch (e) {
        $('apply-info').textContent = '失败：' + e.message;
    }
    setTimeout(updateApplyBar, 2200);
    setTimeout(() => (listSig = ''), 100);
}

async function post(url, body) {
    return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
    }).then((x) => x.json());
}

function saveCfg(patch) {
    fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch)
    });
}

/* ---------------------------------------------------------------- 绑定 --- */
$('chk-edit').addEventListener('change', (e) => {
    editMode = e.target.checked;
    dirty.clear();
    listSig = '';
    renderList(last);
});

$('btn-apply').addEventListener('click', importTiming);
$('btn-backup').addEventListener('click', () => post('/api/backup'));
$('btn-rescan').addEventListener('click', () => post('/api/rescan'));

$('cfg-interval').addEventListener('change', (e) => {
    const v = Math.max(1, Math.min(120, Number(e.target.value) || 2));
    e.target.value = v;
    saveCfg({ backup: { intervalMinutes: v } });
});
$('cfg-keep').addEventListener('change', (e) => {
    const v = Math.max(1, Math.min(999, Number(e.target.value) || 60));
    e.target.value = v;
    saveCfg({ backup: { keepCount: v } });
});
$('cfg-enabled').addEventListener('change', (e) => saveCfg({ backup: { enabled: e.target.checked } }));

// 备份位置（可改）
$('cfg-bkdir').addEventListener('change', (e) => {
    saveCfg({ backup: { dir: e.target.value.trim() } });
});

// 透明度滑条（实时生效）
$('cfg-opacity').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    $('opacity-val').textContent = Math.round(v * 100) + '%';
    saveCfg({ window: { opacity: v } });
});

// Ctrl+S 导入写回
window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        importTiming();
    }
});

/* ---------------------------------------------------------------- 面板拖拽 --- */
initPanelDrag();

function initPanelDrag() {
    const root = $('app-root');
    let dragEl = null;
    let placeholder = null;
    let offsetY = 0;

    root.addEventListener('mousedown', (e) => {
        const hd = e.target.closest('.card-hd');
        if (!hd) return;
        const card = hd.closest('.card');
        if (!card) return;
        // 只在按住卡片标题栏拖动（且不是按钮/输入框）
        if (e.target.closest('button,input,label,.toggle')) return;
        dragEl = card;
        offsetY = e.clientY - card.getBoundingClientRect().top;
        dragEl.classList.add('dragging');
        placeholder = document.createElement('div');
        placeholder.className = 'card placeholder';
        placeholder.style.height = card.offsetHeight + 'px';
        card.after(placeholder);
        card.style.position = 'fixed';
        card.style.width = card.offsetWidth + 'px';
        card.style.left = card.getBoundingClientRect().left + 'px';
        card.style.top = card.getBoundingClientRect().top + 'px';
        card.style.zIndex = 1000;
        e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
        if (!dragEl) return;
        dragEl.style.top = e.clientY - offsetY + 'px';

        // 判断插入位置
        const cards = [...root.querySelectorAll('.card:not(.dragging):not(.placeholder)')];
        for (const c of cards) {
            const r = c.getBoundingClientRect();
            const mid = r.top + r.height / 2;
            if (e.clientY < mid) {
                c.before(placeholder);
                break;
            } else {
                c.after(placeholder);
            }
        }
    });

    window.addEventListener('mouseup', () => {
        if (!dragEl) return;
        placeholder.after(dragEl);
        placeholder.remove();
        dragEl.style.position = '';
        dragEl.style.width = '';
        dragEl.style.left = '';
        dragEl.style.top = '';
        dragEl.style.zIndex = '';
        dragEl.classList.remove('dragging');
        persistPanelOrder();
        dragEl = null;
        placeholder = null;
    });
}

function persistPanelOrder() {
    const ids = [...document.querySelectorAll('#app-root > .card')].map((c) => c.dataset.panel).filter(Boolean);
    saveCfg({ layout: { order: ids } });
}

/* ---------------------------------------------------------------- 轮询 --- */
let polling = false;
async function poll() {
    if (polling) return;
    polling = true;
    try {
        const s = await fetch('/api/state', { cache: 'no-store' }).then((x) => x.json());
        render(s);
    } catch (e) {
        /* 服务没起来就静默重试 */
    }
    polling = false;
}

initViz();
poll();
setInterval(poll, 100);
