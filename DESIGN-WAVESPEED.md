# WaveSpeed provider design

## API contract

WaveSpeed uses `POST https://api.wavespeed.ai/api/v3/<provider>/<model>` with JSON input and returns a prediction ID. Valefront will poll the documented result endpoint with backoff (starting around two seconds) until a terminal state; completed outputs are read from `data.outputs`. Authentication uses the `Authorization: Bearer <Worker secret>` header. The integration will also support WaveSpeed's documented webhook verification and optional webhook callback, model-list endpoint, and upload endpoint for file inputs. Submission errors and rate limits will preserve WaveSpeed's status/code/message shape in Valefront's API error response.

Sources: https://wavespeed.ai/docs (API authentication, predictions, webhooks, uploads, list models, pricing, errors and rate limits); model-specific schemas and pricing pages linked from the WaveSpeed model library.

## Valefront API

- `POST /v1/images/generations` for text-to-image models, returning an asynchronous prediction ID.
- `POST /v1/predictions` with `{ model, input }` for video, image-to-video, audio, lip-sync, 3D, and other non-chat models.
- `GET /v1/predictions/:id` returns `id`, `status`, `outputs`, `usage`, and `cost`.
- An optional webhook endpoint updates the same prediction record.

Models are namespaced as `wavespeed/<provider>/<model>`. `/v1/models` and `/v1/pricing` expose only the curated, priced catalog with modality, input schema, and official price. Existing issued-key authentication, quota/budget limits, and per-key usage records apply before submission and on completion.

## Initial curated catalog and pricing

The first catalog will cover text-to-image, image edit, text-to-video, image-to-video, talking avatar/lip-sync (including `bytedance/latentsync`), TTS, and speech-to-text. Entries are checked into one WaveSpeed catalog with their model-specific input schemas. Prices are copied from WaveSpeed's official model/pricing data with no markup and retain the billing rule (per run, duration, resolution, or other documented unit). Models without an official price are not offered. Where WaveSpeed reports an actual billed amount, Valefront records that amount; otherwise it calculates from the catalog rule.

## Outputs and retention

WaveSpeed returns output URLs. The provider's retention/expiry behavior will be confirmed from its data-retention and prediction documentation before implementation. Because external URLs may expire, completed outputs will be copied to owner-scoped R2 storage and returned as signed URLs with a documented retention period; storage keys include the issued-key owner and never expose another owner's output.

## Secrets and deployment safety

The provider is configured only by the Worker secret name `WAVESPEED_API_KEY`; this change does not set that secret anywhere. The testing credential in Arcana is not copied into source, tests, env files, CI, deployment configuration, PR text, documentation, logs, or the deployed Worker. Until Steve supplies a production credential and explicitly provisions it, production remains without WaveSpeed and must not advertise or call the provider. Unit and integration tests use mocked WaveSpeed responses only.

A local-only smoke script will read `WAVESPEED_API_KEY` from the invoking process environment and will never retrieve or persist it. Steve can run it under Arcana for one image model and `bytedance/latentsync`; the exact command will be documented with the implementation. This is not a dash.valefront.com live verification.

## Tests and release verification

Mocked tests will cover submission, polling success and failure, webhook handling, model/pricing publication, output persistence, per-key usage and accounting, and refusal of unpriced models. No automated test contacts WaveSpeed or uses a real credential. After review, Steve may run the local smoke script manually with a process-injected testing credential; merge and deployment do not make WaveSpeed live, and no production run is performed until a production key is explicitly provisioned.

Release notes will be included in short and full form in the PR.

### Local smoke verification

This is a local-only check and does not deploy or configure WaveSpeed on `dash.valefront.com`. After Arcana injects the testing credential into the single process, run:

`WAVESPEED_API_KEY="$(arcana read arcana://wavespeed/api-key)" npx tsx scripts/wavespeed-smoke.ts`

The script submits one small image request and one small `bytedance/latentsync` request, polls both to completion or failure, and prints only outputs and recorded costs. It reads `WAVESPEED_API_KEY` from the process environment and does not write the value to files, logs, CI, Worker configuration, or deployment settings. Do not run this command against production; WaveSpeed remains unavailable in production until Steve provides and explicitly provisions a production credential.

### Validation

The focused mocked validation passed: 10 suites and 64 tests passed with no real WaveSpeed credential or network call. The provider, pricing/catalog, polling, failure handling, and existing provider tests are covered.

### Release notes

Short: Add a curated, no-markup WaveSpeed provider for asynchronous image, video, audio, lip-sync, 3D, TTS, and speech-to-text models, with mocked tests and a local-only smoke command.

Full: Add namespaced WaveSpeed models with schemas and sourced pricing, asynchronous submission and polling, output and usage/cost recording, and refusal of unpriced models. Keep the provider disabled in production by leaving `WAVESPEED_API_KEY` unset; the testing-only Arcana credential is used only for an explicitly manual local smoke run. No claim of live WaveSpeed support on `dash.valefront.com` is made.