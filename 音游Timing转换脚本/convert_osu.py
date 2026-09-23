# -*- coding: utf-8 -*-
"""
convert_osu.py —— 软件 timing JSON → osu! TimingPoints（.osu 的 [TimingPoints] 段 / 纯文本 .txt）

输出格式（与软件「导出 osu! TimingPoints」按钮完全一致）：
  [TimingPoints]
  475,329.670329670330,4,1,0,72,1,0     ← 红线：定义 BPM，beatLength = 60000/bpm
  475,-100.000000000000,4,1,0,72,0,0    ← 绿线：流速 SV = 基准BPM/当前BPM，-100/SV
  489046,300.390507659958,4,1,0,72,1,0
  ...

规则：
  - 红线仅「第一个点 + BPM 变化点」输出（相邻相同 BPM 只输出一次）
  - 绿线紧随红线（基准 BPM = 第一个点的 BPM；SV 四舍五入两位）
  - 时间累加：time[i] = time[i-1] + (beatIndex 差) × 60000 / bpm[i-1]，time[0] = offset×1000

用法：
  python convert_osu.py timing_config.json [输出.osu 或 .txt]
"""

import sys
from common import load_timing, calc_times_ms, round_half_up, bpm_change_points, arg_input_output, usage_header


def convert(offset_sec, points):
    """返回 [TimingPoints] 文本"""
    _, filtered = bpm_change_points(points)
    if not filtered:
        return '[TimingPoints]'

    times = calc_times_ms(offset_sec, points)          # 全部点的绝对时间
    keep_idx, _ = bpm_change_points(points)            # 保留点的下标
    base_bpm = points[0]['bpm']                        # 基准 BPM（绿线 SV 用）

    out = ['[TimingPoints]']
    for i, idx in enumerate(keep_idx):
        bpm = points[idx]['bpm']
        t = round(times[idx])
        beat_len = 60000.0 / bpm
        out.append('%d,%.12f,4,1,0,72,1,0' % (t, beat_len))
        sv = round_half_up(base_bpm / bpm, 2)
        green = -100.0 / sv
        out.append('%d,%.12f,4,1,0,72,0,0' % (t, green))
    return '\n'.join(out)


def main():
    in_path, out_path, song = arg_input_output(game='osu')
    offset, points = load_timing(in_path)
    text = convert(offset, points)
    # 顶部使用说明（// 注释行，勿复制进谱面）
    text = usage_header(song, 'osu!', [
        '复制 [TimingPoints] 段（红线+绿线）替换 .osu 谱面中的对应段落；',
        '[TimingPoints] 位于 [HitObjects] 之前；绿线为变速 SV（保持原速）。',
    ]) + text
    if out_path:
        with open(out_path, 'w', encoding='utf-8') as f:
            f.write(text)
        print('已写入: %s' % out_path)
    else:
        print(text)


if __name__ == '__main__':
    main()
