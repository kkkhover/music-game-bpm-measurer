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
  launchMapHelper: () => ipcRenderer.invoke('launch-maphelper')
});
