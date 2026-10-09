# Payment Validator

A multi-bank payment verification platform built with Next.js: it validates
incoming payments across a crypto rail (Binance Pay) and three Venezuelan bank
"Pago Móvil" rails (BDV, Sofitasa, Bancamiga), using AI-assisted OCR to read
payment receipts and direct bank API calls to confirm funds actually arrived.

> **Note:** this is a sanitized portfolio copy of a production system. All
> company names, account numbers, and credentials in this repository are
> dummy values — see `.env.example`. The real client/employer is not
> identified here.

## Domain terms

This project's code, UI, and data use Venezuelan payments vocabulary.
Those terms stay in Spanish here too — translating them would be
inaccurate and would break the mapping between this README and the
actual code:

- **Pago Móvil** (Venezuelan instant bank transfer) — the three bank
  rails (BDV, Sofitasa, Bancamiga), as opposed to the Binance Pay
  crypto rail.
- **cédula** (Venezuelan national ID number) — identifies the payer on
  Pago Móvil transactions; stored as `cedula_pagador`.
- **comanda** (internal sale/order number) — the business's own ticket
  number, assigned by the teller when claiming a payment.
- **BCV** (Banco Central de Venezuela, the central bank) — its 4-digit
  bank codes identify the issuing bank; stored as `banco_origen`.
- **IGTF** (Impuesto a las Grandes Transacciones Financieras — a tax on
  large and foreign-currency financial transactions) — part of the
  real-world reason businesses route some payments through a crypto
  rail instead of a bank transfer.

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

## Database column glossary

`db/migrations/` mixes Spanish domain terms with English, added by
different people over different years. Renaming columns on a running
production database carries real migration risk and cost for no
functional gain, so the names stay as-is here too. Main columns on
`transacciones`:

| Column | Meaning |
| --- | --- |
| `proveedor` | Payment rail: `BINANCE`, `BDV`, `SOFITASA`, or `BANCAMIGA` |
| `moneda` / `monto` | Currency / amount |
| `estado` | `PENDIENTE` (detected, not yet claimed) or `VERIFICADO` (matched to a sale) |
| `anulada` | Voided (e.g. refunded) — excluded from the money totals |
| `comanda` | Internal sale/order number, assigned by the teller |
| `ciudad` | Branch that claimed the payment (`NULL` = unclaimed) |
| `pagador` | Payer's name, as reported by Binance |
| `cedula_pagador` | Payer's cédula/RIF (Pago Móvil only) |
| `banco_origen` | 4-digit BCV code of the issuing bank |
| `referencia` | Bank reference number (Pago Móvil only) |
| `fecha_pago` | When the payment actually happened, per the bank/rail |
| `fecha_cajero` | When the teller claimed/submitted it |
| `fecha_validacion` | When the system confirmed it against the bank |
| `created_at` | When the row was inserted (used to audit detection lag) |
| `nota` | Free-text note left by an admin |

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
