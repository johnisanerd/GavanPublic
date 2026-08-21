/**
 * PAT: monkey-patch RTCPeerConnection + RTCDataChannel to log every
 * message that flows through Anam's WebRTC transport. Goal: find a
 * persona-audio-end signal that Anam's backend may be sending but the
 * SDK throws away in its `default: break;` branch (unknown
 * DataChannelMessage types are silently ignored per StreamingClient.js).
 *
 * Logs are tagged `[rtc-tap]` so they're easy to filter in devtools.
 * Optionally POSTs to /api/anam/rtc-tap so the dashboard sees them too.
 *
 * Side-effect-only — imported for its top-level patching, no exports.
 * MUST run BEFORE the @anam-ai/js-sdk is instantiated.
 */

declare global {
  interface Window {
    __ANAM_RTC_TAP_INSTALLED__?: boolean;
  }
}

const TAG = '[rtc-tap]';

// Forward observed events to the server-side log so they show up in
// pat-trace alongside the structured stream. Throttled per kind so a
// chatty channel can't drown the log endpoint.
const lastForwardByKind = new Map<string, number>();
const FORWARD_MIN_INTERVAL_MS = 50;

function forwardToServer(kind: string, data: Record<string, unknown>): void {
  const now = Date.now();
  const last = lastForwardByKind.get(kind) ?? 0;
  if (now - last < FORWARD_MIN_INTERVAL_MS) return;
  lastForwardByKind.set(kind, now);
  // Best-effort, fire-and-forget. No await, no error handling on the
  // network failure path — the console.log already captured locally.
  fetch('/api/anam/rtc-tap', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind, ts: new Date().toISOString(), data }),
    keepalive: true,
  }).catch(() => {
    /* noop */
  });
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function summarizeData(raw: unknown): { messageType?: string; preview?: string; size: number } {
  if (typeof raw === 'string') {
    const parsed = safeParse(raw);
    if (parsed && typeof parsed === 'object') {
      const p = parsed as Record<string, unknown>;
      return {
        messageType: typeof p.messageType === 'string' ? p.messageType : typeof p.actionType === 'string' ? p.actionType : undefined,
        preview: raw.length > 240 ? raw.slice(0, 240) + '…' : raw,
        size: raw.length,
      };
    }
    return { preview: raw.length > 240 ? raw.slice(0, 240) + '…' : raw, size: raw.length };
  }
  if (raw instanceof ArrayBuffer) {
    return { size: raw.byteLength };
  }
  return { size: 0 };
}

function installDataChannelHooks(channel: RTCDataChannel, ownerLabel: string): void {
  const label = channel.label || '(unlabeled)';
  console.log(`${TAG} ↪ datachannel attached owner=${ownerLabel} label=${label} readyState=${channel.readyState}`);
  forwardToServer('rtc-tap.channel-attached', { owner: ownerLabel, label, readyState: channel.readyState });

  channel.addEventListener('open', () => {
    console.log(`${TAG} ▶ open  label=${label}`);
    forwardToServer('rtc-tap.channel-open', { label });
  });

  channel.addEventListener('close', () => {
    console.log(`${TAG} ■ close label=${label}`);
    forwardToServer('rtc-tap.channel-close', { label });
  });

  channel.addEventListener('error', (e) => {
    console.warn(`${TAG} ✗ error label=${label}`, e);
    forwardToServer('rtc-tap.channel-error', { label, error: String(e) });
  });

  // Inbound — what Anam sends US. THIS is where a hidden persona-audio-end
  // event would show up if one exists.
  channel.addEventListener('message', (ev: MessageEvent) => {
    const summary = summarizeData(ev.data);
    const mt = summary.messageType ?? '(no messageType)';
    console.log(`${TAG} ← inbound  label=${label} type=${mt} size=${summary.size}`, summary.preview ?? ev.data);
    forwardToServer('rtc-tap.inbound', { label, ...summary });
  });

  // Outbound — wrap .send so we see what WE push (talkstream chunks, etc.).
  const origSend = channel.send.bind(channel);
  // `send` has multiple overloads (string | ArrayBuffer | Blob | etc.) —
  // route through a typed cast on the binding side.
  (channel as unknown as { send: (data: unknown) => void }).send = (data: unknown) => {
    const summary = summarizeData(data);
    const mt = summary.messageType ?? '(no messageType)';
    console.log(`${TAG} → outbound label=${label} type=${mt} size=${summary.size}`, summary.preview ?? data);
    forwardToServer('rtc-tap.outbound', { label, ...summary });
    // Original `send` is overloaded — TS can't follow our generic cast.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return origSend(data as any);
  };
}

