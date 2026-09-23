// ============================================================================
// 实机验证（CDP）—— 侧栏 viz：蓝线（节拍线）拖动改 BPM 到底通不通
//
// 背景：用户报「侧栏的红线可以拖动，但是蓝线不能拖动改变 bpm」。
//   静态读码链路是完整的（_onDown 命中 beats!=0 → type:'bpm' → _move 换算
//   → onEditTiming → viz-panel.handleEdit → 主进程 editTiming('bpm')），
//   所以必须实机跑一遍，才能确认到底是「点不中」还是「点了没生效」。
//
// ★ 为什么不直接改生产代码暴露实例：viz-panel.js 里的 viz 是闭包变量。
//   这里改成在页面里**新建**一个独立 Viz 实例（window.Viz 类本来就是暴露的），
//   挂在一个我们自建的测试容器上 —— 生产代码零改动。
//
// 驱动方式：Input.dispatchMouseEvent 发**真实鼠标事件**（不是直接调 _onDown/_move），
//   否则绕过命中判定，测不出"到底点中了红线还是蓝线"。
//
// 用法：node tests/verify_viz_drag.mjs   （需先有 CDP 实例，默认端口 9333）
// ============================================================================
import http from 'node:http';

const PORT = Number(process.env.CDP_PORT || 9333);

function getJson(path) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
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
        if (r.result && r.result.exceptionDetails) {
            const ex = r.result.exceptionDetails.exception || r.result.exceptionDetails;
            throw new Error('页面异常: ' + (ex.description || ex.text || JSON.stringify(ex)));
        }
        return r.result && r.result.result ? r.result.result.value : undefined;
    };
    return { ws, send, evaluate, close: () => ws.close() };
}

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
    if (cond) { pass++; console.log(`  PASS  ${name}${extra ? '   ' + extra : ''}`); }
    else { fail++; console.log(`  FAIL  ${name}${extra ? '   ' + extra : ''}`); }
};

const list = await getJson('/json/list');
const page = list.find((t) => t.type === 'page' && /viz\.html/.test(t.url));
if (!page) { console.error('找不到 viz 窗口，请先打开它（S.openPanel("viz")）'); process.exit(1); }

const cdp = await connect(page.webSocketDebuggerUrl);
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
// ★ 必须重载：viz.js 是普通 script，改完磁盘后页面里跑的还是旧代码
//   （第一次修完 beats 简写 bug 后没重载，测出来还是 FAIL，白查半天）。
await cdp.send('Page.reload', { ignoreCache: true });
await new Promise((r) => setTimeout(r, 1500));
await cdp.send('Runtime.enable');

