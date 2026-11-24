// ============================================================================
// 实机验证（CDP）—— 主程序 v0.8.16 新增的两个快捷键
//   ① Alt+← / Alt+→  = 切到上一段 / 下一段（基准 = 播放头所在段）
//   ② Alt+滚轮       = 精细调整频谱 px/s（缩放，以鼠标位置为锚点）
//
// 观测指标（全部来自真实 UI，不读内部变量）：
//   · 缩放 → 界面上的「{Math.round(viewState.zoom)}px/s」文本（App.tsx:1289）
//   · 段落切换 → 顶部 header 的 currentTime 文本
//
// ★ 三个踩过的坑（不改就会得到假的"功能没生效"结论）：
//   1. 页面要**先 reload**：上一轮往 props.onChange 上套的 wrapper 会残留叠加。
//   2. Electron 下 handleFileUpload 走原生对话框，测试时需临时短路（见 App.tsx 注释）。
//   3. DOM.setFileInputFiles 只塞文件、不触发 change；且 React 合成事件在 async handler
//      里取 files 不稳 → 改用「原生 Event + defineProperty 硬绑 target」直接调 props.onChange。
//
// 用法：node dev-tools/verify_hotkeys_v0816.mjs（需先起主程序，CDP 默认 9334）
// ============================================================================
import http from 'node:http';
import fs from 'node:fs';

const PORT = Number(process.env.CDP_PORT || 9334);
const AUDIO = process.env.TEST_AUDIO || 'D:/tmp/新建文件夹/bpm app/_test_tone_120bpm.wav';

const getJson = (p) => new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
        let d = ''; r.on('data', c => d += c);
        r.on('end', () => { try { res(JSON.parse(d)) } catch (e) { rej(e) } });
    }).on('error', rej);
});

async function connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0; const waits = new Map();
    ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); }
        if (m.method === 'Page.javascriptDialogOpening') {   // alert 会阻塞渲染进程
            console.log('  [对话框] ' + (m.params?.message || '').slice(0, 120));
            ws.send(JSON.stringify({ id: -1, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
        }
    };
    const send = (method, params = {}) => new Promise((res) => {
        const i = ++id; waits.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
    });
    const evaluate = async (expr) => {
        const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
        if (r.result && r.result.exceptionDetails) {
            const ex = r.result.exceptionDetails.exception || r.result.exceptionDetails;
            throw new Error('页面异常: ' + (ex.description || ex.text || JSON.stringify(ex)));
        }
        return r.result?.result?.value;
    };
    return { send, evaluate, close: () => ws.close() };
}

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
    if (cond) { pass++; console.log(`  PASS  ${name}${extra ? '   ' + extra : ''}`); }
    else { fail++; console.log(`  FAIL  ${name}${extra ? '   ' + extra : ''}`); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const list = await getJson('/json/list');
const page = list.find(t => t.type === 'page');
if (!page) { console.error('没有可用页面'); process.exit(1); }
const cdp = await connect(page.webSocketDebuggerUrl);
await cdp.send('Runtime.enable');
await cdp.send('DOM.enable');
await cdp.send('Page.enable');
// ★ 坑 1：先刷新，清掉上一轮残留的 props.onChange wrapper
await cdp.send('Page.reload', { ignoreCache: true });
await sleep(2500);
await cdp.send('Runtime.enable');
await cdp.send('DOM.enable');
await cdp.send('Page.enable');

// ---------------------------------------------------------------- 载入音频
console.log('\n=== 准备：注入并载入测试音频 ===');
if (!fs.existsSync(AUDIO)) { console.error('测试音频不存在: ' + AUDIO); process.exit(1); }
const gdoc = await cdp.send('DOM.getDocument', { depth: -1 });
const q = await cdp.send('DOM.querySelector', { nodeId: gdoc.result.root.nodeId, selector: 'input[type=file][accept="audio/*"]' });
const nodeId = q.result.nodeId;
if (!nodeId) { console.error('找不到音频 file input'); process.exit(1); }

// 用户手势（AudioContext 需要激活）
const vp = JSON.parse(await cdp.evaluate('JSON.stringify({w:innerWidth,h:innerHeight})'));
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.floor(vp.w / 2), y: vp.h - 8, button: 'left', buttons: 1, clickCount: 1 });
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.floor(vp.w / 2), y: vp.h - 8, button: 'left', buttons: 0, clickCount: 1 });
await cdp.send('DOM.setFileInputFiles', { files: [AUDIO], nodeId });

