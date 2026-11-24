// ===== 频谱原生 FFT 预计算（GitHub 主流方案）=====

export interface PrecomputedSpectrogram {
  data: Uint8Array[];    // 每列 fftSize/2 个量化 dB（0~255，对应 -120~0 dB）
  hop: number;           // 每列样本步长（= fftSize/4，75% 窗重叠，AU 风格）
  fftSize: number;       // FFT 窗口（1024~16384，bins=fftSize/2）
  /**
   * ★ v0.8.19：列 i 的**真实**中心时间（样本）= i * hop + timeShift。
   *
   * 第 i 列是 AnalyserNode 在「已处理到 (i+1)*hop」那一刻抓的一帧，它的窗是**居中**的：
   * 窗尾在 (i+1)*hop、长 fftSize，所以窗心 = (i+1)*hop - fftSize/2。
   * hop = fftSize/4 时就是 (i-1)*hop，即 timeShift = -hop。
   *
   * 以前按 i*hop 取列 → 频谱整体右偏一个 hop（48k/2048 时 10.7ms），
   * 这正是「红线里的频谱总跟红线差 10ms」的根因（实测正弦突变 50% 上升点在第 47.76 列，
   * 居中模型预测 47.88，左对齐模型预测 46.88 → 实际是居中）。
   */
  timeShift: number;
}
// 量化范围：-120dB（Uint8=0）~ 0dB（Uint8=255）
const DB_MIN = -120;
const DB_RANGE = 120;
// 默认显示阈值（floor）：低于该 dB 显示为黑色（可在设置中调，60~120dB，越小越敏感）
const DEFAULT_FLOOR = 100;

// 窗重叠比例（Adobe Audition 风格）：hop = fftSize / OVERLAP_DIV，相邻 FFT 窗重叠 75%。
// 重叠让时间方向更平滑（消除 STFT 窗的块状模糊），且每档内存恒定（列数×bins = 时长×2，~26MB/5min）。
export const OVERLAP_DIV = 4;   // 75% 重叠（1/4 步进）

/** 按 fftSize 计算频谱列步进（样本数）：fftSize/4，即 75% 窗重叠（AU 风格） */
export function hopFor(fftSize: number): number {
  // ScriptProcessor bufferSize 范围 256~16384，且必须 2 的幂；fftSize 0.5K~16K → hop 128~4096（下限 256）
  return Math.max(256, Math.min(16384, fftSize / OVERLAP_DIV));
}

/** 量化：dB → Uint8（0~255） */
export function dbToU8(db: number): number {
  const v = Math.round(((db - DB_MIN) / DB_RANGE) * 255);
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** 反量化：Uint8 → dB */
export function u8ToDb(v: number): number {
  return (v / 255) * DB_RANGE + DB_MIN;
}

/**
 * 反量化并直接映射到 0~1 显示强度（(db+floor)/floor 等价变换）。
 * @param v Uint8 量化值（0~255，对应 -120~0 dB）
 * @param floor 显示阈值 dB（60~120，越小越敏感；默认 100）
 * 例：floor=100 时 v=85(-80dB)→0.2，v=170(-40dB)→0.6，v=255(0dB)→1.0
 */
export function u8ToVal(v: number, floor = DEFAULT_FLOOR): number {
  return (v / 255) * (DB_RANGE / floor) + ((DB_MIN + floor) / floor);
}

/**
 * 整曲频谱预计算（原生 FFT）。
 * @param buffer 已解码的 AudioBuffer（取第 0 声道，与现有频谱绘制一致）
 * @param fftSize FFT 采样点数（2 的幂，32~32768；越大频率分辨率越高）
 * @returns 预计算频谱数据；任何异常返回 null（调用方回退 JS FFT）
 */
export async function precomputeSpectrogram(buffer: AudioBuffer, fftSize = 2048): Promise<PrecomputedSpectrogram | null> {
  try {
    const sampleRate = buffer.sampleRate;
    const totalSamples = buffer.length;
    // OfflineAudioContext：不接声卡，全速离线渲染（渲染期间回调抓频谱）
    const ctx = new OfflineAudioContext(1, totalSamples, sampleRate);

    const src = ctx.createBufferSource();
    src.buffer = buffer;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = fftSize;              // bins = fftSize / 2
    analyser.smoothingTimeConstant = 0;      // 关闭时域平滑，保留每块精确频谱

    src.connect(analyser);

    // ScriptProcessorNode 流式抓取：每 hop 样本回调一次（hop=fftSize/4 → 75% 窗重叠，AU 风格）
    const hop = hopFor(fftSize);
    const processor = ctx.createScriptProcessor(hop, 1, 1);
    analyser.connect(processor);
    processor.connect(ctx.destination);      // 必须连到 destination 才会被处理

    const cols: Uint8Array[] = [];
    const bins = analyser.frequencyBinCount; // = fftSize / 2
    const tmp = new Float32Array(bins);
    processor.onaudioprocess = () => {
      analyser.getFloatFrequencyData(tmp);
      const q = new Uint8Array(bins);
      for (let b = 0; b < bins; b++) q[b] = dbToU8(tmp[b]);
      cols.push(q);
    };

    src.start(0);
    await ctx.startRendering();              // 整曲渲染完成时，所有块已抓取

    if (cols.length === 0) return null;
    const out = { data: cols, hop, fftSize, timeShift: hop - fftSize / 2 };

    // ★ v0.8.13：渲染完必须**显式拆掉离线音频图**，否则每打开一张谱面就多占一份内存。
    processor.onaudioprocess = null;
    try { processor.disconnect(); } catch { /* 已断开则忽略 */ }
    try { analyser.disconnect(); } catch { /* 同上 */ }
    try { src.disconnect(); } catch { /* 同上 */ }
    src.buffer = null; // 关键：松开整曲音频
    return out;
  } catch (err) {
    console.warn('原生 FFT 预计算失败，回退 JS FFT:', err);
    return null;
  }
}
