# Production deployment and BytePlus verification

`https://llm.theaiinc.com` is served in production by the Cloudflare Worker named `leyline`, configured by `wrangler.jsonc`. The Worker is deployed by `.github/workflows/deploy-worker.yml` after changes are merged to `main`.

`BYTEPLUS_ARK_API_KEY` is a Cloudflare Worker secret. It is set in the Worker secret store and must never be committed to this repository or placed in `render.yaml`.

The Render service described by `render.yaml` is not production for `llm.theaiinc.com`; it is retained as a legacy or secondary deployment until Steve decides otherwise. Changes deployed there do not update the production Worker.

After deployment, verify the production Worker with:

```sh
curl -s https://llm.theaiinc.com/healthz
```

A live deployment reports `status: "ok"`, `service: "leyline"`, and the deployed Git commit in `commit`.