// ------------------------------------------------------------ 准备：独立实例
console.log('\n=== 准备：新建独立 Viz 实例 + 注入桩数据 ===');
const setup = await cdp.evaluate(`(() => {
    if (!window.Viz) return 'NO_VIZ_CLASS';
    // 自建测试容器：铺在窗口左上角，盖住真界面（只影响本次测量）
    // ★ 必须带 viz-container 这个 class —— style.css 里
    //   「.viz-container canvas{position:absolute;left:0}」和
    //   「.viz-overlay{pointer-events:auto}」是 viz.js 正确工作的前提：
    //   canvas 本身是 static，靠这条 CSS 才绝对定位；缺了它四层画布会流到文档底部、
    //   鼠标事件根本落不到 overlay 上（第一次跑就是被这个坑骗成"点不中"）。
    let box = document.getElementById('__testbox');
    if (!box) {
        box = document.createElement('div');
        box.id = '__testbox';
        box.className = 'viz-container';
        // ★ 尺寸必须落在**视口内**：CDP 的鼠标坐标是视口坐标，超出部分会被直接丢弃
        //   （实测这个面板视口只有 741x369，第一次用 800x400 时 y=380 已在视口外 →
        //     elementFromPoint 返回 null、事件根本没送达，被误判成"点不中"）。
        box.style.cssText = 'position:fixed;left:0;top:0;width:700px;height:300px;z-index:2147483647;';
        document.body.appendChild(box);
    }
    // 合成 60 秒 44.1kHz 音频（440Hz 正弦 + 慢包络，频谱有内容即可）
    const sr = 44100, dur = 60;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const buf = ctx.createBuffer(1, sr * dur, sr);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < ch.length; i++) {
        const t = i / sr;
        ch[i] = 0.3 * Math.sin(2 * Math.PI * 440 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 2 * t));
    }

    // 桩红线（单位：秒）：0s@120 / 10s@150 / 20s@180 —— BPM 各不相同，便于分辨改的是哪段
    const reds = [
        { time: 0,  bpm: 120 },
        { time: 10, bpm: 150 },
        { time: 20, bpm: 180 }
    ];
    window.__edits = [];
    const viz = new window.Viz({
        container: box,
        getState: () => ({ time: 0, duration: dur, timingPoints: reds }),
        onEditTiming: (e) => { window.__edits.push(e); },
        onSelect: () => {}
    });
    const W = 700, H = 300;  // 必须 ≤ 视口尺寸，否则 CDP 鼠标事件落在视口外被丢弃
    viz.setSize(W, H);
    viz.setAudio(buf, 'stub.mp3');
    viz.zoom = 20;                 // 20px/秒 → 12s 落在 x=240
    viz.scrollLeft = 0;
    viz._beatLineDelaySec = 0;     // 关掉 30ms 显示延迟，坐标换算更直观
    viz.refresh();
    viz._drawOverlay();
    window.__viz = viz;
    return JSON.stringify({
        contentBottom: viz.contentBottom, width: viz.width, height: viz.height,
        reds: viz._reds.map(r => ({ time: r.time, bpm: r.bpm, beatIndex: r.beatIndex }))
    });
})()`);
if (setup === 'NO_VIZ_CLASS') { console.error('页面里没有 window.Viz 类'); process.exit(1); }
const geo = JSON.parse(setup);
console.log('  几何:', JSON.stringify(geo));
ok('实例创建 + 桩数据注入成功（3 条红线）', geo.reds.length === 3);
// 拍号派生规则：首条=0；其后 = 上一条 + max(1, round(Δt / **上一段**的拍长))
//   段0→1: Δt=10s, 上一段(120BPM)拍长=0.5s → +20 = 20
//   段1→2: Δt=10s, 上一段(150BPM)拍长=0.4s → +25 = 45
ok('拍号派生正确（0 / 20 / 45）',
    geo.reds[0].beatIndex === 0 && geo.reds[1].beatIndex === 20 && geo.reds[2].beatIndex === 45,
    JSON.stringify(geo.reds.map(r => r.beatIndex)));
ok('时间轴区存在（contentBottom < height）', geo.contentBottom < geo.height,
    `contentBottom=${geo.contentBottom} height=${geo.height} 时间轴=${geo.height - geo.contentBottom}px`);

// 画布左上角就在 (0,0)：container 是 fixed left:0 top:0
// 注意：坐标必须在视口内（视口实测 741x369）
const timelineY = geo.contentBottom + 20;   // 时间轴区中部（260+20=280）
const specY = Math.floor(geo.contentBottom / 2); // 内容区中部（波形/声谱区）
const mouse = (type, x, y) =>
    cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
const clearEdits = () => cdp.evaluate('window.__edits = []');
const getEdits = async () => JSON.parse(await cdp.evaluate('JSON.stringify(window.__edits)'));
const dragType = () => cdp.evaluate('window.__viz.dragging ? window.__viz.dragging.type : "null"');

// ------------------------------------------------------------ 测试 1：蓝线
console.log('\n=== 测试 1：拖蓝线（12s 处，第 2 段第 5 拍）应改该段 BPM ===');
const mx = 12 * 20; // = 240
await clearEdits();
await mouse('mousePressed', mx, timelineY);
const t1 = await dragType();
ok('按下蓝线 → dragging.type === "bpm"', t1 === 'bpm', `实际: ${t1}`);

