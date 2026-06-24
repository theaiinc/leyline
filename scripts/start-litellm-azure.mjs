#!/usr/bin/env node
import dotenv from 'dotenv';
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

dotenv.config();

function azureResourceBaseUrl(baseUrl) {
  return baseUrl
    .replace(/\/+$/, '')
    .replace(/\/openai\/v1$/i, '')
    .replace(/\/openai$/i, '');
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

function optionalPositiveInteger(value, name) {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
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
  const baseModel = process.env.LITELLM_BASE_MODEL
    || process.env.AZURE_OPENAI_BASE_MODEL
    || `azure/${deployment}`;
  const maxInputTokens = optionalPositiveInteger(
    process.env.LITELLM_MAX_INPUT_TOKENS || process.env.AZURE_OPENAI_MAX_INPUT_TOKENS,
    'LITELLM_MAX_INPUT_TOKENS',
  );
  const maxOutputTokens = optionalPositiveInteger(
    process.env.LITELLM_MAX_OUTPUT_TOKENS || process.env.AZURE_OPENAI_MAX_OUTPUT_TOKENS,
    'LITELLM_MAX_OUTPUT_TOKENS',
  );

  if (!key) {
    throw new Error('Missing AzureOpenAI API key in env or Leyline Keychain.');
  }
  if (!apiBase) {
    throw new Error('Missing Azure base URL in env or Leyline Keychain runtime config.');
  }

  const configDir = join(tmpdir(), 'leyline-litellm');
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, 'config.yaml');
  const configLines = [
    'model_list:',
    '  - model_name: ' + yamlString(deployment),
    '    litellm_params:',
    '      model: ' + yamlString(`azure/responses/${deployment}`),
    '      api_base: os.environ/AZURE_API_BASE',
    '      api_key: os.environ/AZURE_API_KEY',
    '      api_version: os.environ/AZURE_API_VERSION',
    '    model_info:',
    '      base_model: ' + yamlString(baseModel),
  ];
  if (maxInputTokens) {
    configLines.push('      max_input_tokens: ' + maxInputTokens);
  }
  if (maxOutputTokens) {
    configLines.push('      max_tokens: ' + maxOutputTokens);
    configLines.push('      max_output_tokens: ' + maxOutputTokens);
  }
  configLines.push(
    '',
    'litellm_settings:',
    '  cache: false',
    '',
    'router_settings:',
    '  enable_pre_call_checks: true',
    '',
    'general_settings:',
    '  master_key: os.environ/LITELLM_MASTER_KEY',
    '',
  );
  writeFileSync(configPath, configLines.join('\n'));

  const env = {
    ...process.env,
    AZURE_API_BASE: apiBase,
    AZURE_API_KEY: key,
    AZURE_API_VERSION: apiVersion,
    LITELLM_MASTER_KEY: process.env.LITELLM_API_KEY || process.env.LITELLM_MASTER_KEY || 'not-needed',
  };

  console.log(`[Leyline] Starting LiteLLM on port ${port} for Azure deployment ${deployment}`);
  console.log(`[Leyline] LiteLLM Azure base: ${apiBase}`);
  console.log(`[Leyline] LiteLLM base model: ${baseModel}`);
  if (maxInputTokens) console.log(`[Leyline] LiteLLM max input tokens: ${maxInputTokens}`);
  if (maxOutputTokens) console.log(`[Leyline] LiteLLM max output tokens: ${maxOutputTokens}`);
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
