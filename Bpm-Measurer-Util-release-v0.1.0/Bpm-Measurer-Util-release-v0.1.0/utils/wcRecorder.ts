// ===== WebCodecs 实时录制引擎（音画完全同步） =====
//
// 为什么不用 MediaRecorder：
//   MediaRecorder(captureStream) 的**视频帧时间戳按「画布实际绘制的墙钟时刻」打标**，
//   而音轨按「音频设备时钟」打标，两者是两个时基。预览掉帧、音频设备漂移、蓝牙缓冲
//   都会让画面相对声音越走越偏 —— 这就是「录出来延迟越来越大」的根因，且无法从
//   MediaRecorder 外部修正（它不暴露帧时间戳）。
//
// 这里采用 OBS 的核心思路：**自己掌握时间戳**。
//   - 视频：渲染循环实时把当前帧交给 VideoEncoder（H.264），显式写入
//           `timestamp = 帧号 / fps`，帧号由「内容时间网格」算出；
//   - 音频：停止后从**原始 AudioBuffer** 按同一「内容时间」切片，交给
//           AudioEncoder（AAC），`timestamp = 采样偏移 / sampleRate`；
//   - 两轨时间戳都从 0 起、单位都是微秒、基准都是「录制起点的内容时间」，
//     由 mp4-muxer 写进同一个 MP4 —— 音画在容器层面就严格对齐，零漂移。
//
// 帧号允许跳号：WebCodecs 是显式时间戳，跳号时播放器会把上一帧保持到下一个时间戳
// （正确的 freeze-frame 语义），既不需要补帧，也不会像 MediaRecorder 那样累积墙钟漂移。
//
// 「停止后编码音频」不算后渲染：视频在录制期间已逐帧编码完毕，音频只是把已知 PCM
// 喂给硬件编码器（2 分钟音频通常 < 1 秒），没有逐帧重画，停止即导出。
//
// 变速（soundtouchjs time-stretch）与「节拍器入录」时实际输出 ≠ 原始 buffer，
// 这两个场景由调用方降级回 MediaRecorder（录的是实时总线），见 BeatmapPreview。

import { Muxer, ArrayBufferTarget } from 'mp4-muxer';

export interface WcRecorderOptions {
  width: number;
  height: number;
  fps: number;
  /** 视频码率（bps） */
  videoBitrate: number;
  sampleRate: number;
  numberOfChannels: number;
  /** 音频码率（bps） */
  audioBitrate: number;
}

/** AAC 一个编码帧的采样数（WebCodecs 的 AudioEncoder 按此缓冲） */
const AAC_FRAME = 1024;
const VIDEO_CODECS = ['avc1.640028', 'avc1.4D401F', 'avc1.42E01E', 'avc1.42001F'];

/**
 * 探测结果按「分辨率/帧率/声道/采样率」缓存：isConfigSupported 是异步的，
 * 每次开录都重跑 4 个 codec 探测会让「按下录制 → 画面动起来」有可感延迟。
 */
const supportCache = new Map<string, { codec: string | null; audio: boolean }>();

function videoConfig(codec: string, o: WcRecorderOptions): VideoEncoderConfig {
  return {
    codec, width: o.width, height: o.height,
    bitrate: o.videoBitrate, framerate: o.fps,
    latencyMode: 'realtime', avc: { format: 'avc' },
  };
}

async function probe(o: WcRecorderOptions): Promise<{ codec: string | null; audio: boolean }> {
  const key = `${o.width}x${o.height}@${o.fps}-${o.sampleRate}-${o.numberOfChannels}`;
  const hit = supportCache.get(key);
  if (hit) return hit;
  let codec: string | null = null;
  let audio = false;
  if (typeof VideoEncoder !== 'undefined' && typeof AudioEncoder !== 'undefined' &&
      typeof VideoFrame !== 'undefined' && typeof AudioData !== 'undefined') {
    for (const c of VIDEO_CODECS) {
      try {
        const r = await VideoEncoder.isConfigSupported(videoConfig(c, o));
        if (r.supported) { codec = c; break; }
      } catch { /* 试下一个 */ }
    }
    try {
      const r = await AudioEncoder.isConfigSupported({
        codec: 'mp4a.40.2', sampleRate: o.sampleRate,
        numberOfChannels: o.numberOfChannels, bitrate: o.audioBitrate,
      });
      audio = !!r.supported;
    } catch { audio = false; }
  }
  const out = { codec, audio };
  supportCache.set(key, out);
  return out;
}

