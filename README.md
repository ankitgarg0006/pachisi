# Pachisi

**Pachisi** — the classic Indian **cross-and-cloth race game**, the ancestor of Ludo — playable in the browser. Race all four of your pieces once around the embroidered board and home. Play online with friends, against bots, or pass-and-play on one phone. No ads, no sign-up.

**▶ Play:** https://pachisi.agapps.workers.dev

## Features

- **Three ways to play** — online multiplayer (6-digit room codes, public or private), vs. bots, or local pass-and-play.
- **Real-time** over WebSockets with reconnect; pass-and-play **survives a page refresh**.
- **Authentic board** — a cross-shaped embroidered cloth with a *charkoni* centre, plus a **day & night** theme and a 3D die.
- Installable **PWA**, in-game chat, colour picking, and bots driven by Durable Object alarms.
- **One shared rules engine** (`public/engine.js`) runs on both the server and the client, so online and pass-and-play stay in sync.

## How it plays

- Tap the die to roll. You need a **6** to bring a piece out of its yard.
- Land exactly on a rival to send it home — but the **★ safe squares** can't be captured.
- Roll a 6, capture a piece, or send one home to **throw again**; three 6s in a row skips your turn.
- Reach the centre with the **exact roll**. First to bring all four pieces home wins.

## Stack

- **Cloudflare Workers** (free tier) serving a static, no-build ES-module PWA.
- **Durable Objects** — one `LudoRoom` per board (authoritative state, WebSocket hibernation, alarms for bots/turn timers) plus a single `Lobby` DO for 6-digit codes and the public-board list.
- Vanilla JavaScript client, no framework, no bundler. Board geometry (52-cell ring + home columns + yards) lives in the shared engine.

## Local development

```bash
npx wrangler@4.113.0 dev      # run locally
npx wrangler@4.113.0 deploy   # deploy to Cloudflare
```

No build step — edit `public/*` and reload. Bump the `VERSION` in `public/sw.js` on each deploy so clients pick up new assets.

### Tests

- `simtest.mjs` — headless engine simulation; every game terminates with a valid four-home winner and valid board coordinates.
- `livetest.mjs` — live WebSocket smoke test.
- `uitest.mjs` — screenshot pass (Playwright).

## Project layout

```
public/      static PWA — index.html, app.js (client), engine.js (shared rules + board geometry), styles.css, sw.js, manifest
src/         Durable Objects — index.js (router), room.js (LudoRoom), lobby.js (Lobby)
wrangler.jsonc
```

---

© agapps
