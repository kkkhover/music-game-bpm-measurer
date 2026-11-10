// 逐层隐藏画布，测同一动作（一次缩放）下一帧的耗时，二分出哪一层在拖合成/光栅
(async () => {
  const key = k => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  const frameGap = () => new Promise(r => { const t = performance.now(); requestAnimationFrame(() => r(+(performance.now() - t).toFixed(0))); });
  const paper = [...document.querySelectorAll('canvas')].map((c, i) => ({ i, el: c, w: c.width, h: c.height }));
  const labels = paper.map(p => `${p.i}:${p.w}x${p.h}`);
  const out = {};

  const measure = async (name, hideIdx) => {
    for (const p of paper) p.el.style.display = hideIdx.includes(p.i) ? 'none' : '';
    await new Promise(r => setTimeout(r, 350));
    key('+'); const a = await frameGap();      // 放大一档
    await new Promise(r => setTimeout(r, 250));
    key('-'); const b = await frameGap();      // 缩回去
    await new Promise(r => setTimeout(r, 250));
    out[name] = [a, b];
  };

  await measure('全部可见', []);
  await measure('隐藏频谱', [1]);
  await measure('隐藏叠加层', [2]);
  await measure('隐藏波形', [0]);
  await measure('隐藏播放头', [3]);
  await measure('隐藏全部', [0, 1, 2, 3]);
  for (const p of paper) p.el.style.display = '';
  return { layers: labels, configs: out };
})()