/** 探测当前 Electron/Chromium 能否做 H.264 + AAC 编码（任一不支持就返回 false，调用方降级） */
export async function isWcRecordingSupported(opts: WcRecorderOptions): Promise<boolean> {
  const r = await probe(opts);
  return !!r.codec && r.audio;
}

export class WcRecorder {
  private muxer: Muxer<ArrayBufferTarget> | null = null;
  private video: VideoEncoder | null = null;
  private audio: AudioEncoder | null = null;
  private target: ArrayBufferTarget | null = null;
  private disposed = false;
  private error: string | null = null;
  /** 实际写入的视频帧数（= 最后一帧号 + 1） */
  frameCount = 0;
  /** 真正送进编码器的帧数（背压丢弃不计） */
  encodedFrames = 0;
  /** 编码器跟不上而丢弃的帧数（跳号，播放器保持上一帧） */
  droppedFrames = 0;
  /** 音频编码帧数 */
  audioChunks = 0;

  private constructor(private opts: WcRecorderOptions) {}

  static async create(opts: WcRecorderOptions): Promise<WcRecorder | null> {
    const p = await probe(opts);
    if (!p.codec || !p.audio) return null;
    const self = new WcRecorder(opts);
    try {
      self.target = new ArrayBufferTarget();
      self.muxer = new Muxer({
        target: self.target,
        video: { codec: 'avc', width: opts.width, height: opts.height, frameRate: opts.fps },
        audio: { codec: 'aac', numberOfChannels: opts.numberOfChannels, sampleRate: opts.sampleRate },
        // metadata 放文件尾：不必把所有 chunk 缓存在内存里（本机 8GB，长录制要省）。
        // 本地文件一次性可读，moov 在末尾不影响任何播放器。
        fastStart: false,
        // 两轨时间戳同源（都从 0 起），按最早的一轨统一偏移，保持相对关系。
        firstTimestampBehavior: 'cross-track-offset',
      });

      self.video = new VideoEncoder({
        output: (chunk, meta) => {
          try { self.muxer?.addVideoChunk(chunk, meta); }
          catch (e) { self.error = `视频封装失败：${String(e)}`; }
        },
        error: e => { self.error = `视频编码失败：${String(e)}`; },
      });
      self.video.configure(videoConfig(p.codec, opts));

      self.audio = new AudioEncoder({
        output: (chunk, meta) => {
          try { self.muxer?.addAudioChunk(chunk, meta); self.audioChunks++; }
          catch (e) { self.error = `音频封装失败：${String(e)}`; }
        },
        error: e => { self.error = `音频编码失败：${String(e)}`; },
      });
      self.audio.configure({
        codec: 'mp4a.40.2', sampleRate: opts.sampleRate,
        numberOfChannels: opts.numberOfChannels, bitrate: opts.audioBitrate,
      });
      return self;
    } catch (e) {
      self.cancel();
      console.warn('[wc] 录制器初始化失败：', e);
      return null;
    }
  }

  /**
   * 实时编码一帧。frameIndex 是**内容时间网格下标**：
   *   `frameIndex = round((内容时间 - 录制起点) × fps)`。
   * 编码器跟不上时主动丢这一帧（跳号 = 播放器保持上一帧），避免编码队列无限堆积。
   */
  encodeFrame(canvas: HTMLCanvasElement, frameIndex: number): void {
    if (this.disposed || !this.video || this.video.state !== 'configured') return;
    if (this.video.encodeQueueSize > 30) { this.droppedFrames++; return; } // 背压
    const { fps } = this.opts;
    const timestamp = Math.round((frameIndex * 1_000_000) / fps);
    const duration = Math.round(1_000_000 / fps);
    let frame: VideoFrame | null = null;
    try {
      frame = new VideoFrame(canvas, { timestamp, duration });
      // 每 2 秒一个关键帧：拖动进度条时不用从头解，文件也不会因全 I 帧暴涨。
      this.video.encode(frame, { keyFrame: frameIndex % (fps * 2) === 0 });
      this.frameCount = Math.max(this.frameCount, frameIndex + 1);
      this.encodedFrames++;
    } catch (e) {
      this.error = `抓帧失败：${String(e)}`;
    } finally {
      // WebCodecs 规范：encode() 之后调用方可以立刻 close（编码器内部持有引用）。
      // 不 close 会把每帧的 RGBA 像素一直留在内存里 —— 720p60 录 2 分钟就是十几 GB。
      try { frame?.close(); } catch { /* ignore */ }
    }
  }

