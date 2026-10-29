import { benchmarkSources } from '../src/core/benchmarks.js';

async function main(): Promise<void> {
  const sources = benchmarkSources({
    artificialAnalysisApiKey: process.env.ARTIFICIAL_ANALYSIS_API_KEY,
    artificialAnalysisUrl: process.env.ARTIFICIAL_ANALYSIS_URL,
    epochUrl: process.env.EPOCH_BENCHMARKS_URL,
    lmarenaUrl: process.env.LMARENA_BENCHMARKS_URL,
  });

  let totalRows = 0;
  for (const source of sources) {
    try {
      const snapshot = await source.fetch();
      const rows = snapshot.benchmarks.flatMap((benchmark) =>
        benchmark.scores.map((score) => ({
          benchmark: benchmark.name,
          model: score.model,
          score: score.score,
        })),
      );
      totalRows += rows.length;
      console.log(JSON.stringify({
        source: source.name,
        rows: rows.length,
        benchmarks: [...new Set(rows.map((row) => row.benchmark))],
        sample: rows.slice(0, 5),
      }));
    } catch (error) {
      console.error(JSON.stringify({
        source: source.name,
        rows: 0,
        error: error instanceof Error ? error.message : 'unknown error',
      }));
    }
  }

  if (totalRows === 0) {
    process.exitCode = 1;
  }
}

void main();