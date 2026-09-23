// 最小探针：定位 Electron 侧栏 ERR_FAILED 的真正原因。
// 用法：electron tests/proto_probe.cjs <preset>
//   preset: plain | nosandbox | swiftshader | gpuoff | combo
const { app, BrowserWindow, protocol } = require('electron');

const PRESET = process.argv[2] || 'plain';
console.log('=== preset =', PRESET, '===');

const presets = {
    plain: { ha: true, flags: ['disable-gpu'] },
    nosandbox: { ha: true, flags: ['disable-gpu', 'no-sandbox'] },
    swiftshader: { ha: false, flags: ['use-angle=swiftshader', 'use-gl=angle', 'disable-gpu-sandbox'] },
    gpuoff: { ha: true, flags: ['disable-gpu', 'disable-gpu-compositing', 'in-process-gpu', 'disable-software-rasterizer'] },
    combo: { ha: true, flags: ['no-sandbox', 'disable-gpu', 'disable-gpu-compositing', 'in-process-gpu'] },
    // 关掉沙箱但保留硬件加速 —— 决定正式运行时要不要关 GPU
    ns_gpu: { ha: false, flags: ['no-sandbox'] },
    // 关沙箱 + 只关合成器（保留 GPU 光栅化）
    ns_gpucomp: { ha: false, flags: ['no-sandbox', 'disable-gpu-compositing'] }
};

const P = presets[PRESET] || presets.plain;
if (P.ha) app.disableHardwareAcceleration();
for (const f of P.flags) {
    const i = f.indexOf('=');
    if (i > 0) app.commandLine.appendSwitch(f.slice(0, i), f.slice(i + 1));
    else app.commandLine.appendSwitch(f);
}

protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }
]);

app.whenReady().then(async () => {
    protocol.handle('app', () => {
        return new Response('<html><body><h1>HELLO-OK</h1></body></html>', {
            headers: { 'content-type': 'text/html; charset=utf-8' }
        });
    });

    const w = new BrowserWindow({ show: false, width: 500, height: 300 });
    let gone = null;
    w.webContents.on('did-fail-load', (_e, c, d, u) => console.log('  [did-fail-load]', c, d, u));
    w.webContents.on('did-finish-load', () => console.log('  [did-finish-load]'));
    w.webContents.on('render-process-gone', (_e, d) => {
        gone = d;
        console.log('  [render-gone]', JSON.stringify(d));
    });

    let loaded = false;
    try {
        await w.loadURL('app://renderer/index.html');
        loaded = true;
    } catch (e) {
        console.log('  [loadURL] threw:', e.message);
    }

    await new Promise((r) => setTimeout(r, 1500));
    let text = '';
    try {
        text = await w.webContents.executeJavaScript('document.body ? document.body.innerText : "(no body)"');
    } catch (e) {
        text = '(eval error: ' + e.message + ')';
    }
    console.log('  RESULT loaded=' + loaded + ' renderGone=' + (gone ? gone.reason : 'no') + ' text=' + JSON.stringify(text));
    app.quit();
});
