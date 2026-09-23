# -*- coding: utf-8 -*-
"""
convert_malody.py —— 软件 timing JSON → Malody 谱面时间轴（.txt 文本，JSON 内容）

输出为 Malody 谱面（.mc 是 JSON 结构，这里统一导出为文本文件 malody-timing.txt，
可把内容复制进 .mc 的对应字段，或按文末说明替换谱面文件）。

.mc 关键结构（对照真实谱面 黄昏の碑文 1628597331.mc 等 23 个真实谱面订正）：
  meta    : 歌曲信息；$ver=0、mode=0 键盘模式、mode_ext.column=轨道数；
            background/cover 必须保留该键（空串=无图）—— 整个省掉会让 mcz转osz 等工具报错
  time    : BPM 变化列表，[{"beat":[拍号,0,1], "bpm": 182, "delay": 0.0}, ...]
  effect  : 视觉变速（保持原速）：
            [{"beat":[拍号,0,1], "scroll": 基准BPM/当前BPM}, ...]
            scroll 与 osu 绿线 SV 同公式：BPM 变化时 scroll 反向补偿，
            使音符下落视觉速度恒定（"变速保持原速"）
  note    : 音符列表；第 0 拍放音频特殊音符、游戏音符从第 4 拍起；
            特殊音符必须是**最后一条**，携带音频与偏移：
            {"beat":[0,0,1], "sound":"音频文件名", "vol":100, "offset": 毫秒(负值), "type":1}
            —— sound 必须与谱面文件夹里的音频同名，否则 Malody 打开谱面编辑会崩溃
  extra   : {"test":{"divide":8, ...}} 编辑器节拍细分等状态

说明：
  - beat 数组 [a,b,c] = a + b/c 拍；默认 4/4（4 拍一小节）
  - Malody 的 offset 约定与 osu 相反（负值毫秒）：offset = -round(软件offset×1000)
  - 仅输出「起始 BPM + BPM 变化点」（相同 BPM 的重复点省略）

用法：
  python convert_malody.py timing_config.json [输出.txt]

可调参数（在下方 CONFIG 中修改）：
  TITLE / ARTIST / AUDIO_FILE / COLUMN  → 歌曲名 / 曲师 / 音频文件名 / 轨道数
"""

import json
import sys
from common import (load_timing, beat_to_bar, bpm_change_points,
                    arg_input_output, write_output)

# ===== 可调参数 =====
CONFIG = {
    'title': 'Timing',          # 歌曲标题
    'artist': '',               # 曲师
    'audio_file': 'song.ogg',   # 音频文件名（与歌曲放同一目录）
    'column': 4,                # 轨道数（4K 默认，可改 5/6/7K）
    'difficulty': '4K',         # 难度显示名（meta.version）
    'creator': 'BPM 测速助手',  # 谱师
}
# ====================


def convert(offset_sec, points, cfg=None):
    """返回 .mc 字典（JSON 对象）"""
    cfg = {**CONFIG, **(cfg or {})}
    _, filtered = bpm_change_points(points)
    if not filtered:
        filtered = [{'beatIndex': 0, 'bpm': 120.0}]

    base_bpm = filtered[0]['bpm']  # 基准 BPM（scroll 保持原速用）

    # meta 与真实 .mc 逐字段对齐（普查 23 个真实谱面得出）：
    #  · $ver:0 —— 真实谱面 meta 的第一个字段
    #  · ★ background / cover 必须**保留该键**（空串表示无图）。
    #    实测把这两个键整个省掉后，mcz转osz.exe/malody2osu 会直接报错、不产出 .osu
    #    （它无条件读取 meta["background"]）；所以写空串，不能删。
    meta = {
        "$ver": 0,
        "id": 0,
        "creator": cfg['creator'],
        "background": "",
        "cover": "",
        "version": cfg['difficulty'],
        "preview": 0,
        "mode": 0,                                   # 0 = Key（键盘下落）模式
        "song": {
            "id": 0,
            "title": cfg['title'],
            "artist": cfg['artist'],
            "titleorg": cfg['title'],
            "artistorg": cfg['artist'],
            "file": cfg['audio_file'],
            "bpm": base_bpm,
        },
        "mode_ext": {
            "column": cfg['column'],
            "bar_begin": 0,
        },
        "aimode": "",
    }

    time_list = []
    effect_list = []
    for p in filtered:
        beat = beat_to_bar(p['beatIndex'])
        time_list.append({"beat": beat, "bpm": p['bpm'], "delay": 0.0})
        # scroll = 基准BPM/当前BPM：BPM 变化时反向补偿，保持下落视觉原速（与 osu 绿线同公式）
        effect_list.append({"beat": beat, "scroll": round(base_bpm / p['bpm'], 6)})

    # Malody offset 约定：负值毫秒（与 osu 反号）
    malody_offset = -int(round(offset_sec * 1000))
    # note 与真实谱面一致：第 0 拍只放音频特殊音符、游戏音符从第 4 拍起；
    # 特殊音符必须是最后一条，sound 指向音频文件名（找不到会崩溃）、vol 音量、type:1
    note_list = [
        # 占位音符（4K 左轨第 4 拍）；替换谱面时在此追加真实音符
        {"beat": [4, 0, 1], "column": 0},
        # 末尾特殊音符（必须，且必须是最后一条）：携带音频文件名与偏移信息
        {"beat": [0, 0, 1], "sound": cfg['audio_file'], "vol": 100,
         "offset": malody_offset, "type": 1},
    ]

    chart = {
        "meta": meta,
        "time": time_list,
        "effect": effect_list,
        "note": note_list,
        # extra.test 是编辑器节拍细分等状态（8 = 1/8 拍），与真实谱面一致
        "extra": {"test": {"divide": 8, "speed": 100, "save": 0, "lock": 0, "edit_mode": 0}},
    }
    return chart


def main():
    in_path, out_path, song = arg_input_output(game='malody', default_song=CONFIG['title'])
    offset, points = load_timing(in_path)
    chart = convert(offset, points, {**CONFIG, 'title': song})
    # 产物必须是**纯 JSON**：.mc 由标准 JSON 解析器读取，任何 “//” 注释（含 BOM 之外的杂质）
    # 都会让它加载失败。实测把带注释头的导出文件直接改名喂给转换器不会产出任何谱面。
    # 因此使用说明不写进文件，改为打印到终端。
    text = json.dumps(chart, ensure_ascii=False, separators=(',', ':'))
    write_output(text, out_path)
    print('')
    print('使用说明（未写入文件，以保持纯 JSON）：')
    print('  1. 直接改名为 xxx.mc 放进谱面文件夹即可（本文件不含任何注释）；')
    print('  2. 或复制 time（BPM）与 effect（变速保持原速）数组，替换现有 .mc 的对应字段；')
    print('  3. meta.song.file 与特殊音符 sound 已填成 %s；若目标谱面的音频不同名，请改成实际文件名 —— 同名才能载入，否则 Malody 打开谱面编辑会崩溃。' % CONFIG['audio_file'])


if __name__ == '__main__':
    main()
