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

## Read-only sale simulator

Run **022_sell_simulator.sql after 021**, then restart. Authenticated `POST /api/v1/trades/simulate-sale` uses the existing database cost engines: offshore Compressed FIFO, Thai FIFO and mutual-fund Moving Weighted Average. Returns native-currency before/after quantities, remaining costs, average costs, sold cost and hypothetical profit before fees/taxes/FX. No transactions or portfolio changes are saved and no market providers are called. Ambiguous or missing cost data returns `INCOMPLETE` with null dependent values. See [Frontend sale simulator contract](docs/FRONTEND_SELL_SIMULATOR_GUIDE.md). No new environment variables or PDF reimport are needed.

## Analytics performance and win rate

Run **021_analytics_orders.sql after 020**, then restart. Authenticated `GET /api/v1/trades/analytics/performance` returns daily cash-flow-adjusted approximate returns and a THB benchmark; `/api/v1/trades/analytics/win-rate` returns calendar comparison periods for all four benchmarks. Calculation version 2 includes the first invested day's return using gross buys excluding fees, with a benchmark baseline before that day. The first WEEK/MONTH/YEAR starts at inception and exposes actual/calendar bounds and `isPartialPeriod`; subsequent periods use regular calendar boundaries. Frontend must invalidate old Analytics caches when adopting version 2. Categories include all assets, offshore, Thai stocks and mutual funds. Existing holdings, costs and value-chart contracts remain unchanged. No new SQL after 021, env settings or reimport are needed. See [Frontend Analytics contract, assumptions and provider coverage](docs/FRONTEND_ANALYTICS_GUIDE.md). SET/SET50 historical benchmarks now use TradingView (SET:SET/SET:SET50) with a shared 6-hour range cache; latest indices remain Yahoo. See [Thai benchmark history and Frontend source/cache changes](docs/FRONTEND_THAI_INDEX_HISTORY_GUIDE.md). Runtime uses @mathieuc/tradingview 4.1.0; no extra env, SQL or reimport. Clear old SET/SET50 Analytics client caches when deploying this provider change. Run `node --use-system-ca --env-file=.env scripts/verification/verify-analytics.cjs` for synthetic orders with real providers and no database access.

## Offshore market valuation

Thai stocks and mutual funds now also support includeMarket=true: Yahoo Finance for Thai THB equity quotes and SEC Open API v2 for exact fund-class NAV, with separate thaiStockValuation/mutualFundValuation summaries. Set SEC_API_KEY (one Primary or Secondary key) in Backend .env and restart. Yahoo needs no key. Existing PDF FIFO/Average Cost and offshore Finnhub data stay unchanged; no new SQL or reimport. See [Thai stock and fund Frontend guide](docs/FRONTEND_THAI_STOCK_AND_FUND_MARKET_GUIDE.md). Run node --use-system-ca --env-file=.env scripts/verification/verify-domestic-market.cjs for a read-only provider smoke test; authenticated SEC validation remains pending until a key is configured.

Finnhub supplies quotes, logos and on-demand company news for held offshore USD positions. PDF amounts/costs and Frankfurter USD/THB conversions remain unchanged; no migration or reimport is required.

For trade-history images, `GET /api/v1/trades/holdings?includeClosed=true&includeLogos=true` also decorates closed offshore/Thai stock rows with logos, reusing the existing Finnhub profile cache or SET URL policy. Do not enable includeMarket/includeFx just to get images; quote/news eligibility stays held-only. Transactions remain unchanged and can join these logo fields by instrument identity. See [Frontend closed-stock logo guide](docs/FRONTEND_CLOSED_STOCK_LOGOS_GUIDE.md). No new SQL or env settings are needed.

Offshore logos can also resolve a unique current listing when a PDF contains a former US market (such as QS XNYS → Nasdaq), corroborated by exact USD ticker/security type in the Finnhub catalog and matching profile ticker/currency/exchange. `logo.providerMicCode` and `listingResolution` describe this logo-only resolution; original PDF/holdings MICs and strict price/news checks remain unchanged. Run `node --use-system-ca --env-file=.env scripts/verification/verify-moved-stock-logo.cjs` for real QS metadata, image availability and no-quote/cache checks. The frontend guide includes the observed static2-to-static9 Finnhub image CDN redirect/CSP note.

