// ===== 主窗口 ⇄ 独立预览窗口 的数据桥 =====
//
// 为什么用 BroadcastChannel 而不是 IPC：
//   两个窗口都从 file:// 加载（同一个源），BroadcastChannel 可以直接对连，
//   消息不需要主进程转发，播放头 60fps 的 tick 也不会成为 IPC 瓶颈。
//   实测 Electron 34 下跨 BrowserWindow 的 BroadcastChannel 与 localStorage 都是通的
//   （见 .tmp-probe2/bc-main.cjs）；顺带的好处是两边 localStorage 共享 ——
//   「上次用的皮肤」这种偏好只写一份，独立窗口自己也读得到。
//
// 方向：
//   主窗口 → 独立窗口：init（谱面 + timing 卡片 + 帧率/录制设置，换谱面/改设置时重发）、tick（播放头）
//   独立窗口 → 主窗口：ready（请求 init）、cmd（播放/暂停/定位/录制起点）、
//                      recording（录制开始/结束 → 主窗口关掉「跟随播放头」）、
//                      setting（工具条上改的录制开关，例如节拍器入录）
import type { OsuDocument } from './osuBeatmap';
import type { PatchPoint } from './osuPatch';

export const PREVIEW_CHANNEL = 'bpm.preview.bridge.v1';

export interface PreviewFpsSetting { vsync: boolean; limit: number }

/** 录制参数（分辨率短边 / 帧率 / 视频码率 kbps） */
export interface PreviewRecSetting { height: number; fps: number; kbps: number }

export type HostToPreview =
  | { type: 'init'; doc: OsuDocument; points: PatchPoint[]; fps: PreviewFpsSetting;
      rec?: PreviewRecSetting; recMetronome?: boolean; playing?: boolean; audioMs?: number; t: number }
  | { type: 'tick'; t: number }
  /** 播放/暂停状态变化：预览据此**立刻**锁死画面（暂停时零外推，不会抽搐） */
  | { type: 'state'; playing: boolean }
  | { type: 'fps'; fps: PreviewFpsSetting };

export type PreviewCommand =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'seek'; t: number }
  /** 录制起点：把播放头摆到 t 并保证处于播放状态（**不能**用 seek+play 代替，
   *  那个组合在同一个批处理里会把播放循环的 effect 折叠掉，播放头会冻死） */
  | { type: 'recordFrom'; t: number };

export type PreviewToHost =
  | { type: 'ready' }
  | { type: 'cmd'; cmd: PreviewCommand }
  | { type: 'recording'; on: boolean }
  | { type: 'setting'; recMetronome: boolean };
