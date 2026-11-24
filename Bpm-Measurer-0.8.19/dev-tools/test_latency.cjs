// 精确测量：①AnalyserNode 预计算的 FFT 偏移（修复后应为 0）②AudioContext 设备延迟（outputLatency/baseLatency）
const { app, BrowserWindow } = require('electron');

app.whenReady().then(async () => {
  const html = `<!DOCTYPE html><html><body><script>
    (async () => {
      try {
        // ① 设备延迟
        const ac = new AudioContext();
        await ac.resume();
        await new Promise(r => setTimeout(r, 100));
        const devLatency = {
          baseLatency: ac.baseLatency,        // 处理管线固定延迟（含量子缓冲）
          outputLatency: ac.outputLatency,    // 到声卡输出的总估计延迟
        };
        console.log('DEV=' + JSON.stringify(devLatency));

        // ② FFT 偏移验证：440Hz 正弦从样本 0 开始，预计算后峰值列应为 1（窗口中心=0）
        const sr = 44100, secs = 2, len = sr * secs;
        const off = new OfflineAudioContext(1, len, sr);
        const buf = off.createBuffer(1, len, sr);
        const ch = buf.getChannelData(0);
        for (let i = 0; i < len; i++) ch[i] = Math.sin(2*Math.PI*440*i/sr) * 0.8;
        const src = off.createBufferSource();
        src.buffer = buf;
        const fftSize = 2048, hop = 512;
        const an = off.createAnalyser();
        an.fftSize = fftSize;
        src.connect(an);
        const proc = off.createScriptProcessor(hop, 1, 1);
        an.connect(proc);
        proc.connect(off.destination);
        const cols = [];
        proc.onaudioprocess = () => {
          const d = new Float32Array(an.frequencyBinCount);
          an.getFloatFrequencyData(d);
          cols.push(d);
        };
        src.start();
        await off.startRendering();
        // 440Hz bin ≈ 440/(44100/2048) = 20.4 → bin 20
        const bin = Math.round(440 / (sr / fftSize));
        let peakCol = -1, peakVal = -Infinity;
        for (let i = 0; i < cols.length; i++) {
          if (cols[i][bin] > peakVal) { peakVal = cols[i][bin]; peakCol = i; }
        }
        // 修复后的映射：绘制 sampleIdx=0 取 block = 0/hop + (fftSize/(2*hop)-1) = 0 + (2-1) = 1
        // 若峰值列 = 1 → 偏移已归零；若 = 0 → 还需 +1 block（即偏移 = fftSize/2 而非 hop）
        console.log('FFT=' + JSON.stringify({ peakCol, expectedCol: 1, peakBin: bin, hop, fftSize }));
      } catch (e) {
        console.log('ERR=' + JSON.stringify({ err: e.message }));
      }
      window.close();
    })();
  </script></body></html>`;

  const win = new BrowserWindow({ show: false });
  win.webContents.on('console-message', (e, level, message) => { console.log(message); });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  setTimeout(() => { app.quit(); }, 20000);
});
