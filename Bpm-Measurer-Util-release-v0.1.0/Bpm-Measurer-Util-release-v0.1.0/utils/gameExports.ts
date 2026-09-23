// 音游 Timing 转换模块
// 将软件 timing（offset + points[beatIndex/bpm/timeSec]）转换为多种音游的 BPM 时间轴：
//   ADOFAI / Malody / Phigros(RPE) / Arcaea / vivid/stasis
// 时间逻辑与 utils/osuExport.ts 完全一致（v0.7.18 起：红线绝对时间 timeSec 优先，其次按拍号累加）
// osu! 导出仍走 utils/osuExport.ts。

import { roundHalfUp } from './osuExport';

// 本模块只依赖 beatIndex/bpm/timeSec 三个字段（与 osuExport.OsuPointInput 一致），
// 不要求完整 TimingPoint（其 time 字段为可选派生值），方便 App 直接传入 rawPoints。
export interface TimingInput {
  beatIndex: number;
  bpm: number;
  sv?: boolean;    // 是否输出绿线/SV（默认 true）
  svRate?: number; // 绿线自定义倍速（0/空 = 按基准BPM自动计算）
  timeSec?: number; // 红线绝对时间（秒）—— 权威值：有则红线位置只由它决定（改 BPM 不会挪动下一条红线）
}

/** 绿线倍速：自定义（svRate>0）优先，否则按「基准BPM/当前BPM」自动计算（保持视觉原速） */
export function svFor(p: TimingInput, baseBpm: number): number {
  return p.svRate && p.svRate > 0 ? p.svRate : roundHalfUp(baseBpm / p.bpm, 6);
}

// ============ 公共：时间与 BPM 变化点 ============

/** 计算每个点的绝对时间（毫秒）：timeSec 优先（红线位置独立），否则按上一段 BPM 累加（与 osuExport 一致） */
export function calcTimesMs(offsetSec: number, points: TimingInput[]): number[] {
  const times: number[] = [offsetSec * 1000];
  for (let i = 0; i < points.length - 1; i++) {
    const prev = points[i];
    const cur = points[i + 1];
    const beatLenPrev = 60000 / Math.max(1, prev.bpm);
    const beatDiff = cur.beatIndex - prev.beatIndex;
    times.push(
      typeof cur.timeSec === 'number' && isFinite(cur.timeSec)
        ? cur.timeSec * 1000
        : times[times.length - 1] + beatDiff * beatLenPrev
    );
  }
  return times;
}

/**
 * 保留全部红线（v0.7.20：用户要求「不要合并、导出完整 timing」）。
 * 函数名保留以兼容各导出器调用点，语义已等价于「原样返回」。
 */
export function bpmChangePoints(points: TimingInput[]): TimingInput[] {
  return points.slice();
}

/**
 * 绝对拍号 → Malody / Phigros(RPE) 的 beat 三元组 [a, b, c]。
 *
 * 真实语义（用真实谱面 + Jakads「mcz转osz」对照实测确认）：
 *   三元素的「值 = a + b/c，单位是拍」，且 **a 就是拍号本身（不是小节号）**。
 *   实测例：真实 .mc 里音符 [2,0,8]（= 第 2 拍），在 bpm=147、offset≈-392ms 下
 *   落在 424ms，与转换器产出的 .osu 首个 HitObject 完全吻合。
 *   （若按「小节」理解成 2 小节×4=8 拍会变成 2873ms，整整差 4 倍——所以不是小节。）
 *   故这里直接把拍号写进第一位、分子 0、分母 1，得到值 = beatIndex。
 *
 * 旧实现是 [拍号//4, 拍号%4, 1]：写 695 会变成 [173,3,1]=176，下一条 [174,1,1]=175，
 * 既不等值、还会「越写越小」，Malody 时间轴错乱、mcz转osz 之类也算出非单调偏移。
 */
export function beatToBar(beatIndex: number, beatsPerBar = 4): [number, number, number] {
  void beatsPerBar; // 绝对拍号表示与拍号无关（3/4、6/8 同样适用）；保留形参仅为兼容调用点
  return [beatIndex, 0, 1];
}

