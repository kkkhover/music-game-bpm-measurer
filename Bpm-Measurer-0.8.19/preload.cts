import { contextBridge, ipcRenderer } from 'electron';

// 统一暴露为 window.electronAPI（与 App.tsx 中的检查保持一致）
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
  // 导入：音频 / .osu / .osz 同一个对话框；另可单独选谱面文件夹
  openImportFile: () => ipcRenderer.invoke('open-import-file'),
  openMapFolder: () => ipcRenderer.invoke('open-map-folder'),
  // 读 .osu 文本 / 读 .osu + 同目录音频 / 解 .osz / 扫谱面文件夹
  readTextFile: (filePath: string) => ipcRenderer.invoke('read-text-file', filePath),
  readOsuFile: (filePath: string) => ipcRenderer.invoke('read-osu-file', filePath),
  readMapPackage: (filePath: string) => ipcRenderer.invoke('read-map-package', filePath),
  scanMapFolder: (dir: string) => ipcRenderer.invoke('scan-map-folder', dir),
  findMapAudio: (dir: string, preferred: string) => ipcRenderer.invoke('find-map-audio', dir, preferred),
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