if (t1 === 'bpm') {
    const d = JSON.parse(await cdp.evaluate('JSON.stringify(window.__viz.dragging)'));
    ok('命中第 2 段红线（redIndex=1）', d.redIndex === 1, `redIndex=${d.redIndex}`);
    ok('beats=5（是蓝线不是红线）', d.beats === 5, `beats=${d.beats}`);

    await mouse('mouseMoved', mx + 24, timelineY); // 右移 24px = +1.2s
    const edits = await getEdits();
    const bpmEdit = edits.filter((e) => e.type === 'bpm').pop();
    ok('拖蓝线发起了 bpm 编辑', !!bpmEdit, JSON.stringify(bpmEdit));
    if (bpmEdit) {
        // 期望 beats*60/(mouseTime - p.time) = 5*60/(13.2-10) = 93.75
        const expect = Math.round((5 * 60 / (13.2 - 10)) * 100) / 100;
        ok('BPM 按「拍数/时间差」正确换算', Math.abs(bpmEdit.bpm - expect) < 0.02,
            `实际 ${bpmEdit.bpm} 期望 ${expect}`);
        ok('改的确实是第 2 段（redIndex=1）', bpmEdit.redIndex === 1, `redIndex=${bpmEdit.redIndex}`);
        ok('右拖 → BPM 变小（时间差变大）', bpmEdit.bpm < 150, `${bpmEdit.bpm} < 150`);
    }
    await mouse('mouseReleased', mx + 24, timelineY);
} else {
    ok('拖蓝线发起了 bpm 编辑', false, '未能进入 bpm 拖动，后续断言跳过');
    await mouse('mouseReleased', mx, timelineY);
}

// ------------------------------------------------------------ 测试 2：反向
console.log('\n=== 测试 2：左拖应让 BPM 变大（证明双向可用）===');
await clearEdits();
await mouse('mousePressed', mx, timelineY);
const t2 = await dragType();
if (t2 === 'bpm') {
    await mouse('mouseMoved', mx - 24, timelineY); // -1.2s → 时间差 10.8-10=0.8 → 5*60/0.8=375
    const e2 = (await getEdits()).filter((e) => e.type === 'bpm').pop();
    const expect2 = Math.round((5 * 60 / (10.8 - 10)) * 100) / 100;
    ok('左拖 → BPM 变大', !!e2 && e2.bpm > 150, e2 ? `bpm=${e2.bpm}（期望≈${expect2}）` : '无编辑');
    await mouse('mouseReleased', mx - 24, timelineY);
} else {
    ok('左拖 → BPM 变大', false, `未进入 bpm 拖动: ${t2}`);
    await mouse('mouseReleased', mx, timelineY);
}

// ------------------------------------------------------------ 测试 3：红线优先
console.log('\n=== 测试 3：拖红线（20s）应改时间戳，且不夹带 bpm ===');
await clearEdits();
await mouse('mousePressed', 20 * 20, timelineY);
const t3 = await dragType();
ok('按下红线 → dragging.type === "redline"', t3 === 'redline', `实际: ${t3}`);
if (t3 === 'redline') {
    await mouse('mouseMoved', 20 * 20 + 20, timelineY); // +20px = +1s → 21s
    const e3 = await getEdits();
    const red = e3.filter((e) => e.type === 'redline').pop();
    ok('发出 redline 编辑（改时间）', !!red, JSON.stringify(red));
    if (red) ok('时间被改到 21s（21000ms）', Math.abs(red.timeMs - 21000) <= 20, `timeMs=${red.timeMs}`);
    ok('redline 拖动不夹带 bpm 编辑', e3.filter((e) => e.type === 'bpm').length === 0);
}
await mouse('mouseReleased', 20 * 20 + 20, timelineY);

// ------------------------------------------------------------ 测试 4：内容区
console.log('\n=== 测试 4：在频谱/波形区按下 → 不进入 bpm 拖动（应为平移）===');
await clearEdits();
await mouse('mousePressed', mx, specY);
const t4 = await dragType();
ok('内容区按下 → 不进入 bpm 拖动', t4 !== 'bpm', `实际: ${t4}`);
const panState = await cdp.evaluate('window.__viz.panState ? "pan" : "null"');
ok('内容区按下 → 进入平移状态', panState === 'pan', `panState=${panState}`);
await mouse('mouseReleased', mx, specY);

// ------------------------------------------------------------ 清理
await cdp.evaluate(`(() => { const b = document.getElementById('__testbox'); if (b) b.remove(); })()`);

console.log('\n=== 结果 ===');
console.log(`  ${pass} 通过 / ${fail} 失败`);
cdp.close();
process.exit(fail ? 1 : 0);
