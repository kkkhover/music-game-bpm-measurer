/* ============================================================================
   主窗口逻辑 —— 精简状态 + 播放位置 + 功能区块入口按钮
   每个功能区块按钮 → 打开对应的独立子窗口（通过主进程 IPC）。
   ============================================================================ */
(function () {
    'use strict';
    const { $, fmtTime, fmtMs, fmtBpm, setOn, post, saveCfg, startPoll, openPanel } = window.S;

    let last = null;

    function render(s) {
        last = s;

        // 状态胶囊
        setOn($('pill-tosu'), s.tosu.up && s.tosu.connected);
        setOn($('pill-osu'), s.osu.running);
        $('pill-state').textContent = s.tosu.connected ? s.tosu.stateLabel : s.tosu.up ? '等待 osu!' : '未连接 tosu';
        setOn($('pill-state'), s.tosu.isEditor);

        // 播放位置
        $('time-main').textContent = s.tosu.connected ? fmtTime(s.player.time) : '--:--.---';
        $('cur-bpm').textContent = s.player.currentBpm ? s.player.currentBpm.toFixed(2) : '—';
        $('audio-len').textContent = s.player.audioLength ? fmtMs(s.player.audioLength) : '—';
        $('bpm-range').textContent = fmtBpm(s.player.bpmRange) ? `BPM ${fmtBpm(s.player.bpmRange)}` : '';
        const pct = s.player.audioLength > 0 ? Math.min(100, (s.player.time * 1000 * 100) / s.player.audioLength) : 0;
        $('bar-fill').style.width = pct + '%';

        // 谱面标题
        const bm = s.beatmap;
        if (bm) {
            const h = bm.header || {};
            const name = h.artist || h.title ? `${h.artist || '?'} - ${h.title || '?'}${h.version ? ' [' + h.version + ']' : ''}` : bm.label;
            $('map-name').textContent = name;
            $('map-file').textContent = bm.fileName;
        } else {
            $('map-name').textContent = s.tosu.up ? '等待 osu! 打开制谱器…' : '未连接 tosu';
            $('map-file').textContent = '';
        }

        // 导出按钮状态（刚导出成功的 3 秒内优先显示文件名，之后回到 dirty 提示。
        //   导出不清 memDirty——磁盘 .osu 确实还没变，所以轮询文案要给"已导出"留一个可见窗口）
        const dirty = s.memDirty;
        $('btn-apply').disabled = !dirty;
        const recent = window.__lastExport && Date.now() - window.__lastExport.at < 3000;
        $('apply-info').textContent = recent
            ? `已导出 → ${window.__lastExport.name}`
            : dirty ? '有未导出修改' : '未修改';
    }

    // 功能区按钮 → 打开独立窗口
    document.querySelectorAll('.launch[data-panel-id]').forEach((btn) => {
        btn.addEventListener('click', () => {
            openPanel(btn.dataset.panelId);
        });
    });

    // 返回 BPM 测速助手（把它的窗口拉到前台）
    $('btn-back-bpm').addEventListener('click', () => post('/api/window/focus-bpm'));

    // 打开保存文件夹 / 备份文件夹
    $('btn-open-export').addEventListener('click', () => post('/api/window/open-folder', { type: 'export' }));
    $('btn-open-backup').addEventListener('click', () => post('/api/window/open-folder', { type: 'backup' }));

    // 导出 timing（保存到时间戳命名文件，不写回 .osu）
    $('btn-apply').addEventListener('click', () => {
        $('btn-apply').disabled = true;
        $('apply-info').textContent = '导出中…';
        post('/api/timing/export', { mode: 'redlines' }).then((r) => {
            if (r.ok) window.__lastExport = { name: r.name, at: Date.now() };
            $('apply-info').textContent = r.ok ? `已导出 → ${r.name}` : '失败：' + (r.error || '');
            $('btn-apply').disabled = false;
        });
    });

    // Ctrl+S 导出 timing
    window.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();
            $('btn-apply').click();
        }
    });

    startPoll(render, 100);
})();