/**
 * 把**任意精确拍位置**写成 Malody 的 beat 三元组（值 = a + b/c）。
 *
 * 为什么必须要这个（v0.8.11 修正「Malody timing 转换偏移」）：
 *   Jakads「mcz转osz」转换 .mc 时，红线时间**完全由 beat 差值推出**，公式是
 *       t[i] = t[i-1] + (beat[i] - beat[i-1]) × 60000 / bpm[i-1]
 *   （见其 convert.py：`bpmoffset.append(ms(beat(x['beat'])-beat(lastbeat), line[j]['bpm'], bpmoffset[j]))`，
 *     `time[i].delay` 字段它**从头到尾没读过**）。
 *   而软件的 beatIndex 是按上一段拍长取整得到的整数（见 utils/timingUtils.ts），
 *   真正的红线位置存在 timeSec 里。旧实现把 beatIndex 直接写进 .mc，
 *   于是"红线不在整拍上"的那部分偏移被整拍整拍地丢掉，还会**逐条累积**：
 *   实测一组 206/150/120/180/100 BPM 的谱面，转出来的红线时间最多偏 **121ms**。
 *
 * 解法：用 beatsFromTimes() 把真实时间反算成累计拍位置（浮点），再在这里用
 *   高分辨率分母（默认 1440 = 2^5·3^2·5，能被 Malody 自己用过的所有分母
 *   2/4/6/8/10/12/18/24/30/40 整除）写成 a + b/1440，精度 1/1440 拍
 *   —— 100BPM 下一拍 600ms，误差上限约 0.4ms，可忽略。
 *
 * @param beat 累计拍位置（可为小数，如 3.2623）
 * @param den  分母（细分格），默认 1440
 */
export function beatToRational(beat: number, den = 1440): [number, number, number] {
  if (!isFinite(beat) || beat < 0) return [0, 0, den];
  const a = Math.floor(beat + 1e-9);
  const b = Math.round((beat - a) * den);
  if (b >= den) return [a + 1, 0, den]; // 进位（四舍五入到整拍）
  return [a, b < 0 ? 0 : b, den];
}

/**
 * 每条红线的**累计拍位置**（浮点）—— 与 beatToRational 配套。
 *
 * 这是「mcz转osz」时间公式的**严格逆运算**：
 *   beat[i] = beat[i-1] + (t[i] - t[i-1]) / (60000 / bpm[i-1])
 * 所以这样写出的 .mc 经它转换后，红线时间能**逐条还原**原来的 timeSec
 * （误差只剩 beatToRational 的 1/1440 拍量化）。
 *
 * 注意：这里必须用「上一段自己的 BPM」做除数（跟转换器一致），
 * 不能用 beatIndex 差值 —— beatIndex 是取整过的。
 */
export function beatsFromTimes(offsetSec: number, points: TimingInput[]): number[] {
  const times = calcTimesMs(offsetSec, points);
  const beats: number[] = [0];
  for (let i = 1; i < times.length; i++) {
    const prevBpm = Math.max(1, points[i - 1].bpm);
    beats.push(beats[i - 1] + (times[i] - times[i - 1]) / (60000 / prevBpm));
  }
  return beats;
}

// ============ 1. ADOFAI（.adofai）============

export function generateAdofaiChart(
  offsetSec: number,
  points: TimingInput[],
  title = 'Timing',
  artist = '',
): string {
  const filtered = bpmChangePoints(points);
  const startBpm = filtered[0]?.bpm ?? 120;
  const actions = filtered.slice(1).map(p => ({
    floor: p.beatIndex,
    eventType: 'SetSpeed',
    speedType: 'Bpm',
    beatsPerMinute: p.bpm,
    angleOffset: 0,
  }));
  const chart = {
    settings: {
      version: 6,
      artist,
      song: title,
      bpm: startBpm,
      offset: Math.round(offsetSec * 1000),
      beat: 0,
      zoom: 1,
      trackColor: '#debb7b',
      trackColor2: '#6f4a21',
      trackDisappearAnimation: 'None',
      countdownTicks: 2,
      noteLines: 0,
      pitch: 100,
      tolerance: 50,
      volume: 100,
      backgroundColor: '#ff0000',
      planetColor: '#00ff00',
    },
    actions,
    pathData: 'R',       // 最小直路，编辑器里替换为实际路径
    angleData: [0],
  };
  return JSON.stringify(chart, null, 2);
}

// ============ 2. Malody（.mc，对照真实谱面订正：meta/time.delay/effect.scroll/特殊note）============

