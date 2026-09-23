/* 日志独立窗口 */
(function () {
    'use strict';
    const { $, escapeHtml, startPoll, togglePin } = window.S;

    $('btn-pin').addEventListener('click', () => togglePin('log'));

    function render(s) {
        $('log').innerHTML = s.events.map((e) => `<div>${escapeHtml(e)}</div>`).join('');
    }

    startPoll(render, 500);
})();
