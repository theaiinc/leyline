import type { SpendLine } from './spending-types';

export type DailyPoint = { day: string; [key: string]: string | number };

export type DailySpend = {
  byDay?: Record<string, Record<string, SpendLine>>;
};

export function shapeDailySpend(
  spend: DailySpend,
  mode: 'usd' | 'tokens',
): { points: DailyPoint[]; series: string[]; other: boolean } | null {
  if (!spend.byDay) return null;
  const totals = new Map<string, number>();
  for (const lines of Object.values(spend.byDay)) {
    for (const [id, line] of Object.entries(lines)) {
      totals.set(id, (totals.get(id) ?? 0) + (line[mode] ?? 0));
    }
  }
  const series = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
  const top = series.slice(0, 6);
  const other = series.length > top.length;
  const points = Object.entries(spend.byDay)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, lines]) => {
      const point: DailyPoint = { day };
      let rest = 0;
      for (const [id, line] of Object.entries(lines)) {
        if (top.includes(id)) point[id] = line[mode] ?? 0;
        else rest += line[mode] ?? 0;
      }
      if (other) point.Other = rest;
      return point;
    });
  return { points, series: [...top, ...(other ? ['Other'] : [])], other };
}