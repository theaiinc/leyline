#!/usr/bin/env node
// Builds a production-only node_modules for the Tauri-bundled sidecar.
// dist/index.js is plain tsc output (CJS requires, not bundled), so the
// packaged app needs a real node_modules next to it at runtime. We install
// a pruned copy here (deps only, no jest/tsc/vite/tauri-cli/...) instead of
// shipping the whole workspace node_modules.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const projectRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const outDir = path.join(projectRoot, 'src-tauri', 'sidecar-deps');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
copyFileSync(path.join(projectRoot, 'package.json'), path.join(outDir, 'package.json'));
copyFileSync(path.join(projectRoot, 'package-lock.json'), path.join(outDir, 'package-lock.json'));

// Never copy the developer's .env into the bundle: it holds real API keys and
// would ship inside every build. Packaged apps read config from a per-user
// file instead (see src-tauri/src/sidecar.rs).

console.log('[Leyline] Installing production-only sidecar dependencies...');
execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
  cwd: outDir,
  stdio: 'inherit',
});

if (!existsSync(path.join(outDir, 'node_modules'))) {
  throw new Error('[Leyline] Expected src-tauri/sidecar-deps/node_modules after npm ci');
}
console.log('[Leyline] Sidecar dependencies ready at src-tauri/sidecar-deps/node_modules');
