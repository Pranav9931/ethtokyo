# Robot Rescue

**When a virtual robot gets stuck, its agent posts a job. Any verified human anywhere in the world can take it, teleoperate the robot in the browser, and get paid.**

World ID is the trust layer: it decides who can take a job and who gets paid. This platform posts jobs to a global pool of verified humans, gates robot control behind a fresh World ID verification, and pays the reward to the worker's World ID `sub`.

Built for the *World ID for Agents* track. Physics is [MuJoCo](https://mujoco.org/) running as WebAssembly in Node (the official `@mujoco/mujoco` bindings), rendered in the browser with three.js.

## The loop

1. **Robot works autonomously.** A 3-DoF arm runs an inspection sweep in MuJoCo.
2. **Robot gets stuck** and holds position. Three triggers exist, two of them physics-driven:
   - *hazard*: a person comes within 0.6 m of the end effector
   - *obstructed*: joint tracking error stays high for 3 s (a crate in the sweep path)
   - *low confidence*: the target part is not where the plan expects it
3. **Its agent posts a job**: what's needed, urgency, reward. It appears on the job board for everyone connected.
4. **A human accepts it.** The "Connect your World ID" modal opens with a QR code built by the official SDK (`@worldcoin/idkit-core`) against the **sandbox** environment. The backend signs the RP context with `signRequest`, the proof is bound to this job and browser session via the signal, and the backend forwards the proof to the Developer Portal verify endpoint (`/api/v4/verify/{rp_id}`) and checks the returned environment and action. The RP-scoped **nullifier** is the worker's identity.
5. **Control unlocks only after validation.** Teleop commands over the WebSocket are accepted only from the session that holds the active, verified claim.
6. **Done.** The human marks the job complete, the robot resumes autonomy, and the reward (0.05 to 0.1 WLD depending on urgency) is paid in **WLD on World Chain** to the worker's payout wallet, keyed by their World ID nullifier. Same human, same nullifier, one balance and one wallet: no reward farming with multiple accounts.

### Failure paths (all demoable from the UI)

| Path | What happens |
|---|---|
| Not verified | Sliders are locked, WebSocket control messages are answered with `denied` |
| Cancelled in World App | Job returns to the pool, robot stays paused |
| Verification times out (2 min) | Job returns to the pool, robot stays paused |
| Tampered proof | Portal (or mock signer) rejects it, job returns to the pool |
| Forged / replayed proof | Unknown, foreign, or already-consumed request is rejected, nothing unlocks |

## Run it

```sh
npm install
npm run dev          # backend on :8787 + Vite on :5173
open http://localhost:5173
```

Use the **Scenario** buttons (bottom left) to get the robot stuck, then accept the job from the pool.

Without World ID credentials the server runs a **local mock World App**: the browser shows the same "Connect your World ID" modal and QR code, but the QR links to a page that plays the phone and lets the presenter pick Verify, Cancel, or a tampered proof. Proofs are HMAC-signed and verified with the same request/nonce/signal checks as the real path.

### Verification modes

| Mode | Enabled by | What runs |
|---|---|---|
| `idkit` | `WORLD_APP_ID`, `WORLD_RP_ID`, `WORLD_SIGNING_KEY` | Official SDK, sandbox World App, Developer Portal verify |
| `oidc` | `WORLD_CLIENT_ID`, `WORLD_CLIENT_SECRET` | Sign in with World ID (authorization code + PKCE, JWKS-verified ID token) |
| `mock` | nothing set | Local stand-in for World App, same UI and checks |

### Using the real World ID sandbox

1. Request sandbox access and create an app in the [World Developer Portal](https://developer.world.org). Register the action `rescue-robot` and note the app id, RP id and RP signing key.
2. Install the sandbox World App on a phone (TestFlight or Play testing track, see the [sandbox access guide](https://docs.world.org/world-id/sandbox/sandbox-access)).
3. `cp .env.example .env`, fill in `WORLD_APP_ID`, `WORLD_RP_ID`, `WORLD_SIGNING_KEY`, and set `PUBLIC_URL` to a URL the phone can reach (a tunnel such as `ngrok http 8787` works).
4. `npm run build && npm start`.

### Automated check

`node scripts/e2e.mjs` (with the backend running) walks every path above against the mock issuer and prints the outcome of each step.

## Layout

```
server/index.js      HTTP + WebSocket server, job/auth wiring, 60 Hz sim loop
server/sim.js        MuJoCo world, autopilot, stuck detection, teleop input
server/jobs.js       job pool state machine + payout ledger keyed by sub
server/worldid.js    IDKit verification: RP signing, portal verify, replay guard (+ mock signer)
server/auth.js       optional OIDC relying party (discovery, PKCE, JWKS verification)
server/mock-world.js local stand-in for World App (Verify / Cancel / tampered proof)
server/robot.xml     MJCF model: arm, target part, crate, person
src/main.js          job board, job/teleop panel, WebSocket client
src/viewer.js        three.js renderer fed by the server's pose stream
scripts/e2e.mjs      scripted walk-through of all flows
```

## Payouts

With `TREASURY_PRIVATE_KEY` set, every completed job sends an ERC-20 transfer of the reward from the treasury to the worker's payout wallet on World Chain (chain 480, WLD `0x2cFc…3003`). The worker enters their wallet once after verifying; it's stored against their World ID identity, and any payout that completed before a wallet was set is sent as soon as one is. Each payment shows its status (sent, confirmed, failed with retry) and links to the transaction on worldscan.org. Set `WORLD_CHAIN=sepolia` to rehearse on World Chain Sepolia. Without a treasury key, payouts are simulated and labelled as such.

The treasury needs WLD for rewards plus a little ETH on World Chain for gas.

## Persistence

Set `DATABASE_URL` (Supabase: Project Settings, Database, Connection string, **Transaction pooler** URI; percent-encode special characters in the password) and the server keeps workers and payout wallets, jobs with their history, payments with transaction hashes, and the used-proof replay guard in Postgres. Tables are created on first start. Without it everything runs in memory.

## Design

The UI follows World's design language: tokens (grays, success/error/warning/info, World blue, radii) are lifted from `@worldcoin/mini-apps-ui-kit-react`, primary actions are black pills, and the verification modal follows the World ID design guidelines (logo, "Connect your World ID", QR ≥ 160 px, Terms & Privacy, dismiss). Verified workers get the "human" badge. TWK Lausanne is a licensed font, so the system sans stack stands in. The ring mark is a neutral glyph, not the World trademark.

## Pitch wording

Say: *"posted to a global pool of verified humans."* World ID decides who can take a job and who gets paid; the platform does the posting.
