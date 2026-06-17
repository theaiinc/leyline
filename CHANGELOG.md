# Changelog

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
