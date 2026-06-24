# Changelog

## [1.3.3] - 2026-06-25

### Added

- LiteLLM payload audit logging for safe inbound/outbound metadata comparison without logging prompt contents.
- LiteLLM Azure launcher now writes model context metadata, disables LiteLLM cache, and enables pre-call checks.

### Fixed

- LiteLLM streaming parser now buffers SSE lines across transport chunks so Cursor tool-call deltas and usage chunks are not dropped when JSON events are split.
- Stream usage logging now records provider token usage when LiteLLM returns it, with dashboard fallback text clarified as output characters.
- Cursor flat function/custom tool definitions are normalized before forwarding to LiteLLM's Azure Responses transformer.

## [1.3.2] - 2026-06-24

### Fixed

- Docker Hub README sync is non-blocking in the release workflow so npm and image publishing are not marked failed when Docker Hub denies description updates.

## [1.3.1] - 2026-06-24

### Fixed

- Docker image builds now use Node 22 so Vite 8 can run during `npm run build`.

## [1.3.0] - 2026-06-24

### Added

- Azure OpenAI provider support via `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT`, and optional `AZURE_OPENAI_API_VERSION`.
- Azure OpenAI quota configuration and default model/deployment wiring for standalone server bootstrap.
- OpenAI provider support with `gpt-5.5` as the default model via `OPENAI_API_KEY`.
- Single model mode via `LEYLINE_ROUTER_ENABLED=false`, `LEYLINE_FIXED_PROVIDER`, and `LEYLINE_FIXED_MODEL` to bypass dynamic routing/failover.
- React dashboard with provider cards, runtime API key persistence controls, Azure runtime settings, network status, analytics, and recent logs.
- Optional Apple Keychain persistence for dashboard-saved API keys via the macOS `security` CLI, with server memory fallback and browser `localStorage` fallback from the dashboard.
- OpenAI-compatible Azure `/openai/v1` endpoint support via `AZURE_OPENAI_BASE_URL`, matching Azure OpenAI SDK usage with only URL, key, and model.
- LiteLLM provider and `npm run litellm:azure` launcher for Cursor Agent / Azure Responses compatibility.
- Cloudflare tunnel sessions now generate a fresh random `ll-...` client API key when `LEYLINE_CLIENT_API_KEY` is unset.
- Dashboard tunnel banner now shows masked connection details with Show/Hide and Copy controls for the public base URL and session API key.

### Changed

- **Prompt Compression migrated from `headroom-ai` npm package to `@theaiinc/headroom-ai` Python library**: Forked `chopratejas/headroom` to `github.com/theaiinc/headroom-ai`, stripped it to library-only (kept: transforms, memory, ccr, cache, relevance, shared_context). Added `headroom.json_cli` JSON stdin/stdout bridge. Leyline spawns it as a subprocess via `headroom-compress` CLI entry point (falls back to `python3 -m headroom.json_cli`). Install: `pip install headroom-ai`.
- Removed `headroom-ai` optional peer dependency from `package.json`.
- Removed `HEADROOM_BASE_URL` env var (no longer needed — calls Python library directly, not HTTP proxy).
- Recommended Cursor + Azure path now routes Leyline through LiteLLM (`LEYLINE_FIXED_PROVIDER=LiteLLM`) instead of hand-rolled Azure request shims.

### Fixed

- Dashboard Keychain status now treats missing saved provider keys as normal unconfigured keys and reserves fallback warnings for actual `security` CLI or Keychain access failures.
- Ollama is opt-in and rejects cloud model names that are not installed local tags, preventing accidental localhost failover for Azure/OpenAI model IDs.
- Azure request normalization preserves tool call messages and avoids dropping conversations with empty/Responses-style payloads.

### Security

- Dashboard routes and dashboard management APIs are restricted to direct localhost access; public tunnel/proxy requests are blocked.

## [1.2.0] - 2026-06-17

### Added

