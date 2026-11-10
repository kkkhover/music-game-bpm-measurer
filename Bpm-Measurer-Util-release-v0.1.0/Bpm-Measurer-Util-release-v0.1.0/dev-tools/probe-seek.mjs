// 复现「播放中点击频谱/播放头白条后播放位置不跳转 / 播放头冻结」的问题
// 用法: node dev-tools/probe-seek.mjs <audioPath> [osuPath]
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

const sleep = ms => new Promise(r => setTimeout(r, ms));

const audioPath = process.argv[2];
const osuPath = process.argv[3] || '';

const target = await getTarget();
const ws = await connect(target.webSocketDebuggerUrl);
await send(ws, 'Runtime.enable');
await send(ws, 'Input.enable').catch(() => {});

// 停止并注入音频
await evalJs(ws, `(() => { const b = document.querySelector('.lucide-square')?.closest('button'); if (b) b.click(); return !!b; })()`);
await evalJs(ws, `(() => {
  const path = ${JSON.stringify(audioPath.replace(/\\/g, '/'))};
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
    } catch (e) { window.__injectResult = 'error:' + (e && e.message); }
  })();
  return 'started';
})()`);
for (let i = 0; i < 100; i++) {
  const r = await evalJs(ws, `window.__injectResult`);
  if (r && r !== 'pending') { console.log('注入:', r); break; }
  await sleep(200);
}
for (let i = 0; i < 150; i++) {
  const ok = await evalJs(ws, `document.querySelectorAll('canvas').length >= 5`);
  if (ok) break;
  await sleep(200);
}
await sleep(600);

if (osuPath) {
  await evalJs(ws, `(() => {
    const path = ${JSON.stringify(osuPath.replace(/\\/g, '/'))};
    window.__osuResult = 'pending';
    window.__osuPromise = (async () => {
      try {
        const data = await window.electronAPI.readAudioFile(path);
        const name = path.split('/').pop();
        const file = new File([data], name, { type: 'text/plain' });
        const input = document.querySelector('input[accept*=".osu"]');
        const dt = new DataTransfer(); dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        window.__osuResult = 'ok:' + name;
      } catch (e) { window.__osuResult = 'error:' + (e && e.message); }
    })();
    return 'started';
  })()`);
  for (let i = 0; i < 60; i++) {
    const r = await evalJs(ws, `window.__osuResult`);
    if (r && r !== 'pending') { console.log('timing:', r); break; }
    await sleep(200);
  }
  await sleep(600);
}

// 读取频谱区域几何与当前时间码
const geo = await evalJs(ws, `(() => {
  const cvs = [...document.querySelectorAll('canvas')];
  const overlay = cvs.find(c => c.className.includes('cursor-crosshair') || c.className.includes('cursor-grabbing'));
  const r = overlay.getBoundingClientRect();
  const tc = [...document.querySelectorAll('span')].find(s => /^\\d+:\\d+\\.\\d+ \\//.test(s.textContent || ''));
  return { left: r.left, top: r.top, width: r.width, height: r.height, tc: tc && tc.textContent, zoom: [...document.querySelectorAll('input')].find(i=>i.inputMode==='decimal')?.value };
})()`);
console.log('几何:', JSON.stringify(geo));

// 播放
await evalJs(ws, `(() => { const b = document.querySelector('button .lucide-play')?.closest('button'); if (b) b.click(); return !!b; })()`);
await sleep(2500);

const snapshot = async () => await evalJs(ws, `(() => {
  const el = [...document.querySelectorAll('div')].find(d => d.style && d.style.willChange === 'transform' && d.style.zIndex === '5');
  const m = el ? /translate3d\\((-?[\\d.]+)px/.exec(el.style.transform || '') : null;
  const tc = [...document.querySelectorAll('span')].find(s => /^\\d+:\\d+\\.\\d+ \\//.test(s.textContent || ''));
  return {
    tc: tc ? tc.textContent : null,
    x: m ? +m[1] : null,
    op: el ? el.style.opacity : null,
    playing: !!document.querySelector('.lucide-pause'),
  };
})()`);

const before = await snapshot();
console.log('点击前:', JSON.stringify(before));

// 在频谱区域中间位置真实点击（这里正是播放头会经过的位置）
const clickX = Math.round(geo.left + geo.width * 0.55);
const clickY = Math.round(geo.top + geo.height * 0.4);
await send(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: clickX, y: clickY, button: 'left', clickCount: 1 });
await sleep(60);
await send(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1 });
await sleep(120);

const after = await snapshot();
console.log('点击后(120ms):', JSON.stringify(after));

// 继续观察 1.6s，看播放头是否还在走、时间码是否还在更新
const trail = [];
for (let i = 0; i < 8; i++) {
  await sleep(200);
  trail.push(await snapshot());
}
console.log('后续轨迹:', JSON.stringify(trail));

// 结论：播放头 x 是否连续推进
const xs = [after, ...trail].map(s => s.x).filter(v => v !== null);
const increasing = xs.every((v, i) => i === 0 || v > xs[i - 1] - 0.5);
console.log('播放头持续前进:', increasing, 'x:', xs.map(v => Math.round(v)).join(','));

ws.close();
