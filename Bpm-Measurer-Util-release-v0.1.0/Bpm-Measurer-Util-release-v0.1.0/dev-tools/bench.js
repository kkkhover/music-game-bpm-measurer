// 在渲染进程里跑的实测脚本：空闲 / 缩放 / 拖拽 / 播放 四个场景的帧间隔统计
(async () => {
  const host = document.querySelector('canvas.cursor-crosshair')?.parentElement;
  if (!host) return { error: '找不到可视化区域' };
  const R = host.getBoundingClientRect();
  const cx = R.left + R.width / 2;
  const cy = R.top + R.height / 2;

  const wait = ms => new Promise(r => setTimeout(r, ms));
  const key = k => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  const mouse = (type, x, y, extra = {}) => {
    const ev = new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true, ...extra });
    (type === 'mousedown' ? host : window).dispatchEvent(ev);
  };

  let frames = [];
  let raf = 0, last = 0;
  const loop = () => { const n = performance.now(); frames.push(n - last); last = n; raf = requestAnimationFrame(loop); };
  const start = () => { frames = []; last = performance.now(); raf = requestAnimationFrame(loop); };
  const stop = () => {
    cancelAnimationFrame(raf);
    const f = frames.slice(1);
    const s = [...f].sort((a, b) => a - b);
    const q = p => s.length ? +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(1) : 0;
    const sum = s.reduce((a, b) => a + b, 0);
    return {
      frames: s.length,
      fps: +(1000 / (sum / s.length)).toFixed(1),
      avg: +(sum / s.length).toFixed(1),
      p50: q(0.5), p95: q(0.95), max: +(s[s.length - 1] || 0).toFixed(1),
      over50ms: f.filter(x => x > 50).length,
      over100ms: f.filter(x => x > 100).length,
    };
  };

  const out = { canvasInfo: [...document.querySelectorAll('canvas')].map(c => [c.width, c.height, Math.round(c.getBoundingClientRect().width)]), phases: {} };

  // 1) 空闲：只播放头在动
  start(); await wait(2500); out.phases.idle = stop();

  // 2) 连续缩放：每个 '+' 都要整幅重绘频谱（最重的一档）
  start();
  for (let i = 0; i < 12; i++) { key('+'); await wait(90); }
  for (let i = 0; i < 12; i++) { key('-'); await wait(90); }
  out.phases.zoom = stop();
  await wait(600);

  // 3) 拖拽平移：高频 scrollLeft 变化 + 边缘增量重绘
  mouse('mousedown', cx, cy);
  start();
  for (let i = 0; i < 100; i++) { mouse('mousemove', cx - i * 6, cy); await wait(16); }
  out.phases.pan = stop();
  mouse('mouseup', cx - 600, cy);
  await wait(400);

  // 4) 播放 + 播放头跟随
  key(' ');
  await wait(800);
  start(); await wait(3000); out.phases.play = stop();
  key(' ');
  await wait(200);

  // 5) 缩放到整曲（最小缩放）后的平移：列数最多、最费
  for (let i = 0; i < 14; i++) { key('-'); await wait(60); }
  await wait(1200);
  mouse('mousedown', cx, cy);
  start();
  for (let i = 0; i < 100; i++) { mouse('mousemove', cx + i * 4, cy); await wait(16); }
  out.phases.panFar = stop();
  mouse('mouseup', cx + 400, cy);

  out.mem = performance.memory ? {
    heapMB: +(performance.memory.usedJSHeapSize / 1048576).toFixed(1),
    totalMB: +(performance.memory.totalJSHeapSize / 1048576).toFixed(1),
  } : null;
  return out;
})()
