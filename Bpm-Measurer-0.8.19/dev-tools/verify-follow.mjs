// 注入测试音频并观察播放头 x 位置，验证「滑出当前区域 → 自动跳到下一区域」
// 用法: node dev-tools/verify-follow.mjs [audioPath] [观察秒数]
const PORT = 9222;

async function getTarget() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const list = await res.json();
  const page = list.find(t => t.type === 'page');
  if (!page) throw new Error('没有找到页面目标');
  return page;
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => resolve(ws);
    ws.onerror = e => reject(new Error('WS 连接失败: ' + (e?.message || 'unknown')));
  });
}

let seq = 100;
function send(ws, method, params = {}) {
  const id = seq++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP 超时: ' + method)), 60000);
    const onMsg = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener('message', onMsg);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const evalJs = async (ws, expression) => {
  const r = await send(ws, 'Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, allowUnsafeEvalBlockedByCSP: true,
  });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails));
  return r.result.value;
};

const audioPath = process.argv[2] || 'D:/aiwork/workbuddy/music-game-bpm-measurer/Bpm-Measurer-Util-release-v0.1.0/Bpm-Measurer-Util-release-v0.1.0/.tmp/test120.wav';
const watchSec = Number(process.argv[3] || 10);
const osuPath = process.argv[4] || '';

const target = await getTarget();
const ws = await connect(target.webSocketDebuggerUrl);
await send(ws, 'Runtime.enable');

// 1) 先停止当前播放，避免注入后还在旧位置
await evalJs(ws, `(() => { const b = document.querySelector('.lucide-square')?.closest('button'); if (b) b.click(); return !!b; })()`);

// 2) 注入音频：走 preload 暴露的 readAudioFile 读磁盘 → DataTransfer 塞进 <input type=file>
//    注：大文件 IPC 耗时较长，promise 必须挂在 window 上，否则 CDP awaitPromise 会报 "Promise was collected"
const injectExpr = `(() => {
  const path = ${JSON.stringify(audioPath.replace(/\\/g, '/'))};
  if (!window.electronAPI?.readAudioFile) { window.__injectResult = 'no-electron-api'; return 'done'; }
  window.__injectResult = 'pending';
  window.__injectPromise = (async () => {
    try {
      const data = await window.electronAPI.readAudioFile(path);
      if (!data) { window.__injectResult = 'read-failed'; return; }
      const name = path.split('/').pop();
      const file = new File([data], name, { type: 'audio/wav' });
      const input = document.querySelector('input[accept="audio/*"]');
      if (!input) { window.__injectResult = 'input-not-found'; return; }
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      window.__injectResult = 'ok:' + name;
    } catch (e) {
      window.__injectResult = 'error:' + (e && e.message);
    }
  })();
  return 'started';
})()`;
await evalJs(ws, injectExpr);
let injectResult = 'pending';
for (let i = 0; i < 100; i++) {
  injectResult = await evalJs(ws, `window.__injectResult`);
  if (injectResult && injectResult !== 'pending') break;
  await new Promise(r => setTimeout(r, 200));
}
console.log('注入结果:', injectResult);

// 2) 等待解码完成（主频谱三层 canvas 出现 = Visualizer 已挂载）
let ready = false;
for (let i = 0; i < 150; i++) {
  ready = await evalJs(ws, `document.querySelectorAll('canvas').length >= 5 && !!document.querySelector('div[style*="will-change: transform"]')`);
  if (ready) break;
  await new Promise(r => setTimeout(r, 200));
}
console.log('界面就绪:', ready);
await new Promise(r => setTimeout(r, 800));

// 3) 可选：注入 .osu 的 timing（复现「导入 timing 后」的真实状态）
if (osuPath) {
  const osuExpr = `(() => {
    const path = ${JSON.stringify(osuPath.replace(/\\/g, '/'))};
    window.__osuResult = 'pending';
    window.__osuPromise = (async () => {
      try {
        const data = await window.electronAPI.readAudioFile(path);
        const name = path.split('/').pop();
        const file = new File([data], name, { type: 'text/plain' });
        const input = document.querySelector('input[accept*=".osu"]');
        if (!input) { window.__osuResult = 'input-not-found'; return; }
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        window.__osuResult = 'ok:' + name;
      } catch (e) { window.__osuResult = 'error:' + (e && e.message); }
    })();
    return 'started';
  })()`;
  await evalJs(ws, osuExpr);
  let osuResult = 'pending';
  for (let i = 0; i < 60; i++) {
    osuResult = await evalJs(ws, `window.__osuResult`);
    if (osuResult && osuResult !== 'pending') break;
    await new Promise(r => setTimeout(r, 200));
  }
  console.log('timing 注入:', osuResult);
  await new Promise(r => setTimeout(r, 800));
}

