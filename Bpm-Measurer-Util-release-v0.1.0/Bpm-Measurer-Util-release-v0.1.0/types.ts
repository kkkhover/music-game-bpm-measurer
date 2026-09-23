export interface AudioData {
  buffer: AudioBuffer;
  peaks: Float32Array;
  duration: number;
}

export interface TimingPoint {
  id: string;
  beatIndex: number; // The global beat count where this section starts
  bpm: number;       // The tempo of this section
  time: number;      // Calculated absolute time (seconds)
  sv?: boolean;      // 导出 osu! 时是否生成变速绿线（inherited point），默认 true
  svRate?: number;   // 绿线自定义倍速（0/空 = 按基准BPM自动计算；如 1.5 / 0.75）
  timeSec?: number;  // 红线绝对时间（秒，v0.7.18 起为红线位置的权威值）：
                     // 有值时红线位置只由它决定 —— 改 BPM 只影响它下方的蓝线间距，不会挪动下一条红线
}

export interface ViewState {
  zoom: number; // Pixels per second
  scrollLeft: number; // Pixels
}