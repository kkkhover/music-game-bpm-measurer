// ============================================================================
// 本地 HTTP 服务 —— 网页模式（浏览器直接打开）用
//
// 路由逻辑全在 src/router.mjs，这里只负责"把 HTTP 请求翻译成 router 调用"。
// 只监听 127.0.0.1，不对外暴露。
// ============================================================================
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCore } from './core.mjs';
import { createRouter } from './router.mjs';
import { loadConfig } from './config.mjs';

/** 读请求体并 JSON 解析（解析不了就当空对象） */
function readBody(req) {
    return new Promise((resolve) => {
        let raw = '';
        req.on('data', (c) => {
            raw += c;
            if (raw.length > 4 * 1024 * 1024) req.destroy();
        });
        req.on('end', () => {
            try {
                resolve(raw ? JSON.parse(raw) : {});
            } catch {
                resolve({});
            }
        });
    });
}

export async function startServer({ port } = {}) {
    const cfgPort = port || loadConfig().server.port || 24100;

    const core = await startCore();
    const handle = createRouter(core.app);

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        let body = null;
        if (req.method === 'POST' || req.method === 'PUT') body = await readBody(req);

        let out;
        try {
            out = await handle(req.method, url.pathname, body);
        } catch (e) {
            out = {
                status: 500,
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify({ ok: false, error: e.message })
            };
        }

        const payload = Buffer.isBuffer(out.body) ? out.body : Buffer.from(String(out.body));
        res.writeHead(out.status, { ...out.headers, 'Content-Length': payload.length });
        res.end(payload);
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(cfgPort, '127.0.0.1', resolve);
    });

    const actualPort = server.address().port;
    console.log(`[osu-maphelper] 侧栏服务已启动 → http://127.0.0.1:${actualPort}`);

    return {
        port: actualPort,
        app: core.app,
        close: () => {
            core.close();
            server.close();
        }
    };
}

// 直接运行时启动
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
    startServer().catch((e) => {
        console.error('启动失败：', e);
        process.exit(1);
    });
}
