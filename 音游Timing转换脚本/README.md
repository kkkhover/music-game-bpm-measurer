# BPM 测速助手 → 音游 Timing 转换脚本

把 BPM 测速助手软件导出的 timing JSON，转换为 **6 种音游**的谱面时间轴（BPM 变速）定义。

> 当前只转换 **BPM 时间轴**（变速节奏），不含音符排布。生成的谱面结构完整可被对应编辑器打开，
> 音符可在编辑器中后续添加。**所有输出统一为 txt 文本格式，命名「游戏名-音乐名-timing.txt」**，
> txt 文件顶部带有该游戏的替换使用说明（`//` 注释行，替换进谱面时勿复制）。

---

## 一、输入格式（软件导出的 timing JSON）

```json
{
  "version": "1.0",
  "offset": 0.488,        // 秒：第 0 拍相对音乐起点的绝对时间
  "points": [
    { "beatIndex": 0,  "bpm": 182 },
    { "beatIndex": 288, "bpm": 182 },
    { "beatIndex": 695, "bpm": 180 },
    ...
  ]
}
```

**核心约定**（与软件内「导出 osu! TimingPoints」逻辑完全一致）：
- `beatIndex` 是从歌曲开头累计的**绝对拍号**（从 0 开始）
- 每个点表示：从该拍开始按该 BPM 打拍，直到下一个点
- 时间累加：`time[i] = time[i-1] + (beatIndex[i]-beatIndex[i-1]) × 60000 / bpm[i-1]`
- 所有脚本都只输出「**起始点 + BPM 实际变化点**」（相邻相同 BPM 自动合并）
- **变速保持原速**：Malody 的 `effect.scroll`、vivid/stasis 的 `events.speed` 均采用
  `基准BPM ÷ 当前BPM` 反向补偿（与 osu 绿线 SV 同公式），BPM 变化时下落视觉速度恒定

---

## 二、支持的音游与用法

所有脚本用法统一：`python convert_xxx.py <timing.json> [音乐名] [输出文件]`
（`音乐名` 缺省为 song；不给输出文件时自动生成默认名「游戏名-音乐名-timing.txt」）

| # | 音游 | 脚本 | 输出内容 | 默认文件名（音乐名=xxx） |
|---|------|------|----------|-----------|
| 1 | osu!（含 mania） | `convert_osu.py` | `[TimingPoints]` 红线 BPM + 绿线 SV | `osu-xxx-timing.txt` |
| 2 | Malody | `convert_malody.py` | JSON：`meta` + `time` BPM 列表 + `effect` 变速 | `malody-xxx-timing.txt` |
| 3 | Arcaea 自制谱 | `convert_arcaea.py` | `AudioOffset` + `timing(t,bpm,4.00);` | `arcaea-xxx-timing.txt` |
| 4 | Phigros 自制谱 | `convert_phigros.py` | RPE 格式：`BPMList` + 空判定线 | `phigros-xxx-timing.txt` |
| 5 | ADOFAI（冰与火之舞） | `convert_adofai.py` | JSON：`settings.bpm/offset` + `actions` SetSpeed | `adofai-xxx-timing.txt` |
| 6 | vivid/stasis | `convert_vividstasis.py` | vschart.json：`timingPoints` + `events`(speed) | `vividstasis-xxx-timing.txt` |

示例（用真实 timing 文件 + 音乐名 Sigrdrifa 生成，见 `examples/` 目录）：

```bash
python convert_osu.py timing_config.json Sigrdrifa examples/osu-Sigrdrifa-timing.txt
python convert_malody.py timing_config.json Sigrdrifa examples/malody-Sigrdrifa-timing.txt
python convert_arcaea.py timing_config.json Sigrdrifa examples/arcaea-Sigrdrifa-timing.txt
python convert_phigros.py timing_config.json Sigrdrifa examples/phigros-Sigrdrifa-timing.txt
python convert_adofai.py timing_config.json Sigrdrifa examples/adofai-Sigrdrifa-timing.txt
python convert_vividstasis.py timing_config.json Sigrdrifa examples/vividstasis-Sigrdrifa-timing.txt
```

每个 txt 文件顶部带有 `//` 注释形式的使用说明（该游戏的替换步骤），替换进谱面时**请勿复制注释行**。

---

## 三、各音游格式细节