export function generateMalodyChart(
  offsetSec: number,
  points: TimingInput[],
  title = 'Timing',
  artist = '',
  column = 4,
  audioFile = '',
  audioDurationSec = 0,
): string {
  const filtered = bpmChangePoints(points);
  const baseBpm = filtered[0]?.bpm ?? 120;
  // ★ v0.8.11 修正：beat 用「真实时间反算出来的累计拍位置」写成 a + b/1440，
  //   不再直接把取整后的 beatIndex 写进去 —— 详见 beatToRational 的注释。
  //   time / effect 必须**用同一个 beat**，这样 mcz转osz 算出来的绿线时间
  //   正好落在对应红线上（它按"最后一条 beat 不大于它的红线"定位基点）。
  const beats = beatsFromTimes(offsetSec, points);
  const timeList = filtered.map((p, i) => ({ beat: beatToRational(beats[i]), bpm: p.bpm, delay: 0.0 }));
  // effect.scroll = 绿线倍速（svRate 优先）或 基准BPM/当前BPM：BPM 变化时反向补偿，保持下落视觉原速（与 osu 绿线 SV 同公式）
  const effectList = filtered.map((p, i) => ({ beat: beatToRational(beats[i]), scroll: svFor(p, baseBpm) }));

  // ★ v0.8.12：占位音符放到**音频末尾**，而不是第 4 拍。
  //   原因：Malody 的谱面长度以"最后一个音符"为准（真实谱面里音符一直排到曲子结束），
  //   而原来只放一条第 4 拍的占位音符 → 谱面长度 ≈ 4 拍 ≈ 1.3 秒，
  //   编辑器里就表现为"音乐只有几秒钟"。
  //   这里按音频时长（调用方从已解码的音频拿到）反算出末尾那一拍的位置；
  //   拿不到时长时退回"最后一条红线的位置"，至少不会比 timing 短。
  const tailBeat = (() => {
    const lastBeat = beats.length ? beats[beats.length - 1] : 0;
    const lastPoint = points[points.length - 1];
    if (!lastPoint) return 4;
    const bpmLast = Math.max(1, lastPoint.bpm);
    const beatMs = 60000 / bpmLast;
    const lastMs = calcTimesMs(offsetSec, points)[points.length - 1];
    if (Number.isFinite(audioDurationSec) && audioDurationSec > 1) {
      // 留 0.5 秒余量，避免正好压在音频末尾之外
      const endMs = audioDurationSec * 1000 - 500;
      const b = lastBeat + Math.max(0, endMs - lastMs) / beatMs;
      return Math.max(4, b);
    }
    return Math.max(4, lastBeat);
  })();

  // ★ 音频文件名：必须与该谱面文件夹里的音频**同名**（Malody 靠它载入歌曲，找不到就会在打开编辑器时崩溃）。
  //   旧实现写死 'song.ogg' —— 谱面目录里根本没有这个文件，这正是「替换后打开谱面编辑就崩溃」的根因。
  //   这里改用软件「导入音频」时的真实文件名（App.tsx 的 fileName）。
  const audio = audioFile.trim() || 'audio.ogg';

  // 与真实 .mc 逐字段对齐（普查本机 23 个真实 Malody 谱面得出）：
  //  · meta.$ver:0 —— 真实谱面 meta 的第一个字段
  //  · ★ background / cover 必须**保留该键**（值为空串表示无图）。
  //    实测把这两个键整个省掉后，mcz转osz.exe/malody2osu 会直接报错、不产出 .osu
  //    （它无条件读取 meta["background"]）；所以这里写空串，不能删。
  //  · 末尾特殊音符 —— sound 指向音频文件名、vol 音量、type:1，且必须是 note 数组的最后一条
  //  · extra.test.divide —— 编辑器节拍细分（8 = 1/8 拍），与真实谱面一致
  const chart = {
    meta: {
      $ver: 0,
      id: 0,
      creator: 'BPM 测速助手',
      background: '',
      cover: '',
      version: `${column}K`,
      preview: 0,
      mode: 0, // 0 = Key（键盘下落）
      song: {
        id: 0,
        title,
        artist,
        titleorg: title,
        artistorg: artist,
        file: audio,
        bpm: baseBpm,
      },
      mode_ext: { column, bar_begin: 0 },
      aimode: '',
    },
    time: timeList,
    effect: effectList,
    note: [
      // 占位音符：真实 Malody 谱面第 0 拍只放「音频特殊音符」，游戏音符从第 4 拍起。
      // ★ v0.8.12：这条同时用来"撑起谱面长度"——必须排在**音频末尾**，
      //   否则 Malody 编辑器里谱面只有几拍长（表现为"音乐只有几秒钟"）。
      { beat: beatToRational(tailBeat), column: 0 },
      // 末尾特殊音符（必须，且必须是 note 的最后一条）：携带音频文件名与偏移；
      // Malody offset 与 osu 反号（负值毫秒）
      { beat: [0, 0, 1], sound: audio, vol: 100, offset: -Math.round(offsetSec * 1000), type: 1 },
    ],
    extra: { test: { divide: 8, speed: 100, save: 0, lock: 0, edit_mode: 0 } },
  };
  // Malody 的 .mc 原文件是「全部内容压成一行」的紧凑 JSON（无缩进/无空格）。
  // 旧实现输出 indent=2 的美化 JSON（几千个空格 + 上千行），用户反映「有空格不能直接当 .mc 用」，
  // 故这里改成紧凑序列化，与真实谱面字节风格一致，可存为 xxx.mc 直接放进谱面文件夹。
  return JSON.stringify(chart);
}