- **Prompt Compression (off by default)**: New optional integration with `headroom-ai` to compress prompts and context before sending to LLM providers. Set `LEYLINE_COMPRESSION_ENABLED=true` and install `npm install headroom-ai`. A headroom proxy must be running. The `maybeCompress()` function is called automatically in `Router.route()` and `Router.routeStream()`, and is also exported for direct use. Exported `CompressionConfig` type.

### Changed

- `headroom-ai` added as optional peer dependency.

## [1.1.2] - 2026-06-17

### Fixed

- Changed `vars.DOCKER_HUB_USERNAME` to `secrets.DOCKER_HUB_USERNAME` in publish workflow so the Docker Hub login picks up the secret properly.
- Removed duplicate `Push Docker Hub README` step from publish workflow.

## [1.1.1] - 2026-06-17

### Fixed

- npm publish provenance failure: added missing `repository.url` to `package.json`.
- Removed Oasis-specific env var aliases (`OASIS_MODEL_*`, `OASIS_ROUTER_MODEL`, `OASIS_OPENAI_BASE_URL`) from config.ts, `.env.example`, README, and CHANGELOG — Leyline must be a standalone package with no external dependencies.

## [1.1.0] - 2026-06-17

### Added

- **Semantic Router**: New `Classifier` module that uses a lightweight LLM to classify requests by `complexity`, `domain`, and `reasoning`.
- **Model Registry**: New `ModelRegistry` class providing a configurable catalog of `ModelVariant` entries with support for custom variant definitions via `LEYLINE_CUSTOM_VARIANTS`.
- **Code Policy**: Exported `selectModelByRouter` function — a deterministic code-policy that maps router classifications to model tiers (`2b`, `4b`, `12b`).
- **`resolveRoute` endpoint**: `POST /v1/route` accepts `user_message` and `chat_history`, returns a structured routing decision (`classification`, `selectedTier`, `selectedModel`, `selectedProvider`).
- **LM Studio Provider**: New `LMStudioProvider` for local OpenAI-compatible endpoints (configurable via `LMSTUDIO_BASE_URL` / `LMSTUDIO_MODEL`).
- **Configuration Types**: Exported `LeylineConfig`, `QuotaConfig`, `RouterModelConfig`, `DefaultModelsConfig` for typed consumer usage.
- **Docker Compose**: Production Dockerfile and docker-compose.yml for containerized deployment.
- **CI/CD Pipeline**: `.github/workflows/publish.yml` — OIDC-based npm publish and Docker image build/push (mimics Yggdrasil pipeline).
- **Leyline Logo**: Branded logo displayed in the dashboard UI and included in the published package.
- **Tests**: Comprehensive unit tests for `ModelRegistry`, `Classifier`, and extended `Router` methods covering all routing, policy, and edge-case scenarios.

### Changed

- **Router class extended**: Backward-compatible constructor now accepts either a `QuotaManager` (existing usage) or `RouterOptions` (new features). Added `resolveRoute`, `resolveEffectiveModel`, `setTierConfig`, `setClassifier`, `setCodePolicy`, `setServiceTiers`.
- **Configuration**: New environment variables for router model (`LEYLINE_ROUTER_MODEL`, `LEYLINE_OPENAI_BASE_URL`), tier models (`LEYLINE_MODEL_2B`, `LEYLINE_MODEL_4B`, `LEYLINE_MODEL_12B`), and custom variants (`LEYLINE_CUSTOM_VARIANTS`).
- **License**: Changed from `UNLICENSED` to `MIT`.
- **README**: Replaced ASCII diagrams with Mermaid charts (Architecture, Routing Flow, Classifier Prompt, Code Policy). Updated all documentation, configuration tables, and usage examples.
- **Dashboard**: Logo image added to `public/index.html` header.
- **Build artifacts**: Removed accidentally committed `.d.ts` files from `src/` directory (build output lives in `dist/`).

### Fixed

- Logo path in dashboard HTML corrected to resolve under `/dashboard/` prefix, plus root-level `/logo.png` route for direct access.

### Security

- Updated dependencies to latest compatible versions.
- Reduced npm audit warnings.
