import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { DeckPage } from './talk/DeckPage';
import { installAnamRtcTap } from './lib/anam-rtc-tap';
import { installSimUserSay } from './lib/sim-user-say';
import './index.css';

// PAT: install the WebRTC data-channel tap BEFORE anything else mounts.
// The tap monkey-patches RTCPeerConnection + RTCDataChannel at the
// prototype level so every channel created by Anam's SDK is observed.
// Goal: find a persona-audio-end signal that Anam may be sending
// over the data channel but the SDK silently drops (its switch on
// messageType has `default: break;` for unknown types).
installAnamRtcTap();

// PAT: dev-only — `?simUserSay=1` replaces the mic with Cartesia TTS so
// console-driven tests don't need the speakers→mic acoustic loop. Must
// run before the Anam SDK calls getUserMedia.
if (new URLSearchParams(window.location.search).has('simUserSay')) {
  installSimUserSay();
}

/**
 * Tiny dispatch: `/decks/<slug>` or `/_dev/deck` → DeckPage; anything
 * else → App. We avoid a router dependency for this — the dispatch
 * surface is two routes, the path is parsed once at mount, navigation
 * inside the deck happens via reveal not URL.
 */
function root() {
  const path = window.location.pathname;
  const m = path.match(/^\/decks\/([^/]+)\/?$/);
  if (m) return <DeckPage slug={m[1]} />;
  if (path === '/_dev/deck') return <DeckPage slug="_helloworld" />;
  if (path === '/_dev/fuzz') return <DeckPage slug="_fuzz" />;
  if (path === '/_dev/palisade') return <DeckPage slug="_palisade" />;
  return <App />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>{root()}</StrictMode>,
);
