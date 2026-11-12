export interface AudioData {
  buffer: AudioBuffer;
  peaks: Float32Array;
  duration: number;
}

/**
 * 一条 timing 卡片对应的 osu! 线型。
 *  - 'red'  只写红线（uninherited=1），改 BPM；
 *  - 'green'只写绿线（inherited=0），改 SV；
 *  - 'both' 同一次同时写红线 + 绿线（默认），且绿线 SV 默认 = 1（正常流速）。
 */
export type LineType = 'red' | 'green' | 'both';

/** 写回时用来保留 osu! 原始 timing 行的采样/音量/Kiai 字段 */
export interface TimingLineOrigin {
  red?: number;    // 原始 [TimingPoints] 段内的行下标（红线）
  green?: number;  // 原始 [TimingPoints] 段内的行下标（绿线）
}

export interface TimingPoint {
  id: string;
  beatIndex: number; // The global beat count where this section starts
  bpm: number;       // The tempo of this section
  time: number;      // Calculated absolute time (seconds)
  meter?: number;    // 拍号（每小节几拍，osu! 的 meter，如 4=4/4 拍、3=3/4 拍），默认 4
                     // v0.8.17 新增：决定这一段的小节线/重音分组，导出时写进 [TimingPoints] 第 3 字段
  sv?: boolean;      // 兼容旧配置：是否生成绿线，默认 true
  svRate?: number;   // 绿线倍速 SV（默认 1 = 正常流速；旧版本 0 = 按基准 BPM 自动补偿，已废弃）
  timeSec?: number;  // 红线绝对时间（秒，v0.7.18 起为红线位置的权威值）：
                     // 有值时红线位置只由它决定 —— 改 BPM 只影响它下方的蓝线间距，不会挪动下一条红线
  lineType?: LineType;       // ★ 卡片线型，默认 'both'
  origin?: TimingLineOrigin; // ★ 由 .osu 导入时记录原始行下标，仅用于保留采样/音量等字段
}

export interface ViewState {
  zoom: number; // Pixels per second
  scrollLeft: number; // Pixels
}
