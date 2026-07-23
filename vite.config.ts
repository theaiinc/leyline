import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  root: 'dashboard',
  base: process.env.VITE_TAURI === 'true' ? '/' : '/dashboard/',
  publicDir: path.resolve(__dirname, 'dashboard/public'),
  esbuild: {
    jsx: 'automatic',
  },
  build: {
    outDir: '../public',
    emptyOutDir: true,
  },
});
