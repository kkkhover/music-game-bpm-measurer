export interface AudioFileOptions {
  defaultPath?: string;
  filters: Array<{ name: string; extensions: string[] }>;
}

/** 谱面导入结果（.osz / .osu / 谱面文件夹 统一结构） */
export interface MapImportPayload {
  ok: boolean;
  error?: string;
  dir?: string;
  sourceName?: string;
  audioPath?: string;
  audioName?: string;
  osuFiles?: { name: string; path: string; text: string }[];
}

declare global {
  interface Window {
    electronAPI?: {
      // 本机性能档案（低配自适应）：主进程按内存判定，渲染进程据此限制渲染倍率
      getPerfProfile: () => { totalGB: number; freeGB: number; lowEnd: boolean };
      onAutoOpenAudio: (cb: (filePath: string) => void) => () => void;
      openAudioFile: () => Promise<string | null>;
      // 导入通道（v0.8.19）：音频 / .osu / .osz / 谱面文件夹
      openImportFile: () => Promise<string | null>;
      openMapFolder: () => Promise<string | null>;
      readTextFile: (filePath: string) => Promise<string | null>;
      readOsuFile: (filePath: string) => Promise<MapImportPayload & { text?: string }>;
      readMapPackage: (filePath: string) => Promise<MapImportPayload>;
      scanMapFolder: (dir: string) => Promise<MapImportPayload>;
      findMapAudio: (dir: string, preferred: string) => Promise<{ path: string; name: string } | null>;
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
