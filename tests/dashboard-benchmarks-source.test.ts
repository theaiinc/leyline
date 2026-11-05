import { readFileSync } from 'node:fs';
import { globSync } from 'glob';

describe('dashboard benchmark requests', () => {
  it('does not fetch benchmarks through the API base URL', () => {
    const sources = globSync('dashboard/src/**/*.{ts,tsx}', { nodir: true })
      .map(path => readFileSync(path, 'utf8'))
      .join('\n');

    expect(sources).not.toMatch(/fetch\(\s*`\$\{[^`]*base[^`]*\}\/v1\/benchmarks/);
    expect(sources).not.toMatch(/fetch\(\s*[^)]*base[^)]*\/v1\/benchmarks/);
  });
});