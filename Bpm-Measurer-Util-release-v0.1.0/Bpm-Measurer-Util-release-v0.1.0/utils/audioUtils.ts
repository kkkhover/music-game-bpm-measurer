export const extractPeaks = (buffer: AudioBuffer, samplesPerPixel: number = 100): Float32Array => {
  const data = buffer.getChannelData(0);
  const dataLength = data.length;
  const peakLength = Math.ceil(dataLength / samplesPerPixel);
  const peaks = new Float32Array(peakLength * 2);

  for (let i = 0; i < peakLength; i++) {
    const start = i * samplesPerPixel;
    const end = Math.min(start + samplesPerPixel, dataLength);
    let min = 0;
    let max = 0;

    for (let j = start; j < end; j++) {
      const val = data[j];
      if (val < min) min = val;
      if (val > max) max = val;
    }
    peaks[i * 2] = min;
    peaks[i * 2 + 1] = max;
  }
  return peaks;
};

// Exported window function
export const getHannWindow = (length: number): Float32Array => {
  const win = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (length - 1)));
  }
  return win;
};

// Buffers for FFT reuse to reduce GC pressure
let fftRealCache: Float32Array | null = null;
let fftImagCache: Float32Array | null = null;

export const computeFFT = (input: Float32Array): Float32Array => {
  const n = input.length;
  
  // Reuse buffers if size matches
  if (!fftRealCache || fftRealCache.length !== n) {
      fftRealCache = new Float32Array(n);
      fftImagCache = new Float32Array(n);
  }
  
  const real = fftRealCache;
  const imag = fftImagCache;

  if (!imag || !real) {
    throw new Error('FFT buffers not initialized');
  }
  
  // Initialize
  for(let i=0; i<n; i++) {
      real[i] = input[i];
      imag[i] = 0;
  }

  // Bit reversal
  let j = 0;
  for (let i = 0; i < n - 1; i++) {
    if (i < j) {
      const tr = real[i];
      const ti = imag[i];
      real[i] = real[j];
      imag[i] = imag[j];
      real[j] = tr;
      imag[j] = ti;
    }
    let k = n / 2;
    while (k <= j) {
      j -= k;
      k /= 2;
    }
    j += k;
  }

  // Butterfly updates
  for (let len = 2; len <= n; len *= 2) {
    const angle = (2 * Math.PI) / len;
    const wlen_r = Math.cos(angle);
    const wlen_i = -Math.sin(angle);

    for (let i = 0; i < n; i += len) {
      let w_r = 1;
      let w_i = 0;
      for (let j = 0; j < len / 2; j++) {
        const u_r = real[i + j];
        const u_i = imag[i + j];
        const v_r = real[i + j + len / 2] * w_r - imag[i + j + len / 2] * w_i;
        const v_i = real[i + j + len / 2] * w_i + imag[i + j + len / 2] * w_r;

        real[i + j] = u_r + v_r;
        imag[i + j] = u_i + v_i;
        real[i + j + len / 2] = u_r - v_r;
        imag[i + j + len / 2] = u_i - v_i;

        const temp_w_r = w_r * wlen_r - w_i * wlen_i;
        w_i = w_r * wlen_i + w_i * wlen_r;
        w_r = temp_w_r;
      }
    }
  }

  const magnitudes = new Float32Array(n / 2);
  const scale = 2.0 / n;
  for (let i = 0; i < n / 2; i++) {
    // Safety against NaN
    const r = real[i] || 0; 
    const im = imag[i] || 0;
    magnitudes[i] = Math.sqrt(r * r + im * im) * scale;
  }
  return magnitudes;
};

// Adobe Audition 风格频谱配色：黑底 → 深蓝 → 青 → 亮青 → 黄白
export const getSpectrogramColor = (magnitude: number): [number, number, number] => {
  if (!Number.isFinite(magnitude)) return [0, 0, 0];
  
  // -80dB floor
  const db = 20 * Math.log10(magnitude + 1e-9); 
  const val = Math.max(0, Math.min(1, (db + 80) / 80)); 

  let r, g, b;
  if (val < 0.5) {
    // 深蓝 → 青
    const t = val / 0.5;
    r = t * 25; g = t * 140; b = 45 + t * 210;
  } else {
    // 青 → 黄白
    const t = (val - 0.5) / 0.5;
    r = 25 + t * 230; g = 140 + t * 115; b = 255 - t * 70;
  }
  
  return [Math.floor(r), Math.floor(g), Math.floor(b)];
};