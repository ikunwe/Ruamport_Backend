# PortfolioManage Backend

Express REST API for the Smart Portfolio Tracker described in the frontend README.

## Run locally

Requires Node.js 24 or newer (the PDF reader and built-in environment-file support use a modern Node runtime).

The dev/start scripts enable `--use-system-ca` so HTTPS also trusts the operating system certificate store; certificate verification remains enabled.

```bash
copy .env.example .env
npm run dev
```

The first endpoint is `GET http://localhost:3000/api/v1/health`.

## Portfolio display exchange rate

Call `GET /api/v1/trades/holdings?includeFx=true` with a Supabase Bearer token to add a Frankfurter USD/THB reference-rate snapshot (`fx.rate`, `fx.rateDate`) and separate `displayThb` amounts/costs. Every conversion in that response uses the same rate. Original USD and historical PDF THB values remain unchanged; no database migration, reimport, API key or new environment variables are needed. Without `includeFx=true`, holdings keeps its existing contract and does not fetch FX.

`GET /api/v1/trades/exchange-rate` returns the rate alone using the same process-local cache (1-hour TTL, single-flight refresh, bounded stale fallback). These are daily blended reference rates, not real-time Dime bank quotes. Converted remaining cost is not current market value; FX profit/loss is not calculated yet. See [Frontend Frankfurter FX guide](docs/FRONTEND_FRANKFURTER_FX_GUIDE.md) for fields, totals scope, rounding and outage handling.

## Gmail sync preview

Run migration **012** to include already-imported mutual funds in GET /api/v1/trades/holdings: SUB + SWI - RED - SWO units, separately by fund/account. Scope is now STOCKS_AND_MUTUAL_FUNDS and fund rows have assetType=MUTUAL_FUND/fundName plus separate switchInUnits/switchOutUnits. Stock rounding remains stock-only; no NAV/cost/current value is computed. No resync/reimport of existing fund records is required. See [Holdings frontend guide](docs/FRONTEND_STOCK_HOLDINGS_GUIDE.md).

Holdings display tolerance: run migration **011** after 010. Residuals within ±0.0000003 shares are shown as CLOSED only when both buy/sell quantities exist, with no excluded special transactions or order-identity collisions in that position. `rawQuantity` and original stored units remain unchanged; `quantity` is the display amount and `roundingAdjusted` records the adjustment. `includeClosed=true` exposes these closed positions for inspection. This is a display estimate, not a verified Dime balance or a change to order deduplication.

Run migration **010_order_level_deduplication.sql** to deduplicate orders across different PDF numbers. Identity includes user/account/asset/type/order ID/effective date; exact financial duplicates are skipped and return duplicateOrders references. Reused identity with changed values returns ORDER_ID_CONFLICT without partial import. Historical exact duplicates are preserved but flagged is_duplicate and excluded from holdings; ambiguous historical variants are reported rather than silently removed. See [Order deduplication](docs/ORDER_DEDUPLICATION_GUIDE.md).

Holdings: run migrations 009–012 in order, then call `GET /api/v1/trades/holdings` with the authenticated user's Bearer token. Stocks use BUY minus SELL; mutual funds use SUB + SWI - RED - SWO units, separately by account/market/asset/currency. Closed positions are hidden unless `includeClosed=true`; negative balances and excluded special transactions are flagged rather than silently corrected. No cost or current market prices/NAV are calculated yet. See [Frontend holdings](docs/FRONTEND_STOCK_HOLDINGS_GUIDE.md).

Monthly attachments with recognizable Dime monthly-statement filenames are deferred before download/decryption and remembered as IGNORED, so a wrong/missing PDF password does not surface them in preview results. Generic renamed files still need content classification after successful decryption; confirmation password errors remain retryable. This does not store raw Monthly PDFs or enable Monthly ingestion.

Repeat sync returns no old preview payload for ALREADY_READ/ALREADY_IMPORTED. Only READY contains a new preview; cached pending documents remain accessible through GET /trades/documents/:id. Frontend must clear prior preview cards on a fresh sync, follow all pages, and use syncStatus=NO_NEW_DATA (noNewData=true) to show the empty-new-data state. Failures produce COMPLETED_WITH_ERRORS rather than incorrectly claiming there is no new data. Attachment identity/hash/document-number checks are used instead of filenames alone.

