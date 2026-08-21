# Passkey Research

**Status:** research notes — captures sub-agent investigation 2026-05-21 of WebAuthn/passkey implementation feasibility for the PAT dashboard. Not a committed plan. Implementation explicitly deferred to post-demo per `one-flow-well.md` stretch list.

**Last updated:** 2026-05-21

**Related plans:** `one-flow-well.md` (stretch section mentions this), `person-identity.md` (passkeys would attach to `person.id`).

## Why this exists

Question raised mid-design: how hard is it to implement passkeys in 2026, and is there a trivial way to do it in this system tied to the `person` concept? Quick answer captured here so the research doesn't evaporate when we get back to it.

Two specific use cases sized:
1. **Replace/supplement `PAT_ADMIN_TOKEN`** as dashboard auth — phishing-resistant browser auth instead of a long-lived bearer token in `.env`.
2. **Per-action approval signed by passkey** — alternative to "tap approve in a DM card" when the admin happens to be at a browser.

## Bottom-line

**"Pick a Tuesday and ship it" in 2026.** Not a research project. ~3–4 days for a dashboard-login MVP, +1–2 days for per-action approval. Library landscape is stable, ecosystem hasn't churned, recovery story is the only genuinely interesting part.

**When to revisit:** once the demo lands and we want to harden admin auth. Bundle with the dashboard's other auth-model decisions (Conversation Lens tab access, scrub-button permissions, etc.) so the whole admin surface gets thought through once.

## Library landscape (2026)

- **`@simplewebauthn/server` v13.3.0** + **`@simplewebauthn/browser`** — canonical TS library, FIDO-conformance-tested, Auth0/Okta-sponsored. No newer competitors worth switching to.
- GitHub deprecated `@github/webauthn-json` in March 2025; everyone consolidated on native browser `PublicKeyCredential.parseCreationOptionsFromJSON()` / `.toJSON()` APIs, which SimpleWebAuthn wraps cleanly.
- Library is stable enough that the barrier is "understanding the WebAuthn ceremony," not "fighting the library."

Docs:
- https://simplewebauthn.dev
- https://github.com/masterkale/simplewebauthn
- https://www.passkeys.dev/ (FIDO Alliance reference)

## Concrete code shape

Four endpoints on the Hono server (recovery is admin-mediated — no recovery endpoints needed):

| Endpoint | Purpose | Library call |
|---|---|---|
| `GET /auth/register/begin` | Issue registration challenge | `generateRegistrationOptions()` |
| `POST /auth/register/verify` | Verify attestation, store credential | `verifyRegistrationResponse()` |
| `GET /auth/login/begin` | Issue auth challenge | `generateAuthenticationOptions()` |
| `POST /auth/login/verify` | Verify assertion, issue session | `verifyAuthenticationResponse()` |

Client-side ceremony in React:
1. Enroll: fetch begin → `startRegistration()` → POST verify
2. Login: fetch begin → `startAuthentication()` → POST verify → set session token

For per-action approval (use case 2), add a 5th endpoint or extend `/auth/login/verify` with an `action_id` query param and a `person_passkey_approvals` table tracking pending signatures.

## Database schema

```sql
CREATE TABLE person_passkeys (
  id              TEXT PRIMARY KEY,
  person_id       TEXT NOT NULL REFERENCES people(id),
  credential_id   TEXT NOT NULL UNIQUE,        -- PublicKeyCredential.id (Base64URL)
  public_key      BLOB NOT NULL,                -- cryptographic public key
  counter         INTEGER NOT NULL DEFAULT 0,   -- signature counter (cloned-credential detection)
  transports      TEXT,                          -- CSV: 'usb','ble','nfc','internal'
  device_type     TEXT,                          -- 'singleDevice' | 'multiDevice'
  backed_up       INTEGER,                       -- platform sync available
  name            TEXT,                          -- human label: "iPhone 16" / "YubiKey 5"
  created_at      TEXT NOT NULL,
  last_used_at    TEXT
);

-- For per-action approval (use case 2)
CREATE TABLE person_passkey_approvals (
  id              TEXT PRIMARY KEY,
  person_id       TEXT NOT NULL REFERENCES people(id),
  action_id       TEXT NOT NULL,                 -- e.g. outbound message id
  challenge       BLOB NOT NULL,                 -- WebAuthn challenge
  assertion_json  TEXT,                          -- serialized PublicKeyCredentialAssertionJSON
  verified_at     TEXT,
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL                  -- 10-min TTL typical
);
```

A person has many passkeys (one per device + optional hardware backup). No recovery codes — recovery is admin-mediated (see below).

## Cross-device sync (2026 reality)

**Platform passkeys sync reliably:**
- Apple iCloud Keychain — iPhone, iPad, Mac (Apple sign-in required). Seamless.
- Google Password Manager — Android + Chrome cross-device.
- 1Password, Bitwarden — explicit sync across all enrolled devices.

**Hardware passkeys (YubiKey, Solo, etc.) do NOT sync** — single-device by design. Main case where they don't.

**Idiomatic mixed strategy:** require at least one platform passkey + one backup (hardware key or secondary platform passkey + recovery codes). Handles "lost all devices" and "hardware key in toilet."

## Recovery story

