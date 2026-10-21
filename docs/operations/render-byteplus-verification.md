# Render deployment and BytePlus configuration note

## Production verification

On 2026-10-21, `https://llm.theaiinc.com/healthz` returned HTTP 200 with:

```json
{"status":"ok","service":"leyline"}
```

This confirms that the public service is responding and that Render's configured `/healthz` health check is available. The response did not expose a build identifier, Git revision, image digest, or other deployment metadata, so the deployed revision cannot be independently verified from this endpoint. In particular, this check does not prove that revision `bb4352589682` is deployed.

The repository's `render.yaml` defines the `leyline` service as a Docker web service using `Dockerfile`, with `/healthz` as its Render health check. No GitHub release, Render mutation, or redeploy was performed as part of this verification.

## Secure BytePlus configuration procedure

This procedure is intentionally documented but was not executed. No Arcana secret was read, no Render environment variable was changed, and no redeploy was triggered.

1. On Steve's signed-in device, use an approved `run_on_device` job with computer access and the Arcana skill.
2. Check Arcana project policy and secret metadata for an existing Render API credential. Do not print, copy, or send secret values through chat.
3. If a permitted Render API credential exists, inject it directly from Arcana into the Render API request on the device. Set the `leyline` service variables:
   - Required: `BYTEPLUS_ARK_API_KEY` from `arcana://byteplus/ark-api-key`
   - Optional: `BYTEPLUS_ARK_DEFAULT_MODEL`
4. If no Render API credential is available, use Steve's already authenticated Render dashboard in Chrome. Retrieve the BytePlus value only through the approved Arcana flow and paste it directly into the service environment-variable field; do not place it in chat, shell history, logs, or source control.
5. Save the environment changes and allow Render to redeploy the service.
6. Verify `https://llm.theaiinc.com/healthz`, then use an authenticated model-list or routing request to confirm the configured BytePlus model is available. Do not include the API key in diagnostics.

The procedure requires Steve's approval before any secret access or Render mutation. No such approval or operation was performed here.
