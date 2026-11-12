// ===== 变速不变调播放器（soundtouchjs 封装） =====
//
// 需求：主程序的「变速播放」滑条（0.25x ~ 2.0x）在改变播放速度时**保持音高不变**，
// 用于把速度降到 30%~50% 听清鼓点、又不让音调飘。
//
// 原生 `AudioBufferSourceNode.playbackRate` 是「重采样变速」，速度一变音高跟着变（变调）。
// 要做到变速不变调，需要 time-stretch 算法；这里用 soundtouchjs（SoundTouch 的 JS 移植，
// LGPL-2.1，以依赖形式引用、未修改源码）的 PitchShifter：
//   - `tempo` = 播放速度倍率，**不变调**（本封装只用它）；
//   - `pitch` = 音高倍率，**不变速**（未用）。
//
// PitchShifter 是「伪节点」：内部是一个 ScriptProcessorNode，`connect(gain)` 即开始播放、
// `disconnect()` 即暂停；seek 通过 `percentagePlayed` 写入（其 setter 会清空内部缓冲后
// 改 sourcePosition，因此 seek 是干净的、不会带出旧位置的残留音频）。
//
// 设计取舍：
// - 每次 play()/seek() 都**新建**一个 PitchShifter（销毁旧的），而不是复用同一个。
//   因为 ScriptProcessor 的暂停/恢复语义不可靠（disconnect 后内部缓冲状态难以精确恢复），
//   而「销毁重建」的语义最清晰、最不容易出「暂停后时间错位」这类 bug。
// - 播放头位置不从这里读（墙钟公式仍在 App.tsx 里算），本封装只负责「出声」与「变速」，
//   因此它需要向调用方暴露一个「源内容时间」用于校验，但 App.tsx 仍用自己的平滑推进。

import { PitchShifter } from 'soundtouchjs';

export interface StretchHandle {
  /** 变速不变调：设播放速度倍率（1 = 原速，0.5 = 慢一半不变调） */
  setRate(rate: number): void;
  /** 停止并释放（disconnect + 清引用）。调用后本句柄失效。 */
  stop(): void;
  /** 当前是否已停止 */
  readonly stopped: boolean;
}

const SCRIPT_PROCESSOR_SUPPORTED = (() => {
  try {
    // ScriptProcessorNode 已废弃但仍被 Chromium/Electron 支持；万一移除则回退原生。
    return typeof AudioContext !== 'undefined' &&
      typeof (AudioContext.prototype as any).createScriptProcessor === 'function';
  } catch { return false; }
})();

/** 缓冲区大小：越大延迟越高、越稳定；4096 帧 @44.1k ≈ 93ms，够用且延迟可接受。 */
const BUFFER_SIZE = 4096;

/**
 * 创建一个变速不变调的播放源，并连接到目标节点（通常是 masterGain）。
 * @param ctx     共享的 AudioContext
 * @param buffer  已解码的整曲 AudioBuffer
 * @param rate    初始速度倍率
 * @param to      输出目标（masterGain）
 * @param startAt 从第几秒开始播（0 起）。seek 通过 percentagePlayed 写入，
 *                会先清空内部缓冲，因此不会带出旧位置残留音频。
 * @param onEnd   播完回调（PitchShifter 内部在 sourcePosition 到末尾时触发）
 * @returns 句柄；若 soundtouchjs 不可用则回退原生 AudioBufferSourceNode（会变调）。
 */
export function createStretchPlayer(
  ctx: AudioContext,
  buffer: AudioBuffer,
  rate: number,
  to: AudioNode,
  startAt = 0,
  onEnd?: () => void,
): StretchHandle {
  if (SCRIPT_PROCESSOR_SUPPORTED) {
    return createPitchShifter(ctx, buffer, rate, to, startAt, onEnd);
  }
  return createNativeFallback(ctx, buffer, rate, to, startAt, onEnd);
}

function createPitchShifter(
  ctx: AudioContext,
  buffer: AudioBuffer,
  rate: number,
  to: AudioNode,
  startAt: number,
  onEnd?: () => void,
): StretchHandle {
  let shifter: PitchShifter | null = null;
  let ended = false;
  const guard = () => {
    if (ended) return;
    ended = true;
    onEnd?.();
  };
  shifter = new PitchShifter(ctx, buffer, BUFFER_SIZE, guard);
  shifter.tempo = rate;
  // seek：percentagePlayed 的 setter 会 clear 内部缓冲再设 sourcePosition，干净无残留。
  // 必须在 connect 之前设，否则会先按 0 位置吐一小段再跳。
  if (startAt > 0 && buffer.duration > 0) {
    const pct = Math.min(100, Math.max(0, (startAt / buffer.duration) * 100));
    shifter.percentagePlayed = pct;
  }
  shifter.connect(to);
  return {
    setRate(r: number) {
      if (shifter) shifter.tempo = r;
    },
    stop() {
      if (shifter) {
        try { shifter.disconnect(); } catch { /* 已断开 */ }
        shifter = null;
      }
      // 停掉也把 onEnd 关掉，避免「手动 stop」误触发「播完」逻辑
      ended = true;
    },
    get stopped() { return shifter === null; },
  };
}

/** 原生回退：直接 AudioBufferSourceNode.playbackRate（会变调，但保证能出声）。 */
function createNativeFallback(
  ctx: AudioContext,
  buffer: AudioBuffer,
  rate: number,
  to: AudioNode,
  startAt: number,
  onEnd?: () => void,
): StretchHandle {
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = rate;
  source.connect(to);
  source.onended = () => onEnd?.();
  source.start(0, Math.max(0, Math.min(buffer.duration, startAt)));
  return {
    setRate(r: number) { source.playbackRate.value = r; },
    stop() { try { source.stop(); } catch { /* 已停 */ } },
    get stopped() { return false; },
  };
}
