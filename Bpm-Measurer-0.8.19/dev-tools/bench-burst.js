// 真实节奏：连续缩放 12 档（70ms 间隔）→ 停手，分别统计「连打期间」与「停手后」的帧间隔
(async () => {
  const raf = () => new Promise(r => requestAnimationFrame(() => r()));
  const gaps = [];
  let stop = false, last = performance.now();
  const loop = () => { const n = performance.now(); gaps.push({ t: n, d: n - last }); last = n; if (!stop) requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  await new Promise(r => setTimeout(r, 400));

  // 先把缩放拉回中位，保证每步都真实生效
  for (let i = 0; i < 10; i++) { document.dispatchEvent(new KeyboardEvent('keydown', { key: '-', bubbles: true })); await new Promise(r => setTimeout(r, 60)); }
  await new Promise(r => setTimeout(r, 600));

  const t0 = performance.now();
  for (let i = 0; i < 12; i++) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }));
    await new Promise(r => setTimeout(r, 70));
  }
  const t1 = performance.now();
  await new Promise(r => setTimeout(r, 2000));
  const t2 = performance.now();
  stop = true; await raf();

  const stat = arr => {
    const s = arr.map(x => x.d).sort((a, b) => a - b);
    if (!s.length) return { n: 0 };
    const sum = s.reduce((a, b) => a + b, 0);
    return { n: s.length, fps: +(1000 / (sum / s.length)).toFixed(1), p50: +s[Math.floor(s.length * .5)].toFixed(1), p95: +s[Math.floor(s.length * .95)].toFixed(1), max: +s[s.length - 1].toFixed(1), over100: s.filter(x => x > 100).length };
  };
  const burst = gaps.filter(g => g.t >= t0 && g.t < t1);
  const after = gaps.filter(g => g.t >= t1 && g.t <= t2);
  return { burst: stat(burst), afterSettle: stat(after) };
})()
