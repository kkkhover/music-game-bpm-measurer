/* ============================================================================
   实机验证（CDP）—— v0.8.16 侧栏面板多语言（map / backup / log / settings）

   为什么还要这一步？
   静态对账（tests/verify_i18n_panels.mjs）只能证明"key 都在字典里"，证明不了
   真到浏览器里 applyTo 会把文案刷进 DOM，更证明不了「把 <label> 拆成
   <span>+<input>+<span>」之后输入框**还在** —— applyTo 是用 textContent 覆写的，
   万一标记挂错层，输入框会被整块冲掉，页面直接坏掉。这类事故只有真跑才看得见。

   做法：起一个带远程调试端口的侧栏实例 → 用窗口 API 逐个打开面板 →
   在每个面板里切到 en 并 applyTo → 回读文案 + 比对控件数量。
   ============================================================================ */
import http from 'node:http';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ELECTRON = 'D:/tmp/新建文件夹/bpm app/Bpm-Measurer-Util-release-v0.1.0/Bpm-Measurer-Util-release-v0.1.0/node_modules/electron/dist/electron.exe';
const CDP_PORT = 9341;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
    if (cond) { pass++; console.log(`  PASS  ${name}${extra ? '  ' + extra : ''}`); }
    else { fail++; console.log(`  FAIL  ${name}${extra ? '  ' + extra : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(port, p) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: p }, (res) => {
            let d = '';
            res.on('data', (c) => (d += c));
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
        }).on('error', reject);
    });
}

async function connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0;
    const waits = new Map();
    ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && waits.has(msg.id)) { waits.get(msg.id)(msg); waits.delete(msg.id); }
    };
    const send = (method, params = {}) => new Promise((res) => {
        const myId = ++id;
        waits.set(myId, res);
        ws.send(JSON.stringify({ id: myId, method, params }));
    });
    const evaluate = async (expr) => {
        const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
        if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
        return r.result && r.result.result ? r.result.result.value : undefined;
    };
    return { send, evaluate, close: () => ws.close() };
}

// ---- 起实例 ----
console.log('[1] 启动侧栏实例（远程调试端口 ' + CDP_PORT + '）…');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
const logFd = fs.openSync(path.join(ROOT, 'logs', 'cdp-i18n.log'), 'w');
const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${CDP_PORT}`, '--no-sandbox', '--disable-gpu'], {
    cwd: ROOT, stdio: ['ignore', logFd, logFd], windowsHide: false, env
});

let list = [];
for (let i = 0; i < 60; i++) {
    await sleep(500);
    try { list = await getJson(CDP_PORT, '/json/list'); } catch { /* 还没起来 */ }
    if (list.some((t) => t.type === 'page' && /index\.html/.test(t.url))) break;
}
const mainPage = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
if (!mainPage) {
    console.error('起不来侧栏主窗口');
    try { child.kill(); } catch { /* ignore */ }
    process.exit(1);
}
console.log('    主窗口已就绪');

const main = await connect(mainPage.webSocketDebuggerUrl);
await main.send('Runtime.enable');