For personal use, includeLogos=true also supplies deterministic SET image URLs for held Thai THB stocks, with logo.status=UNVERIFIED and fallbackText. No image fetch/proxy or Yahoo session is used. Frontend must fall back to the symbol on image load failure. Offshore Finnhub logos and Thai prices are unchanged. See [Thai logo and Frontend fallback guide](docs/FRONTEND_THAI_STOCK_LOGO_GUIDE.md). Public use rights are not implied; no new SQL or env setting is required.

- GET /api/v1/trades/holdings?includeMarket=true&includeLogos=true&includeFx=true adds existing marketValuation, offshoreValuation and logo fields. source is now FINNHUB.
- GET /api/v1/trades/stocks/:symbol/news?exchange=XNAS&limit=20 adds authenticated held-stock news for the latest seven UTC dates.
- Configure FINNHUB_API_KEY on Backend only. Without it, market-data requests remain advisory with MARKET_DATA_CONFIG_MISSING; historical holdings remain available.
- Per-process shared budget defaults to 60 calls/minute and a 30 calls/second ceiling; optional FINNHUB_CALLS_PER_DAY=0 disables only our application daily cap. Quotes use a 15-minute open-session TTL, an on-demand post-close refresh, then cache until the next scheduled opening (DST/holidays/early closes, 2026-2028 calendar). Logos/news retain 7-day/30-minute caches. A shared US listing catalog (24-hour cache) verifies symbol/MIC/price currency before accepting provider data. XNAS maps only to the known Nasdaq MIC family.
- Public market data is cached across users, never private quantities/costs. Defaults make no network calls. Stale/missing-price states are explicit; quotes are not labelled regular-session or guaranteed real-time. Only unrealized price PnL is calculated, excluding fees/dividends/FX PnL.
- Verify Finnhub/data-publisher display and news rights before production. Multi-instance deployments need a shared limiter/cache or a divided budget.

See [Finnhub setup](docs/FINNHUB_SETUP_GUIDE.md) and [Frontend price/logo/news contract](docs/FRONTEND_OFFSHORE_MARKET_VALUATION_GUIDE.md).

See [Frontend session-aware quote cache](docs/FRONTEND_STOCK_CACHE_GUIDE.md) for cachePolicy, requestedAt, marketSchedule and dynamic expiresAt. Refreshes remain request-driven, not background jobs. A five-minute close-settling window and short retries for old provider timestamps prevent freezing a previous-day quote; unknown calendar dates fall back to the normal TTL. The schedule is not live exchange/holiday/halt detection, and quote session classification remains unknown.

## Mutual-fund AMC logos

`GET /api/v1/trades/holdings?includeLogos=true` now also resolves held THB mutual-fund AMC identities from SEC, matches official member websites through AIMC, and supplies Logo.dev CDN URLs. Configure `SEC_API_KEY` and `LOGO_DEV_PUBLISHABLE_KEY`, then restart. The secret Search API key is not used. Metadata is shared/cached; no PDF costs, NAV, Thai SET logos or offshore Finnhub behavior changes, and no SQL is needed. URLs are `UNVERIFIED`: Frontend must show the fund symbol while loading and on failure. See [Frontend fund-logo guide](docs/FRONTEND_MUTUAL_FUND_LOGO_GUIDE.md). Run `node --use-system-ca --env-file=.env scripts/verification/verify-fund-logos.cjs` for read-only live matching checks.

## Realized profit/loss

Historical charts now normalize Yahoo split/reverse-split events automatically and replay quantities at each effective date, without editing PDFs or current holdings/cost basis. A mismatched US listing can be accepted for charts only when Yahoo and the current Finnhub catalog agree on exact ticker, USD, market and security type. This is not proof of a historical transfer date; unresolved cases stay incomplete. See the historical chart guide for metadata, limits and unsupported corporate actions.

