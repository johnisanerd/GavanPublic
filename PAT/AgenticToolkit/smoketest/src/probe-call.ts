/**
 * Tier 3A connectivity probe — opens a Cartesia WS, sends `start`, waits 2s
 * for any server event, closes. No TTS, no audio sent. Cheap sanity check
 * that auth + endpoint + agent_id are wired correctly before burning a
 * full scenario's worth of Cartesia minutes.
 *
 *   tsx src/probe-call.ts
 */
import { CartesiaCallClient } from './cartesia-call.js';

async function main() {
  console.log('[probe] connecting to Cartesia…');
  const client = new CartesiaCallClient({
    onServerEvent: (ev) => {
      console.log('[probe] server event:', ev.event, JSON.stringify(ev.payload).slice(0, 200));
    },
  });
  try {
    await client.connect();
    console.log('[probe] WS open + start ack received');
    // Hold the socket open briefly to surface any deferred error events
    // (some failures only fire after a few hundred ms).
    await new Promise((r) => setTimeout(r, 2000));
  } finally {
    await client.close();
  }
  console.log('[probe] closed cleanly');
}

main().catch((err) => {
  console.error('[probe] FAIL:', err.message);
  process.exit(1);
});
