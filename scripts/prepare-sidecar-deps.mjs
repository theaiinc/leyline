#!/usr/bin/env node
// Builds a production-only node_modules for the Tauri-bundled sidecar.
// dist/index.js is plain tsc output (CJS requires, not bundled), so the
// packaged app needs a real node_modules next to it at runtime. We install
// a pruned copy here (deps only, no jest/tsc/vite/tauri-cli/...) instead of
// shipping the whole workspace node_modules.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const projectRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const outDir = path.join(projectRoot, 'src-tauri', 'sidecar-deps');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
copyFileSync(path.join(projectRoot, 'package.json'), path.join(outDir, 'package.json'));
copyFileSync(path.join(projectRoot, 'package-lock.json'), path.join(outDir, 'package-lock.json'));

// Packaged builds run with cwd pointed at the bundled resource dir (see
// sidecar.rs) so dotenv can find a .env the same way `npm start` does. The
// resource must exist at build time even when the developer has no local
// .env yet, so always produce one (falling back to a harmless empty file).
const localEnvPath = path.join(projectRoot, '.env');
const bundledEnvPath = path.join(outDir, '.env');
if (existsSync(localEnvPath)) {
  copyFileSync(localEnvPath, bundledEnvPath);
} else {
  writeFileSync(bundledEnvPath, '');
}

console.log('[Leyline] Installing production-only sidecar dependencies...');
execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
  cwd: outDir,
  stdio: 'inherit',
});

if (!existsSync(path.join(outDir, 'node_modules'))) {
  throw new Error('[Leyline] Expected src-tauri/sidecar-deps/node_modules after npm ci');
}
console.log('[Leyline] Sidecar dependencies ready at src-tauri/sidecar-deps/node_modules');