**Admin-mediated only.** No recovery codes, no secondary-passkey requirement. Decided 2026-05-21 — for PAT's scale (single install, small set of admin operators), the recovery-code UX cost isn't worth it.

Flow when a person loses all their passkeys:
1. Locked-out person contacts an existing admin out-of-band (Signal DM, voice, whatever — they have other channels via the Person concept).
2. Admin opens People tab in dashboard, finds the locked-out person, clicks **"Reset passkeys"** → invalidates all `person_passkeys` rows for that person.
3. Admin shares a one-time enrollment link with the locked-out person OOB (or just tells them "your passkeys are reset, visit the dashboard and enroll a new one"). Mechanism is an implementation detail — could be a signed URL with TTL, a temporary auth bypass for person_ids with zero passkeys, or admin walks them through it on a shared screen.
4. Locked-out person visits dashboard, enrolls new passkey via the same `/auth/register/begin` flow.

Implementation surface for recovery:
- One button on the People tab: "Reset passkeys for this person" (with confirmation).
- One server endpoint: `DELETE /people/<id>/passkeys` (admin-auth'd).
- Optionally a "Generate enrollment link" affordance if the implicit "no passkeys = open enrollment" flow feels too loose.

For PAT's threat model (internal admin tool, small ops team) this is sufficient. If PAT ever goes multi-tenant or grows to ops staff who don't know each other, revisit and add recovery codes.

## Origin pinning (dev / prod mismatch)

Passkeys cryptographically bound to RP ID (eTLD+1 domain). Separate credentials for `localhost` vs `dashboard.fly.dev` is the feature, not a bug.

**Real-world handling:**
- **Separate credential sets per environment** — dev uses `localhost:5173`, prod uses `dashboard.fly.dev`. Each person maintains separate passkeys. Painful but correct.
- **Cloudflared tunnel** — run locally at `tunnel.example.com` → maps to `localhost:5173`. RP ID matches prod cert. Credentials work cross-environment. **Most common workaround.**
- **Staging domain** — prod at `dashboard.example.com`, staging at `staging.dashboard.example.com`. Different RP IDs but closer to reality than localhost.

For PAT's Fly setup: cloudflared tunnel to something like `dev.dashboard.fly.dev` during development. Register once, works across machines.

## Effort estimate

Assuming an experienced TS dev with good system context but no prior passkey experience, dashboard-login MVP (with admin-mediated recovery, no recovery codes; defer per-action approval to wave 2):

| Component | LOC | Notes |
|---|---|---|
| Server routes (4 endpoints + admin reset) | 150–220 | Hono middleware, challenge session, verify wrappers, reset endpoint |
| DB schema + migration | 25–40 | SQL for `person_passkeys` only |
| Client ceremony (React) | 120–160 | Registration flow, login form |
| UI (enrollment + admin reset button) | 120–160 | "Add passkey" modal, People-tab reset button |
| Testing (E2E + unit) | 60–100 | Happy path + admin reset flow |
| Docs + comments | 40–80 | Setup guide, origin pinning notes |
| **Total** | **~520–760** | |

**Timeline (one focused dev):**
- Day 1: SimpleWebAuthn deep-dive, RP ID setup, test credential creation
- Day 2: Server routes + DB + admin reset endpoint
- Day 3: React ceremony + UI + integration with People tab
- Day 4: E2E test + dev origin handling + buffer

**Total: ~2.5–3 days for "login + admin-mediated recovery" MVP.** Add 1–2 days for per-action approval. Saves roughly a day vs. the recovery-codes path.

## Use cases for PAT, weighed

**(1) Replace/supplement `PAT_ADMIN_TOKEN` on dashboard — clear win.**
- Phishing-resistant browser auth instead of bearer token in `.env` (rotatable, but still a shared secret in environment).
- Direct mapping to `person.id` — the human authenticating is a recognized person.
- Pure upside, no UX regression.

**(2) Per-action approval via passkey — complementary, not replacement.**
- Passkeys are browser-only. Don't help if admin is on the go and approval needs to land in a Signal DM.
- Natural fit: "if you happen to be at the dashboard, sign here; otherwise use the DM-card flow as today."
- Mental model: **passkeys = browser-authenticated admin**, **DM cards = mobile-authenticated admin**. Same person, two paths.

## When to revisit

After the demo lands. Bundle with:
- Other dashboard auth-model decisions (Conversation Lens tab access, scrub-button permissions, per-tab admin-only flags).
- Decision on whether dashboard is admin-only or has read-only "viewer" tier.
- Any future move toward multi-operator installs.

## Decision log

- SimpleWebAuthn is the canonical library — no library research needed when we revisit.
- Tied to `person` (not `users`) — passkey is "this human" not "this channel handle."
- Cloudflared tunnel for dev origin handling — settle on a `dev.dashboard.fly.dev` style domain once we get there.
- Admin-mediated recovery only. No recovery codes, no secondary-passkey requirement. Decided 2026-05-21 — for PAT's single-install, small-ops-team threat model, the recovery-code UX cost isn't worth it. Revisit if PAT goes multi-tenant.
- Per-action passkey approval is complementary to (not replacement for) DM-card approval. Both paths coexist.
- Deferred to post-demo. The demo doesn't need stronger admin auth; capturing the research here so when we do tackle it we don't re-investigate.
