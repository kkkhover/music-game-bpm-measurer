// ============================================================================
// 核心运行时 —— 与"怎么把界面送到屏幕"无关的那部分
//
// 只做两件事：
//   1. 建 app（tosu 客户端 / 谱面读写 / 备份调度器）
//   2. 起一个不间断的轮询循环，把实时状态刷进 app 内部
//
// 谁用：
//   · src/server.mjs      → 核心 + HTTP 服务（网页模式 / 浏览器打开）
//   · electron/main.cjs   → 核心 + app:// 自定义协议（侧栏模式）
//
// 为什么拆出来：两种模式的差别只在"传输层"，核心完全一样，拆开后不会各写一份。
// ============================================================================
import { createApp } from './app.mjs';

/**
 * 启动核心运行时。
 * @returns {Promise<{app: object, close: () => void}>}
 */
export async function startCore() {
    const app = createApp();

    await app.init();

    let stopped = false;

    // 主轮询循环。注意：refresh() 内部已经包了 try/catch，
    // 这里再兜一层，防止将来有人改动 refresh 后把循环打断。
    const loop = async () => {
        while (!stopped) {
            try {
                await app.refresh();
            } catch (e) {
                app.pushLog('刷新异常: ' + e.message);
            }
            await new Promise((r) => setTimeout(r, app.pollMs));
        }
    };
    loop();

    return {
        app,
        close: () => {
            stopped = true;
            try {
                app.backupManager.stop();
            } catch {
                /* 忽略 */
            }
        }
    };
}
