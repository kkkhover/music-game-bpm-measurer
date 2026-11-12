import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    return {
      base: './',
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [react()],
      define: {
        'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY)
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      },
      build: {
        outDir: 'dist',
        assetsDir: 'assets',
        emptyOutDir: true,
        sourcemap: false,
        // 两个页面入口：
        //   index.html   = 主界面
        //   preview.html = 谱面预览的「独立窗口」（main.ts 用 open-preview-window 加载它）
        rollupOptions: {
          input: {
            main: path.resolve(__dirname, 'index.html'),
            preview: path.resolve(__dirname, 'preview.html'),
          },
        },
      }
    };
});
