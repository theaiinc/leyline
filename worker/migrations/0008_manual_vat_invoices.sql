-- VAT invoices on request (billing-service.ts requestVatInvoice / issueEinvoiceManually). While Viettel S-Invoice
-- isn't usable (in live mode without all its live secrets), a buyer's VAT invoice is not issued automatically: it is
-- recorded as a request (einvoices.status 'requested', manual = 1) that an admin issues by hand on adm (invoice
-- number, lookup code, optionally the PDF in billing_documents) or rejects with a reason. Expand-only: new nullable
-- or defaulted columns; code before this migration never reads them and never picks up 'requested' rows.
ALTER TABLE einvoices ADD COLUMN manual INTEGER NOT NULL DEFAULT 0;
ALTER TABLE einvoices ADD COLUMN reject_reason TEXT;
ALTER TABLE einvoices ADD COLUMN resolved_by TEXT;
ALTER TABLE einvoices ADD COLUMN resolved_at INTEGER;