### 1. osu!（`convert_osu.py`）
```
[TimingPoints]
488,329.670329670330,4,1,0,72,1,0   ← 红线：beatLength = 60000/bpm
488,-100.000000000000,4,1,0,72,0,0  ← 绿线：SV = 基准BPM/当前BPM，-100/SV（四舍五入两位）
```
- 基准 BPM = 第一个点的 BPM；与软件内「导出 osu! TimingPoints」按钮输出完全一致

### 2. Malody（`convert_malody.py`）
- `time` 列表：`{"beat": [a, b, c], "bpm": x, "delay": 0.0}`
  —— 三元组的**值 = `a + b/c`，单位是「拍」，`a` 就是拍号本身**（不是小节号）。
  实测真实谱面：音符 `[2,0,8]` = 第 2 拍（bpm=147、offset≈-392ms 时落在 424ms，与转换器产出的 `.osu` 首个 HitObject 吻合）；
  若按「小节」理解成 2×4=8 拍会整整差 4 倍。故导出直接把拍号写进第一位：`[拍号, 0, 1]`。
- **`effect` 列表（保持原速）**：`{"beat": [...], "scroll": 基准BPM/当前BPM}`
  —— 与 osu 绿线 SV 同公式，BPM 变化时下落视觉速度恒定（对照真实谱面订正）
- `meta` 完整结构（id/creator/song/mode_ext/aimode 等）；末尾特殊音符携带音频文件名与 offset
- offset 写入末尾特殊 note（毫秒，**与 osu 反号**，Malody 惯例）；`meta.mode_ext.column` 默认 4（4K）
- 输出为**纯 JSON**（单行紧凑；真实 `.mc` 就是「把全部内容压成一行」）。
  使用说明只打印到终端、**不写入文件** —— `.mc` 由标准 JSON 解析器读取，
  任何 `//` 注释都会让它直接加载失败（实测：把带注释头的导出文件喂给 mcz转osz 转换器，
  **不会产出任何谱面**）。所以导出文件**可直接改名 `.mc`** 使用，无需手动删注释。

### 3. Arcaea（`convert_arcaea.py`）
```
AudioOffset:0
-
Timing:
timing(488,182.00,4.00);     ← 已含 t=0 必须行（Arcaea 要求），偏移已计入时间
-
```
- bpm 两位小数、4/4 拍号

### 4. Phigros（`convert_phigros.py`）
- RPE（Re:PhiEdit）格式，`BPMList` 定义全部变速：
  ```json
  {"bpm": 180.0, "startTime": [695,0,1], "startBeat": 695.0, "startTimeSec": 229.609}
  ```
- 用 **PhiEditor** 打开后添加音符；`meta.offset` 毫秒

### 5. ADOFAI（`convert_adofai.py`）
- `settings.bpm` = 起始 BPM，`settings.offset` = 偏移（毫秒）
- 每个 BPM 变化点 = 一条 `SetSpeed` 事件，`floor` = 绝对拍号
- `pathData` 给最小直路 `"R"`，在编辑器里替换成实际路径

### 6. vivid/stasis（`convert_vividstasis.py`）
- vschart.json（formatVersion=2）：`timingPoints`（BPM 阶跃变化，第一个点 beat=0.0）+ `events`（speed）
- **变速保持原速**：`events.speed.value = 基准BPM/当前BPM`（与 osu 绿线 SV 同公式；speed 是视觉下落速度，与 BPM 无关）
- `offset` 单位**秒**（正数=音频提前播放，与软件 offset 语义一致直接沿用）
- `metadata.difficultyName` 必须大写（PRELUDE/OPENING/MIDDLE/FINALE/ENCORE/BACKSTAGE/SHATTER）
- `notes` 输出空数组，用编辑器添加音符

---

## 四、文件说明

```
音游Timing转换脚本/
├── common.py               公共模块（读 JSON / 时间累加 / 拍号换算 / BPM 变化点过滤）
├── convert_osu.py          osu!
├── convert_malody.py       Malody（对照真实谱面订正）
├── convert_arcaea.py       Arcaea
├── convert_phigros.py      Phigros（RPE）
├── convert_adofai.py       A Dance of Fire and Ice
├── convert_vividstasis.py  vivid/stasis（vschart.json）
└── examples/               用真实 timing 生成的 6 个示例文件
```

