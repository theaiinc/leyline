# Get started

> This page documents the self-serve foundation currently implemented in this branch. Workspace persistence, key issuance, email verification, Turnstile verification, billing, and production free-grant fulfillment are not yet enabled here; do not use this branch as a production signup flow. with Valefront

## Sign in and create your workspace

1. Open `https://dash.valefront.com`.
2. Sign in with Aegis using the `leyline-dashboard` client.
3. Accept the current Terms.
4. Verify your email address. Valefront will not issue an API key until the email is verified.
5. Complete the Cloudflare Turnstile check.
6. Create your first API key. The complete key is shown once; store it securely.

Each Aegis account receives an isolated workspace. Keys, usage, billing, history, grants, and suspension state are scoped to that workspace.

Disposable email domains and duplicate free-grant claims are rejected. Workspace creation is also rate-limited by source IP.

## Free tier

The initial free grant is 1,000,000 tokens and expires after 30 days. Free keys can use only the eligible free-tier models and are subject to request-per-minute, concurrency, and daily-token limits. Paid models require paid credit.

When the global free-tier daily budget is exhausted, requests return HTTP 429 with an explicit free-budget error.

## OpenAI-compatible request

Replace `$VALEFRONT_API_KEY` with the key shown during onboarding:

```sh
export VALEFRONT_API_KEY='...'

curl https://llm.valefront.com/v1/chat/completions \
  -H "Authorization: Bearer $VALEFRONT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "Say hello from Valefront."}]
  }'
```

## Anthropic-compatible request

```sh
curl https://llm.valefront.com/v1/messages \
  -H "x-api-key: $VALEFRONT_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-5-haiku",
    "max_tokens": 128,
    "messages": [{"role": "user", "content": "Say hello from Valefront."}]
  }'
```

## Security and suspension

Never commit an API key. A suspended workspace or key returns HTTP 403. Sudden request spikes can automatically pause a key for administrator review.

For billing, Add-credit, and every subsequent API-key creation, Valefront requires another successful Turnstile check.

## Support and administration

Administrative controls remain restricted to configured `adminEmails` and are intended for `https://adm.valefront.com` behind Cloudflare Access. The administrator surface handles suspensions, anomaly review, the global free-tier budget, and audit events.

## Deployment configuration

The Turnstile widget must allow these hostnames:

- `dash.valefront.com`
- `valefront.com`

The public site key may be dashboard configuration. The Siteverify secret must be stored as the Worker secret `TURNSTILE_SECRET`; it must never be committed or sent to the browser.