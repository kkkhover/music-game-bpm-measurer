// ============================================================================
// UI 契约检查（静态，不需要浏览器/Electron）—— 多窗口版
// 主窗口 index.html + 各 panel.html + 共享 state.js/viz.js + 各 panel-*.js
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const R = path.resolve(__dirname, '..', 'renderer');

const css = fs.readFileSync(path.join(R, 'style.css'), 'utf8');

// 各页面与其对应脚本
const PAGES = {
    'index.html': ['state.js', 'main.js'],
    'viz.html': ['state.js', 'viz.js', 'viz-panel.js'],
    'map.html': ['state.js', 'map-panel.js'],
    'backup.html': ['state.js', 'backup-panel.js'],
    'settings.html': ['state.js', 'settings-panel.js'],
    'log.html': ['state.js', 'log-panel.js']
};

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
    if (cond) { pass++; console.log(`  PASS  ${name}${extra ? '  ' + extra : ''}`); }
    else { fail++; console.log(`  FAIL  ${name}${extra ? '  ' + extra : ''}`); }
};

// ---------- ① 每个页面引用的脚本都存在 + id 都存在于自己的 HTML ----------
console.log('\n=== ① 页面引用脚本存在 + id 匹配 ===');
for (const [htmlName, scripts] of Object.entries(PAGES)) {
    const html = fs.readFileSync(path.join(R, htmlName), 'utf8');
    const htmlIds = new Set();
    for (const m of html.matchAll(/\bid="([^"]+)"/g)) htmlIds.add(m[1]);

    let allScriptsExist = true;
    let allIdsExist = true;
    const missingIds = [];

    for (const s of scripts) {
        const sp = path.join(R, s);
        if (!fs.existsSync(sp)) { allScriptsExist = false; continue; }
        const js = fs.readFileSync(sp, 'utf8');
        // 该脚本引用的 id
        const ids = new Set();
        for (const m of js.matchAll(/\$\('([^']+)'\)/g)) ids.add(m[1]);
        for (const m of js.matchAll(/getElementById\('([^']+)'\)/g)) ids.add(m[1]);
        for (const id of ids) {
            if (!htmlIds.has(id)) { allIdsExist = false; missingIds.push(id); }
        }
    }
    ok(`${htmlName} 脚本存在`, allScriptsExist);
    ok(`${htmlName} 引用的 id 都存在`, allIdsExist, missingIds.length ? `缺失: ${missingIds.join(', ')}` : '');
}

// ---------- ② 各 JS 文件语法 ----------
console.log('\n=== ② 文件语法 ===');
for (const [htmlName, scripts] of Object.entries(PAGES)) {
    for (const s of scripts) {
        const sp = path.join(R, s);
        const js = fs.readFileSync(sp, 'utf8');
        try {
            new Function(js);
            ok(`${s} 语法合法`, true);
        } catch (e) {
            ok(`${s} 语法合法`, false, e.message);
        }
    }
}

// ---------- ③ 关键结构（合并所有 JS） ----------
console.log('\n=== ③ 关键结构 ===');
const allJs = Object.values(PAGES).flat().map((s) => fs.readFileSync(path.join(R, s), 'utf8')).join('\n');
const vizJs = fs.readFileSync(path.join(R, 'viz.js'), 'utf8');
const vizPanelJs = fs.readFileSync(path.join(R, 'viz-panel.js'), 'utf8');
const appMjs = fs.readFileSync(path.join(R, '..', 'src', 'app.mjs'), 'utf8');
const html = fs.readFileSync(path.join(R, 'index.html'), 'utf8');
// ★ v0.8.4：原独立「红线 timing」窗口已合并进 viz 窗口，不再单独存在
const vizHtmlForMerge = fs.readFileSync(path.join(R, 'viz.html'), 'utf8');

ok('主窗口引用 main.js', /<script src="main\.js">/.test(html));
ok('主窗口引用 state.js', /<script src="state\.js">/.test(html));
ok('viz 窗口引用 viz.js', /<script src="viz\.js">/.test(fs.readFileSync(path.join(R, 'viz.html'), 'utf8')));
ok('有轮询 /api/state', /\/api\/state/.test(allJs));
ok('有写回 /api/timing', /\/api\/timing/.test(allJs));
ok('有内存编辑 /api/timing/edit', /\/api\/timing\/edit/.test(allJs));
ok('有音频 /api/audio', /\/api\/audio/.test(allJs));
ok('有手动备份 /api/backup', /\/api\/backup/.test(allJs));
ok('有重探 /api/rescan', /\/api\/rescan/.test(allJs));
ok('有配置保存 /api/config', /\/api\/config/.test(allJs));
ok('有窗口打开 /api/window/open', /\/api\/window\/open/.test(allJs));
ok('有窗口置顶 /api/window/pin', /\/api\/window\/pin/.test(allJs));
ok('有置顶状态回显 /api/window/pin-state', /\/api\/window\/pin-state/.test(allJs));
{
    const stateJs = fs.readFileSync(path.join(R, 'state.js'), 'utf8');
    const panelHtmls = Object.keys(PAGES).filter((f) => f !== 'index.html');
    const missingPin = panelHtmls.filter((f) => !/id="btn-pin"/.test(fs.readFileSync(path.join(R, f), 'utf8')));
    ok('每个面板页都有置顶按钮 #btn-pin', missingPin.length === 0, missingPin.length ? `缺失: ${missingPin.join(', ')}` : '');
    // 吸附功能已按需求删除：按钮 / API / 磁吸 全部不应再出现
    const stillHasDock = panelHtmls.filter((f) => /id="btn-dock"/.test(fs.readFileSync(path.join(R, f), 'utf8')));
    ok('吸附按钮 #btn-dock 已全部删除', stillHasDock.length === 0, stillHasDock.length ? `残留: ${stillHasDock.join(', ')}` : '');
    ok('state.js 不再有 dockPanel / 吸附绑定', !/dockPanel/.test(stateJs) && !/#btn-dock/.test(stateJs));
    ok('state.js 会回显置顶高亮（pinState + pinned 类）', /pinState/.test(stateJs) && /classList\.toggle\('pinned'/.test(stateJs));
    ok('主窗口没有置顶按钮（避免误点）', !/id="btn-pin"/.test(html));
}
ok('绑定了 Ctrl+S 写回', /ctrlKey/.test(allJs) && /key === 's'/.test(allJs));
// v0.8.8：用户要求取消"卡片随播放头自动切换" —— 现在只保留手动选中的高亮
ok('红线列表只有手动选中高亮（v0.8.8 起不再有"当前段"自动高亮）',
    /classList\.toggle\('sel'/.test(allJs) && !/classList\.toggle\('cur'/.test(allJs));
ok('有各窗口独立透明度滑条', /op-viz/.test(allJs) && /panels: \{ \[pid\]: \{ opacity/.test(allJs));
ok('有声谱配色选择', /cfg-palette/.test(allJs));
ok('有软件同款设置项（对数刻度/峰值/倒转/渲染倍率/节拍线延迟）',
    /cfg-logbase/.test(allJs) && /cfg-peak/.test(allJs) && /cfg-invert/.test(allJs)
    && /cfg-renderscale/.test(allJs) && /cfg-delay/.test(allJs));
ok('有备份目录输入', /cfg-bkdir/.test(allJs));
ok('有红线拖动逻辑', /type: 'redline'/.test(vizJs) && /type: 'bpm'/.test(vizJs) && /type: 'offset'/.test(vizJs));
ok('有声谱配色函数（对齐 BPM）', /spectrogramColor/.test(vizJs) && /SCALES/.test(vizJs) && /MULTI_COLORS/.test(vizJs));
ok('有原生 FFT 预计算', /OfflineAudioContext/.test(vizJs) && /createScriptProcessor/.test(vizJs));
ok('有 custom 自定义配色分支', /palette === 'custom'/.test(vizJs));

// ---------- ④ 画布分层（"声谱盖住波形、下半屏死黑"的根因回归） ----------
console.log('\n=== ④ 画布分层与布局 ===');
ok('按层设置画布尺寸/位置（_sizeLayer + _applySizes）', /_sizeLayer/.test(vizJs) && /_applySizes/.test(vizJs));
ok('时间轴高度 40px（与软件一致）', /TIMELINE_HEIGHT = 40/.test(vizJs));
ok('波形/声谱各占内容区一半', /waveHeight = Math\.floor\(av \* 0\.5\)/.test(vizJs) && /specHeight = av - this\.waveHeight/.test(vizJs));
ok('声谱层从 waveHeight 起、只占 specHeight 高', /this\.specCanvas, this\.width, this\.specHeight, this\.specTop/.test(vizJs));
ok('overlay / playhead 覆盖整高', /this\.overlayCanvas, this\.width, this\.height, 0/.test(vizJs) && /this\.playheadCanvas, this\.width, this\.height, 0/.test(vizJs));
ok('CSS 未写死 top:0（否则四层会叠在顶部）', !/\.viz-container canvas \{[^}]*top: 0/.test(css));
ok('渲染倍率参与 dpr（devicePixelRatio × renderScale）', /devicePixelRatio/.test(vizJs) && /_renderScale/.test(vizJs));
ok('派生整数拍号（红线/蓝线编号）', /_deriveBeatIndex/.test(vizJs) && /beatIndex/.test(vizJs));
ok('红线/蓝线配色与软件一致（蓝线分强/弱拍两档）', /#ef4444/.test(vizJs) && /rgba\(0, 242, 255, 0\.95\)/.test(vizJs) && /rgba\(0, 242, 255, 0\.35\)/.test(vizJs));
ok('红线节拍线延迟只偏移拍线', /_beatLineDelaySec/.test(vizJs) && /beatLineDelayMs/.test(vizJs));

// ---------- ⑤ 主进程窗口行为 ----------
console.log('\n=== ⑤ 主进程窗口行为 ===');
const mainCjs = fs.readFileSync(path.join(R, '..', 'electron', 'main.cjs'), 'utf8');
ok('新窗口默认置顶（DEFAULT_PINNED）', /DEFAULT_PINNED = true/.test(mainCjs));
ok('viz 面板默认横屏大窗（合并后要放得下频谱 + 变速段落卡片区）',
    /viz: \{ html: 'viz\.html'[^}]*width: 980[^}]*height: 560/.test(mainCjs));
ok('各 panel 独立透明度同步', /cfg\.panels\[panelId\]/.test(mainCjs) && /setOpacity\(clampOpacity/.test(mainCjs));
ok('吸附 API 已删除（/api/window/dock）', !/\/api\/window\/dock/.test(mainCjs));
ok('磁吸对齐已删除（snapToWindows）', !/snapToWindows/.test(mainCjs));

// ---------- ⑥ 需求 1：帧率优化（对齐 BPM 测速助手的性能方案） ----------
console.log('\n=== ⑥ 帧率优化（对齐原软件方案） ===');
ok('颜色 LUT 预计算（256×256 调色映射）', /_ensureColorLUT/.test(vizJs) && /Uint32Array\(256 \* 256\)/.test(vizJs));
ok('频率行 LUT 预计算（免每像素 Math.pow）', /_ensureBinLUT/.test(vizJs) && /b0|bf/.test(vizJs));
ok('绘制循环里走 LUT 查表（不再逐像素算颜色）', /colorLUT\[/.test(vizJs) && /binLUT\./.test(vizJs));
ok('主进程禁用 2D 画布硬件加速（putImageData 更快）', /disable-accelerated-2d-canvas/.test(mainCjs));
ok('列缓存有效性与视图缩放解耦（缩放不销毁 FFT 列缓存）',
    /const colSame = /.test(vizJs) && /const same = colSame && last\.zoom/.test(vizJs));
ok('滚轮缩放按 rAF 节流（避免 >60Hz 重绘）', /_wheelRaf/.test(vizJs) && /requestAnimationFrame/.test(vizJs));
ok('拖动平移按 rAF 节流', /_panRaf/.test(vizJs));
ok('overlay 重绘签名相同则跳过', /_overlaySig/.test(vizJs) && /sig === this\._overlaySig/.test(vizJs));

// ---------- ⑦ 频谱声谱 与 红线 timing 合并成同一个窗口 ----------
console.log('\n=== ⑦ 合并窗口：频谱声谱 + 变速段落 ===');
const vizHtml = fs.readFileSync(path.join(R, 'viz.html'), 'utf8');

// —— 合并本身：独立的 timing 窗口应当彻底消失 ——
ok('原独立 timing 窗口文件已删除', !fs.existsSync(path.join(R, 'timing.html')) && !fs.existsSync(path.join(R, 'timing-panel.js')));
ok('主进程 PANELS 里已无 timing 面板', /const PANELS = \{/.test(mainCjs) && !/^\s*timing:\s*\{/m.test(mainCjs));
ok('启动区已无 timing 入口按钮', !/data-panel-id="timing"/.test(html));
ok('设置面板已无 timing 透明度行', !/op-timing/.test(fs.readFileSync(path.join(R, 'settings.html'), 'utf8')));
ok('viz 窗口同时挂 viz.js（渲染）+ viz-panel.js（编辑）',
    /<script src="viz\.js">/.test(vizHtml) && /<script src="viz-panel\.js">/.test(vizHtml));
ok('上=频谱声谱、下=①② 的合并布局（.mg-bottom）', /class="mg-bottom"/.test(vizHtml) && /\.mg-bottom\b/.test(css));

// —— ① 变速段落选项卡 ——
ok('① 区有变速段落卡片容器 #sec-strip', /id="sec-strip"/.test(vizHtml) && /id="sec-zone"|class="sec-zone"/.test(vizHtml));
ok('① 区卡片横向铺开 + 最底部左右滑条（overflow-x:auto + 横向滚动条）',
    /\.sec-strip\s*\{[\s\S]{0,500}overflow-x:\s*auto/.test(css) &&
    /\.sec-strip::-webkit-scrollbar\b/.test(css) && /\.sec-strip::-webkit-scrollbar-thumb\b/.test(css));
ok('① 向右无限收纳（卡片定宽不收缩、横排不换行）',
    /\.sec-card\s*\{[\s\S]{0,260}flex:\s*0 0 auto/.test(css) && /\.sec-strip\s*\{[\s\S]{0,500}display:\s*flex/.test(css));
ok('卡片含 拍索引 / BPM / 起始时间 三个输入', /f-beat/.test(vizPanelJs) && /f-bpm/.test(vizPanelJs) && /f-time/.test(vizPanelJs));
ok('卡片标注段落编号 + 拍索引（起点锚点单独标注）',
    /起点锚点/.test(vizPanelJs) && /拍 \$\{sec\.beatIndex\}/.test(vizPanelJs));
ok('改拍索引 → 按上一段 BPM 推算新时间（对齐软件算法）',
    /function editBeatIndex/.test(vizPanelJs) && /const beatLen = 60 \/ \(prev\.bpm/.test(vizPanelJs));
ok('起点锚点的拍索引固定为 0（输入框 disabled）', /sec\.anchor\s*\n?\s*\?\s*'disabled/.test(vizPanelJs) || /anchor[\s\S]{0,120}disabled/.test(vizPanelJs));
ok('起点锚点不允许删除', /起点锚点不能删除/.test(vizPanelJs));

// —— ② 全局 offset / 编号 / 添加 ——
ok('② 区有全局起始偏移输入 #sz-offset', /id="sz-offset"/.test(vizHtml));
ok('offset 走主进程 type:offset（整体平移所有段落）',
    /type: 'offset'/.test(vizPanelJs) && /edit\.type === 'offset'/.test(appMjs));
ok('② 区有变速段落编号 #sz-idx + 上/下一段按钮', /id="sz-idx"/.test(vizHtml) && /id="sz-prev"/.test(vizHtml) && /id="sz-next"/.test(vizHtml));
ok('② 区有「添加变速段落」按钮 #sz-add', /id="sz-add"/.test(vizHtml) && /添加变速段落/.test(vizHtml));
ok('添加变速段落走主进程 type:add（继承所在段 BPM）', /type: 'add'/.test(vizPanelJs) && /sectionIndexAt/.test(appMjs));
ok('② 区还有 删除 / 导入谱面', /id="sz-del"/.test(vizHtml) && /id="sz-import"/.test(vizHtml));

// —— 联动 & 后端 ——
ok('点频谱红线 → ① 卡片滚动到位（onSelect → scrollCardIntoView）',
    /onSelect: onVizSelect/.test(vizPanelJs) && /function scrollCardIntoView/.test(vizPanelJs) && /onVizSelect/.test(vizPanelJs));
ok('双击卡片 → 频谱滚到该红线居中（不改播放位置）',
    /jumpToRed/.test(vizPanelJs) && /addEventListener\('dblclick'/.test(vizPanelJs));
// v0.8.8：用户要求取消"卡片随播放头自动切换 / 滚动" —— 断言反过来：不该再有 scrollCardIntoView(cur
ok('取消播放头所在段自动跟随滚动（卡片只响应手动操作）',
    /function curSectionIndex/.test(vizPanelJs) && !/scrollCardIntoView\(cur/.test(vizPanelJs));
ok('卡片滚轮 → 横向浏览（滑条之外的第二种滑动方式）', /sec-strip'\)\.addEventListener\('wheel'/.test(vizPanelJs));
ok('viz 暴露 getSections()（卡片数据源，index 与 memTiming 对齐）',
    /getSections\(\)/.test(vizJs) && /anchor: i === 0/.test(vizJs));
ok('viz 红线透传 meter（卡片显示拍号）', /meter: Number\(p\.meter\)/.test(vizJs));
ok('暴露 window.__vizDebug 把手（实机/CDP 测试用）', /window\.__vizDebug = viz/.test(vizPanelJs));
ok('双击时间轴可跳转 / 添加红线', /dblclick/.test(vizJs) && /_onDblClick/.test(vizJs) && /selectRed\(bestIdx, \{ jump: true \}\)/.test(vizJs));
ok('双击空白处添加红线（type: add）', /type: 'add'/.test(vizJs));
ok('后端支持 add / delete / replace 编辑', /'add'/.test(appMjs) && /'delete'/.test(appMjs) && /'replace'/.test(appMjs));
ok('编辑后返回最新 redLines 快照', /function redLinesSnapshot/.test(appMjs) && /redLines: redLinesSnapshot\(\)/.test(appMjs));

// ---------- ⑧ 需求 3：侧栏快捷键与原软件对齐 ----------
console.log('\n=== ⑧ 侧栏快捷键 ===');
ok('Ctrl+Z 撤销 / Ctrl+Shift+Z·Ctrl+Y 重做', /undoStack/.test(vizPanelJs) && /redoStack/.test(vizPanelJs) && /ctrlKey/.test(vizPanelJs) && /shiftKey/.test(vizPanelJs));
ok('空格 播放 / 暂停', /e\.code === 'Space'/.test(vizPanelJs) && /togglePreview/.test(vizPanelJs));
ok('← → 平移 ±1s，Shift ±5s', /ArrowLeft/.test(vizPanelJs) && /ArrowRight/.test(vizPanelJs) && /e\.shiftKey \? 5 : 1/.test(vizPanelJs));
ok('+ / - 缩放时间轴', /key === '\+'/.test(vizPanelJs) && /zoomBy/.test(vizPanelJs));
ok('Ctrl+O 打开音频 / Ctrl+S 导入谱面', /key === 'o'/.test(vizPanelJs) && /key === 's'/.test(vizPanelJs));
ok('Delete / Backspace 删除选中红线', /Delete/.test(vizPanelJs) && /Backspace/.test(vizPanelJs));
ok('输入框内不触发快捷键（stopPropagation + blur）', /stopPropagation/.test(vizPanelJs) && /blur\(\)/.test(vizPanelJs));
ok('连续编辑 400ms 合并为一步撤销', /400/.test(vizPanelJs));
ok('撤销栈上限 200', /200/.test(vizPanelJs));

// ---------- ⑨ 需求 4：自动翻页（播放头将出界时提前渲染下一段） ----------
console.log('\n=== ⑨ 自动翻页 ===');
ok('标题栏有自动翻页开关 #btn-autofollow', /id="btn-autofollow"/.test(vizHtml));
ok('viz.js 实现 setAutoFollow（含开关）', /setAutoFollow\(/.test(vizJs) && /this\.autoFollow = !!on/.test(vizJs));
ok('播放头到视区 85% 即提前翻页', /this\.width \* 0\.85/.test(vizJs));
ok('翻页后播放头回到视区 15% 位置', /this\.width \* 0\.15/.test(vizJs));
ok('开关状态持久化到 config.visual.autoFollow', /visual/.test(vizPanelJs) && /autoFollow/.test(vizPanelJs));
ok('config.mjs 默认 autoFollow = true', /autoFollow: true/.test(fs.readFileSync(path.join(R, '..', 'src', 'config.mjs'), 'utf8')));
ok('viz 读取配置时应用 autoFollow', /cfg\.autoFollow !== undefined/.test(vizJs));

// ---------- ⑩ 需求 6：返回软件（隐藏后仍能被找到并唤醒） ----------
console.log('\n=== ⑩ 与 BPM 测速助手联动 ===');
ok('有 /api/window/focus-bpm（返回软件）', /\/api\/window\/focus-bpm/.test(mainCjs));
ok('用 EnumWindows 枚举隐藏/最小化窗口（MainWindowHandle 为 0 时也能找到）',
    /EnumWindows/.test(mainCjs) && /ShowWindow/.test(mainCjs) && /SetForegroundWindow/.test(mainCjs));
ok('返回软件后自动关闭侧栏', /closeSidebar\(\)/.test(mainCjs) && /closing: true/.test(mainCjs));
ok('唤醒时优先挑「可见」的同名窗口（Electron 会另建一个同名隐藏辅助窗口，挑错就白唤醒）',
    /FoundVisible/.test(mainCjs) && /FoundAny/.test(mainCjs) && /IsWindowVisible/.test(mainCjs));
ok('先 SW_RESTORE 再 SW_SHOW（最小化窗口只做 SHOW 还原不了）', /ShowWindow\(\$t, 9\)/.test(mainCjs) && /ShowWindow\(\$t, 5\)/.test(mainCjs));
ok('返回里带可观测的还原结果（iconicBefore/iconicAfter/restored）',
    /iconicBefore/.test(mainCjs) && /iconicAfter/.test(mainCjs) && /restored:/.test(mainCjs));

// ---------- ⑪ 五项修复（锁帧 / ② 区裁切 / 标题栏音频 / 双击红线 / 播放跟随） ----------
console.log('\n=== ⑪ 五项修复 ===');
const cfgMjs = fs.readFileSync(path.join(R, '..', 'src', 'config.mjs'), 'utf8');

// ① 窗口不在前台时被锁帧
ok('每个 BrowserWindow 都关了 backgroundThrottling',
    (mainCjs.match(/backgroundThrottling: false/g) || []).length >= 3);
ok('主进程加了三个反节流命令行开关',
    /disable-background-timer-throttling/.test(mainCjs) &&
    /disable-renderer-backgrounding/.test(mainCjs) &&
    /disable-backgrounding-occluded-windows/.test(mainCjs));

// ② 右下角卡片压紧，功能完整显示
ok('② 区整体压紧（gap/padding/内边距缩小）',
    /\.side-zone\s*\{[\s\S]{0,300}?gap:\s*2px/.test(css) &&
    /\.side-zone\s*\{[\s\S]{0,300}?padding:\s*4px 7px/.test(css) &&
    /\.side-zone \.mini\s*\{/.test(css));

// ③ 标题栏音频控件（黄圈位置）
ok('标题栏有音频控制条 .au-bar（黄圈位置）', /class="au-bar"/.test(vizHtml) && /\.au-bar\s*\{/.test(css));
ok('含 时间 / 音乐音量 / 节拍器音量 / 节拍器开关 / 音乐变速 五个控件',
    /id="au-time"/.test(vizHtml) && /id="au-vol"/.test(vizHtml) && /id="au-mvol"/.test(vizHtml) &&
    /id="au-metro"/.test(vizHtml) && /id="au-rate"/.test(vizHtml));
ok('音乐/节拍器各自独立音量节点', /musicGain = audioCtx\.createGain\(\)/.test(vizPanelJs) &&
    /metroGain = audioCtx\.createGain\(\)/.test(vizPanelJs));
ok('变速保持音调不变（playbackRate + preservesPitch）',
    /playbackRate\.value = au\.rate/.test(vizPanelJs) && /preservesPitch = true/.test(vizPanelJs));
ok('音频参数持久化到 config.audio（含默认值）',
    /audio:\s*\{[\s\S]{0,200}?musicVolume/.test(cfgMjs) &&
    /saveCfg\(\{[\s\S]{0,120}?audio:\s*\{/.test(vizPanelJs));
ok('节拍器按红线/BPM 排拍（跨段切到下一段第 0 拍）',
    /function metroSeek/.test(vizPanelJs) && /function metroAdvance/.test(vizPanelJs) &&
    /function metroClick/.test(vizPanelJs) && /function metroTick/.test(vizPanelJs));
ok('节拍器重拍落在每小节第一拍（beat % meter === 0）', /metro\.beat % meter === 0/.test(vizPanelJs));
ok('标题栏控件不拖动窗口（app-region:no-drag）',
    /\.panel-titlebar \.au-bar \*/.test(css) && /-webkit-app-region:\s*no-drag/.test(css));

// ④ 双击频谱红线没有跳转
//    注意：不能直接 indexOf —— 新加的注释里为了说明历史，**引用了旧代码那行原文**，
//    会被 indexOf 先命中。先把整行注释剥掉，再比 *_onDblClick 内部* 的真实代码顺序：
//    "命中红线并 selectRed" 必须在 "if (my <= contentBottom) return;" 之前。
{
    const code = vizJs.replace(/^\s*\/\/.*$/gm, '');
    const iFn = code.indexOf('_onDblClick(e) {');
    const iSel = code.indexOf('this.selectRed(bestIdx, { jump: true });', iFn);
    const iGate = code.indexOf('if (my <= this.contentBottom) return;', iFn);
    ok('双击红线不再被"仅底部时间轴区"限制（命中红线在高度判断之前）',
        iFn > 0 && iSel > 0 && iGate > 0 && iSel < iGate);
}
ok('单击频谱里的红线也会选中（联动 ① 卡片）',
    /hitRed/.test(vizJs) && /this\.selectRed\(hit\)/.test(vizJs));
ok('未命中红线时仍只在底部时间轴区才新增红线',
    /if \(my <= this\.contentBottom\) return;/.test(vizJs) && /type: 'add'/.test(vizJs));

// ⑤ 制谱器播放时频谱没跟随
ok('osu! 在走时时间基准交给 osu!（本地定位点不再钉死播放头）',
    /function osuAdvancing/.test(vizPanelJs) && /!osuAdvancing\(\) && preview\.offset > 0/.test(vizPanelJs));
ok('轮询里检测 osu! 播放位置推进并清掉本地定位点',
    /osuAdvancingUntil = Date\.now\(\) \+ 600/.test(vizPanelJs));
ok('变速后内容时间按 rate 折算（播放头/时间显示不跑偏）',
    /\(audioCtx\.currentTime - preview\.startedAt\) \* au\.rate/.test(vizPanelJs));

// ---------- ⑫ 节拍线延迟同步 BPM 测速助手（v0.8.5） ----------
console.log('\n=== ⑫ 节拍线延迟跟随软件 ===');
{
    const srcDir = path.join(R, '..', 'src');
    const bpmMjs = fs.readFileSync(path.join(srcDir, 'bpmSettings.mjs'), 'utf8');
    const appMjs = fs.readFileSync(path.join(srcDir, 'app.mjs'), 'utf8');
    const routerMjs = fs.readFileSync(path.join(srcDir, 'router.mjs'), 'utf8');
    const settingsHtml = fs.readFileSync(path.join(R, 'settings.html'), 'utf8');
    const settingsPnl = fs.readFileSync(path.join(R, 'settings-panel.js'), 'utf8');

    // —— 读取器：能定位软件 userData / 兼容两种编码 / 取「最后一次」写入 / 纯只读 ——
    ok('有 BPM 设置读取器（定位软件 userData 下的 Local Storage/leveldb）',
        /Local Storage/.test(bpmMjs) && /leveldb/.test(bpmMjs) && /bpm-measurer-util/.test(bpmMjs));
    ok('解析设置 JSON 用的是括号配平（正则搞不定嵌套/字符串里的花括号）',
        /function braceObjectAt/.test(bpmMjs) && /function extractSettingsObject/.test(bpmMjs));
    ok('取同一键的**最后一次**写入（LevelDB 追加写，历史值会残留）',
        /let best = null/.test(bpmMjs) && /best = parsed/.test(bpmMjs) && /from = hit \+ 1/.test(bpmMjs));
    ok('兼容 Latin-1 与 UTF-16LE 两种落盘编码',
        /toString\('latin1'\)/.test(bpmMjs) && /toString\('utf16le'\)/.test(bpmMjs));
    ok('带文件指纹缓存（避免每 100ms 轮询都读盘）', /CACHE_TTL_MS/.test(bpmMjs) && /dirSignature/.test(bpmMjs));
    ok('对软件设置**纯只读**（绝不写对方的文件）',
        !/fs\.(writeFileSync|appendFileSync|mkdirSync|unlinkSync|rmSync|rmdirSync)/.test(bpmMjs));
    ok('导出 readBpmSettings / readBpmBeatLineDelayMs',
        /export function readBpmSettings/.test(bpmMjs) && /export function readBpmBeatLineDelayMs/.test(bpmMjs));

    // —— 配置：多一个「跟随软件」开关，默认开 ——
    ok('config.visual 有 beatLineDelayFollowSoftware 且默认 true',
        /beatLineDelayFollowSoftware:\s*true/.test(cfgMjs));

    // —— 快照：下发「生效值」，且必须克隆配置（不能污染 loadConfig 缓存） ——
    // ★ v0.8.16：cfgOut 改成多行（同时覆盖延迟与语言两项），断言随之改为
    //   「展开 cfgNow + 展开 cfgNow.visual + 覆盖 beatLineDelayMs」三个语义片段，
    //   仍然保证没有直接改 cfgNow（改了就污染缓存、把软件值写进 config.json）。
    ok('app.mjs 引入 bpmSettings', /from '\.\/bpmSettings\.mjs'/.test(appMjs));
    ok('有 bpmDelayState()（跟随时取软件值，读不到才退回手动值）',
        /function bpmDelayState/.test(appMjs) && /effectiveMs/.test(appMjs));
    ok('快照里**克隆** config 再覆盖延迟（直接改会污染缓存并写错 config.json）',
        /const cfgOut = \{[\s\S]{0,200}?\.\.\.cfgNow,[\s\S]{0,200}?visual: \{ \.\.\.cfgNow\.visual,[\s\S]{0,200}?beatLineDelayMs: bpmDelay\.effectiveMs/.test(appMjs));
    ok('快照下发 cfgOut 且附带 bpmDelay 来源信息',
        /config: cfgOut/.test(appMjs) && /bpmDelay,/.test(appMjs));

    // ★ v0.8.16 新增：语言同步（修 Bug 1 的侧栏半边）
    ok('config.visual 有 langFollow 且默认 true',
        /langFollow:\s*true/.test(cfgMjs));
    ok('config.visual 有 lang 字段',
        /lang:\s*'zh'/.test(cfgMjs));
    ok('有 langState()（跟随时取软件语言，读不到才退回侧栏值）',
        /function langState/.test(appMjs) && /softwareLang/.test(appMjs));
    ok('bpmSettings 提供 readBpmLang（读软件 localStorage 的 lang）',
        /export function readBpmLang/.test(bpmMjs));
    ok('快照 config 注入生效语言（前端据此渲染）',
        /lang: lang\.effective/.test(appMjs));
    ok('快照附带 lang 来源信息',
        /\n\s*lang,\n/.test(appMjs));
    ok('路由 /api/bpm-settings 回传 lang',
        /lang: typeof s\.lang === 'string'/.test(routerMjs));
    ok('设置页有语言区块（跟随开关 / 下拉 / 重新读取 / 来源提示）',
        /id="cfg-lang-follow"/.test(settingsHtml) && /id="cfg-lang"/.test(settingsHtml) &&
        /id="btn-lang-reload"/.test(settingsHtml) && /id="lang-src"/.test(settingsHtml));
    ok('语言开关写回 config.visual.langFollow', /langFollow:\s*on/.test(settingsPnl));
    ok('语言下拉写回 config.visual.lang', /visual: \{ lang: e\.target\.value \}/.test(settingsPnl));
    ok('跟随时语言下拉禁用（避免"选了没反应"的困惑）', /langSel\.disabled = langFollow/.test(settingsPnl));
    ok('侧栏 i18n 模块存在', fs.existsSync(path.join(R, 'i18n.js')));
    ok('所有面板页都引入了 i18n.js', ['index', 'settings', 'viz', 'map', 'backup', 'log']
        .every((n) => /i18n\.js/.test(fs.readFileSync(path.join(R, n + '.html'), 'utf8'))));
    {
        const stJs = fs.readFileSync(path.join(R, 'state.js'), 'utf8');
        const i18Js = fs.readFileSync(path.join(R, 'i18n.js'), 'utf8');
        ok('state.js 轮询时自动套用语言（语言变化才重刷 DOM）',
            /applyLangFromState/.test(stJs) && /_appliedLang/.test(stJs));
        ok('i18n 字典含 9 语言且 zh 为兜底',
            /var LANGS = \['zh', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'ru', 'pt'\]/.test(i18Js) &&
            /entry\[current\] \|\| entry\.zh/.test(i18Js));
    }
    ok('提供强制重读入口 syncBpmSettings()', /syncBpmSettings\(\)/.test(appMjs));
    ok('路由有 POST /api/bpm-settings（忽略缓存重读）',
        /'\/api\/bpm-settings'/.test(routerMjs) && /app\.syncBpmSettings\(\)/.test(routerMjs));

    // —— 设置面板：开关 + 只读滑条 + 来源提示 + 重新读取按钮 ——
    ok('设置页有「跟随软件」开关 / 重新读取按钮 / 来源提示',
        /id="cfg-delay-follow"/.test(settingsHtml) && /id="btn-bpm-reload"/.test(settingsHtml) &&
        /id="delay-src"/.test(settingsHtml));
    ok('开关写回 config.visual.beatLineDelayFollowSoftware',
        /beatLineDelayFollowSoftware: on/.test(settingsPnl));
    ok('跟随时延迟滑条只读（避免"拖了没反应"的困惑）',
        /\$\('cfg-delay'\)\.disabled = follow/.test(settingsPnl));
    ok('滑条改动前判断是否跟随（跟随时不写手动值）',
        /if \(!\$\('cfg-delay-follow'\)\.checked\)/.test(settingsPnl));
    ok('来源提示区分「软件 / 侧栏手动 / 读不到」三种状态',
        /节拍线延迟来源：BPM 测速助手/.test(settingsPnl) && /侧栏手动设置/.test(settingsPnl) &&
        /读不到软件设置/.test(settingsPnl));
}

// ---------- ⑬ 反降频：挂载小窗切进游戏全屏时不掉帧 ----------
// 症状：挂着侧栏 → 切进 osu! 全屏编辑谱面 → 频谱预览卡顿 / 低帧率。
// 根因：窗口被游戏完全盖住时，Windows 原生遮挡检测 + Chromium 隐藏页强化节流
//       会把 rAF 停摆、把 setInterval 压到 1 分钟一次；同时侧栏只有 Normal
//       优先级，抢不到被前台游戏倾斜的 CPU 时间片。
console.log('\n=== ⑬ 反降频（挂载窗口切进游戏不卡） ===');
ok('关闭 Windows 原生遮挡检测（被全屏盖住也不变 hidden）',
    /disable-features/.test(mainCjs) && /CalculateNativeWinOcclusion/.test(mainCjs));
ok('关闭隐藏页定时器强化节流（否则 100ms 轮询被压到 1 分钟）',
    /IntensiveWakeUpThrottling/.test(mainCjs));
ok('阻止系统把侧栏当空闲应用挂起',
    /powerSaveBlocker/.test(mainCjs) && /prevent-app-suspension/.test(mainCjs));
ok('进程优先级提到 AboveNormal（不用 HIGH / Realtime，避免反过来饿死游戏）',
    /boostProcessPriority/.test(mainCjs) && /'AboveNormal'/.test(mainCjs) &&
    !/'Realtime'/.test(mainCjs) && !/'High'/.test(mainCjs));
ok('优先级只作用于侧栏自己的进程树（以本进程 PID 为根做 BFS）',
    /MH_ROOT_PID/.test(mainCjs) && /ParentProcessId/.test(mainCjs));
ok('反降频两项都有环境变量开关可关',
    /OSU_MAPHELPER_NO_PRIORITY_BOOST/.test(mainCjs) && /keepAlive\(\)/.test(mainCjs));
ok('viz 有 rAF 失联兜底心跳（定时器接管绘制）',
    /_fallbackTimer/.test(vizJs) && /RAF_STALL_MS/.test(vizJs) && /FALLBACK_INTERVAL_DEFAULT_MS/.test(vizJs));
ok('仅在 rAF 真失联时才接管（同时活着不重复绘制）',
    /performance\.now\(\) - this\._lastRafAt <= RAF_STALL_MS/.test(vizJs));
ok('stop() 会清理兜底定时器', /clearInterval\(this\._fallbackTimer\)/.test(vizJs));
// v0.8.7：兜底帧率可调 —— 它是 rAF 停摆时用户**实际看到的帧率**（"锁 30"就来自这里）
ok('兜底帧率可配置（setFallbackFps + fallbackFps 入口）',
    /setFallbackFps\(fps\)/.test(vizJs) && /setFallbackFps\(cfg\.fallbackFps\)/.test(vizJs)
    && /fallbackFps/.test(cfgMjs));
ok('面板有帧率诊断可读（frameStat + rAF/画/兜底 三路计数）',
    /this\.frameStat\s*=/.test(vizJs) && /_statDrawFallback/.test(vizJs) && /renderFrameStat/.test(vizPanelJs));
// v0.8.7：跟随 osu! 的播放头平滑 —— 数据 100~150ms 一跳，不平滑必然"卡"
ok('跟随 osu! 时按本地时钟外推（平滑播放头）',
    /smoothOsuTime/.test(vizPanelJs) && /osuFollowSmooth/.test(vizPanelJs));
// v0.8.8：平滑器重写为「最小二乘回归估速 + PLL 位置输出」——
//   起因：v0.8.7 用单点 dv/dtWall 估速，被"主进程 100ms 轮询 × tosu 150ms 更新"的
//   样本到达抖动带偏，实测 20.2 次/秒位置回退（肉眼"一抽一抽"）。
ok('平滑器用回归估速（8 样本窗口，抗到达抖动）',
    /osuSmooth\.samples/.test(vizPanelJs) && /S\.length > 8/.test(vizPanelJs)
    && /n \* stv - st \* sv/.test(vizPanelJs));
ok('位置自己积分推进、不被样本重设（消除"外推被拽回"式回退）',
    /osuSmooth\.disp \+= a \* dt/.test(vizPanelJs) && /err \* Math\.min\(1, dt \/ 0\.12\)/.test(vizPanelJs));
ok('平滑器保留 seek 防护（倒放/跳段清空窗口 + 大误差直接吸附）',
    /S\.length = 0/.test(vizPanelJs) && /Math\.abs\(err\) > 0\.25/.test(vizPanelJs));
// v0.8.8：暂停改为"样本断了→目标冻结、disp 平滑收敛"，不再在 currentTime 里硬切回 raw
ok('暂停时目标冻结、位置平滑停住（不再硬切回 raw 造成回退）',
    /const capS = Math\.max/.test(vizPanelJs) && /const tEff = Math\.min/.test(vizPanelJs)
    && !/resetOsuSmooth\(\); return raw/.test(vizPanelJs));
ok('标题栏显示当前 BPM（v0.8.8 取代原窗口名文字）',
    /id="pt-bpm"/.test(fs.readFileSync(path.join(R, 'viz.html'), 'utf8'))
    && /function updateTitleBpm/.test(vizPanelJs));
ok('设置面板有「跟随 osu! 与帧率」四项控件', (() => {
    const sh = fs.readFileSync(path.join(R, 'settings.html'), 'utf8');
    const sp = fs.readFileSync(path.join(R, 'settings-panel.js'), 'utf8');
    return /cfg-ossmooth/.test(sh) && /cfg-osmax/.test(sh)
        && /cfg-fallbackfps/.test(sh) && /cfg-framestat/.test(sh)
        && /cfg-ossmooth/.test(sp) && /cfg-fallbackfps/.test(sp);
})());
ok('渲染循环加了"已取消不续期"守卫（否则 stop 后会被复活）',
    /if \(!this\._raf\) return;/.test(vizJs));

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
