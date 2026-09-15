# Team 11 Transport & Parking API — Assignment 3: Data and Query Design

Cloudflare Workers + Hono + **Cloudflare D1** implementation of the Team 11 PRD data model
(routes, stops, vehicles, parking zones, availability, alerts; journeys computed, never stored).

- Live: https://team11-transport-parking.kanthiphs.workers.dev
- Report: `A3-Team11-Data-and-Query-Design.md` / `.pdf`
- Schema + seed: `migrations/` (applied with `wrangler d1 migrations apply … --remote`)
- ER diagram: `evidence/erd.png` (`evidence/erd.mmd` Mermaid source)
- Demo of every endpoint against production: `bash scripts/api-demo.sh` → `evidence/api-demo-<ts>.txt`

```bash
npm ci
npx wrangler d1 migrations apply team11-transport-parking --remote
npx wrangler deploy
```
Secrets: `OPERATOR_TOKEN`, `DISPATCHER_TOKEN` (`wrangler secret put`), mirrored in a local `.dev.vars` for the demo script.
