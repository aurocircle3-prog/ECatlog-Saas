# Wholesale Reseller SaaS (MVP)

A separate catalog SaaS with three roles: **Admin** (platform owner), **Wholesaler**, and **Reseller**. Built with the same lightweight stack as catalogpro (Express + lowdb + JWT), so it runs locally with no external services.

## Run it

```bash
cd wholesale-reseller-saas
npm install
npm start
```

Server starts on `http://localhost:4000` (override with `PORT` env var). On first run it seeds an admin user:

- **userId:** `admin`
- **password:** `admin123`

## How the flow works

1. **Wholesaler** registers at `/api/register` (`role: "wholesaler"`) — auto-approved, no gate. Response includes a `signupLink` like `/w/<slug>/signup`. Share that link with resellers.
2. Wholesaler does manual entry (`POST /api/catalogs/:id/products`) or CSV/XLSX upload (`POST /api/catalogs/:id/upload-csv`) into their catalog. CSV columns: `itemNo*`, `productName`, `salePrice*`, `category`, `minQty`, `unit`, `description`, `description2`, `filter1/2/3`, `tag1/2` — **no discounted price column**, wholesalers only set one selling price.
3. **Reseller** registers via the wholesaler's link (`role: "reseller"`, `wholesalerSlug: "<slug>"`). Account starts `status: "pending"` and is blocked from building a catalog.
4. Wholesaler approves/rejects from `PUT /api/wholesaler/resellers/:id/approve` (or `/reject`).
5. Once approved, the reseller browses the linked wholesaler's items (`GET /api/reseller/wholesaler-items`, read-only) and adds them to their own catalog with a margin % and discount %:
   - `discPrice (final price) = wholesalerPrice * (1 + margin/100)`
   - `salePrice (crossed-out MRP) = discPrice / (1 - discount/100)` if discount > 0, else equal to discPrice.
   - Example: wholesaler price 100, margin 50% → discPrice 150; discount 20% → salePrice 187.50.
6. Reseller publishes their catalog publicly at `/catalog/:resellerId/:catalogSlug` (same UI styling as catalogpro). End customers place orders via `POST /api/orders` — visible only to that reseller.
7. Reseller can forward a received order to their wholesaler (`POST /api/orders/:id/forward-to-wholesaler`), which creates a `wholesaleOrders` record using the *original wholesaler item prices* (not the reseller's marked-up prices) and marks the order as forwarded so it can't be forwarded twice.
8. Wholesaler views these B2B orders at `GET /api/wholesaler/wholesale-orders`.
9. **Admin** can list all wholesalers/resellers via `/api/admin/wholesalers` and `/api/admin/resellers`.

## Smoke-tested end to end

Verified manually with curl: wholesaler registration → CSV upload (3 items, no discPrice) → reseller registration via slug → blocked while pending → approval → reseller adds item with margin=50/discount=20 on a ₹100 item → got `discPrice=150`, `salePrice=187.5` (matches formula exactly) → public catalog shows computed prices → order placed → forwarded to wholesaler with original ₹100 price (not ₹150) → double-forward correctly rejected.

## Known v2 TODOs

- No image upload UI (image filenames are stored, but no file upload endpoint wired into this MVP's frontend)
- No payments/billing, plan tiers, or usage limits
- No custom domains for wholesalers (slug-based link only, by design for v1)
- No email verification / password reset flows
- Reseller is tied to exactly one wholesaler (by design — confirmed scope)
- No PDF/Excel export, no order email notifications
