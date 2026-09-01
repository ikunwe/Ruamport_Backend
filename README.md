# PortfolioManage Backend

Express REST API for the Smart Portfolio Tracker described in the frontend README.

## Run locally

Requires Node.js 18 or newer.

```bash
copy .env.example .env
npm run dev
```

The first endpoint is `GET http://localhost:3000/api/v1/health`.

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

## Scripts

- `npm run dev` — start with Node watch mode
- `npm start` — start normally
- `npm test` — run the Node test suite