**扩展新音游**：复制任意 `convert_xxx.py` 模板，改 `convert()` 函数输出目标格式即可——
时间计算全部由 `common.calc_times_ms()` 提供，与软件内导出逻辑保持 100% 一致。

---

## 五、如何替换谱面文件（重要）

生成的 timing 文件只是**时间轴**，要变成可玩的谱面，需要把内容合并进对应游戏的谱面文件。
以下是各音游的替换/使用方式（以 `游戏名-音乐名-timing.txt` 为例；每个文件顶部已有同样的说明）：

### 1. osu!（osu-timing.txt）
- 内容就是 `[TimingPoints]` 段：用文本编辑器打开你的 `.osu` 谱面，
  把 `[TimingPoints]` 段落整段替换为 timing 文件内容（保留原来的 `[HitObjects]` 等段落）。
- 注意：osu 的 `.osu` 文件中 `[TimingPoints]` 位于 `[HitObjects]` 之前。

### 2. Malody（malody-timing.txt）
- 文件内容为完整 `.mc`（JSON）结构。用谱面编辑器（如 Malody 的 PC 编辑器）或文本工具操作：
  - **方式 A**：把 timing 文件里的 `time` 数组与 `effect` 数组复制进现有 `.mc` 文件的对应字段；
  - **方式 B**：把现有 `.mc` 的 `note` 数组复制进 timing 文件的 `note` 字段（保留末尾特殊音符），
    改好 `meta.song.file`（音频文件名）、`meta.title/artist` 后另存为 `.mc`。
- 音频文件需与 `.mc` 同目录，文件名对应 `meta.song.file`。
- 若想直接替换整张谱面：将 timing 文件改名为 `xxx.mc` 放入谱面文件夹，再在编辑器里补音符。

### 3. Arcaea（arcaea-timing.txt）
- 内容为 `AudioOffset` + `Timing:` 段。用文本编辑器打开你的 `.aff` 谱面，
  把 `Timing:` 段（timing(...) 行）替换为 timing 文件内容，`AudioOffset` 保持不变。
- 注意：Arcaea 要求 t=0 的 timing 必须存在（文件已包含）。

### 4. Phigros（phigros-timing.txt）
- 内容为 RPE JSON。用 **PhiEditor**（Re:PhiEdit）打开后：
  - 文件 → 打开 → 选择 timing 文件（或复制 BPMList 进现有谱面）；
  - 在编辑器中检查 BPM 曲线是否正确，然后添加音符。
- 也可用 Phira 等支持 RPE 的工具导入。

### 5. ADOFAI（adofai-timing.txt）
- 内容为 `.adofai` JSON。用文本编辑器把 `actions` 数组（SetSpeed 事件）复制进
  现有 `.adofai` 文件的 `actions` 字段；`settings.bpm`/`settings.offset` 也一并替换。
- `pathData` 需要替换为实际路径（默认是最小直路 "R"）。

### 6. vivid/stasis（vividstasis-timing.txt）
- 内容为 vschart.json（formatVersion=2）。将文件改名为 `finale.vschart.json`（或
  opening/middle/encore 等，文件名小写与 `metadata.difficultyName` 大写对应），
  放入歌曲目录（与 `meta.json`、音频文件同目录），然后：
  - `timingPoints` / `events` 已含全部变速信息（events.speed 保持原速）；
  - 在谱面编辑器中打开后补 `notes` 音符（当前为空数组）；
  - 编辑 `metadata`（难度/定数/谱师）与曲目根目录 `meta.json`（标题/音频文件名等）。

> 通用提示：所有格式替换前建议先备份原谱面文件；替换后在对应编辑器/游戏中
> 试玩一遍确认 BPM 与偏移正确，再开始补音符。

---

## 六、注意事项

1. **只含 BPM 时间轴**：各格式中的音符列表为空/占位，需要谱师在编辑器里补音符。
2. `beat` 三元组 `[a,b,c]` 的**值 = `a + b/c`，单位是「拍」、`a` 就是拍号**（Malody / Phigros 同一约定）；
   与拍号 3/4、6/8 无关，所以 `common.beat_to_bar` 的 `beats_per_bar` 形参已不参与换算。
3. 如果某音游要求「BPM 点必须从 0 开始」（如 Arcaea 的 t=0、vivid/stasis 第一个 timingPoint），脚本已自动处理。
4. 建议转换后先在对应编辑器里预览一遍节奏再补谱。
