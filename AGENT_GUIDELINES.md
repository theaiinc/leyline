# Agent Guidelines

## Development Notes

- Azure OpenAI supports both `AZURE_OPENAI_BASE_URL` (`.../openai/v1`, OpenAI-compatible with bearer auth and model in payload) and legacy `AZURE_OPENAI_ENDPOINT` + deployment URLs.
- Direct OpenAI support uses `OPENAI_API_KEY` and defaults to `gpt-5.5`; keep Azure deployment names separate from OpenAI model ids in registry decisions.
- Single model mode is controlled by `LEYLINE_ROUTER_ENABLED=false` plus `LEYLINE_FIXED_MODEL`; `LEYLINE_FIXED_PROVIDER` is optional when `ModelRegistry` can infer the provider.
- Dashboard API key overrides call provider `setApiKey()` hooks and can use Apple Keychain (`security` CLI), browser `localStorage`, or server memory; never return raw keys from dashboard APIs.
- `.env` API keys are explicit startup config and take precedence over Keychain-loaded keys; dashboard saves still update the running provider immediately.
- Azure runtime URL/model settings persist in Apple Keychain under `runtime-config:<ProviderName>` (same service as API keys); `.env` base URLs still take precedence on startup.
- For dashboard Keychain reads, `security find-generic-password` can exit nonzero when an item is simply missing; treat that as an unconfigured provider key, not Keychain unavailability.
- Normalize dashboard API payloads at the frontend boundary before rendering; provider/model/status fields can be absent in stats, logs, or runtime config responses.
- Dashboard request logs come from the singleton router logger via `/dashboard/stats`; log unavailable provider attempts too, preserve non-stream `response.usage`, keep logger tests isolated with `logger.clear()`, and make empty log states explicit in the UI.
- Logs panel empty states should replace the table entirely, not render alongside an empty table or placeholder rows; keep row error truncation display-only with full text available on hover.
- `/v1/chat/completions` must wait for dashboard/provider API key initialization before routing; browser `localStorage` keys only reach providers after the dashboard rehydrates them back through `/dashboard/api-keys`.
- `/v1/route` is always registered. Startup logs distinguish fixed model mode (`LEYLINE_ROUTER_ENABLED=false` + `LEYLINE_FIXED_MODEL`), classifier mode (`LEYLINE_ROUTER_MODEL` + `LEYLINE_OPENAI_BASE_URL`), and tier-default mode (no classifier). Dashboard Azure deployment selection does not enable fixed model mode — that requires env vars.
- Leyline validates client `Authorization` headers on `/v1/*` with default key `leyline` (`LEYLINE_CLIENT_API_KEY` / `LEYLINE_CLIENT_AUTH_ENABLED=false` to override). Provider keys live in Leyline env/dashboard.
- When Cloudflare tunnel is enabled and `LEYLINE_CLIENT_API_KEY` is unset, Leyline generates a fresh random `ll-...` client API key per server process and prints it with the public URL.
- Dashboard and dashboard APIs are localhost-only; block requests with Cloudflare/proxy headers (`cf-connecting-ip`, `cf-ray`, `x-forwarded-for`) so the public tunnel only exposes `/v1/*`.
- Docker image builds need Node 22+ (`node:22-alpine`) because current Vite requires Node `20.19+` / `22.12+`; Node 18 fails with `CustomEvent is not defined`.
- Docker Hub README sync can return `Forbidden` even after Docker image push succeeds; keep that workflow step non-blocking unless Docker Hub token scopes are confirmed.
- On boot, Leyline auto-starts `cloudflared tunnel --url http://127.0.0.1:$PORT` unless `LEYLINE_TUNNEL_ENABLED=false`. Public URL is logged and returned in `/dashboard/stats` + `/dashboard/tunnel` for cloud clients that cannot reach localhost.
- JSON body limit defaults to `100mb` (`LEYLINE_BODY_LIMIT`); Express default is 100kb and causes `PayloadTooLargeError` on large chat/tool payloads. Run `npm start` (includes `prestart` tsc) so `dist/` matches source.
- Normalize `/v1/chat/completions` payloads at the server boundary (`normalizeCompletionRequest`) — Cursor may send multimodal `content` arrays or non-array `messages`; streaming failover uses `ensureMessageArray` to avoid `compressed.messages is not iterable`.
- Ollama is opt-in (`OLLAMA_ENABLED=true`). `canHandle` rejects registry cloud models (e.g. `gpt-5.5` → `openai`) and only accepts installed local tags. Without `LEYLINE_ROUTER_ENABLED=false`, Azure 400s still trigger multi-provider failover — pin Azure with fixed model mode.
- For Cursor + Azure, prefer Leyline → LiteLLM → Azure: `LEYLINE_ROUTER_ENABLED=false`, `LEYLINE_FIXED_PROVIDER=LiteLLM`, `LEYLINE_FIXED_MODEL=gpt-5.5`, then run `npm run litellm:azure` before `npm start`.
- LiteLLM is the Azure compatibility adapter for Cursor Agent request shapes (`azure/responses/<deployment>`). Avoid adding more Azure Chat Completions shims unless LiteLLM cannot cover a case.
- Azure 400 with payload `messages:[]` means normalization/sanitization dropped the conversation — router now runs `ensureMessageArray` before every provider call and rejects empty message arrays early; `normalizeCompletionRequest` also accepts Responses-style `input`.
- Cursor Agent sends flat tools (`tools[i].name`) and custom tools like `apply_patch`; Azure Chat Completions needs nested `tools[i].function.*` or `tools[i].custom.name`. Incomplete `custom.format: { type: "grammar" }` without `grammar.syntax/definition` becomes `{ type: "text" }` — otherwise Azure 400s with `tools[n].custom.format.grammar`.
- Leyline provider quotas (`LEYLINE_QUOTAS_ENABLED`) are **off by default**. When enabled, Azure defaults to 60 RPM which Cursor bursts exceed quickly — Cursor shows that as "User API Key Rate limit exceeded".
- `gpt-5.5` in the default registry maps to `openai`; Azure fixed-model setups need `LEYLINE_FIXED_PROVIDER=AzureOpenAI` when the deployment name matches an OpenAI model id.
