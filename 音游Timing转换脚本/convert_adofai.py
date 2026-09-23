# -*- coding: utf-8 -*-
"""
convert_adofai.py —— 软件 timing JSON → ADOFAI（A Dance of Fire and Ice / 冰与火之舞）谱面 .adofai

.adofai 是 JSON 文件，关键结构：
  settings.offset  : 整体偏移（毫秒），音乐相对谱面起点的延迟
  settings.bpm     : 起始 BPM
  actions          : 事件数组，BPM 变化用 SetSpeed 事件：
                     {"floor": 拍号, "eventType": "SetSpeed",
                      "speedType": "Bpm", "beatsPerMinute": 182, "angleOffset": 0}
  pathData/angleData : 路径定义（至少一格才能被游戏读取，这里给最小直路）

说明：
  - ADOFAI 中每格地板 = 1 拍（180 度），软件的 beatIndex 直接映射为 floor
  - 仅「起始 BPM + BPM 变化点」生成 SetSpeed 事件（与 osu 红线规则一致）
  - offset 单位毫秒，直接取软件的 offset×1000

用法：
  python convert_adofai.py timing_config.json [输出.adofai]
"""

import json
import sys
from common import load_timing, bpm_change_points, arg_input_output, write_output, usage_header


def convert(offset_sec, points, title='Timing', artist=''):
    """返回可保存的 .adofai 字典（JSON 对象）"""
    _, filtered = bpm_change_points(points)
    start_bpm = filtered[0]['bpm'] if filtered else 120.0

    settings = {
        "version": 6,
        "artist": artist,
        "song": title,
        "bpm": start_bpm,                     # 起始 BPM
        "offset": int(round(offset_sec * 1000)),   # 毫秒
        "beat": 0,
        "zoom": 1,
        "trackColor": "#debb7b",
        "trackColor2": "#6f4a21",
        "trackDisappearAnimation": "None",
        "countdownTicks": 2,
        "noteLines": 0,
        "pitch": 100,
        "tolerance": 50,
        "volume": 100,
        "backgroundColor": "#ff0000",
        "planetColor": "#00ff00",
    }

    actions = []
    # 第一个点作为起始 BPM（已写进 settings.bpm），从第二个保留点开始放 SetSpeed
    for i, p in enumerate(filtered):
        if i == 0:
            continue
        actions.append({
            "floor": p['beatIndex'],
            "eventType": "SetSpeed",
            "speedType": "Bpm",
            "beatsPerMinute": p['bpm'],
            "angleOffset": 0,
        })

    chart = {
        "settings": settings,
        "actions": actions,
        "pathData": "R",      # 最小直路：向右一格（必须非空）
        "angleData": [0],
    }
    return chart


def main():
    in_path, out_path, song = arg_input_output(game='adofai')
    offset, points = load_timing(in_path)
    chart = convert(offset, points, title=song)
    text = usage_header(song, 'ADOFAI', [
        '复制 actions 数组（SetSpeed 事件）替换 .adofai 谱面对应字段；',
        '同时替换 settings.bpm 与 settings.offset；pathData 需换成实际路径（默认为最小直路 R）。',
    ]) + json.dumps(chart, ensure_ascii=False, indent=2)
    write_output(text, out_path)


if __name__ == '__main__':
    main()
