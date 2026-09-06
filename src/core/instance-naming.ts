// Generates a short, human-readable id for a new provider instance.
// Tries an optional LLM adapter first (bounded by a timeout), and always
// falls back to a deterministic slug derived from the endpoint/deployment
// so instance creation never depends on — or blocks indefinitely on — an
// LLM being reachable.

const MAX_SLUG_LENGTH = 24;
const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/;

export interface InstanceNamingInput {
  endpoint: string;
  deployment: string;
}

export interface NameGeneratorLLM {
  complete(system: string, user: string): Promise<string>;
}

export function slugify(input: string): string {
  const stripped = input
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
  const slug = stripped
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '');
  return slug || 'instance';
}

function dedupe(candidate: string, existingIds: Set<string>): string {
  if (!existingIds.has(candidate)) return candidate;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const attempt = `${candidate.slice(0, MAX_SLUG_LENGTH - String(suffix).length - 1)}-${suffix}`;
    if (!existingIds.has(attempt)) return attempt;
  }
  return `${candidate}-${Date.now()}`;
}

export function deterministicInstanceId(input: InstanceNamingInput, existingIds: Set<string>): string {
  const base = slugify(input.endpoint) !== 'instance'
    ? slugify(input.endpoint)
    : slugify(input.deployment);
  return dedupe(base, existingIds);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), timeoutMs);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

/**
 * Generates a short kebab-case instance id. Tries `llm` (if provided) with a
 * bounded timeout; falls back to a deterministic slug on any failure,
 * invalid output, or missing adapter.
 */
export async function generateInstanceId(
  input: InstanceNamingInput,
  existingIds: Set<string>,
  llm?: NameGeneratorLLM,
  timeoutMs = 3000,
): Promise<string> {
  if (llm) {
    try {
      const raw = await withTimeout(
        llm.complete(
          'Reply with only a short kebab-case identifier (letters, digits, hyphens, max 24 characters, no explanation) '
          + 'that identifies this API endpoint/deployment. Example: contoso-eastus2',
          `endpoint: ${input.endpoint}\ndeployment: ${input.deployment}`,
        ),
        timeoutMs,
      );
      const candidate = slugify(raw.trim());
      if (candidate !== 'instance' && ID_PATTERN.test(candidate)) {
        return dedupe(candidate, existingIds);
      }
    } catch {
      // Fall through to the deterministic fallback below.
    }
  }
  return deterministicInstanceId(input, existingIds);
}
