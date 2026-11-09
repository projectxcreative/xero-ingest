# xero-ingest

A small Dext replacement. Drop a supplier invoice or receipt into the **Ingest** folder in Google Drive, and every 15 minutes this Cloudflare Worker:

1. Reads it with Claude: supplier, date, invoice number, currency, total, UK VAT, and the account code to use.
2. Finds the card charge for it on your Xero bank feed. For USD (or any foreign currency) invoices it converts at the market rate to get a rough figure, then looks for a bank line from that supplier within ±6%.
3. Creates the bill in Xero **in GBP, for the exact amount the bank charged**, with the PDF attached and the original currency amount in the reference (e.g. `USD 20.00 charged as GBP 16.11 (rate 0.8055)`).
4. Records the payment from your bank account on the bank line's date, so Xero offers the statement line as a ready-made match. You just click **OK** in Reconcile.
5. Moves the file to **Done**, or to **Needs review** with the reason in the file's Drive description.

If the card charge hasn't reached the bank feed yet, the file stays in Ingest and is retried each run for up to `PENDING_DAYS` (default 7).

## Why bills are booked in GBP

Your Xero plan has no multi-currency, and a card charges a different rate (plus fees) than the one on the invoice date. Booking at the actual GBP bank amount means every bill matches its bank line to the penny. If you add multi-currency later, this can switch to USD bills plus a GBP payment, with Xero posting the FX difference.

## What it won't do

- **Click "OK" on the bank reconciliation.** Xero's API doesn't let any app reconcile statement lines. The bill and payment are set up so Xero suggests the exact match.
- Credit notes or refunds, invoices without a total or date, and anything Claude is unsure about. These go to Needs review.
- Reverse-charge VAT on overseas services. Foreign invoices use `NO_VAT_TAX_TYPE` (default `NONE`). If you are VAT registered and account for reverse charge, set it to the right Xero tax type.

## Account codes

If the supplier already has a bill in Xero, the same account code is reused. Otherwise Claude picks from your active expense accounts.

## Setup (about 30 minutes, once)

### 1. Google Drive
1. Create three folders in Drive: `Ingest`, `Done` and `Needs review`. Copy each folder's ID (the long string at the end of its URL).
2. In Google Cloud Console, create a project, enable the **Google Drive API**, then create a **service account** and download a JSON key.
3. Share all three folders with the service account's email address (`...@...iam.gserviceaccount.com`) as **Editor**.

### 2. Xero app
1. Go to <https://developer.xero.com/app/manage> and create a **Web app**.
2. Set the redirect URI to `https://xero-ingest.<your-subdomain>.workers.dev/xero/callback`.
3. Copy the client ID and generate a client secret.

### 3. Cloudflare
```sh
npm install
npx wrangler login
npx wrangler kv namespace create STATE   # paste the id into wrangler.toml
```
Fill in the `[vars]` in `wrangler.toml` (folder IDs, redirect URI), then add the secrets:
```sh
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON   # paste the whole JSON key
npx wrangler secret put XERO_CLIENT_ID
npx wrangler secret put XERO_CLIENT_SECRET
npx wrangler secret put ADMIN_TOKEN                   # any long random string
npm run deploy
```

### 4. Connect Xero and pick the bank account
1. Open `https://xero-ingest.<sub>.workers.dev/xero/connect?key=ADMIN_TOKEN` and approve access to Project X Services Ltd.
2. Open `/admin/bank-accounts?key=ADMIN_TOKEN`, copy the `id` of the account your card payments go through into `XERO_BANK_ACCOUNT_ID`, and deploy again.
3. Check `/admin/bank-lines?key=ADMIN_TOKEN` shows recent bank feed lines. Add `&raw` to see Xero's raw report if it looks wrong.

If Xero rejects the scopes on connect (newer Xero apps use finer-grained scopes), add an `XERO_SCOPES` var with the scopes your app page lists for invoices, payments, contacts, attachments, settings (read) and reports (read).

### 5. Try it in dry-run mode
`DRY_RUN` is `"true"` by default. In that mode nothing is written to Xero or moved in Drive. Drop a few invoices in Ingest and open `/admin/run?key=ADMIN_TOKEN` to see what it *would* do. When you're happy, set `DRY_RUN = "false"` and deploy.

## Settings (`wrangler.toml`)

| Var | Default | Meaning |
|---|---|---|
| `DRY_RUN` | `true` | Preview only. |
| `CLAUDE_MODEL` | `claude-opus-5-5` | Model used to read invoices. |
| `PENDING_DAYS` | `7` | Days to wait for the bank line before sending to review. |
| `FX_TOLERANCE` | `0.06` | Allowed gap between market-rate estimate and the bank charge. |
| `MAX_FILES_PER_RUN` | `5` | Files handled per 15-minute run. |
| `VAT_TAX_TYPE` | `INPUT2` | Xero tax type for GBP invoices showing UK VAT. |
| `NO_VAT_TAX_TYPE` | `NONE` | Xero tax type for everything else. |

## Development
```sh
npm test         # matching logic tests
npm run typecheck
npx wrangler dev --test-scheduled   # then: curl "http://localhost:8787/__scheduled"
```

Costs: the Workers paid plan ($5/month) is recommended because reading PDFs can exceed the free plan's CPU limit. Claude costs roughly a penny or two per invoice.
