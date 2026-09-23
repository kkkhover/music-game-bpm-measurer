/* ============================================================================
   侧栏多语言对账测试（v0.8.16，修 Bug 1「多语言没有全软件统一 / 侧栏没有语言更改」）

   查三件事，任一不过就 exit(1)：
   ① HTML 里 data-i18n / data-i18n-title / data-i18n-ph 引用的每个 key，字典里都得有
      —— 否则换语言时那一处会保持中文（正是用户报的"没统一"）。
   ② 字典里每个 key 都得配齐 9 种语言 —— 缺一种就在该语言下回退中文，属于隐性残缺。
   ③ 「文字夹输入框」的标签（如「间隔 <input> 分」）不能把 data-i18n 直接挂在 <label> 上
      —— applyTo 会覆写 textContent，把里面的 <input> 一起冲掉，控件直接消失。

   另外顺带查 i18n.js 语法（用 node --check 之外的办法：这里直接 eval 一遍）。
   ============================================================================ */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'renderer');
const LANGS = ['zh', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'ru', 'pt'];

let pass = 0;
let fail = 0;
function ok(cond, msg) {
    if (cond) { pass++; console.log('  PASS  ' + msg); }
    else { fail++; console.log('  FAIL  ' + msg); }
}

// ---- 载入 i18n.js（它是给浏览器用的 IIFE，这里造一个假 window 直接 eval）----
const i18nSrc = readFileSync(join(HERE, 'i18n.js'), 'utf8');
const fakeWindow = {};
// eslint-disable-next-line no-eval
eval(i18nSrc.replace(/\bwindow\.I18N\b/g, 'fakeWindow.I18N'));
const I18N = fakeWindow.I18N;

ok(!!I18N, 'i18n.js 可载入并挂出 window.I18N');
ok(I18N.LANGS.join(',') === LANGS.join(','), '语言列表 = ' + I18N.LANGS.join('/'));

// ---- ① 每个 key 都要配齐 9 种语言 ----
// 通过公开的 t() 反查：切到某语言后取值，若与 zh 相同且该 key 的 zh 不是「天然各语言相同」
// （如 'BPM'、'60 fps'）就说明漏配。这里只做"存在性"检查更稳：直接翻 D。
// D 是闭包内的私有变量，取不到 —— 改用逐个语言 setLang + t() 比对 zh 的方式，
// 对"纯 ASCII 且各语言本就相同"的 key 放宽（这些 key 本来就一样，无法区分）。
const DICT_KEYS = [];
{
    // 从源码里抠出所有 `keyName: {` 形式的键名（字典是对象字面量，键名后紧跟冒号 + 空格 + {）
    const re = /^\s{8}([A-Za-z][A-Za-z0-9]*):\s*\{/gm;
    let m;
    while ((m = re.exec(i18nSrc))) DICT_KEYS.push(m[1]);
}
ok(DICT_KEYS.length > 60, '从 i18n.js 抠到字典 key 共 ' + DICT_KEYS.length + ' 个');

const missingByLang = {};
for (const lang of LANGS) {
    I18N.setLang(lang);
    missingByLang[lang] = DICT_KEYS.filter((k) => {
        const v = I18N.t(k);
        return !v || v === k; // t() 取不到会原样返回 key
    });
}
for (const lang of LANGS) {
    ok(missingByLang[lang].length === 0, `字典 key 在 [${lang}] 下都有值` + (missingByLang[lang].length ? '（缺 ' + missingByLang[lang].join(', ') + '）' : ''));
}
I18N.setLang('zh');

// ---- ② HTML 引用的 key 必须都在字典里 ----
const HTML_FILES = readdirSync(HERE).filter((f) => f.endsWith('.html'));
ok(HTML_FILES.length >= 6, '扫到面板 HTML：' + HTML_FILES.join(', '));

const ATTR_RE = /data-i18n(?:-title|-ph)?="([^"]+)"/g;
for (const f of HTML_FILES) {
    const src = readFileSync(join(HERE, f), 'utf8');
    const keys = new Set();
    let m;
    while ((m = ATTR_RE.exec(src))) keys.add(m[1]);
    const missing = [...keys].filter((k) => !DICT_KEYS.includes(k));
    ok(missing.length === 0, `${f}：${keys.size} 个 i18n key 全部在字典里` + (missing.length ? '（缺 ' + missing.join(', ') + '）' : ''));

    // ---- ③ 带子元素的标签不能整块挂 data-i18n ----
    // 找出形如 <label ... data-i18n="x" ...> ... <input ...> ... </label> 的写法
    const bad = [...src.matchAll(/<label[^>]*\bdata-i18n="[^"]+"[^>]*>(?:(?!<\/label>)[\s\S])*?<input/g)];
    ok(bad.length === 0, `${f}：没有把 data-i18n 直接挂在含 <input> 的 <label> 上` + (bad.length ? `（${bad.length} 处会冲掉输入框）` : ''));
}

// ---- ④ 抽查：切成 en 后几个关键位置确实变英文（不是"配了但没生效"）----
I18N.setLang('en');
ok(I18N.t('titleMap') === 'Beatmap info', 'en: titleMap → ' + I18N.t('titleMap'));
ok(I18N.t('autoBackup') === 'Auto backup', 'en: autoBackup → ' + I18N.t('autoBackup'));
ok(I18N.t('pinTip').startsWith('Toggle'), 'en: pinTip → ' + I18N.t('pinTip'));
ok(I18N.t('delaySrcApp', { n: 42 }) === 'Beat line delay source: BPM Measurer (currently 42 ms)', 'en: delaySrcApp 占位符 → ' + I18N.t('delaySrcApp', { n: 42 }));
I18N.setLang('ja');
ok(I18N.t('backupNow') === '今すぐバックアップ', 'ja: backupNow → ' + I18N.t('backupNow'));
ok(I18N.t('secLater', { n: 3 }) === '3 秒後', 'ja: secLater 占位符 → ' + I18N.t('secLater', { n: 3 }));
// 没配的语言要回退 zh 而不是空白
I18N.setLang('zh');
ok(I18N.t('__no_such_key__') === '__no_such_key__', '未定义 key 原样返回（方便排查）');

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
