export function fetchBenchmarks(): Promise<Response> {
  return fetch('/v1/benchmarks', { credentials: 'include' });
}