// ---- 逐个开面板并验证 ----
const PANELS = [
    {
        id: 'map', file: 'map.html',
        checks: [
            ['.pt-title', 'Current beatmap'],
            ['#btn-rescan', 'Rescan'],
            ['.map-stats .stat:nth-child(1) span', 'Red lines'],
            ['.map-stats .stat:nth-child(2) span', 'Green lines'],
            ['.map-stats .stat:nth-child(3) span', 'Consistency'],
            ['#map-name', 'Waiting for osu! editor…']
        ],
        attrs: [['#btn-rescan', 'title', 'Re-detect the osu! folder and re-read the beatmap']]
    },
    {
        id: 'backup', file: 'backup.html',
        checks: [
            ['.pt-title', 'Auto backup'],
            ['#btn-backup', 'Back up now'],
            ['.bk-row span:nth-of-type(1)', 'Next'],
            ['.bk-cfg label:nth-child(1) span:nth-of-type(1)', 'Every'],
            ['.bk-cfg label:nth-child(1) span:nth-of-type(2)', 'min'],
            ['.bk-cfg label:nth-child(2) span:nth-of-type(1)', 'Keep'],
            ['.bk-cfg label:nth-child(2) span:nth-of-type(2)', 'files'],
            ['.bk-cfg label:nth-child(3) span', 'Enabled'],
            ['.bk-dir-set span', 'Backup folder']
        ],
        // ★ 关键回归点：间隔/保留两个 input 必须还在（label 拆层不能把 input 冲掉）
        mustExist: ['#cfg-interval', '#cfg-keep', '#cfg-enabled', '#cfg-bkdir'],
        attrs: [['#btn-backup', 'title', 'Back up once right now']],
        ph: [['#cfg-bkdir', 'Leave empty for the default folder']],
        titleAttrs: [['#cfg-bkdir', 'Where backups are saved — you can change it']]
    },
    {
        id: 'log', file: 'log.html',
        checks: [['.pt-title', 'Log'], ['title', 'Log']]
    },
    {
        id: 'settings', file: 'settings.html',
        checks: [
            ['.pt-title', 'Settings'],
            ['.set-sec:nth-of-type(1)', 'Window opacity (per window)'],
            ['#cfg-fallbackfps option[value="33"]', '30 fps (low CPU, default)'],
            ['#cfg-fallbackfps option[value="-1"]', 'Match screen refresh rate']
        ],
        mustExist: ['#op-main', '#cfg-palette', '#cfg-fft', '#cfg-lang', '#cfg-osmax'],
        titleAttrs: [['#btn-pin', 'Toggle always-on-top (on by default)']]
    }
];

for (const p of PANELS) {
    console.log(`\n[面板] ${p.id} (${p.file})`);
    await main.evaluate(`fetch('/api/window/open',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({panel:'${p.id}'})})`);
    let target = null;
    for (let i = 0; i < 30; i++) {
        await sleep(400);
        const l = await getJson(CDP_PORT, '/json/list');
        target = l.find((t) => t.type === 'page' && t.url.includes(p.file));
        if (target) break;
    }
    if (!target) { ok(`${p.id} 面板能打开`, false); continue; }
    const cdp = await connect(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');

    // 控件数量：applyTo 前 vs 后（防"文案替换把 input 冲掉"）
    const before = await cdp.evaluate(`document.querySelectorAll('input,select,button').length`);
    await cdp.evaluate(`window.I18N.setLang('en'); window.I18N.applyTo(document);`);
    await sleep(200);
    const after = await cdp.evaluate(`document.querySelectorAll('input,select,button').length`);
    ok(`${p.id}: 控件数量不变（${before} → ${after}）`, before === after && before > 0);

    for (const [sel, want] of p.checks || []) {
        const got = await cdp.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return e ? e.textContent.trim() : null; })()`);
        ok(`${p.id}: ${sel} → "${want}"`, got === want, got === want ? '' : `实际="${got}"`);
    }
    for (const sel of p.mustExist || []) {
        const n = await cdp.evaluate(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
        ok(`${p.id}: ${sel} 仍在（${n} 个）`, n === 1);
    }
    for (const [sel, want] of p.ph || []) {
        const got = await cdp.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return e ? e.placeholder : null; })()`);
        ok(`${p.id}: ${sel} placeholder → "${want}"`, got === want, got === want ? '' : `实际="${got}"`);
    }
    for (const [sel, want] of p.titleAttrs || []) {
        const got = await cdp.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return e ? e.title : null; })()`);
        ok(`${p.id}: ${sel} title → "${want}"`, got === want, got === want ? '' : `实际="${got}"`);
    }
    // 切回 zh 能还原（证明是双向的、不是硬写英文）
    await cdp.evaluate(`window.I18N.setLang('zh'); window.I18N.applyTo(document);`);
    const zhBack = await cdp.evaluate(`document.querySelector(${JSON.stringify(p.checks[0][0])}) ? document.querySelector(${JSON.stringify(p.checks[0][0])}).textContent.trim() : null`);
    ok(`${p.id}: 切回 zh 能还原（"${zhBack}"）`, !!zhBack && zhBack !== p.checks[0][1]);

    cdp.close();
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
main.close();
try { child.kill(); } catch { /* ignore */ }
try { execSync(`taskkill /F /IM electron.exe /T`, { stdio: 'ignore' }); } catch { /* ignore */ }
process.exit(fail ? 1 : 0);
