// ============================================================================
// 请求路由（与传输方式解耦）
//
// 同一套逻辑被两种传输方式复用：
//   · 网页模式  → src/server.mjs 用 http.createServer 跑在 127.0.0.1:24100
//   · 侧栏模式  → electron/main.cjs 用 app:// 自定义协议在进程内直接响应
//
// 为什么侧栏模式不走 HTTP：
//   部分环境（企业代理 / 沙箱 / 防火墙）下 Chromium 连 127.0.0.1 会直接 ERR_FAILED，
//   界面一片空白。用 app:// 就没有端口、没有 socket、没有代理，稳得多。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig } from './config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RENDERER_DIR = path.resolve(__dirname, '..', 'renderer');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml'
};

/**
 * 创建一个请求处理器。
 * @param {object} app createApp() 的返回值
 * @returns {(method:string, pathname:string, body:any) => Promise<{status:number, headers:object, body:string|Buffer}>}
 */
export function createRouter(app) {
    const json = (obj, status = 200) => ({
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        body: JSON.stringify(obj)
    });

    return async function handle(method, pathname, body) {
        // ---------------- API ----------------
        if (pathname === '/api/state') return json(app.snapshot());

        if (pathname === '/api/backup' && method === 'POST') return json(app.backupNow());

        if (pathname === '/api/rescan' && method === 'POST') return json({ ok: true, ...app.rescan() });

        // 强制重读 BPM 测速助手的设置（忽略内部缓存）—— 设置面板「重新读取」按钮用
        if (pathname === '/api/bpm-settings' && method === 'POST') {
            const r = app.syncBpmSettings();
            const s = r.settings || {};
            const num = (v) => (Number.isFinite(v) ? v : null);
            return json({
                ok: r.ok,
                dir: r.dir,
                error: r.error || null,
                beatLineDelayMs: num(s.beatLineDelayMs),
                specSensitivity: num(s.specSensitivity),
                fftSize: num(s.specFFTSize),
                musicVolume: num(s.musicVolume)
            });
        }

        // 导出 timing 到时间戳命名的独立文件（v0.8.10 起这是 timing 的唯一出口；
        // 原「直接写回谱面 .osu」的 /api/timing 已按需求整个移除）
        if (pathname === '/api/timing/export' && method === 'POST') return json(app.exportTiming(body || {}));

        // 内存编辑（红线拖动 / 列表输入，不写盘）；多窗口通过这里实时同步编辑状态
        if (pathname === '/api/timing/edit' && method === 'POST') return json(app.editTiming(body || {}));

        // 放弃未导入修改，恢复磁盘状态
        if (pathname === '/api/timing/reset' && method === 'POST') return json({ ok: true, ...(() => { app.resetMemTiming(); return {}; })() });

        // 音频文件（二进制）：渲染进程拿去 decodeAudioData 做频谱/声谱
        if (pathname === '/api/audio') {
            const a = app.readAudio();
            if (!a) return { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'no audio' };
            if (!a.ok) return json({ ok: false, error: a.error }, 500);
            return {
                status: 200,
                headers: {
                    'Content-Type': 'audio/mpeg',
                    'Content-Length': String(a.data.length),
                    'X-Audio-Name': encodeURIComponent(a.name)
                },
                body: a.data
            };
        }

        if (pathname === '/api/config') {
            if (method === 'GET') return json(loadConfig());
            try {
                const next = saveConfig(body || {});
                app.pushLog('配置已更新');
                return json({ ok: true, config: next });
            } catch (e) {
                return json({ ok: false, error: e.message }, 500);
            }
        }

        // ---------------- 静态页面 ----------------
        let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
        const filePath = path.join(RENDERER_DIR, rel);

        // 防目录穿越
        if (!filePath.startsWith(RENDERER_DIR)) {
            return { status: 403, headers: { 'Content-Type': 'text/plain' }, body: 'forbidden' };
        }

        try {
            if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
                const ext = path.extname(filePath).toLowerCase();
                return {
                    status: 200,
                    headers: {
                        'Content-Type': MIME[ext] || 'application/octet-stream',
                        'Cache-Control': 'no-store'
                    },
                    body: fs.readFileSync(filePath)
                };
            }
        } catch {
            /* 落到 404 */
        }

        return { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: '404' };
    };
}
