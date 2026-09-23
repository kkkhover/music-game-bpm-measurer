/* 谱面信息独立窗口 */
(function () {
    'use strict';
    const { $, post, startPoll, togglePin } = window.S;

    $('btn-pin').addEventListener('click', () => togglePin('map'));
    $('btn-rescan').addEventListener('click', () => post('/api/rescan'));

    function render(s) {
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
    }

    startPoll(render, 200);
})();
