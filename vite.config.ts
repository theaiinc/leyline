import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  root: 'dashboard',
  base: '/dashboard/',
  publicDir: path.resolve(__dirname, 'dashboard/public'),
  esbuild: {
    jsx: 'automatic',
  },
  build: {
    outDir: '../public',
    emptyOutDir: true,
  },
});
