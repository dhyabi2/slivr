# LOFT (vendored) — serverless realtime multiplayer, no always-on game server

Vendored from https://github.com/dhyabi2/loft-poc (same author + AGPL-3.0-or-later as proov).

LOFT = Lazy-Oracle Fixed-Tick: authoritative, cheat-resistant realtime multiplayer that runs on
serverless infra (Vercel/Cloudflare/Lambda + any CAS KV) with NO persistent game-server process.
Drop these modules into a generated multiplayer game's backend when the deployment target is
serverless. See the `serverless-multiplayer-loft` skill for the playbook and `SPEC.md` for the wire
protocol.

- `sim.mjs` — your game rules go in `step(state, inputs)` (fixed-point integer, pure, deterministic);
  `genesis`, `isGoal`, `serialize`, `stateHash`.
- `protocol.mjs` — `initRoom`, `postInput`, `tryFold`, `replayVerify`, hash-chain helpers.
- `kv.mjs` — `DurableKV` CAS interface (adapt to DynamoDB/Redis/Cloudflare KV).
- `fraud.mjs` — `bisect`, `adjudicate`, `runDispute` (optimistic fraud proofs).

Sweet spot: full-information games (shared boss, visible positions). NOT hidden-state (cards/fog) —
the fraud proof re-executes from public inputs and can't hide secrets.
