/**
 * Prices providers publish in their model lists. llmapi.ai and OpenRouter both give `pricing.prompt` and
 * `pricing.completion` as US dollars per token (strings); Leyline works in dollars per million tokens.
 */
export function parsePublishedPricing(pricing: unknown): { input: number; output: number } | undefined {
  if (!pricing || typeof pricing !== 'object') return undefined;
  const p = pricing as { prompt?: unknown; completion?: unknown };
  const input = Number(p.prompt);
  const output = Number(p.completion);
  if (p.prompt === undefined || p.completion === undefined || !Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) {
    return undefined;
  }
  // Rounded to a millionth of a dollar per million tokens: per-token strings carry float noise.
  const perMillion = (n: number) => Math.round(n * 1e12) / 1e6;
  return { input: perMillion(input), output: perMillion(output) };
}
