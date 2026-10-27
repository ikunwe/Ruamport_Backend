# Sale simulator — Frontend contract

## Setup and scope

Run `supabase/migrations/022_sell_simulator.sql` in Supabase SQL Editor **after migration 021**, then restart Backend. This adds a read-only RPC, not tables or saved simulations. No new `.env` settings or reimport are needed. The migration is supplied with this change; it has not been applied to your live Supabase database.

`POST /api/v1/trades/simulate-sale` requires `Authorization: Bearer <access_token>` and `Content-Type: application/json`. Responses use `Cache-Control: no-store`. POST carries the calculation inputs; it does not submit an order or save a transaction. All financial data comes from the authenticated owner's imported portfolio. Frontend must not send `userId`, costs or calculated results.

The endpoint reuses the existing database engines:

| Asset | Method | Currency | Purchase basis |
| --- | --- | --- | --- |
| OFFSHORE_STOCK | COMPRESSED_FIFO | USD | PDF grossAmount.foreign, daily compressed buy lots |
| THAI_STOCK | FIFO | THB | PDF grossAmount, original transaction lots |
| MUTUAL_FUND | MOVING_WEIGHTED_AVERAGE | THB | PDF investment amount via existing fund cost engine |

Fees, VAT, taxes and FX are excluded. This endpoint does not fetch prices, NAV, news or logos. Existing holdings/providers remain unchanged. A hypothetical future date does not forecast prices, trades or corporate actions.

## Request

Copy the exact identity from the selected holding. Account numbers are strings, preserving leading zeros. All nine fields are required, including explicit nulls for unknown account/exchange. Do not combine accounts or replace the PDF market with a provider's current listing.

```json
{
  "assetType": "OFFSHORE_STOCK",
  "accountNumber": "SIM-A",
  "symbol": "SIMOS",
  "exchange": "XNAS",
  "currency": "USD",
  "action": "SELL",
  "quantity": 10,
  "price": 40,
  "tradeDate": "2026-10-27"
}
```

This is a synthetic example. Use today's Thai date or a future date up to 365 days ahead. The date must also be on/after the position's latest imported trade. This is a sale from the **current imported position**, not historical replay. Only HELD positions with positive quantities qualify; quantity cannot exceed the displayed holding quantity.

`quantity` and `price` must be positive finite JSON numbers, at most 1,000,000,000 each and at most 12 decimal places. Their product must not exceed 1,000,000,000,000. Price means hypothetical gross sale price per share/unit. Funds require `exchange: null`; use native THB for Thai stocks/funds and USD for offshore stocks. Unknown properties are rejected.

Optional `expectedSnapshotRevision` accepts the revision from an earlier simulation response. Omit it on the first request; subsequent requests can send it to detect portfolio changes.

## Response

Selected fields from the tested Compressed FIFO fixture:

```json
{
  "action": "SELL",
  "status": "CALCULATED",
  "isComplete": true,
  "persisted": false,
  "assetType": "OFFSHORE_STOCK",
  "accountNumber": "SIM-A",
  "symbol": "SIMOS",
  "exchange": "XNAS",
  "currency": "USD",
  "method": "COMPRESSED_FIFO",
  "tradeDate": "2026-10-27",
  "quantity": 10,
  "price": 40,
  "before": {
    "quantity": 25,
    "rawQuantity": 25,
    "remainingCost": 525,
    "averageCostPerUnit": 21,
    "status": "CALCULATED"
  },
  "after": {
    "quantity": 15,
    "rawQuantity": 15,
    "remainingCost": 375,
    "averageCostPerUnit": 25,
    "rawRemainingCost": 375,
    "roundingAdjusted": false,
    "status": "CALCULATED"
  },
  "soldCost": 150,
  "proceeds": 400,
  "realizedPnl": 250,
  "realizedPnlPercent": 166.666667,
  "issues": [],
  "feesIncluded": false,
  "taxesIncluded": false,
  "fxIncluded": false,
  "simulationVersion": 1
}
```

Additional fields always describe the calculation:

- `source`: original holding cost-basis source.
- `calculatedAt`: UTC timestamp from the database statement.
- `snapshot`: `revision` (`sim-v1:` plus 32 hex characters), `scope: IMPORTED_PORTFOLIO`, effective `orderCount`, `positionLastTradeDate`. Treat revision as opaque, not authentication. Any effective imported portfolio change may invalidate it, including another position.
- `assumptions`: `basis: CURRENT_IMPORTED_POSITION`, `orderTiming: NO_INTRADAY_INFERENCE`, `marketPriceSource: USER_INPUT`, `historicalReplay: false`, `futureTradesAndCorporateActionsIncluded: false`.
- `limitations`: `HYPOTHETICAL_ONLY_NOT_A_TRADE_ORDER`, `FEES_TAXES_AND_FX_EXCLUDED`, `NO_MARKET_LOT_OR_MINIMUM_ENFORCEMENT`, `PDF_COST_BASIS_NOT_BROKER_VERIFIED`.

