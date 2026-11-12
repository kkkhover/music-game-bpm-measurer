// ===== 预览的「显示时钟」 =====
//
// 为什么需要它：播放头来自 AudioContext.currentTime，而它是**量化**的
// （本机实测每 ~11ms 才跳一次：0.011s 占 62%、0.008s 占 20%）。120Hz 屏一帧只有 8.3ms，
// 于是每 4~6 帧就有 1 帧「时间没变」→ 旧逻辑直接跳过绘制 → 面板 fps 恒定 ~100、
// 高刷屏上还有顿感。独立窗口更糟：主窗口按 16ms 推 tick，天然顶顶到 ~62fps。
//
// 做法是自带一个显示时钟：每帧按学到的速率自行推进，再用不超过 25% 一帧步长的量
// 向真实播放头收敛 —— 增量恒为正，所以画面连续、绝不会倒退
// （纯外推会在音频台阶变短时回跳几毫秒，肉眼就是"抖一下"）。
//
// ★ 暂停必须立刻锁死：旧版要等 150ms 才吸附，而这 150ms 里每帧还在往前推 6~8ms 内容，
//   修正量又追不回来，最后一下猛地回跳 ~90ms —— 就是用户反复反馈的「暂停时预览抽搐」。
//   现在只要播放头超过「1.5 帧 + 8ms」没动就判定为停，直接对齐真实值、不再外推。

export interface ClockState {
  ready: boolean;
  /** 当前显示时间（秒） */
  t: number;
  /** 上一帧的墙钟（performance.now()） */
  now: number;
  /** 学到的速率：内容秒 / 墙钟毫秒（1x 播放 ≈ 0.001） */
  slope: number;
  lastRaw: number;
  /** 真实播放头上一次发生变化的墙钟时刻 */
  lastStepAt: number;
  /** 上一次调用被告知「暂停中」（恢复播放的第一帧要重新学速率） */
  paused: boolean;
}

export function newClock(): ClockState {
  return { ready: false, t: 0, now: 0, slope: 0, lastRaw: -1, lastStepAt: 0, paused: false };
}

/** 一次吸附：把显示时钟重置到真实值，速率重新学 */
function snap(s: ClockState, raw: number, now: number): number {
  s.ready = true;
  s.t = raw;
  s.now = now;
  s.slope = 0;
  s.lastRaw = raw;
  s.lastStepAt = now;
  s.paused = false;
  return raw;
}

/**
 * 推进一帧，返回这一帧要画的**内容时间**（秒）。
 * @param s       跨帧状态（用同一个对象，就地改）
 * @param raw     真实播放头（秒）
 * @param now     墙钟（performance.now() 毫秒）
 * @param playing 主窗口告知的播放状态（可选）：
 *                `false` → 立刻对齐、零外推（这是最干净的"不抽搐"）；
 *                `true` / 省略 → 走外推 + 停滞检测（独立窗口丢消息时也能自己收敛）。
 */
export function stepClock(s: ClockState, raw: number, now: number, playing?: boolean): number {
  /* 明确知道自己停了 —— 不要再靠猜。
   * 「等播放头不动」永远有 1 个量化台阶（~11ms）的滞后，那点滞后就是暂停后
   * 画面继续落下 20ms 再跳回来的"抽搐"。主窗口知道确切的暂停时刻，直接告诉预览最省事。 */
  if (playing === false) {
    const wasPlaying = !s.paused;
    s.paused = true;
    if (!s.ready || wasPlaying || s.t !== raw) {
      s.ready = true;
      s.t = raw; s.now = now; s.slope = 0; s.lastRaw = raw; s.lastStepAt = now;
    } else {
      s.now = now; // 保持 now 新鲜，恢复播放时不会被 "> 250ms" 误判成切歌
      s.lastRaw = raw; s.lastStepAt = now;
    }
    return raw;
  }
  // 恢复播放的第一帧：重新学速率（暂停期间学的都是 0）
  if (s.paused) return snap(s, raw, now);

  // 首次 / 时间跨度太大（切歌、seek、暂停很久）→ 吸附，重新学习速率
  if (!s.ready || now - s.now > 250 || Math.abs(raw - s.t) > 0.08) return snap(s, raw, now);

  const dt = now - s.now;
  s.now = now;

  // 兜底：没拿到 playing 时，靠"播放头超过 1.5 帧 + 8ms 没动"判定停止
  if (raw === s.lastRaw && now - s.lastStepAt > Math.min(160, dt * 1.5 + 8)) {
    s.t = raw;
    s.slope = 0;
    return raw;
  }

  // 用真实播放头的台阶学习"每毫秒推进多少内容秒"（倍速、拖动都会自动跟上）
  if (raw !== s.lastRaw) {
    const wall = now - s.lastStepAt;
    if (wall > 0.5 && wall < 250 && raw > s.lastRaw) s.slope = (raw - s.lastRaw) / wall;
    s.lastRaw = raw;
    s.lastStepAt = now;
  }
  if (!s.slope) s.slope = 1 / 1000; // 还没学到（起步第一帧）先按 1x 估

  const advance = dt * s.slope;
  const err = raw - s.t;
  // 领先真实播放头超过 25ms → 直接吸附。慢慢往回蹭同样是一眼可见的抖动。
  if (err < -0.025) {
    s.t = raw;
    return raw;
  }
  const fix = Math.max(-advance * 0.25, Math.min(advance * 0.25, err));
  s.t += advance + fix;
  return s.t;
}