**Migration 008** changes import validation to advisory warnings: explicit confirmation can import documents with mismatched totals. UI must use `record.canImport`, not `validation.isValid`, to enable import. PDF summary/display remain unchanged; `calculation.investmentTotals` stores separate THB order-derived totals. Total-mismatch warnings include calculatedValue/pdfValue/difference and blocking=false. Ownership, document identity, structural DB constraints and idempotent atomic import still apply.

Run **migration 007** before using upload/sync with document history. See [Investment import and PDF history](docs/FRONTEND_INVESTMENT_IMPORT_GUIDE.md) for the frontend flow: parsed previews are now persisted as PREVIEW; POST /api/v1/trades/import confirms investment transactions. GET /api/v1/trades/documents, /documents/:id and /transactions expose the authenticated user's stored data. Repeated Gmail attachments return ALREADY_READ or ALREADY_IMPORTED without reparsing. Hash and document-identity dedup also cover uploads and other emails. Import is idempotent and atomic per document via SQL RPC, never from client-supplied trade data. Raw PDFs/passwords remain unstored.

Gmail mail-read consent is separate from Supabase login. Connect once, then manually scan all available Dime PDF email history by default (`months: "all"`); the previous 1/2-month filters remain supported. Results are paginated: Frontend must follow `nextCursor` until `hasMore` is false. Each response returns per-batch `foundPdfCount` and cumulative `progress` for loading text; an exact total is only available after all pages have been scanned without unreadable messages. This is preview-only without saving investments. Outlook mail sync is not implemented yet.

- `GET /api/v1/mail/connection`
- `POST /api/v1/mail/gmail/connect`
- `GET /api/v1/mail/gmail/callback` — Google redirect only
- `POST /api/v1/mail/gmail/sync-preview`
- `DELETE /api/v1/mail/gmail/connection`

Run migration `006_gmail_preview_connections.sql`, configure the Gmail variables in `.env.example`, enable Gmail API and register the backend OAuth callback in Google Cloud before testing with real mail. All mail endpoints except the callback require a Supabase Bearer token.

See [Frontend mail-sync flow and setup](docs/FRONTEND_MAIL_SYNC_PREVIEW_GUIDE.md) for request/response, password retry, pagination and limits.

Set `CORS_ORIGINS` to the comma-separated list of Angular origins allowed to call the API. Development defaults to `http://localhost:4200`.

```env
CORS_ORIGINS=http://localhost:4200,https://app.example.com
```

## Authentication API

- `POST /api/v1/auth/login-username` — exchange a username and password for a Supabase session
- `GET /api/v1/auth/me` — return the profile, username-login status, and ingestion channel selected from the email domain
- `PATCH /api/v1/auth/credentials` — update the username and/or set a password through one authenticated endpoint

First-time users authenticate with Google, Apple, or Facebook through Supabase. Their initial username comes from the provider full name, while password login remains disabled until they set a password through `/auth/credentials`. The same endpoint updates the username or password later. Separately, `/auth/me` chooses Gmail API, Microsoft Graph, or direct PDF upload from the authenticated email domain. Run the SQL files in `supabase/migrations` in numeric order before using these endpoints.

Supabase setup required for authentication:

- enable Google, Apple, and Facebook providers and require the email scope
- configure development and production Site/Redirect URLs
- run every SQL migration in numeric order
- keep the service-role/secret key on the Backend only
- configure custom SMTP before enabling production password recovery
- review Auth rate limits and enable CAPTCHA before public launch

Example ingestion route returned by `/auth/me`:

```json
{
  "emailDomain": "gmail.com",
  "channel": "GMAIL_API",
  "connectionProvider": "GOOGLE",
  "requiresMailConnection": true,
  "nextAction": "CONNECT_GOOGLE_MAIL"
}
```

### Authentication errors

API errors use a stable `error.code` for the Frontend:

| HTTP | Code | Meaning |
|---:|---|---|
| 400 | `INVALID_USERNAME` | Username format is invalid |
| 400 | `INVALID_PASSWORD` | Password format is invalid |
| 400 | `PASSWORD_REQUIRED` | Login password was not supplied |
| 400 | `VALIDATION_ERROR` | No credential field was supplied |
| 401 | `INVALID_CREDENTIALS` | Username does not exist or password is incorrect |
| 401 | `UNAUTHORIZED` | Bearer token is missing, invalid, or expired |
| 404 | `PROFILE_NOT_FOUND` | The authenticated account has no profile row |
| 409 | `USERNAME_TAKEN` | Another profile already uses that username |