Calculation: proceeds = quantity × price; soldCost = before.remainingCost − after.remainingCost; realizedPnl = proceeds − soldCost; realizedPnlPercent = realizedPnl / soldCost × 100. These are **this hypothetical sale's** results, not accumulated historical realized profit. Never calculate partial FIFO sold cost from the overall average. Costs/amounts round to eight decimal places at the API boundary; percentage to six. A closed position has `averageCostPerUnit: null`.

## Missing data and ambiguity

HTTP 200 with `status: INCOMPLETE`, `isComplete: false` means valid inputs but insufficient cost information. Keep known quantity/proceeds visible; display `—` for null soldCost, profit and dependent after-cost fields. Never substitute zero or Average Cost for FIFO.

The existing engines retain their rules: same-day BUY plus SELL can return `INTRADAY_ORDER_AMBIGUOUS`; cutting across different-price same-day Thai purchase lots can return `INTRADAY_BUY_ORDER_AMBIGUOUS`. Missing amounts, unsupported movements and conflicting orders remain explicit issues. The simulator does not invent intraday order, including when today's imported purchase and hypothetical sale share a date.

Stock dust tolerance remains ±0.0000003 shares under the existing engine's eligibility rules. `after.quantity`/cost can close to zero while `rawQuantity` and `rawRemainingCost` preserve residuals; inspect `roundingAdjusted` and issues. Funds do not use this stock tolerance. A zero soldCost can produce null profit percentage with `ZERO_SOLD_COST_PERCENT_UNDEFINED`, while other amounts remain calculated.

## Errors

Standard body: `{ "error": { "code": "...", "message": "..." } }`.

| HTTP | Code | Frontend action |
| --- | --- | --- |
| 400 | INVALID_SIMULATION_REQUEST | Check identity, input types, date and bounds |
| 401 | Existing authentication error | Restore session/sign in |
| 404 | SIMULATION_POSITION_NOT_FOUND | Refresh holdings; identity must match exactly |
| 409 | SIMULATION_POSITION_NOT_HELD | Position is closed/unavailable; refresh |
| 409 | SIMULATION_SNAPSHOT_CHANGED | Refresh holdings, discard old result/revision, simulate again |
| 409 | SIMULATION_DATE_BEFORE_SNAPSHOT | Choose a date on/after the last imported trade |
| 422 | SIMULATION_QUANTITY_EXCEEDED | Reduce quantity to the current held amount |
| 422 | SIMULATION_ORDER_LIMIT_EXCEEDED | Portfolio exceeds 20,000 effective imported orders |
| 503 | INVESTMENT_STORAGE_UNAVAILABLE / SIMULATION_UNAVAILABLE | Check migration 022/database; provide retry |

## Frontend flow

1. Load existing holdings for identity, native cost and optional market price. Let users enter a price if no provider price is available.
2. On selection/input change, validate locally and debounce simulation requests. Cancel superseded requests and ignore late responses using a request identifier. Do not poll providers while typing.
3. The first simulation returns authoritative `before` values and a revision from one database statement snapshot. Render its result together; do not mix it with older holding costs. Carry its revision on subsequent requests.
4. Keep drafts/results only in page memory per user and full holding identity. Do not persist private simulations to browser storage. Clear results/revisions on logout/user switch, import/deletion/portfolio refresh, asset change or date rollover; refresh holdings before retrying a snapshot conflict.
5. Label the result as a hypothetical sale before fees/taxes/FX, using response currency/method. Show `issues` as explanations; incomplete values stay null. This result must not update the real Dashboard/holdings or invoke import/save endpoints.

## Verification

`node --test test/sell-simulator.test.js` verifies request validation, authentication, owner-scoped RPC, no-store, errors and no market-provider calls. `node scripts/verification/verify-investment-sql.cjs tmp/cost-basis-validation` applies migrations in isolated PGlite and runs SQL fixtures for all three cost engines, partial/full sales, ambiguity, snapshot changes, ownership and unchanged database/holdings. No live user portfolio is read or changed by these tests.
