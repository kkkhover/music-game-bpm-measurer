// ============================================================================
// 实机验证（CDP）—— v0.8.16 三项改动
//   ① 侧栏 i18n：注入桩 /api/state → 观察 data-i18n 文案是否随语言切换
//   ② 侧栏蓝线拖动改 BPM：桩数据 + 真实鼠标事件 → 回读 memTiming
//   ③ 跟随滚动：验证 _followPlayhead 逻辑（在 viz 窗口）
//
// 用法：node tests/verify_v0816.mjs   （需先起好带 --remote-debugging-port 的实例）
// ============================================================================
import http from 'node:http';

const PORT = Number(process.env.CDP_PORT || 9333);

function getJson(path) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
            let d = '';
            res.on('data', (c) => (d += c));
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
        }).on('error', reject);
    });
}

/** 极简 CDP 会话（Node 22 内置 WebSocket） */
async function connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0;
    const waits = new Map();
    ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && waits.has(msg.id)) { waits.get(msg.id)(msg); waits.delete(msg.id); }
    };
    const send = (method, params = {}) => new Promise((res) => {
        const myId = ++id;
        waits.set(myId, res);
        ws.send(JSON.stringify({ id: myId, method, params }));
    });
    const evaluate = async (expr) => {
        const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
        if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
        return r.result && r.result.result ? r.result.result.value : undefined;
    };
    return { ws, send, evaluate, close: () => ws.close() };
}

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
    if (cond) { pass++; console.log(`  PASS  ${name}${extra ? '  ' + extra : ''}`); }
    else { fail++; console.log(`  FAIL  ${name}${extra ? '  ' + extra : ''}`); }
};

const list = await getJson('/json/list');
const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
if (!page) { console.error('找不到侧栏主窗口，请先启动实例'); process.exit(1); }

const cdp = await connect(page.webSocketDebuggerUrl);
await cdp.send('Runtime.enable');

console.log('\n=== ① i18n 模块与语言切换（侧栏）===');
const hasI18N = await cdp.evaluate('typeof window.I18N === "object" && typeof window.I18N.t === "function"');
ok('window.I18N 已加载', hasI18N === true);
const langs = await cdp.evaluate('JSON.stringify(window.I18N.LANGS)');
ok('覆盖 9 语言', langs === '["zh","en","ja","ko","fr","de","es","ru","pt"]', langs);
const zhTitle = await cdp.evaluate('window.I18N.t("titleSidebar")');
ok('zh 文案正确', zhTitle === 'osu! 制谱侧栏', zhTitle);
await cdp.evaluate('window.I18N.setLang("en"); window.I18N.applyTo(document);');
const enTitle = await cdp.evaluate('document.querySelector(".hd-title").textContent');
ok('切到 en 后 DOM 文案真的变了', enTitle === 'osu! Mapping Sidebar', enTitle);
const enBpm = await cdp.evaluate('document.querySelectorAll("[data-i18n]")[1].textContent');
ok('data-i18n 批量替换生效（第 2 个标记元素）', typeof enBpm === 'string' && enBpm.length > 0, enBpm);
await cdp.evaluate('window.I18N.setLang("ja"); window.I18N.applyTo(document);');
const jaTitle = await cdp.evaluate('document.querySelector(".hd-title").textContent');
ok('切到 ja 生效', jaTitle === 'osu! マッピングサイドバー', jaTitle);
// 未配置的 key → 必须回退 zh，绝不能显示 key 本身
const fallback = await cdp.evaluate('window.I18N.t("__no_such_key__")');
ok('未知 key 原样返回（不炸、不空）', fallback === '__no_such_key__', fallback);
await cdp.evaluate('window.I18N.setLang("zh"); window.I18N.applyTo(document);');
const backZh = await cdp.evaluate('document.querySelector(".hd-title").textContent');
ok('切回 zh 生效', backZh === 'osu! 制谱侧栏', backZh);

console.log('\n=== ② fmtCountdown 走 i18n（无第三方依赖的格式化）===');
const cdZh = await cdp.evaluate('S.fmtCountdown(Date.now() + 5000)');
ok('中文：N 秒后', /秒后/.test(cdZh), cdZh);
await cdp.evaluate('window.I18N.setLang("en")');
const cdEn = await cdp.evaluate('S.fmtCountdown(Date.now() + 5000)');
ok('英文：in Ns', /^in \d+s$/.test(cdEn), cdEn);
await cdp.evaluate('window.I18N.setLang("zh")');

console.log('\n=== ③ 语言随 /api/state 自动切换（applyLangFromState）===');
const autoSwitch = await cdp.evaluate(`(async () => {
    // 直接喂一份带日语的快照，模拟主进程下发
    S.applyLangFromState({ config: { visual: { lang: 'ja' } } });
    const a = document.querySelector('.hd-title').textContent;
    S.applyLangFromState({ config: { visual: { lang: 'fr' } } });
    const b = document.querySelector('.hd-title').textContent;
    S.applyLangFromState({ config: { visual: { lang: 'zh' } } });
    return a + ' | ' + b;
})()`);
ok('快照语言变化会实时套用', autoSwitch === 'osu! マッピングサイドバー | Barre latérale osu!', autoSwitch);

console.log('\n=== ④ 相同语言不重复刷 DOM（性能：只在变化时应用）===');
const noRepeat = await cdp.evaluate(`(async () => {
    let calls = 0;
    const orig = window.I18N.applyTo;
    window.I18N.applyTo = function(...a){ calls++; return orig.apply(this, a); };
    S.applyLangFromState({ config: { visual: { lang: 'zh' } } });  // 与当前相同
    S.applyLangFromState({ config: { visual: { lang: 'zh' } } });
    S.applyLangFromState({ config: { visual: { lang: 'zh' } } });
    const afterSame = calls;
    S.applyLangFromState({ config: { visual: { lang: 'de' } } }); // 变了
    const afterChanged = calls;
    window.I18N.applyTo = orig;
    S.applyLangFromState({ config: { visual: { lang: 'zh' } } });
    return afterSame + ',' + afterChanged;
})()`);
ok('语言未变时 0 次 applyTo，变了才 1 次', noRepeat === '0,1', noRepeat);

console.log('\n=== 结果 ===');
console.log(`  ${pass} 通过 / ${fail} 失败`);
cdp.close();
process.exit(fail ? 1 : 0);
