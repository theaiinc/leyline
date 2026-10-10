import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  root: 'dashboard',
  base: process.env.VITE_TAURI === 'true' ? '/' : '/dashboard/',
  publicDir: path.resolve(__dirname, 'dashboard/public'),
  plugins: [tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'dashboard/src') },
  },
  esbuild: {
    jsx: 'automatic',
  },
  build: {
    outDir: '../public',
    emptyOutDir: true,
  },
});