Yahoo historical caches retain raw close precision and per-snapshot adjustment dates, merge known split/reverse-split events across cached intervals, then restore as-traded prices and round only at the API boundary. Short-to-ALL expansions therefore use the same basis as cold ALL, including a cache boundary on the action date. The external contract remains unchanged. Run `node --use-system-ca scripts/verification/verify-history-split-cache.cjs` for real NFLX/SQQQ prices with synthetic orders/FX and per-day graph equality checks; no database access is performed.

For client-side instant range switching, see [Frontend portfolio history state/cache guide](docs/FRONTEND_PORTFOLIO_HISTORY_CACHE_GUIDE.md): cache visited ranges per user, derive shorter views from fresh complete ALL, and invalidate on session/holdings revision/date changes. It includes TTL, request-race protection and acceptance tests; documentation only, not a frontend implementation.

Historical daily asset values are available through authenticated `GET /api/v1/trades/portfolio-history?range=1M` after migration **020**. Daily replay uses effective-date quantities, Yahoo Finance historical offshore/Thai closes, SEC NAV and historical Frankfurter FX; excludes cash and is not a return/profit chart. Current offshore quotes/logos/news remain Finnhub. See [Frontend historical chart contract and limitations](docs/FRONTEND_PORTFOLIO_HISTORY_GUIDE.md). `1D` currently means daily points, not intraday. Run `node --use-system-ca --env-file=.env scripts/verification/verify-portfolio-history.cjs` to test a synthetic mixed portfolio against real providers without database access.

Public historical observations use a bounded, process-local 6-hour range-aware cache: ALL coverage can serve shorter ranges without new provider requests, and extensions fetch only missing date intervals. Portfolio quantities and values are still replayed per authenticated request; no private chart result is shared or persisted. The live verification script checks ALL-to-shorter-range equality and zero additional provider calls.

Historical Yahoo coverage also respects validated `firstTradeDate` metadata for every supported stock/ETF, avoiding pre-history-only HTTP 400 requests when expanding a short range to ALL. Positions expose `historyAvailableFrom`; dates with real holdings but no prices remain gaps, never fabricated zeros. PDF records and cost basis are unchanged. Run `node --use-system-ca scripts/verification/verify-history-availability.cjs` for live SPCX/CRWV short-to-ALL versus cold-ALL checks.

Historical Yahoo/FX budgets now use a bounded FIFO admission queue (up to 65 seconds, 64 waiting admissions) instead of immediately rejecting the 21st cold request at our 20/minute cap. Cached coverage bypasses provider admission. History positions and `fxHistory` expose safe `limitSource`, `reason`, `providerStatus`, `retryAt` and `cacheStatus` metadata, distinguishing our budget from actual upstream 429/421 responses while preserving existing error codes. Provider backoff remains respected; this is not an increased provider quota or a persistent cache. See the historical chart guide for frontend handling and cold-start latency limits.

Authenticated `GET /api/v1/trades/market-indices` returns the latest Yahoo S&P 500, Nasdaq Composite, Dow Jones, SET and SET50 levels, previous-session daily changes, market-local dates and UTC observation times. Public snapshots are shared across users with a 15-minute in-memory TTL, single-flight loading and explicitly labelled bounded stale fallback. No SQL, new keys, portfolio changes or historical benchmark graph is added. See [Frontend market indices guide](docs/FRONTEND_MARKET_INDICES_GUIDE.md). Run `node --use-system-ca scripts/verification/verify-market-indices.cjs` to verify all five real indices and zero extra calls on a repeat request.

For latest-reference position/category/portfolio changes in THB, call holdings with `includeMarket=true&includeFx=true`. New `items[].latestChange` and response `latestChange.portfolio/byAssetType` use current quantities and one FX snapshot on both comparison values, excluding daily FX effects. Partial coverage and mixed dates are explicit; this is not an actual daily portfolio return. No SQL or additional provider calls. See [Frontend latest-change guide](docs/FRONTEND_LATEST_CHANGE_GUIDE.md).

