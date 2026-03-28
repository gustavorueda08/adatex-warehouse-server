# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> The parent `../CLAUDE.md` covers the full system overview, environment variables, and cross-repo data flow. Read it first. This file focuses on Strapi-specific implementation patterns inside this repo.

## Commands

```bash
npm run dev      # Strapi develop with hot-reload (use for all development)
npm run build    # Build admin panel (required before production start)
npm run start    # Production — no hot-reload

# Manual integration scripts (run from repo root, not src/)
node scripts/run-test.js
node scripts/test-autocut.js
node scripts/verify-dashboard-stats.js
```

No automated test suite — validation is done via the scripts above and manual API calls.

## Architecture

### Module layout

Each API module under `src/api/<name>/` follows Strapi 5 convention:
- `content-types/` — JSON schema (fields, relations)
- `controllers/` — HTTP layer: parse `ctx`, call service, map errors to HTTP codes
- `services/` — Business logic; always call via `strapi.service(UID)` using the constant from `src/utils/services.js`
- `routes/` — `custom-<name>-routes.js` (loaded first, overrides Strapi defaults) + `<name>.js` (auto-generated find/findOne)

**Custom routes must be named `custom-<name>-routes.js`** (not `01-custom.js`) so they load before the auto-generated route file. The order module uses `custom-order-routes.js`.

### Order lifecycle — the critical module

`order` is the most complex module. Key files:

| File | Purpose |
|------|---------|
| `services/order.js` | Core CRUD + state transitions, wrapped with Zod via `withValidation` |
| `controllers/order.js` | HTTP handlers — reads `ctx.request.body`, delegates to service |
| `strategies/itemMovementStrategies.js` | Strategy pattern for item state changes per order type |
| `utils/orderHelpers.js` | `ORDER_POPULATE`, `ORDER_POPULATE_BASIC`, `generateOrderNumber`, `syncOrderProducts` |
| `utils/invoiceHelpers.js` | Siigo invoice emission logic for `sale` and `partial-invoice` orders |

**Item movement strategies** — when an order transitions to `completed`, `ItemMovementStrategyFactory.getStrategy(type)` picks the right class:
- `PurchaseInStrategy` — creates items with `state: available` in `destinationWarehouse`
- `SaleOutStrategy` — marks items `dropped`
- `TransferStrategy` — moves items (new warehouse, keeps `available`)
- `NationalizationStrategy extends TransferStrategy` — same as transfer; items end up `available` in the destination warehouse (NOT `dropped`)
- `ReturnStrategy`, `TransformStrategy`, etc.

This matters when querying "has this item been nationalized?": check `item.warehouse.id !== sourceWarehouse.id`, not `item.state === "dropped"`.

### Validation layer

Service methods are wrapped with `withValidation(ZodSchema, handler)` from `src/validation/withValidation.js`. Schemas live in `src/validation/schemas.js`. If validation fails, an `Error` is thrown with pipe-delimited field messages — the controller maps this to a 500. To return a 400, catch and throw `new ApplicationError(msg)` instead.

### Utility constants

Always import from `src/utils/` — never inline strings:

| File | Exports |
|------|---------|
| `services.js` | Service UIDs (`ORDER_SERVICE`, `ITEM_SERVICE`, etc.) |
| `orderTypes.js` | `ORDER_TYPES` (sale, purchase, transfer, return, nationalization, …) |
| `orderStates.js` | `ORDER_STATES` (draft, confirmed, processing, completed, cancelled) |
| `itemStates.js` | `ITEM_STATES` (available, reserved, dropped, …) |
| `warehouseTypes.js` | `WAREHOUSE_TYPES` (stock, freeTradeZone, …) |
| `itemMovementTypes.js` | Movement type constants |
| `runInBatches.js` | `runInBatches(ids, asyncFn)` — avoids N+1 in loops |

### Siigo integration

Invoice emission happens in `src/api/order/utils/invoiceHelpers.js` and the `src/api/siigo/` module. Triggered automatically when:
- `order.type === "partial-invoice"`, or
- `order.emitInvoice === true` on a sale order transition to `completed`

`AccountingApi.js` in `src/utils/` is the HTTP client for Siigo's REST API.

### Socket.io

Configured in `src/index.js` bootstrap. Every connection requires a valid Strapi JWT (via `Authorization` header, `auth.token`, or `?token=`). Rooms:
- `user:<id>` — personal room, joined automatically
- `order:<id>` — joined via `socket.emit("join:order", id)` from the frontend

To emit from a service: `strapi.io.to("order:<id>").emit("event", payload)`.

### Cron jobs (`config/cron-tasks.js`)

| Schedule | Task |
|----------|------|
| `0 1 * * *` (1 AM) | `customer.calculateAnalytics()` — updates `currentMonthVolume`, `projectedVolume`, `threeMonthAverage`, `lastPurchaseDate`, `topProducts`, `status` on every customer |
| `0 2 * * *` (2 AM) | `demand-forecast.calculateForecasts()` — statistical demand predictions stored in `demand_forecasts` table |

Customer analytics fields are the source of truth for the frontend `/customers` list page. The Python forecast API (`adatex-forecast-api`) is a separate service used on the customer detail page for per-product Prophet forecasts.
