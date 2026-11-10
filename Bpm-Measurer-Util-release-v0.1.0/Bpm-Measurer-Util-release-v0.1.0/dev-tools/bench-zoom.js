(async () => {
  const key = k => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const t0 = performance.now();
  const marks = [];
  for (let i = 0; i < 6; i++) {
    const t = performance.now();
    key('+');
    await new Promise(r => requestAnimationFrame(() => r()));
    marks.push(+((performance.now() - t).toFixed(0)));
    await wait(300);
  }
  return { totalMs: +(performance.now() - t0).toFixed(0), perZoomFrameMs: marks };
})()