Domestic quotes now also include daily changes with `includeMarket=true`: Thai stocks expose `previousClose`, `previousCloseDate`, `change`, `changePercent`; mutual funds expose `previousNav`, `previousNavDate` alongside `navDate`, `change`, `changePercent`. Values use the existing Yahoo/SEC responses and cache, not new requests; missing baselines are null. See [Frontend Thai/fund guide](docs/FRONTEND_THAI_STOCK_AND_FUND_MARKET_GUIDE.md).

Run migration **019** after 018 to add database-calculated `items[].realizedPnl`, `realizedPnlTotals` and `stockRealizedPnlTotals` to the existing holdings endpoint. Disposed cost and realized profit use historical PDF amounts, before fees/taxes, separately in USD/THB, with the existing asset-specific cost methods. Missing values return null, not zero; totals include closed positions. No reimport or table changes. See [Frontend realized PnL guide](docs/FRONTEND_REALIZED_PNL_GUIDE.md).

## Portfolio display exchange rate

Call `GET /api/v1/trades/holdings?includeFx=true` with a Supabase Bearer token to add a Frankfurter USD/THB reference-rate snapshot (`fx.rate`, `fx.rateDate`) and separate `displayThb` amounts/costs. Every conversion in that response uses the same rate. Original USD and historical PDF THB values remain unchanged; no database migration, reimport, API key or new environment variables are needed. Without `includeFx=true`, holdings keeps its existing contract and does not fetch FX.

`GET /api/v1/trades/exchange-rate` returns the rate alone using the same process-local cache (1-hour TTL, single-flight refresh, bounded stale fallback). These are daily blended reference rates, not real-time Dime bank quotes. Converted remaining cost is not current market value; FX profit/loss is not calculated yet. See [Frontend Frankfurter FX guide](docs/FRONTEND_FRANKFURTER_FX_GUIDE.md) for fields, totals scope, rounding and outage handling.

## Gmail sync preview

Run migration **012** to include already-imported mutual funds in GET /api/v1/trades/holdings: SUB + SWI - RED - SWO units, separately by fund/account. Scope is STOCKS_AND_MUTUAL_FUNDS and fund rows have assetType=MUTUAL_FUND/fundName plus separate switchInUnits/switchOutUnits. Stock rounding remains stock-only. Later migrations 015–018 add cost basis; includeMarket=true now adds offshore USD, Thai THB and fund THB market valuation when provider data is available. No resync/reimport of existing fund records is required. See [Holdings frontend guide](docs/FRONTEND_STOCK_HOLDINGS_GUIDE.md).

Holdings display tolerance: run migration **011** after 010. Residuals within ±0.0000003 shares are shown as CLOSED only when both buy/sell quantities exist, with no excluded special transactions or order-identity collisions in that position. `rawQuantity` and original stored units remain unchanged; `quantity` is the display amount and `roundingAdjusted` records the adjustment. `includeClosed=true` exposes these closed positions for inspection. This is a display estimate, not a verified Dime balance or a change to order deduplication.

Run migration **010_order_level_deduplication.sql** to deduplicate orders across different PDF numbers. Identity includes user/account/asset/type/order ID/effective date; exact financial duplicates are skipped and return duplicateOrders references. Reused identity with changed values returns ORDER_ID_CONFLICT without partial import. Historical exact duplicates are preserved but flagged is_duplicate and excluded from holdings; ambiguous historical variants are reported rather than silently removed. See [Order deduplication](docs/ORDER_DEDUPLICATION_GUIDE.md).

Holdings: run migrations through 018 in order, then call `GET /api/v1/trades/holdings` with the authenticated user's Bearer token. Stocks use BUY minus SELL; mutual funds use SUB + SWI - RED - SWO units, separately by account/market/asset/currency. Closed positions are hidden unless `includeClosed=true`; negative balances and excluded special transactions are flagged rather than silently corrected. Cost basis is provided by asset-specific methods; market prices/NAV and unrealized PnL require `includeMarket=true` and available provider data. See [Frontend holdings](docs/FRONTEND_STOCK_HOLDINGS_GUIDE.md).

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
`node scripts/verification/verify-investment-sql.cjs tmp/cost-basis-validation` runs 007–016 and all SQL
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
