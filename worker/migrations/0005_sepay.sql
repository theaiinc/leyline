-- SePay (Vietnamese bank-transfer QR in VND; src/core/sepay.ts). A SePay order carries its VND quote: the rate and
-- the exact VND amount the customer was asked to pay, valid for 30 minutes (JSON). payment_note records what an admin
-- should know about how it was paid (underpaid, overpaid: refund the excess, paid after the quote expired...).
ALTER TABLE billing_orders ADD COLUMN quote TEXT;
ALTER TABLE billing_orders ADD COLUMN payment_note TEXT;

-- Every incoming SePay transaction we were told about (webhook) or found (polling), once per SePay transaction id:
-- a replay never counts twice. order_id is the order whose reference was in the transfer content; outcome is what
-- was done with it. The amounts of an order's 'credited' and 'underpaid' rows add up to what it received.
CREATE TABLE sepay_transactions (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  account_number TEXT NOT NULL,
  direction TEXT NOT NULL,
  amount_vnd INTEGER NOT NULL,
  content TEXT NOT NULL,
  reference_code TEXT,
  transaction_date TEXT,
  gateway TEXT,
  order_id TEXT,
  outcome TEXT,
  received_at INTEGER NOT NULL
);
CREATE INDEX sepay_transactions_order ON sepay_transactions (order_id);
CREATE INDEX sepay_transactions_received ON sepay_transactions (source, received_at);
