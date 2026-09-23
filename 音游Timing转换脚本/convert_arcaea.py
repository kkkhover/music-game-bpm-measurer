# -*- coding: utf-8 -*-
"""
convert_arcaea.py —— 软件 timing JSON → Arcaea 自制谱（.aff）

.aff 关键结构：
  AudioOffset:x          头部整体偏移（毫秒），这里写 0（偏移已算进 timing 时间）
  -                       分隔线
  timing(t,bpm,4.00);    BPM 事件：t=毫秒，bpm=两位小数，4.00=4/4 拍号

规则：
  - Arcaea 要求必须有一条 t=0 的 timing：先输出 timing(0, 起始bpm, 4.00)
  - 其余 BPM 变化点按绝对时间输出（软件 offset 已计入：第 0 拍在 offset×1000 ms）
  - 仅「起始 BPM + BPM 变化点」输出（相邻相同 BPM 合并）

用法：
  python convert_arcaea.py timing_config.json [输出.aff]
"""

import sys
from common import (load_timing, calc_times_ms, bpm_change_points,
                    arg_input_output, write_output, usage_header)


def convert(offset_sec, points):
    """返回 .aff 文本"""
    keep_idx, filtered = bpm_change_points(points)
    if not filtered:
        return 'AudioOffset:0\n-\n-\n'

    times = calc_times_ms(offset_sec, points)

    lines = ['AudioOffset:0', '-', 'Timing:']
    for i, idx in enumerate(keep_idx):
        bpm = filtered[i]['bpm']
        t = int(round(times[idx]))
        # bpm/beats 均保留两位小数（Arcaea 要求）
        lines.append('timing(%d,%.2f,4.00);' % (t, bpm))
    lines.append('-')
    return '\n'.join(lines)


def main():
    in_path, out_path, song = arg_input_output(game='arcaea')
    offset, points = load_timing(in_path)
    text = convert(offset, points)
    text = usage_header(song, 'Arcaea', [
        '复制 Timing: 段的 timing(...) 行替换 .aff 谱面对应段落；',
        'AudioOffset 保持原样即可；文件已包含 t=0 的必须 timing。',
    ]) + text
    write_output(text, out_path)


if __name__ == '__main__':
    main()
