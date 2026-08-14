# FM 360 Console — Facilio Vibe app

An operations console for facilities managers to act on Facilio records the moment they need attention.

- **Live feed:** each action bucket is a live query against Facilio (no batch copy). The UI smart-polls counts every 30s (visibility-aware) and lazy-loads details for the bucket in view.
- **Immediate write-back:** taking an action writes to Facilio right away and drops the card from the feed.

## Structure
- `src/` — React (Vite) console UI (`@facilio/vibe-sdk`).
- `functions/feed.js` — server function: `counts`, `bucket`, `act`, `unact` (live reads + action write-back).
- `functions/sync_jobs.js` — earlier batch-sync engine (superseded by the live feed).
- `vibe.json` — Vibe app config (app: `fm-360-console`).

## Buckets wired
- **TSR's to acknowledge** — Service Requests, `moduleState=Open` (Submitted).
- **Acknowledged TSRs** — Service Requests, `moduleState=tsrvalidated` (Acknowledged); conditional Create Work Order / Create Tenant Quote by Tenant Quote Path; chargeable tag.

## Develop
```bash
npm install
npm run build
facilio vibe deploy
```