// 3) 读取基础信息：视口宽、缩放
const info = await evalJs(ws, `(() => {
  const zoomInput = [...document.querySelectorAll('input')].find(i => i.inputMode === 'decimal');
  const cvs = [...document.querySelectorAll('canvas')];
  const bar = document.querySelector('div.relative.select-none');
  return {
    zoomText: zoomInput ? zoomInput.value : null,
    canvases: cvs.map(c => c.width + 'x' + c.height),
    viewW: bar ? bar.getBoundingClientRect().width : 0,
  };
})()`);
console.log('视图信息:', JSON.stringify(info));

// 4) 确认「跟随播放」按钮处于开启状态（title 里带 ON）
const followState = await evalJs(ws, `(() => {
  const btns = [...document.querySelectorAll('button')];
  const b = btns.find(x => (x.title || '').includes('跟随播放'));
  if (!b) return { found: false };
  const wasOn = (b.title || '').includes('ON');
  if (!wasOn) b.click();
  return { found: true, wasOn, title: b.title };
})()`);
console.log('跟随按钮:', JSON.stringify(followState));

// 5) 点击播放
await evalJs(ws, `(() => {
  const btn = document.querySelector('button .lucide-play')?.closest('button');
  if (!btn) return 'no-play-button';
  btn.click();
  return 'clicked';
})()`);
await new Promise(r => setTimeout(r, 500));

// 6) 用 rAF 采样播放头 x（与渲染同帧），观察是否出现「接近右边缘 → 跳回左侧」
const samples = await evalJs(ws, `(async () => {
  const el = [...document.querySelectorAll('div')].find(d => d.style && d.style.willChange === 'transform' && d.style.zIndex === '5');
  if (!el) return { error: 'no-playhead' };
  const out = [];
  const t0 = performance.now();
  await new Promise(resolve => {
    const tick = () => {
      const m = /translate3d\\((-?[\\d.]+)px/.exec(el.style.transform || '');
      out.push({ ms: Math.round(performance.now() - t0), x: m ? +m[1] : null, op: el.style.opacity });
      if (performance.now() - t0 < ${watchSec * 1000}) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });
  return { width: el.parentElement?.getBoundingClientRect().width || 0, out };
})()`);

if (samples.error) {
  console.log('采样失败:', samples.error);
  ws.close();
  process.exit(1);
}

const w = samples.width;
const xs = samples.out.filter(s => s.x !== null);
// 跟随滚动：x 连续回退（每帧几十 px），连续回退段算一次「跟随」
let follows = [];
let cur = null;
for (let i = 1; i < xs.length; i++) {
  const dx = xs[i].x - xs[i - 1].x;
  if (dx < -12) {
    if (!cur) cur = { from: Math.round(xs[i - 1].x), to: Math.round(xs[i].x), ms: xs[i].ms, frames: 1 };
    else { cur.to = Math.round(xs[i].x); cur.frames++; }
  } else if (cur) { follows.push(cur); cur = null; }
}
if (cur) follows.push(cur);
const inView = xs.filter(s => s.op === '1').length / Math.max(1, xs.length);

console.log('视口宽:', Math.round(w));
console.log('采样点数:', xs.length, '播放头可见比例:', (inView * 100).toFixed(1) + '%');
console.log('x 范围:', Math.round(Math.min(...xs.map(s => s.x))), '~', Math.round(Math.max(...xs.map(s => s.x))), '(触发阈值', Math.round(w * 0.9) + ')');
console.log('跟随次数:', follows.length);
console.log('跟随明细:', JSON.stringify(follows.slice(0, 8)));
console.log('x 轨迹(前 20):', xs.slice(0, 20).map(s => Math.round(s.x)).join(','));

ws.close();
