export interface AudioFileOptions {
  defaultPath?: string;
  filters: Array<{ name: string; extensions: string[] }>;
}

declare global {
  interface Window {
    electronAPI?: {
      // 本机性能档案（低配自适应）：主进程按内存判定，渲染进程据此限制渲染倍率
      getPerfProfile: () => { totalGB: number; freeGB: number; lowEnd: boolean };
      onAutoOpenAudio: (cb: (filePath: string) => void) => () => void;
      openAudioFile: () => Promise<string | null>;
      readAudioFile: (filePath: string) => Promise<Uint8Array | null>;
      saveFile: (options?: {
        defaultPath?: string;
        filters?: Array<{ name: string; extensions: string[] }>;
        content?: string;
      }) => Promise<string | null>;
      onAudioFileProcessed: (callback: (data: any) => void) => () => void;
      // 启动制谱侧栏（osu-maphelper）
      launchMapHelper: () => Promise<{ ok: boolean; alreadyRunning?: boolean; pid?: number; dir?: string; error?: string }>;
    };
  }
}

export {};
