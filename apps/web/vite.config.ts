import { defineConfig, type UserConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const config: UserConfig & { test?: unknown } = {
  plugins: [react(), tailwindcss()],
  base: './',
  build: {
    // React, Markdown, zod and the avatar art change rarely: separate chunks cache across app updates.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          // The avatar portraits are ~200 KB of inline images that only change with the art.
          if (/[\\/]avatar[\\/]portraits\.data\.[jt]s$/.test(id)) return 'avatar-art';
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/](react|react-dom|scheduler|zustand)[\\/]/.test(id)) return 'react';
          if (/[\\/]zod[\\/]/.test(id)) return 'zod';
          if (/[\\/](react-markdown|remark-[\w-]+|micromark[\w-]*|mdast-[\w-]+|hast-[\w-]+|unist-[\w-]+|unified|vfile[\w-]*)[\\/]/.test(id)) return 'markdown';
          return undefined;
        },
      },
    },
  },
  resolve: {
    conditions: ['neo-source', 'module', 'browser', 'development|production'],
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:7777',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: [],
    globals: false,
  },
};

export default defineConfig(config as UserConfig);
