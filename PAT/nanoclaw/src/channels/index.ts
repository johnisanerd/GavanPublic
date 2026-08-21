// Channel self-registration barrel.
// Each import triggers the channel module's registerChannelAdapter() call.
//
// Main ships with one default channel — `cli`, the always-on local-terminal
// channel. Other channel skills (/add-slack, /add-discord, /add-whatsapp,
// ...) copy their module from the `channels` branch and append a
// self-registration import below.

import './cli.js';
// PAT: phone-call channel — PSTN/Cartesia voice. Registered as
// channel_type='realtime' for DB compat (renamed from realtime.ts on
// 2026-05-14; see plans/channel-orchestration-dedup.md).
import './phone-call.js';
// PAT: anam-web channel — HTTP backend for the Anam.ai avatar browser frontend (pat-web/).
import './anam-web.js';
// PAT: signal — native adapter speaking JSON-RPC to a signal-cli daemon
// (sibling Fly process in pat-transports). See src/channels/signal.ts header.
import './signal.js';
// PAT: simulated-Signal capture adapter — test-only outbound sink gated by
// PAT_TEST_OUTBOUND_ADAPTER=1. MUST import after signal.js so, in capture
// mode, its `signal`-keyed adapter is the live one. See signal-sim.ts.
import './signal-sim.js';
import './slack.js';
// staging trial: Telegram connector (added via /add-telegram from upstream/channels).
import './telegram.js';
