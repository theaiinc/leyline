/** Google Cloud access from Cloud Run: an access token (and the project id) from the metadata server. */

const METADATA = 'http://metadata.google.internal/computeMetadata/v1';

export class GcpToken {
  private token: { value: string; until: number } | null = null;
  constructor(private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init)) {}

  async get(): Promise<string> {
    if (this.token && Date.now() < this.token.until) return this.token.value;
    const res = await this.fetchImpl(`${METADATA}/instance/service-accounts/default/token`, { headers: { 'Metadata-Flavor': 'Google' } });
    if (!res.ok) throw new Error(`metadata token: ${res.status}`);
    const t = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: t.access_token, until: Date.now() + (t.expires_in - 60) * 1000 };
    return t.access_token;
  }

  async projectId(): Promise<string> {
    const res = await this.fetchImpl(`${METADATA}/project/project-id`, { headers: { 'Metadata-Flavor': 'Google' } });
    if (!res.ok) throw new Error(`metadata project id: ${res.status}`);
    return (await res.text()).trim();
  }
}
