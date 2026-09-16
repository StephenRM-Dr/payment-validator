# Payment Validator

A multi-bank payment verification platform built with Next.js: it validates
incoming payments across a crypto rail (Binance Pay) and three Venezuelan bank
"Pago Móvil" rails (BDV, Sofitasa, Bancamiga), using AI-assisted OCR to read
payment receipts and direct bank API calls to confirm funds actually arrived.

> **Note:** this is a sanitized portfolio copy of a production system. All
> company names, account numbers, and credentials in this repository are
> dummy values — see `.env.example`. The real client/employer is not
> identified here.

## What it does

- **Teller (cajero) panel** — a cashier scans a customer's payment receipt;
  Gemini-based OCR extracts the amount, currency, and reference/transaction
  ID, then the backend cross-checks that reference directly against the
  issuing bank or crypto rail before accepting the payment.
- **Multi-provider reconciliation** — Binance Pay is *push* (a webhook worker
  detects the payment; the teller claims it against a pending record).
  BDV, Sofitasa, and Bancamiga are *pull* (the teller queries the bank's
  own statement/history API; the record is born already verified).
- **Admin dashboard** — global audit view across branches and providers,
  transaction history, manual voids, and calendar/CSV exports.
- **Balance monitoring** — a daily cron job (`/api/cron/saldos`) snapshots
  account balances across providers and companies, feeding an Excel report
  that mirrors the business's existing accounting sheet format.
- **Kill switch** — a single `configuracion_sistema` flag, cached in memory
  with a short TTL, that can halt every payment endpoint across every branch
  instantly during an incident.

## Tech stack

- **Framework:** Next.js 16 (App Router), React 19, TypeScript
- **Database:** Postgres (Neon serverless driver), plain SQL migrations
- **AI:** Google Gemini for receipt OCR
- **Reporting:** ExcelJS for generated balance/audit reports
- **Testing:** Node's built-in test runner (`node --test`)

## Project layout

```
app/
  cajero/            teller UI
  admin/              admin dashboard + Bancamiga tracking view
  api/                payment validation, verification, webhooks, cron
  api-docs/           OpenAPI documentation viewer
  lib/                domain logic: providers, reports, auth, validation
db/migrations/        plain SQL schema migrations
tests/                unit tests for app/lib
scripts/               operational scripts (migrations, schema checks, latency)
```

## Running locally

```bash
npm install
cp .env.example .env.local   # fill in your own dummy or real credentials
npm run db:migrate
npm run dev
```

## Testing

```bash
npm test
```
