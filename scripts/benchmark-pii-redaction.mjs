import { performance } from 'node:perf_hooks';
import { RequestPiiRedactor } from '../dist/core/pii-redaction.js';

const seed = 'Simasis user ada@example.com called +1 212-555-0199 about the workspace document. ';
const prompt = Array.from({ length: Math.ceil(20_000 / seed.length) }, (_, index) => `${seed}${index} `).join('').slice(0, 20_000);
const samples = [];

for (let i = 0; i < 200; i += 1) {
  const redactor = new RequestPiiRedactor({ mode: 'regex' });
  const start = performance.now();
  await redactor.redact(prompt);
  samples.push(performance.now() - start);
}

samples.sort((a, b) => a - b);
const percentile = (p) => samples[Math.min(samples.length - 1, Math.ceil(samples.length * p) - 1)];
console.log(JSON.stringify({ bytes: prompt.length, iterations: samples.length, p50Ms: Number(percentile(0.5).toFixed(3)), p95Ms: Number(percentile(0.95).toFixed(3)) }));