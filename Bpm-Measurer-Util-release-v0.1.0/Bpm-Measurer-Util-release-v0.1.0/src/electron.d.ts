export interface AudioFileOptions {
  defaultPath?: string;
  filters: Array<{ name: string; extensions: string[] }>;
}

declare global {
  interface Window {
    electronAPI?: {
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
