/** A benchmark score for people: accuracies (0–1) as a percentage, other scores (Elo, indexes) to one decimal. */
export function formatScore(score: number): string {
  if (!Number.isFinite(score)) return '—';
  if (score > 0 && score <= 1 && !Number.isInteger(score)) return `${(score * 100).toFixed(1)}%`;
  return Number.isInteger(score) ? score.toLocaleString('en-US') : score.toLocaleString('en-US', { maximumFractionDigits: 1 });
}
