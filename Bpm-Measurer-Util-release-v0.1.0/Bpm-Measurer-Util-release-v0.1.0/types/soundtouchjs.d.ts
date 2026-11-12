// soundtouchjs（LGPL-2.1）最小类型声明。
// 只声明本软件用到的部分：PitchShifter 的构造、tempo/pitch/percentagePlayed、connect/disconnect。
declare module 'soundtouchjs' {
  /** 播放进度回调 detail */
  interface PitchShifterPlayDetail {
    timePlayed: number;
    formattedTimePlayed: string;
    percentagePlayed: number;
  }

  /**
   * 变速不变调 / 变调不变速的伪节点（内部是 ScriptProcessorNode）。
   * - `tempo`：播放速度倍率，**不变调**（本软件变速滑条用它）。
   * - `pitch`：音高倍率，**不变速**（本软件未用）。
   * - `percentagePlayed`：0~100，可读写（写 = 清空内部缓冲后 seek 到该位置）。
   */
  export class PitchShifter {
    constructor(
      context: AudioContext,
      buffer: AudioBuffer,
      bufferSize?: number,
      onEnd?: () => void,
    );
    /** 当前播放位置（秒，源内容时间） */
    timePlayed: number;
    sourcePosition: number;
    /** 总时长（秒） */
    duration: number;
    /** 播放速度倍率（变速不变调） */
    tempo: number;
    /** 音高倍率（变调不变速） */
    pitch: number;
    /** 音高倍率（变速+变调组合，本软件未用） */
    rate: number;
    /** 0~100，可读写 */
    percentagePlayed: number;
    /** 内部 ScriptProcessorNode */
    readonly node: AudioNode;
    /** 连接到目标节点（开始播放） */
    connect(toNode: AudioNode): void;
    /** 断开输出（暂停） */
    disconnect(): void;
    on(eventName: 'play', cb: (detail: PitchShifterPlayDetail) => void): void;
    off(eventName?: string): void;
  }
}
