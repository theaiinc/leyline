import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  root: 'dashboard',
  base: '/',
  publicDir: path.resolve(__dirname, 'dashboard/public'),
  plugins: [tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'dashboard/src') },
  },
  esbuild: {
    jsx: 'automatic',
  },
  server: {
    proxy: {
      '/v1': 'http://127.0.0.1:3000',
    },
  },
  build: {
    outDir: '../public',
    emptyOutDir: true,
  },
});
