# Get started with Valefront

## Sign up

1. Open `https://dash.valefront.com` and sign in (Aegis).
2. If your email isn't verified yet, verify it from the sign-in email, then sign in again.
3. Accept the Terms, pass the security check, and select **Create workspace and API key**.
4. Copy your API key: it is shown once. You can make more under **API keys** (each needs the security check again).

New accounts get **5,000,000 free tokens for 30 days** on the free-tier models listed on the Get started page and in `https://llm.valefront.com/v1/pricing` (`free_tier`), up to 250,000 a day. Free tokens are given once per email address and sign-in account.

## Make a request

OpenAI format (replace the model with one from `/v1/pricing`, or use `auto`):

```sh
export VALEFRONT_API_KEY='ll_...'

curl https://llm.valefront.com/v1/chat/completions \
  -H "Authorization: Bearer $VALEFRONT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "seed-2-0-lite-260428", "messages": [{"role": "user", "content": "Say hello from Valefront."}]}'
```

Anthropic format:

```sh
curl https://llm.valefront.com/v1/messages \
  -H "x-api-key: $VALEFRONT_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model": "seed-2-0-lite-260428", "max_tokens": 128, "messages": [{"role": "user", "content": "Say hello from Valefront."}]}'
```

## Pay as you go

Each request costs the model's official price per token. Free tokens are used first on free-tier models; everything else comes from your prepaid balance.

- **Add credit** on the Billing page (`https://dash.valefront.com/billing`): at least $10, by PayPal (PayPal balance or card) or by bank transfer in USD. Fill in your billing details first: your country sets the VAT (0% outside Vietnam, 10% in Vietnam).
- PayPal adds the credit as soon as the payment completes. A bank transfer is credited when it arrives (usually 1–3 business days): send exactly the amount shown, with the reference.
- Every payment gets a receipt by email, and on the Billing page (view, print, PDF).
- In Vietnam you can ask for a VAT invoice (hóa đơn GTGT) when adding credit: enter the company name, tax code (MST), address and the email to send it to. It is issued as an e-invoice through Viettel S-Invoice and emailed to you; until then the Billing page says "Your VAT invoice is being issued".

With no credit and no free tokens left, requests return HTTP `402` with the code `insufficient_credit`. Some limits answer `429`: 60 requests a minute per key, the daily free-token limit, and the free tier's daily capacity. A model without a published price returns `403 model_not_priced`.

## Your data

Under **Your data** you can download everything Valefront keeps about your account (JSON), or delete your account. Deleting revokes your keys at once and deletes your workspace and usage; receipts, VAT invoices, payments and the credit ledger are kept for 10 years, as accounting law requires. Questions: privacy@valefront.com.