// ★ 坑 3：原生事件 + 硬绑 target，直接调 props.onChange
await cdp.evaluate(`(() => {
    const inp = document.querySelector('input[type=file][accept="audio/*"]');
    const pk = Object.keys(inp).find(k => k.startsWith('__reactProps$'));
    const e2 = new Event('change', { bubbles: true });
    Object.defineProperty(e2, 'target', { value: inp, enumerable: true });
    Object.defineProperty(e2, 'currentTarget', { value: inp, enumerable: true });
    inp[pk].onChange(e2);
    return 'ok';
})()`);
await sleep(4000);

const st = JSON.parse(await cdp.evaluate(`JSON.stringify({
    canvases: document.querySelectorAll('canvas').length,
    empty: /开始使用/.test(document.body.innerText),
    dur: (() => { const s=[...document.querySelectorAll('span')].find(x=>/^\\d+:\\d\\d\\.\\d \\/ /.test(x.textContent.trim())); return s? s.textContent.trim():null; })(),
    zoom: (() => { const s=[...document.querySelectorAll('span')].find(x=>/px\\/s$/.test(x.textContent.trim())); return s? s.textContent.trim():null; })()
})`));
console.log('  载入状态:', JSON.stringify(st));
ok('音频载入成功（离开空状态、画布齐全）', !st.empty && st.canvases >= 4, `空=${st.empty} 画布=${st.canvases}`);
ok('总时长正确读到 0:30', /\/ 0:30/.test(st.dur || ''), `${st.dur}`);
ok('能读到 zoom 显示（px/s）', !!st.zoom, `${st.zoom}`);
if (st.empty) { console.error('  音频未载入，终止'); cdp.close(); process.exit(1); }

