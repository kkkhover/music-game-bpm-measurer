/* 自动备份独立窗口 */
(function () {
    'use strict';
    const { $, fmtCountdown, fmtSize, post, saveCfg, startPoll, togglePin } = window.S;

    $('btn-pin').addEventListener('click', () => togglePin('backup'));
    $('btn-backup').addEventListener('click', () => post('/api/backup'));

    function syncInput(id, val) {
        const el = $(id);
        if (document.activeElement !== el && el.value !== String(val)) el.value = val;
    }

    function render(s) {
        const bk = s.backup;
        $('bk-next').textContent = bk.enabled ? fmtCountdown(bk.nextRunAt) : '已停用';
        $('bk-count').textContent = bk.count;
        $('bk-size').textContent = fmtSize(bk.usageBytes);
        $('bk-dir').textContent = bk.dir + (bk.lastError ? `  ⚠ ${bk.lastError}` : '');
        $('bk-latest').innerHTML = bk.latest.map((f) => `<div>${f.name} · ${fmtSize(f.size)}</div>`).join('');
        syncInput('cfg-interval', bk.intervalMinutes);
        syncInput('cfg-keep', bk.keepCount);
        if (document.activeElement !== $('cfg-enabled')) $('cfg-enabled').checked = bk.enabled;
        syncInput('cfg-bkdir', bk.dir === '' ? '' : bk.dir);
    }

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
    $('cfg-bkdir').addEventListener('change', (e) => saveCfg({ backup: { dir: e.target.value.trim() } }));

    startPoll(render, 300);
})();