Login deliberately returns the same `INVALID_CREDENTIALS` response for an unknown username and an incorrect password. This prevents account enumeration; the UI should display “Username or password is incorrect.”

Password length rules apply when setting or changing a password, not when attempting login. Any non-empty but incorrect login password returns `401 INVALID_CREDENTIALS`.

## PDF ingestion preview

Only offshore stock (`DIMEOS`), Thai stock (`DIMETH`) and mutual fund (`DIMEMF`) confirmations are routed to parsers. A generic `Confirmation Note` heading is not sufficient to classify a PDF as offshore. Recognized unsupported products such as Dime Gold are omitted from Gmail preview results without an error item; uploading an unsupported document directly returns `422 DIME_DOCUMENT_UNSUPPORTED`. Classification uses extracted content, not the filename, and password-protected files need the correct password first. Supported confirmations with parser errors still return per-file errors for investigation.

`POST /api/v1/trades/upload-preview` accepts one PDF in memory, supports password-protected Dime PDFs, and auto-detects offshore stock, Thai stock and mutual fund confirmation notes. It returns structured trade preview data without writing a transaction or storing the file. Monthly statements are temporarily disabled: upload returns HTTP 422 with `DIME_MONTHLY_TEMPORARILY_DISABLED`, while Gmail sync omits recognized monthly files from `results` entirely and continues with other files. Encrypted PDFs need a valid password before their content can be classified. The monthly parser is retained for future development.

Send `multipart/form-data` with:

- `file` — required PDF, maximum 10 MB
- `pdfPassword` — optional password for an encrypted Dime PDF

The endpoint requires a Supabase Bearer access token. The password, PDF, and raw extracted text are not persisted or returned. Parsed preview data is persisted and returned with a document record; investment transactions are created only after explicit /trades/import confirmation. Run migration 007 first.

Offshore confirmations return `display` amounts based on the PDF's stated net fee (plus stated VAT/tax for combined totals), separately from the existing independent `calculation`. UI must use `display` and preserve missing values as null. `FEE_AFTER_DISCOUNT_MISMATCH` is retained in `diagnostics.validation` for developer inspection, not public `validation.warnings`; other validation warnings remain visible. These diagnostics are returned and persisted with the document's parsed preview after migration 007. Thai stock and mutual fund summaries remain unchanged. See the frontend guides for the updated field contract.

## Project structure

```text
src/
├── app.js                  # Builds and configures the Express app
├── server.js               # Starts HTTP server and handles shutdown
├── config/                 # Environment and external-client configuration
├── middlewares/            # Cross-cutting HTTP middleware
├── modules/                # Feature modules (route/controller/service/repository)
│   └── health/
├── routes/                 # Top-level API route composition
├── shared/                 # Reusable errors, helpers, constants and types
└── integrations/           # Supabase and market/FX data providers
test/                       # Automated tests
```

## Planned feature modules

Build features vertically so each module owns its HTTP, business, and data-access code:

- `accounts` — investment accounts, cash balances, and currencies
- `transactions` — buy, sell, deposit, withdrawal, dividend, and fee events
- `holdings` — positions, cost basis, weights, and asset/sector allocation
- `portfolio` — net worth and consolidated overview
- `analytics` — daily, realized, unrealized, and FX profit/loss calculations
- `market-data` — quotes, benchmarks, metadata, and exchange rates
- `simulations` — forecasts and benchmark comparisons

A feature should normally follow this shape:

```text
modules/holdings/
├── holdings.routes.js
├── holdings.controller.js
├── holdings.service.js
├── holdings.repository.js
└── holdings.schema.js
```

Controllers translate HTTP input/output, services contain portfolio rules, repositories access Supabase, and schemas validate request data. External APIs belong under `integrations/` so providers can be swapped without changing portfolio logic.

## Historical monetary totals for holdings

Run `supabase/migrations/013_holdings_money_totals.sql` after migrations 007–012.
`GET /api/v1/trades/holdings` now adds per-asset `amounts` and portfolio `moneyTotals`
by currency (native offshore currency and historical PDF THB). Only imported,
nonduplicate supported orders are included. Overall totals include closed positions
even when those positions are hidden from `items`. Missing monetary amounts remain
null; switch amounts are separate from subscriptions/redemptions. These totals are
not remaining cost, current market value, live FX conversion, or profit.
See [Frontend monetary totals guide](docs/FRONTEND_HOLDINGS_MONEY_GUIDE.md).
The development SQL test is `test/holdings-money.integration.sql`; it requires a
PostgreSQL/Supabase development database and rolls back its synthetic records.

