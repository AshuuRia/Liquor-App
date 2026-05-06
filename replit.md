# Liquor Inventory System

A web app for Michigan liquor inventory workflows: auto-loads the Michigan LARA price book, supports barcode scanning to build label sessions, price comparison against register exports, and generates Brother QL-820NWB label HTML for printing.

## Run & Operate

- **Dev**: `npm run dev` (runs on port 5000)
- **Build**: `npm run build`
- **Start (prod)**: `npm start`
- **DB push**: `npm run db:push`
- **Required env vars**: `DATABASE_URL` (Replit PostgreSQL)

## Stack

- **Runtime**: Node.js 20
- **Backend**: Express + TypeScript via `tsx`
- **Frontend**: React 18 + Wouter + Tailwind CSS + Radix UI
- **ORM**: Drizzle ORM with Neon serverless PostgreSQL adapter
- **Build**: Vite (client) + esbuild (server)
- **File uploads**: multer
- **Data parsing**: xlsx + custom TSV parser

## Where things live

- `server/index.ts` — Express entry point
- `server/routes.ts` — All API endpoints
- `server/storage.ts` — Data access layer (DB or in-memory fallback)
- `server/db.ts` — Drizzle + Neon pool setup
- `server/vite.ts` — Vite dev middleware + static serving
- `shared/schema.ts` — Drizzle table definitions + Zod schemas (source of truth)
- `client/src/App.tsx` — React routes (`/`, `/scanner`, `/price-compare`)
- `client/src/pages/` — Page components
- `vite.config.ts` — Vite config with `@`, `@shared`, `@assets` aliases

## Architecture decisions

- Liquor records are kept **in-memory** and reloaded on each upload or auto-fetch from michigan.gov; sessions/scans/mappings persist in Postgres.
- `DatabaseStorage` is used when `DATABASE_URL` is set; falls back to `MemStorage` otherwise.
- Vite runs in middleware mode during development (same Express server serves API + frontend).
- Data is auto-fetched from Michigan LARA public URL on startup.

## Product

- Auto-loads 13,899+ Michigan liquor records from the state website on startup
- Barcode scanner page: scan UPCs via camera, build label sessions, resolve duplicates
- Price compare page: upload register CSV, compare vs Michigan shelf prices, export P-touch CSV
- Label generation: produces Brother QL-820NWB print-ready HTML
- Custom UPC→name mappings uploadable per session

## User preferences

_Populate as you build_

## Gotchas

- `tsx` must be invoked via `npx tsx` in the dev script (not bare `tsx`) to ensure it resolves from node_modules
- Michigan LARA price book URL changes monthly — the fetch logic targets a specific rev hash
- `DATABASE_URL` must be set before starting; the server throws immediately if missing

## Pointers

- Drizzle schema: `shared/schema.ts`
- Michigan data fetch endpoint: `POST /api/fetch-liquor-data` in `server/routes.ts`
