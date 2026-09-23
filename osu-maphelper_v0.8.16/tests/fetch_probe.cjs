// 探针：Electron 主进程里能不能用全局 fetch 访问 tosu？
// 背景：侧栏显示"未连接 tosu"，但同一时刻 PowerShell / 纯 node 都能拿到 /json/sc。
const { app, net } = require('electron');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');

app.whenReady().then(async () => {
    console.log('typeof global fetch =', typeof fetch);
    console.log('typeof AbortController =', typeof AbortController);

    // 1) 原生 fetch
    try {
        const r = await fetch('http://127.0.0.1:24050/json/sc');
        const t = await r.text();
        console.log('[native fetch] status=' + r.status + ' len=' + t.length + ' head=' + t.slice(0, 80));
    } catch (e) {
        console.log('[native fetch] FAILED:', e.name, e.message);
    }

    // 2) Electron 的 net.fetch
    try {
        const r = await net.fetch('http://127.0.0.1:24050/json/sc');
        const t = await r.text();
        console.log('[net.fetch] status=' + r.status + ' len=' + t.length + ' head=' + t.slice(0, 80));
    } catch (e) {
        console.log('[net.fetch] FAILED:', e.name, e.message);
    }

    // 3) 原生 http 模块
    try {
        const http = require('node:http');
        await new Promise((resolve) => {
            http.get('http://127.0.0.1:24050/json/sc', (res) => {
                let n = 0;
                res.on('data', (c) => (n += c.length));
                res.on('end', () => {
                    console.log('[node http] status=' + res.statusCode + ' len=' + n);
                    resolve();
                });
            }).on('error', (e) => {
                console.log('[node http] FAILED:', e.message);
                resolve();
            });
        });
    } catch (e) {
        console.log('[node http] threw:', e.message);
    }

    app.quit();
});