Run `supabase/migrations/014_holdings_gross_and_fees.sql` after 013 to add
`totalBuyGross`/`totalSellGross` from stored PDF gross amounts, buy/sell/switch
VAT-inclusive fees, and separate completeness indicators in each monetary row.
Legacy payment totals are unchanged. `stockMoneyTotals` aggregates stocks only;
`moneyTotals` still includes funds, whose missing gross amounts remain null.
Offshore amounts retain native currency and PDF THB; no live FX is fabricated.
Document-level discounts are not allocated (`documentDiscountsApplied: false`).
SQL checks: `test/holdings-gross-fees.integration.sql` (development DB, rollback).

Run `supabase/migrations/015_holdings_average_cost.sql` after 014 for moving
weighted-average cost excluding fees, using historical gross amounts separately
in native offshore currency and THB. The same endpoint adds `items[].costBasis`,
`remainingCostTotals`, and stock-only `stockRemainingCostTotals`. Sales reduce cost
at the prior average, not at sale proceeds. Missing buy gross, oversales, special
transactions, collisions, or mixed buys/sells on a date with no intraday ordering
return explicit incomplete status instead of fabricated costs. Raw rounding
residuals remain visible. No stored transactions or tables are changed.
See [Frontend cost basis guide](docs/FRONTEND_HOLDINGS_COST_BASIS_GUIDE.md).
SQL checks: `test/holdings-average-cost.integration.sql` (development DB, rollback).

**Latest: run `supabase/migrations/016_offshore_compressed_fifo.sql` after 015.**
Only offshore-stock cost now uses Compressed FIFO: merge BUY units/gross by the
stored trade date, then consume oldest daily lots first. Thai stocks and funds
keep the existing moving-average behavior/limitations. Parsed values, fees,
deduplication and raw transactions are unchanged. Native offshore currency and
historical PDF THB are calculated independently without FX conversion.
`costBasisMethod` is now `BY_ASSET_TYPE`; each item and cost currency row identifies
its own method. Remaining-cost field names and total scopes are unchanged.
See [Frontend offshore Compressed FIFO guide](docs/FRONTEND_OFFSHORE_COMPRESSED_FIFO_GUIDE.md).
SQL checks: `test/holdings-compressed-fifo.integration.sql`.
`node verify-investment-sql.cjs tmp/cost-basis-validation` runs 007–016 and all SQL
checks in an optional isolated PGlite runtime, without production credentials.

**Latest: run `supabase/migrations/017_thai_fifo_cost.sql` after 016.** Cost methods
are offshore stocks = `COMPRESSED_FIFO`, Thai stocks = `FIFO` (individual purchase
lots, not compressed days), mutual funds = `MOVING_WEIGHTED_AVERAGE` (Average Cost).
All use existing gross amounts excluding fees. No parser, transaction, schema
column, FX or holdings-quantity changes. Unknown intraday ordering at a partially
consumed Thai multi-price purchase day returns an explicit incomplete status.
Funds with missing gross or unsupported switches remain incomplete as before.
See [Current frontend cost methods](docs/FRONTEND_ASSET_COST_METHODS_GUIDE.md).
SQL checks: `test/holdings-asset-cost-methods.integration.sql`; the optional SQL
runner now applies 007–017 and runs eight isolated SQL suites.

**Latest: run `supabase/migrations/018_mutual_fund_average_cost.sql` after 017.**
Fund Average Cost now uses the existing per-order PDF `details.totalAmount` as
the unit-investment amount, with the separately reported fee excluded (no second
fee subtraction). This is read-only normalization for SUB/RED; raw previews,
transactions and dedup signatures remain unchanged, so existing imports work
without resync/reimport. Stocks retain their 016/017 methods. The same holdings
endpoint returns fund average cost/unit and remaining cost in THB with explicit
source metadata. Unsupported switches, unknown ordering or missing amounts remain
incomplete rather than fabricated. See [Frontend fund cost guide](docs/FRONTEND_MUTUAL_FUND_AVERAGE_COST_GUIDE.md).
SQL checks: `test/holdings-mutual-fund-average-cost.integration.sql`; the optional
SQL runner now applies 007–018 and runs nine isolated suites in memory.

## Scripts

- `npm run dev` — start with Node watch mode
- `npm start` — start normally
- `npm test` — run the Node test suite
