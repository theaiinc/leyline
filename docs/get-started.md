# Get started with Valefront

## Sign up

1. Open `https://dash.valefront.com` and sign in (Aegis).
2. If your email isn't verified yet, verify it from the sign-in email, then sign in again.
3. Accept the Terms, pass the security check, and select **Create workspace and API key**.
4. Copy your API key: it is shown once. You can make more under **API keys** (each needs the security check again).

New accounts get **1,000,000 free tokens**, and **4,000,000 more after their first top-up**, for 30 days, on the free-tier models listed on the Get started page and in `https://llm.valefront.com/v1/pricing` (`free_tier`), up to 250,000 a day. Free tokens are given once per email address and sign-in account.

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

Each request costs the model's official price per token. Free tokens are used first on free-tier models; everything else comes from your prepaid balance. Keys with [PII protection](#pii-protection-add-on) on also pay $0.20 per 1M input tokens from your balance.

- **Add credit** on the Billing page (`https://dash.valefront.com/billing`): at least $10, by PayPal (PayPal balance or card), by bank transfer in USD, or by Vietnamese bank transfer (a QR code, in VND). Fill in your billing details first: your country sets the VAT (0% outside Vietnam, 10% in Vietnam).
- **Quick add** from Get started: pick $10, $25, $50 or $100 and pay by card or PayPal, or by bank QR (VND), with your saved receipt details (the first time: name, email and country). For a Vietnamese VAT invoice or a USD bank transfer, use the Billing page.
- PayPal adds the credit as soon as the payment completes. A bank transfer is credited when it arrives (usually 1–3 business days): send exactly the amount shown, with the reference.
- **Bank QR (VND):** scan the QR with any Vietnamese banking app; the amount and transfer content fill in by themselves (or copy the bank, account number, exact VND amount and content). The amount is your total in US dollars at the day's rate (the one on the pricing page: Vietcombank's USD selling rate), rounded up to a whole dong, and is valid for 30 minutes; after that, get a new quote. Keep the transfer content exactly as shown. Credit is usually added within a minute or two; the page checks every 10 seconds, or press "I've paid — check now". If you send less, the page shows what is left to send with the same content; if you send more, the order's amount is credited and the difference is noted for a refund (write to support@valefront.com).
- Every payment gets a receipt by email, and on the Billing page (view, print, PDF).
- In Vietnam you can ask for a VAT invoice (hóa đơn GTGT) when adding credit: enter the company name, tax code (MST), address and the email to send it to. It is issued as an e-invoice through Viettel S-Invoice and emailed to you; until then the Billing page says "Your VAT invoice is being issued".

With no credit and no free tokens left, requests return HTTP `402` with the code `insufficient_credit`. Some limits answer `429`: 60 requests a minute per key, the daily free-token limit, and the free tier's daily capacity. A model without a published price returns `403 model_not_priced`.

## PII protection (add-on)

PII protection keeps personal data in your prompts from reaching the model's provider. Before the prompt leaves Valefront, **emails, phone numbers, card numbers and API keys** in the messages are replaced with placeholders such as `VF_EMAIL_1X`; the reply, streamed or not, gets the real values back, so your app and your users see no difference.

- **Turn it on** under **API keys**: switch on **PII protection** for a key, or tick it when you create a key. It applies to that key's chat requests (OpenAI `/v1/chat/completions` and Anthropic `/v1/messages`) within about 30 seconds. Switch it off the same way.
- **Price:** **$0.20 per 1M input (prompt) tokens** of each protected request, on top of the model's price. For example, a request with 10,000 input tokens costs $0.002 more. The current price is in `https://llm.valefront.com/v1/pricing` under `addons` (`pii-protection`).
- **Paid from credit:** free tokens never cover PII protection, even on free-tier models. A protected key with a $0.00 balance gets HTTP `402` `insufficient_credit` ("PII protection is on for this key and needs credit"): add credit, or switch it off for that key.
- **On your bill:** the Billing page's ledger shows it as its own line, **PII protection**, apart from API usage; the Spending page shows it under **Add-ons** (requests, input tokens, dollars).
- **Speed:** it adds a few milliseconds a request.
- **What it doesn't catch:** names, street addresses and ID numbers are not detected by the standard mode. Where Valefront offers the thorough mode, a menu next to the switch lets you choose it (same price).

## Your data

Under **Your data** you can download everything Valefront keeps about your account (JSON), or delete your account. Deleting revokes your keys at once and deletes your workspace and usage; receipts, VAT invoices, payments and the credit ledger are kept for 10 years, as accounting law requires. Questions: privacy@valefront.com.