function installPeerConnectionHooks(pc: RTCPeerConnection): void {
  let pcId = `pc-${Math.random().toString(36).slice(2, 8)}`;
  console.log(`${TAG} ⊕ peerConnection created ${pcId}`);
  forwardToServer('rtc-tap.pc-created', { pcId });

  // Datachannels created on THIS side via pc.createDataChannel — already
  // patched at the prototype level. Datachannels arriving FROM the remote
  // come through `ondatachannel` / 'datachannel' events.
  pc.addEventListener('datachannel', (ev: RTCDataChannelEvent) => {
    installDataChannelHooks(ev.channel, `inbound-via-${pcId}`);
  });

  // Track events — the persona audio MediaStream comes through here.
  pc.addEventListener('track', (ev: RTCTrackEvent) => {
    const tk = ev.track;
    console.log(`${TAG} 🎧 track ${pcId} kind=${tk.kind} id=${tk.id} muted=${tk.muted} readyState=${tk.readyState}`);
    forwardToServer('rtc-tap.track', { pcId, kind: tk.kind, trackId: tk.id, muted: tk.muted, readyState: tk.readyState });

    // onmute / onunmute fire when WebRTC determines the source stops/resumes
    // sending data. With Opus DTX they CAN fire on silence — which would
    // give us false positives on intra-say <break> tags. Logging both so
    // we can see empirically how Anam behaves.
    tk.addEventListener('mute', () => {
      console.log(`${TAG} 🔇 track-mute ${pcId} kind=${tk.kind} id=${tk.id}`);
      forwardToServer('rtc-tap.track-mute', { pcId, kind: tk.kind, trackId: tk.id });
    });
    tk.addEventListener('unmute', () => {
      console.log(`${TAG} 🔊 track-unmute ${pcId} kind=${tk.kind} id=${tk.id}`);
      forwardToServer('rtc-tap.track-unmute', { pcId, kind: tk.kind, trackId: tk.id });
    });
    tk.addEventListener('ended', () => {
      console.log(`${TAG} ⏹ track-ended ${pcId} kind=${tk.kind} id=${tk.id}`);
      forwardToServer('rtc-tap.track-ended', { pcId, kind: tk.kind, trackId: tk.id });
    });
  });
}

export function installAnamRtcTap(): void {
  if (typeof window === 'undefined') return;
  if (window.__ANAM_RTC_TAP_INSTALLED__) return;
  window.__ANAM_RTC_TAP_INSTALLED__ = true;

  if (typeof RTCPeerConnection === 'undefined') {
    console.warn(`${TAG} RTCPeerConnection not available — skipping install`);
    return;
  }

  console.log(`${TAG} installing — patching RTCPeerConnection + RTCDataChannel`);

  // Wrap the constructor so every peer connection Anam creates gets hooks.
  const OrigPC = window.RTCPeerConnection;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Wrapped: any = function (config?: RTCConfiguration) {
    const pc = new OrigPC(config);
    installPeerConnectionHooks(pc);
    return pc;
  };
  Wrapped.prototype = OrigPC.prototype;
  // Preserve the static `generateCertificate` if used.
  if ('generateCertificate' in OrigPC) {
    Wrapped.generateCertificate = (OrigPC as unknown as { generateCertificate: unknown }).generateCertificate;
  }
  window.RTCPeerConnection = Wrapped;

  // Patch createDataChannel at the prototype level so locally-created
  // channels also get hooks. (Anam creates one on the offer side.)
  const origCreateDC = OrigPC.prototype.createDataChannel;
  OrigPC.prototype.createDataChannel = function (
    label: string,
    init?: RTCDataChannelInit,
  ): RTCDataChannel {
    const ch = origCreateDC.call(this, label, init);
    installDataChannelHooks(ch, 'local-create');
    return ch;
  };

  console.log(`${TAG} installed`);
}
