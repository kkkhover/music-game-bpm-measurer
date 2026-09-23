# -*- coding: utf-8 -*-
"""
convert_vividstasis.py —— 软件 timing JSON → vivid/stasis 自制谱时间轴（vschart.json，.txt 文本）

输出为 vivid/stasis 明文自制谱（formatVersion=2），统一导出为文本文件 vividstasis-timing.txt，
内容可直接作为 vschart.json 使用（按文末说明替换谱面文件）。

格式要点（对照 vivid/stasis vschart.json 格式文档）：
  formatVersion : 固定 2
  offset        : 全局音频偏移，单位【秒】。正数=音频提前播放（与软件 offset 语义一致，直接沿用）
  timingPoints  : BPM 变化点 [{"beat": 拍(浮点), "bpm": x, "timesigNumerator": 4, "timesigDenominator": 4}]
                  必须按 beat 升序；BPM 阶跃突变；第一个点 beat=0.0
  notes         : 音符（timing 转换不含音符，输出空数组，可在谱面编辑器中添加）
  events        : 变速事件 [{"eventType":"speed","beat":拍,"value":倍率}]
                  speed 是【视觉下落速度】，与 BPM 无关。
                  保持原速：value = 基准BPM/当前BPM（与 osu 绿线 SV、Malody effect.scroll 同公式）
  metadata      : 难度信息（difficultyName 必须大写）

Beat→秒换算：分段累加（每区间 秒数 = 拍差 × 60/bpm），最终音频时间 = beat时间 + offset

用法：
  python convert_vividstasis.py timing_config.json [输出.txt]

可调参数（下方 CONFIG）：
  DIFFICULTY_NAME（大写）/ DIFFICULTY_CONSTANT / CHARTER
"""

import json
import sys
from common import load_timing, bpm_change_points, arg_input_output, write_output, usage_header

# ===== 可调参数 =====
CONFIG = {
    'difficulty_name': 'OPENING',   # 大写：PRELUDE/OPENING/MIDDLE/FINALE/ENCORE/BACKSTAGE/SHATTER
    'difficulty_constant': 3.0,     # 定数（Rating 用）
    'charter': 'BPM 测速助手',      # 谱师
}
# ====================


def convert(offset_sec, points, cfg=None):
    """返回 vschart.json 字典"""
    cfg = {**CONFIG, **(cfg or {})}
    _, filtered = bpm_change_points(points)
    if not filtered:
        filtered = [{'beatIndex': 0, 'bpm': 120.0}]

    base_bpm = filtered[0]['bpm']  # 基准 BPM（speed 保持原速用）

    timing_points = []
    events = []
    for p in filtered:
        beat = float(p['beatIndex'])
        # timingPoints：BPM 阶跃突变，第一个点 beat=0.0（软件 beat 0 即起点，offset 由顶层字段承担）
        timing_points.append({
            "beat": beat,
            "bpm": p['bpm'],
            "timesigNumerator": 4,
            "timesigDenominator": 4,
        })
        # events.speed：保持下落视觉原速（基准BPM/当前BPM，与 osu 绿线 SV 同公式）
        events.append({
            "eventType": "speed",
            "beat": beat,
            "value": round(base_bpm / p['bpm'], 6),
        })

    chart = {
        "formatVersion": 2,
        "offset": offset_sec,          # 秒；正数=音频提前播放（与软件 offset 语义一致）
        "timingPoints": timing_points,
        "notes": [],                   # timing 转换不含音符（编辑器添加）
        "events": events,
        "metadata": {
            "difficultyName": cfg['difficulty_name'],
            "difficultyConstant": cfg['difficulty_constant'],
            "charter": cfg['charter'],
            "noteCount": 0,            # mine 不计入；此处无音符
        },
    }
    return chart


def main():
    in_path, out_path, song = arg_input_output(game='vividstasis')
    offset, points = load_timing(in_path)
    chart = convert(offset, points)
    text = usage_header(song, 'vivid/stasis', [
        '将文件改名为 xxx.vschart.json（如 finale.vschart.json）放入歌曲目录；',
        'difficultyName 需与文件名对应（OPENING/FINALE 等，均大写）；',
        'timingPoints 与 events 已含变速（speed 保持原速），notes 用编辑器补。',
    ]) + json.dumps(chart, ensure_ascii=False, indent=2)
    write_output(text, out_path)


if __name__ == '__main__':
    main()
