import { contextBridge, ipcRenderer } from 'electron';

// 统一暴露为 window.electronAPI（与 App.tsx 中的检查保持一致）
//
// 【关键】本文件必须以 CommonJS 形式加载。
//   Electron 的 preload 脚本（默认沙箱模式）不支持 ESM：若产物里含 `import` 语法，
//   会直接报 “Cannot use import statement outside a module”，preload 加载失败、
//   window.electronAPI 整个未定义（实测踩过这个坑）。
//   因此源码用 `.cts` 扩展名 —— TypeScript 会强制把它编译成 CommonJS 的 preload.cjs。
//   对应的构建配置见 tsconfig.preload.json，主进程引用路径见 main.ts。
contextBridge.exposeInMainWorld('electronAPI', {
  // 本机性能档案（低配自适应用）：{ totalGB, freeGB, lowEnd }
  // 用 sendSync 是因为渲染进程首帧就要按它决定渲染倍率，异步拿会让画面先按高分辨率建一次画布。
  getPerfProfile: () => ipcRenderer.sendSync('get-perf-profile'),
  // 主进程在启动参数里发现音频文件时会推一条路径过来（--open-audio / 拖文件到 exe 上）
  onAutoOpenAudio: (cb: (filePath: string) => void) => {
    const listener = (_e: unknown, filePath: string) => cb(filePath);
    ipcRenderer.on('auto-open-audio', listener);
    return () => { ipcRenderer.removeListener('auto-open-audio', listener); };
  },
  openAudioFile: () => ipcRenderer.invoke('open-audio-file'),
  // 读取音频文件内容（返回 Uint8Array，供渲染进程解码）
  readAudioFile: (filePath: string) => ipcRenderer.invoke('read-audio-file', filePath),
  saveFile: (options?: {
    defaultPath?: string;
    filters?: { name: string; extensions: string[] }[];
    content?: string; // 若提供 content，主进程会直接写入文件
  }) => ipcRenderer.invoke('save-file', options),
  // ★ v0.8.15：原「只导出 Malody 谱面文件（.mc，不含音频）」的桥接 API 已随该选项一起删除。
  // 导出 Malody 完整谱面包(.mcz)：把 .mc 与音频一起打包，避免 Malody 找不到音乐
  saveMalodyPackage: (options: {
    packName: string;
    mcContent: string;
    audioPath: string;
    audioName: string;
  }) => ipcRenderer.invoke('save-malody-package', options),
  // 启动制谱侧栏（osu-maphelper 独立窗口程序）
  launchMapHelper: () => ipcRenderer.invoke('launch-maphelper'),

  // ===== v0.9.0 外部谱面通道（只读写磁盘上的 .osu / .osz 工作副本）=====
  openBeatmap: () => ipcRenderer.invoke('open-beatmap'),
  // osu! 皮肤（文件夹 / .osk）→ skin.ini + mania 素材的 dataURL，仅供预览渲染，不写回皮肤
  openSkin: () => ipcRenderer.invoke('open-skin'),
  // 按记住的皮肤路径重新读取（不弹对话框）：预览重开 / 独立预览窗口都用它
  loadSkinPath: (src: string) => ipcRenderer.invoke('load-skin-path', src),

  // ===== 谱面预览「独立窗口」（可以把预览拖出软件窗口）=====
  openPreviewWindow: (bounds?: { x?: number; y?: number; w?: number; h?: number }) =>
    ipcRenderer.invoke('open-preview-window', bounds),
  closePreviewWindow: () => ipcRenderer.invoke('close-preview-window'),
  /** 独立窗口打开时套用上次记住的位置尺寸（位置由独立窗口自己存 localStorage，两窗口同源共享） */
  setPreviewWindowBounds: (b: { x: number; y: number; w: number; h: number }) =>
    ipcRenderer.invoke('set-preview-window-bounds', b),
  onPreviewWindowClosed: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on('preview-window-closed', listener);
    return () => { ipcRenderer.removeListener('preview-window-closed', listener); };
  },

  readTextFile: (filePath: string) => ipcRenderer.invoke('read-text-file', filePath),
  statFile: (filePath: string) => ipcRenderer.invoke('stat-file', filePath),
  writeOsuAtomic: (options: { path: string; content: string; backup?: boolean }) =>
    ipcRenderer.invoke('write-osu-atomic', options),
  listOsuBackups: () => ipcRenderer.invoke('list-osu-backups'),
  restoreOsuBackup: (options: { backup: string; target: string }) =>
    ipcRenderer.invoke('restore-osu-backup', options),
  saveBinaryFile: (options: {
    defaultPath?: string;
    filters?: { name: string; extensions: string[] }[];
    bytes: Uint8Array;
  }) => ipcRenderer.invoke('save-binary-file', options)
});
