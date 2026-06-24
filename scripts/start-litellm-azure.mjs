#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  apiKeyAccount,
  createDefaultSecretStore,
  parseRuntimeConfig,
  runtimeConfigAccount,
} from '../dist/core/secret-store.js';

function azureResourceBaseUrl(baseUrl) {
  return baseUrl
    .replace(/\/+$/, '')
    .replace(/\/openai\/v1$/i, '')
    .replace(/\/openai$/i, '');
}

async function main() {
  const store = createDefaultSecretStore();
  const key = process.env.AZURE_OPENAI_API_KEY || await store.get(apiKeyAccount('AzureOpenAI'));
  const runtime = process.env.AZURE_OPENAI_BASE_URL
    ? { baseUrl: process.env.AZURE_OPENAI_BASE_URL, model: process.env.AZURE_OPENAI_DEFAULT_MODEL }
    : parseRuntimeConfig(await store.get(runtimeConfigAccount('AzureOpenAI')) || '');

  const deployment = process.env.LITELLM_MODEL
    || process.env.AZURE_OPENAI_DEFAULT_MODEL
    || runtime?.model
    || process.env.AZURE_OPENAI_DEPLOYMENT
    || 'gpt-5.5';
  const apiBase = process.env.AZURE_API_BASE
    || process.env.AZURE_OPENAI_ENDPOINT
    || (runtime?.baseUrl ? azureResourceBaseUrl(runtime.baseUrl) : '');
  const apiVersion = process.env.AZURE_API_VERSION
    || process.env.AZURE_OPENAI_API_VERSION
    || 'preview';
  const port = process.env.LITELLM_PORT || '4000';

  if (!key) {
    throw new Error('Missing AzureOpenAI API key in env or Leyline Keychain.');
  }
  if (!apiBase) {
    throw new Error('Missing Azure base URL in env or Leyline Keychain runtime config.');
  }

  const configDir = join(tmpdir(), 'leyline-litellm');
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, 'config.yaml');
  writeFileSync(configPath, [
    'model_list:',
    '  - model_name: ' + deployment,
    '    litellm_params:',
    '      model: azure/responses/' + deployment,
    '      api_base: os.environ/AZURE_API_BASE',
    '      api_key: os.environ/AZURE_API_KEY',
    '      api_version: os.environ/AZURE_API_VERSION',
    '',
    'general_settings:',
    '  master_key: os.environ/LITELLM_MASTER_KEY',
    '',
  ].join('\n'));

  const env = {
    ...process.env,
    AZURE_API_BASE: apiBase,
    AZURE_API_KEY: key,
    AZURE_API_VERSION: apiVersion,
    LITELLM_MASTER_KEY: process.env.LITELLM_API_KEY || process.env.LITELLM_MASTER_KEY || 'not-needed',
  };

  console.log(`[Leyline] Starting LiteLLM on port ${port} for Azure deployment ${deployment}`);
  console.log(`[Leyline] LiteLLM Azure base: ${apiBase}`);
  console.log(`[Leyline] LiteLLM config: ${configPath}`);

  const command = existsSync('.venv-litellm/bin/litellm') ? '.venv-litellm/bin/litellm' : 'litellm';
  const child = spawn(command, ['--config', configPath, '--port', port], {
    env,
    stdio: 'inherit',
  });

  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  console.error(`[Leyline] Failed to start LiteLLM: ${error.message}`);
  process.exit(1);
});
