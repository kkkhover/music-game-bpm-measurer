/* ============================================================================
   共享状态模块 —— 各 panel 页面通用
   · poll() 轮询 /api/state 拿到实时快照
   · 通用格式化工具
   · 通用 DOM 工具
   每个独立窗口（渲染进程）各自 import 这个模块，各自轮询同一份主进程状态。
   ============================================================================ */
(function () {
    'use strict';

    const $ = (id) => document.getElementById(id);

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

    function fmtBpm(v) {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) return '';
        return String(Math.round(n * 100) / 100);
    }

    function setOn(el, on) {
        if (el) el.classList.toggle('on', !!on);
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    }

    function post(url, body) {
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

    // 轮询：返回一个可停止的句柄
    function startPoll(render, intervalMs = 100) {
        let stopped = false;
        let polling = false;
        async function poll() {
            if (stopped || polling) return;
            polling = true;
            try {
                const s = await fetch('/api/state', { cache: 'no-store' }).then((x) => x.json());
                if (!stopped) render(s);
            } catch (e) {
                /* 服务没起来就静默重试 */
            }
            polling = false;
        }
        poll();
        const timer = setInterval(poll, intervalMs);
        return { stop: () => { stopped = true; clearInterval(timer); } };
    }

    // 窗口管理（通过主进程 API 打开 panel 窗口、切换置顶）
    // 注意：contextIsolation:true 下没有 nodeIntegration，这里通过 fetch 走主进程 API
    function openPanel(panelId) {
        return post('/api/window/open', { panel: panelId });
    }
    function togglePin(panelId) {
        return post('/api/window/pin', { panel: panelId });
    }
    function pinState(panelId) {
        return post('/api/window/pin-state', { panel: panelId });
    }

    // ---- 面板页公共逻辑自动绑定 ----
    // 面板页的标题栏按钮没必要每个页面都写一遍 JS：
    // 页面文件名（viz.html → viz）就是 PANELS 里的 panel id，这里统一处理。
    //
    // ★ 只做"置顶状态回显"：新窗口默认置顶，📌 按钮应当一打开就是高亮态。
    //   点击切换仍由各面板页自己绑（重复绑会导致点一次切两次）。
    (function autoBindPanelState() {
        const body = document.body;
        if (!body || !body.classList.contains('panel-body')) return;
        const pagePanelId = (location.pathname.split('/').pop() || '').replace(/\.html?$/i, '');
        if (!pagePanelId) return;

        const btn = document.querySelector('#btn-pin');
        if (!btn) return;
        const sync = () => {
            pinState(pagePanelId).then((r) => {
                if (r && r.ok) btn.classList.toggle('pinned', !!r.pinned);
            }).catch(() => { /* 服务没起来就静默 */ });
        };
        sync();
        setInterval(sync, 500);
    })();

    window.S = { $, fmtTime, fmtMs, fmtCountdown, fmtSize, fmtBpm, setOn, escapeHtml, post, saveCfg, startPoll, openPanel, togglePin, pinState };
})();
