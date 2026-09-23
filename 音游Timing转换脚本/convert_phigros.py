# -*- coding: utf-8 -*-
"""
convert_phigros.py —— 软件 timing JSON → Phigros 自制谱（RPE / Re:PhiEdit 格式 .json）

RPE 关键结构（PhiEditor 可编辑、Phira 可导入）：
  RPEVersion   : 编辑器版本号
  BPMList      : BPM 变化列表：
                 [{"bpm": 182,
                   "startTime": [小节, 拍, 分母],   # 拍号数组（4/4）
                   "startBeat": 0,                   # 绝对拍数（浮点）
                   "startTimeSec": 0.0}, ...]        # 绝对时间（秒）
  judgeLineList: 判定线列表。这里输出 1 条空判定线（仅节奏信息，无音符），
                 音符（tap/hold 等）可在 PhiEditor 中后续添加

说明：
  - Phigros 谱面中音符/事件时间用「拍」表达，BPM 变化由 BPMList 定义
  - startTimeSec = 对应拍的绝对时间（秒），startBeat = 绝对拍数
  - offset 写入 RPE 顶层 meta.offset（毫秒）

用法：
  python convert_phigros.py timing_config.json [输出.json]
"""

import json
import sys
from common import (load_timing, calc_times_ms, beat_to_bar, beat_to_frac,
                    bpm_change_points, arg_input_output, write_output, usage_header)


def convert(offset_sec, points, name='Timing', composer='', level='Lv.0'):
    """返回 RPE 格式字典"""
    _, filtered = bpm_change_points(points)
    times = calc_times_ms(offset_sec, points)
    keep_idx, _ = bpm_change_points(points)

    bpm_list = []
    for i, idx in enumerate(keep_idx):
        bpm = points[idx]['bpm']
        beat = points[idx]['beatIndex']
        bpm_list.append({
            "bpm": bpm,
            "startTime": beat_to_bar(beat),
            "startBeat": float(beat),
            "startTimeSec": round(times[idx] / 1000.0, 6),
        })

    # 一条空判定线：定义 BPM 参考 + 全曲 1.0 速度事件（速度单位 Y/s）
    judge_line = {
        "eventLayers": [
            {
                "type": 0,
                "alphaEvents": [],
                "moveEvents": [],
                "rotateEvents": [],
                "speedEvents": [
                    {
                        "startTime": [0, 0, 1],
                        "endTime": [100000, 0, 1],
                        "start": 1.0,
                        "end": 1.0,
                    }
                ],
            }
        ],
        "notes": [],
    }

    meta = {
        "RPEVersion": 4,
        "offset": int(round(offset_sec * 1000)),   # 毫秒
        "name": name,
        "song": name,
        "level": level,
        "charter": "BPM 测速助手",
        "composer": composer,
        "background": "",
        "illustration": "",
        "id": "",
        "duration": 0,
    }

    chart = {
        "formatVersion": 3,
        "RPEVersion": 4,
        "meta": meta,
        "BPMList": bpm_list,
        "judgeLineList": [judge_line],
    }
    return chart


def main():
    in_path, out_path, song = arg_input_output(game='phigros')
    offset, points = load_timing(in_path)
    chart = convert(offset, points, name=song)
    text = usage_header(song, 'Phigros', [
        '用 PhiEditor（Re:PhiEdit）打开本文件或复制 BPMList 进现有谱面；',
        '在编辑器中检查 BPM 曲线后添加音符；meta.offset 单位为毫秒。',
    ]) + json.dumps(chart, ensure_ascii=False, indent=2)
    write_output(text, out_path)


if __name__ == '__main__':
    main()