// ============ 3. Phigros（RPE 自制谱 .json）============

export function generatePhigrosChart(
  offsetSec: number,
  points: TimingInput[],
  name = 'Timing',
  composer = '',
  level = 'Lv.0',
): string {
  const filtered = bpmChangePoints(points);
  const times = calcTimesMs(offsetSec, points);
  const bpmList = filtered.map(p => ({
    bpm: p.bpm,
    startTime: beatToBar(p.beatIndex),
    startBeat: p.beatIndex,
    startTimeSec: Math.round((times[points.indexOf(p)] / 1000) * 1e6) / 1e6,
  }));
  const chart = {
    formatVersion: 3,
    RPEVersion: 4,
    meta: {
      RPEVersion: 4,
      offset: Math.round(offsetSec * 1000),
      name,
      song: name,
      level,
      charter: 'BPM 测速助手',
      composer,
      background: '',
      illustration: '',
      id: '',
      duration: 0,
    },
    BPMList: bpmList,
    judgeLineList: [
      {
        eventLayers: [
          {
            type: 0,
            alphaEvents: [],
            moveEvents: [],
            rotateEvents: [],
            speedEvents: [
              { startTime: [0, 0, 1], endTime: [100000, 0, 1], start: 1.0, end: 1.0 },
            ],
          },
        ],
        notes: [],
      },
    ],
  };
  return JSON.stringify(chart, null, 2);
}

// ============ 4. Arcaea（.aff）============

export function generateArcaeaAff(offsetSec: number, points: TimingInput[]): string {
  const filtered = bpmChangePoints(points);
  if (filtered.length === 0) return 'AudioOffset:0\n-\n-\n';
  const times = calcTimesMs(offsetSec, points);
  const lines = ['AudioOffset:0', '-', 'Timing:'];
  for (const p of filtered) {
    const t = Math.round(times[points.indexOf(p)]);
    lines.push(`timing(${t},${p.bpm.toFixed(2)},4.00);`);
  }
  lines.push('-');
  return lines.join('\n');
}

// ============ 5. vivid/stasis（vschart.json，formatVersion=2）============

export function generateVividStasisChart(
  offsetSec: number,
  points: TimingInput[],
  difficultyName = 'OPENING',
  difficultyConstant = 3.0,
): string {
  const filtered = bpmChangePoints(points);
  const baseBpm = filtered[0]?.bpm ?? 120;
  const timingPoints = filtered.map(p => ({
    beat: p.beatIndex,             // 拍（浮点），第一个点 0.0；BPM 阶跃突变
    bpm: p.bpm,
    timesigNumerator: 4,
    timesigDenominator: 4,
  }));
  // events.speed = 绿线倍速（svRate 优先）或 基准BPM/当前BPM：保持下落视觉原速（与 osu 绿线 SV、Malody effect.scroll 同公式）
  const events = filtered.map(p => ({
    eventType: 'speed',
    beat: p.beatIndex,
    value: svFor(p, baseBpm),
  }));
  const chart = {
    formatVersion: 2,
    offset: offsetSec,             // 秒（正数=音频提前播放）
    timingPoints,
    notes: [],                     // timing 转换不含音符（编辑器添加）
    events,
    metadata: {
      difficultyName,              // 必须大写：PRELUDE/OPENING/MIDDLE/FINALE/ENCORE/BACKSTAGE/SHATTER
      difficultyConstant,
      charter: 'BPM 测速助手',
      noteCount: 0,
    },
  };
  return JSON.stringify(chart, null, 2);
}
