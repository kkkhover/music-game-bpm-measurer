# -*- coding: utf-8 -*-
"""
common.py —— BPM 测速助手 timing JSON → 各音游 timing 转换的公共模块

软件导出的 timing JSON 格式（例如 timing_config_1787176961554.json）：
{
  "version": "1.0",
  "offset": 0.488,          # 秒：第 0 拍（beatIndex=0）相对音乐起点的绝对时间
  "points": [
    { "beatIndex": 0,  "bpm": 182 },
    { "beatIndex": 288, "bpm": 182 },
    ...
  ]
}

核心约定（与软件 utils/osuExport.ts 完全一致）：
  - beatIndex 是从歌曲开头累计的绝对拍号（从 0 开始）
  - 每个点表示：从该拍开始，以该 BPM 打拍，直到下一个点
  - 绝对时间累加：time[i] = time[i-1] + (beatIndex[i]-beatIndex[i-1]) * 60000 / bpm[i-1]
  - time[0] = offset * 1000（毫秒）
"""

import json
import re
import sys


def load_timing(json_path):
    """读取软件导出的 timing JSON，返回 (offset_sec, points)"""
    with open(json_path, 'r', encoding='utf-8-sig') as f:
        data = json.load(f)
    offset = float(data.get('offset', 0.0))
    points = [{'beatIndex': int(p['beatIndex']), 'bpm': float(p['bpm'])}
              for p in data.get('points', [])]
    if not points:
        raise ValueError('JSON 中没有 points 数据')
    # 按 beatIndex 升序排序（与软件 recalculateTiming 保持一致）
    points.sort(key=lambda p: p['beatIndex'])
    return offset, points


def calc_times_ms(offset_sec, points):
    """
    计算每个点的绝对时间（毫秒）。
    与软件 osuExport.ts 的 times 数组逻辑完全一致。
    """
    times = [offset_sec * 1000.0]
    for i in range(len(points) - 1):
        beat_diff = points[i + 1]['beatIndex'] - points[i]['beatIndex']
        delta = beat_diff * 60000.0 / points[i]['bpm']
        times.append(times[-1] + delta)
    return times


def round_half_up(x, digits=2):
    """四舍五入保留指定小数位（与 Python round 的银行家舍入不同，与软件一致）"""
    factor = 10 ** digits
    return int(x * factor + 0.5 + 1e-9) / factor


def bpm_change_points(points):
    """
    只保留「第一个点 + BPM 实际发生变化」的点（与 osu 红线输出规则一致）。
    返回 (idx_list, filtered_points)
    """
    keep_idx = [0]
    for i in range(1, len(points)):
        if points[i]['bpm'] != points[i - 1]['bpm']:
            keep_idx.append(i)
    filtered = [points[i] for i in keep_idx]
    return keep_idx, filtered


def beat_to_bar(beat_index, beats_per_bar=4):
    """绝对拍号 → Malody / Phigros(RPE) 的 beat 三元组 [a, b, c]。

    真实语义（用真实谱面 + Jakads「mcz转osz」对照实测确认）：
      三元素的「值 = a + b/c，单位是拍」，且 **a 就是拍号本身（不是小节号）**。
      实测例：真实 .mc 里音符 [2,0,8]（= 第 2 拍），在 bpm=147、offset≈-392ms 下落在 424ms，
      与转换器产出的 .osu 首个 HitObject 完全吻合。
      （若按「小节」理解成 2 小节×4=8 拍会变成 2873ms，整差 4 倍——所以不是小节。）
      故这里直接把拍号写进第一位、分子 0、分母 1，得到值 = beat_index。

    旧实现是 [拍号//4, 拍号%4, 1]：写 695 会变成 [173,3,1]=176，下一条 [174,1,1]=175，
    既不等值、还会「越写越小」，Malody 时间轴错乱、mcz转osz 之类也算出非单调偏移。
    """
    return [beat_index, 0, 1]


def beat_to_frac(beat_index, beats_per_bar=4):
    """绝对拍号 → 浮点小节拍数（bar + beat/beats_per_bar）。"""
    return beat_index / beats_per_bar


def write_output(text, out_path=None):
    """输出到文件（utf-8）或 stdout"""
    if out_path:
        with open(out_path, 'w', encoding='utf-8') as f:
            f.write(text)
        print(f'已写入: {out_path}')
    else:
        print(text)


def arg_input_output(argv=None, game=None, default_song='song'):
    """解析命令行参数：convert_xxx.py <输入timing.json> [音乐名] [输出文件]
    默认输出文件名 = 「游戏名-音乐名-timing.txt」（如 malody-Sigrdrifa-timing.txt）。
    返回 (in_path, out_path, song_name)。"""
    argv = argv if argv is not None else sys.argv[1:]
    if len(argv) < 1:
        print('用法: python %s <timing.json> [音乐名] [输出文件]' % sys.argv[0])
        sys.exit(1)
    in_path = argv[0]
    song_name = argv[1] if len(argv) > 1 else default_song
    out_path = argv[2] if len(argv) > 2 else None
    if not out_path and game:
        out_path = '%s-%s-timing.txt' % (game, sanitize_filename(song_name))
    return in_path, out_path, song_name


def sanitize_filename(name):
    """清洗文件名中的非法字符（Windows）"""
    cleaned = re.sub(r'[\\/:*?"<>|]', '', name).strip()
    return cleaned or 'song'


def usage_header(song_name, game_name, howto_lines):
    """生成 txt 文件顶部的使用说明注释块（// 开头，提示勿复制进谱面文件）"""
    lines = [
        '// ================================================',
        '// %s - %s Timing 数据' % (song_name, game_name),
        '// 使用说明 (How to use):',
    ]
    for i, ln in enumerate(howto_lines, 1):
        lines.append('//   %d. %s' % (i, ln))
    lines.append('// 以上 // 注释行为提示，替换进谱面文件时请勿复制。')
    lines.append('// ================================================')
    lines.append('')
    return '\n'.join(lines)
