import { useEffect, useMemo, useState } from 'react';
import { ArrowUpDown, ExternalLink } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { EmptyState, PageHeader } from '@/components/common';

type Score = {
  model: string;
  leylineModel?: string | null;
  aliases?: string[];
  score: number;
  source: string;
  asOf: string;
};

type Benchmark = {
  id: string;
  name: string;
  source?: string;
  asOf?: string;
  scores: Score[];
};

type Response = { fetchedAt: number | null; benchmarks: Benchmark[] };

const DETAILS: Record<string, { description: string; unit: string; group: string; source?: string }> = {
  hle: { description: 'Very hard expert questions across academic subjects.', unit: 'accuracy; higher is better', group: 'Reasoning, maths and science' },
  'gpqa-diamond': { description: 'Graduate-level science questions.', unit: 'accuracy; higher is better', group: 'Reasoning, maths and science' },
  'swe-bench-verified': { description: 'Fixing real GitHub issues.', unit: 'percentage resolved; higher is better', group: 'Coding' },
  aime: { description: 'Competition mathematics problems.', unit: 'accuracy; higher is better', group: 'Reasoning, maths and science' },
  livebench: { description: 'Mixed, contamination-resistant tasks.', unit: 'score; higher is better', group: 'General chat quality' },
  'terminal-bench': { description: 'Agentic command-line work.', unit: 'accuracy; higher is better', group: 'Agents and tools' },
  livecodebench: { description: 'Fresh coding problems.', unit: 'pass@1; higher is better', group: 'Coding' },
  'lmarena-text-elo': { description: 'Human preference in blind chats.', unit: 'Elo; higher is better (confidence intervals apply)', group: 'General chat quality' },
  'intelligence-index': { description: 'Artificial Analysis composite intelligence score.', unit: 'index; higher is better', group: 'General chat quality' },
};

const GROUPS = ['Coding', 'Agents and tools', 'Reasoning, maths and science', 'General chat quality'];

export function BenchmarksPage({ base }: { base: string }) {
  const [data, setData] = useState<Response | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [onlyServed, setOnlyServed] = useState(false);
  const [ascending, setAscending] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(`${base}/v1/benchmarks`, { credentials: 'include' })
      .then(async response => {
        if (!response.ok) throw new Error(`Benchmark service returned ${response.status}`);
        return response.json() as Promise<Response>;
      })
      .then(value => { if (alive) { setData(value); setSelected(value.benchmarks[0]?.id ?? null); } })
      .catch(reason => { if (alive) setError(reason instanceof Error ? reason.message : 'Unable to load benchmarks'); });
    return () => { alive = false; };
  }, [base]);

  const chosen = data?.benchmarks.find(item => item.id === selected) ?? data?.benchmarks[0];
  const rows = useMemo(() => [...(chosen?.scores ?? [])]
    .filter(row => !onlyServed || Boolean(row.leylineModel))
    .sort((a, b) => (ascending ? a.score - b.score : b.score - a.score) || a.model.localeCompare(b.model)), [chosen, onlyServed, ascending]);

  if (error) return <><PageHeader title="Benchmarks" description="Choose models using independent benchmark results." /><EmptyState title="Benchmarks unavailable">{error}</EmptyState></>;
  if (!data) return <><PageHeader title="Benchmarks" description="Loading benchmark results…" /></>;
  if (!data.benchmarks.length) return <><PageHeader title="Benchmarks" /><EmptyState title="No benchmark data is available">Sources have not produced a snapshot yet, or a source needs configuration.</EmptyState></>;

  const grouped = GROUPS.map(group => ({
    group,
    benchmarks: data.benchmarks.filter(item => DETAILS[item.id]?.group === group),
  })).filter(item => item.benchmarks.length);

  return (
    <>
      <PageHeader title="Benchmarks" description="Scores are not comparable across benchmarks. Small differences are noise; cost and speed matter too." />
      <div className="mb-6 grid gap-4 md:grid-cols-2">
        {grouped.map(({ group, benchmarks }) => (
          <Card key={group}>
            <CardHeader><CardTitle className="text-base">Best for {group.toLowerCase()}</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {benchmarks.map(benchmark => {
                const served = benchmark.scores.filter(row => row.leylineModel).sort((a, b) => b.score - a.score)[0];
                return <button key={benchmark.id} type="button" className="block w-full text-left text-sm hover:underline" onClick={() => setSelected(benchmark.id)}>
                  <span className="font-medium">{benchmark.name}</span>
                  <span className="ml-2 text-muted-foreground">{served ? `Best here: ${served.leylineModel}` : 'No served model in this snapshot'}</span>
                </button>;
              })}
            </CardContent>
          </Card>
        ))}
      </div>
      {chosen ? (
        <Card>
          <CardHeader>
            <CardTitle>{chosen.name}</CardTitle>
            <CardDescription>{DETAILS[chosen.id]?.description ?? 'Benchmark results.'} {DETAILS[chosen.id]?.unit ?? 'Higher is better.'}</CardDescription>
            <div className="flex flex-wrap gap-2">
              {data.benchmarks.map(item => <Button key={item.id} variant={item.id === chosen.id ? 'default' : 'outline'} size="sm" onClick={() => setSelected(item.id)}>{item.name}</Button>)}
              <Button variant="outline" size="sm" onClick={() => setOnlyServed(value => !value)}>{onlyServed ? 'Show all models' : 'Only Leyline models'}</Button>
              <Button variant="outline" size="sm" onClick={() => setAscending(value => !value)}><ArrowUpDown />Sort {ascending ? 'ascending' : 'descending'}</Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead><tr className="border-b"><th className="p-2">Model</th><th className="p-2">Score</th><th className="p-2">Leyline</th><th className="p-2">Date</th></tr></thead>
                <tbody>{rows.map(row => <tr key={`${row.model}-${row.asOf}`} className="border-b last:border-0">
                  <td className="p-2 font-medium">{row.model}</td><td className="p-2 tabular-nums">{row.score}</td>
                  <td className="p-2">{row.leylineModel ? <><span className="text-success">{row.leylineModel}</span>{row.aliases?.length ? <span className="ml-1 text-xs text-muted-foreground">({row.aliases.join(', ')})</span> : null}</> : '—'}</td>
                  <td className="p-2 text-muted-foreground">{row.asOf || chosen.asOf || '—'}</td>
                </tr>)}</tbody>
              </table>
            </div>
            {!rows.length ? <EmptyState title="No matching rows">This benchmark is empty, failed at its source, or has no served model matching the filter.</EmptyState> : null}
            {chosen.source ? <a className="mt-4 inline-flex items-center gap-1 text-sm underline" href={chosen.source} target="_blank" rel="noreferrer">Source <ExternalLink className="size-3" /></a> : null}
          </CardContent>
        </Card>
      ) : null}
      <p className="mt-4 text-xs text-muted-foreground">Reasoning-effort variants are folded into the base model's best score. Data fetched {data.fetchedAt ? new Date(data.fetchedAt).toLocaleString() : 'not yet'}.</p>
    </>
  );
}