  get queueSize(): number { return this.video?.encodeQueueSize ?? 0; }
  get lastError(): string | null { return this.error; }

  /**
   * 从整曲 PCM 切出 [startSec, endSec) 编成 AAC。
   * 时间戳以「录制起点」为 0，与视频帧号严格同源。
   * 用 f32 交错格式（Chromium 的 AAC 编码器最通用的输入布局）。
   */
  async encodeAudio(buffer: AudioBuffer, startSec: number, endSec: number): Promise<void> {
    if (this.disposed || !this.audio || this.audio.state !== 'configured') return;
    const { sampleRate, numberOfChannels } = this.opts;
    const chans: Float32Array[] = [];
    for (let c = 0; c < numberOfChannels; c++) {
      chans.push(c < buffer.numberOfChannels ? buffer.getChannelData(c) : buffer.getChannelData(0));
    }
    const start = Math.max(0, Math.floor(startSec * sampleRate));
    // 至少一帧，避免「刚点录制就停」时音轨一个 chunk 都没有
    const end = Math.max(start + AAC_FRAME,
      Math.min(Math.max(start + AAC_FRAME, buffer.length), Math.ceil(endSec * sampleRate)));
    let written = 0;
    for (let s = start; s < end; s += AAC_FRAME) {
      const frames = Math.min(AAC_FRAME, end - s);
      const data = new Float32Array(frames * numberOfChannels);
      for (let c = 0; c < numberOfChannels; c++) {
        const src = chans[c];
        const avail = Math.max(0, Math.min(frames, src.length - s));
        for (let k = 0; k < avail; k++) data[k * numberOfChannels + c] = src[s + k];
        // 越界部分保持 0（音乐比录制区间短时补静音，不截断视频）
      }
      const ad = new AudioData({
        format: 'f32', sampleRate, numberOfFrames: frames,
        numberOfChannels,
        timestamp: Math.round(((s - start) * 1_000_000) / sampleRate),
        data,
      });
      try { this.audio.encode(ad); } catch (e) { this.error = `音频编码失败：${String(e)}`; }
      finally { try { ad.close(); } catch { /* ignore */ } }
      written += frames;
      if (written >= sampleRate * 10) { // 每 ~10 秒让出一次事件循环
        written = 0;
        await new Promise<void>(r => setTimeout(r, 0));
      }
      // 背压：只让出事件循环等队列下降，不调 flush()（flush 会重置 AAC 编码序列，
      // 在连续 PCM 中间插入断点反而会产生可听的杂音）。
      while (this.audio.encodeQueueSize > 32 && this.audio.state === 'configured') {
        await new Promise<void>(r => setTimeout(r, 0));
      }
    }
  }

  /** flush 两个编码器 + finalize，返回完整 MP4 字节 */
  async finish(): Promise<Uint8Array> {
    if (this.disposed) throw new Error('录制器已释放');
    try {
      if (this.video && this.video.state === 'configured') await this.video.flush();
      if (this.audio && this.audio.state === 'configured') await this.audio.flush();
      if (this.frameCount === 0) throw new Error('没有录到画面（录制时间过短）');
      this.muxer?.finalize();
      const buf = this.target?.buffer;
      if (!buf || buf.byteLength === 0) throw new Error(this.error || '封装结果为空');
      return new Uint8Array(buf);
    } finally {
      this.dispose();
    }
  }

  /** 放弃这次录制（不导出）：立刻释放编码器与内存 */
  cancel(): void { this.dispose(); }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try { if (this.video && this.video.state !== 'closed') this.video.close(); } catch { /* ignore */ }
    try { if (this.audio && this.audio.state !== 'closed') this.audio.close(); } catch { /* ignore */ }
    this.video = null; this.audio = null; this.muxer = null; this.target = null;
  }
}