// ---------------------------------------------------------------- 造多条段落
console.log('\n=== 准备：添加小节 ===');
for (let i = 0; i < 3; i++) {
    await cdp.evaluate(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/添加|Add|追加/i.test(x.textContent)); if(b){b.click(); return 'ok';} return 'nf'; })()`);
    await sleep(700);
}
const secN = await cdp.evaluate(`document.querySelectorAll('[id^="section-row-"]').length`);
console.log('  段落卡片数:', secN);
ok('已造出多条段落（>=3）', secN >= 3, `实际 ${secN}`);

// ---------------------------------------------------------------- 工具
const readZoom = async () => {
    const s = await cdp.evaluate(`(() => { const el=[...document.querySelectorAll('span')].find(x=>/px\\/s$/.test(x.textContent.trim())); return el? el.textContent.trim():null; })()`);
    return s ? parseInt(s) : null;
};
const readTime = async () => cdp.evaluate(`(() => { const el=[...document.querySelectorAll('span')].find(x=>/^\\d+\\.\\d{3}s$/.test(x.textContent.trim())); return el? parseFloat(el.textContent):null; })()`);
const wheel = (x, y, deltaY, modifiers) =>
    cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY, modifiers, pointerType: 'mouse' });
const key = async (code, k, modifiers, vk) => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code, key: k, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: k, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
};

// 频谱区中心（最大的那个 canvas）
const specXY = JSON.parse(await cdp.evaluate(`(() => {
    let best=null,a=0;
    for(const c of document.querySelectorAll('canvas')){const r=c.getBoundingClientRect(); const ar=r.width*r.height; if(ar>a){a=ar;best=c;}}
    if(!best) return JSON.stringify({x:0,y:0});
    const r=best.getBoundingClientRect();
    return JSON.stringify({x:Math.floor(r.left+r.width/2), y:Math.floor(r.top+r.height/2)});
})()`));

// ---------------------------------------------------------------- 测试 ① Alt+滚轮
console.log(`\n=== 测试 ①：Alt+滚轮 精细调 px/s（落点 ${specXY.x},${specXY.y}）===`);
const z0 = await readZoom();
console.log('  初始 zoom:', z0);
for (let i = 0; i < 10; i++) { await wheel(specXY.x, specXY.y, -100, 1); await sleep(110); }
await sleep(800);
const z1 = await readZoom();
console.log(`  Alt+上滚 10 格: ${z0} → ${z1}`);
ok('Alt+滚轮改变了 zoom', z1 !== null && z1 !== z0, `${z0} → ${z1}`);
ok('向上滚 = 放大（px/s 变大）', z1 > z0, `${z0} → ${z1}`);
const expect1 = Math.round(z0 * Math.pow(1.03, 10));
ok('幅度符合精细档 ×1.03/格（10 格后 ≈ 1.344 倍）',
    Math.abs(z1 - expect1) <= 2, `实际 ${z1}，理论 ${expect1}（比例 ${(z1 / z0).toFixed(3)}）`);

// 向下滚 10 格应缩回
for (let i = 0; i < 10; i++) { await wheel(specXY.x, specXY.y, 100, 1); await sleep(110); }
await sleep(800);
const z2 = await readZoom();
console.log(`  Alt+下滚 10 格: ${z1} → ${z2}`);
ok('向下滚 = 缩小（px/s 变小）', z2 < z1 && z2 > 0, `${z1} → ${z2}`);

// 对照：Shift+滚轮（粗档 ×1.1/格）3 格
const zA = await readZoom();
for (let i = 0; i < 3; i++) { await wheel(specXY.x, specXY.y, -100, 8); await sleep(130); }
await sleep(800);
const zB = await readZoom();
console.log(`  对照 Shift+上滚 3 格: ${zA} → ${zB}（理论 ×1.331）`);
ok('Shift+滚轮（粗档）有效（幅度明显更大）', zB > zA, `${zA} → ${zB}，比值 ${(zB / zA).toFixed(3)}`);

// 对照：普通滚轮不改 zoom
const zC = await readZoom();
for (let i = 0; i < 5; i++) { await wheel(specXY.x, specXY.y, 100, 0); await sleep(110); }
await sleep(800);
const zD = await readZoom();
console.log(`  对照 普通滚轮 5 格: ${zC} → ${zD}`);
ok('普通滚轮不改变 zoom（只横向滚动）', zD === zC, `${zC} → ${zD}`);

// ---------------------------------------------------------------- 测试 ② Alt+←→
console.log('\n=== 测试 ②：Alt+← / Alt+→ 切换上/下一段 ===');
// 先推进播放头到中段，确保"当前段"不是最后一段
for (let i = 0; i < 5; i++) { await key('ArrowRight', 'ArrowRight', 0, 39); await sleep(180); }
await sleep(500);
const t0 = await readTime();
await key('ArrowRight', 'ArrowRight', 1, 39);   // Alt+→
await sleep(700);
const t1 = await readTime();
await key('ArrowLeft', 'ArrowLeft', 1, 39);     // Alt+←
await sleep(700);
const t2 = await readTime();
console.log(`  时间轨迹: ${t0} →(Alt+→) ${t1} →(Alt+←) ${t2}`);
ok('Alt+→ 跳到下一段（播放位置改变）', t1 !== null && Math.abs(t1 - t0) > 0.001, `${t0} → ${t1}`);
ok('Alt+← 跳回上一段（播放位置改变）', t2 !== null && Math.abs(t2 - t1) > 0.001, `${t1} → ${t2}`);

// 对照：普通 → 仍是 +1 秒
const b0 = await readTime();
await key('ArrowRight', 'ArrowRight', 0, 39);
await sleep(600);
const b1 = await readTime();
console.log(`  对照 普通→: ${b0} → ${b1}`);
ok('普通 → 仍是「+1 秒」（Alt 分支没吃掉普通方向键）',
    b1 !== null && Math.abs((b1 - b0) - 1) < 0.35, `差值 ${(b1 - b0).toFixed(3)}s`);

// 边界：连按 Alt+← 到头不越界
for (let i = 0; i < 5; i++) { await key('ArrowLeft', 'ArrowLeft', 1, 39); await sleep(120); }
await sleep(600);
const tEnd = await readTime();
console.log(`  连按 5 次 Alt+← 后: ${tEnd}`);
ok('连按 Alt+← 到头不越界（时间 >= 0）', tEnd !== null && tEnd >= 0, `${tEnd}`);

console.log('\n=== 结果 ===');
console.log(`  ${pass} 通过 / ${fail} 失败`);
cdp.close();
process.exit(fail ? 1 : 0);
