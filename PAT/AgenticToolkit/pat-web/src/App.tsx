import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Mic, Play, Square } from 'lucide-react';
import { AvatarCanvas } from '@/talk/AvatarCanvas';
import { BackgroundLayer } from '@/talk/BackgroundLayer';
import { CaptionOverlay } from '@/talk/CaptionOverlay';
import { ControlBar } from '@/talk/ControlBar';
import { ScenariosPanel } from '@/talk/ScenariosPanel';
import { useScenarioBus } from '@/talk/hooks/use-scenario-bus';
import { FullscreenButton } from '@/talk/FullscreenButton';
import { OverlayLayer } from '@/talk/OverlayLayer';
import {
  ToolNotificationLayer,
  normalizeBannerPlacement,
  type ToolBannerPlacement,
} from '@/talk/ToolNotificationLayer';
import { VignetteOverlay, DEFAULT_VIGNETTE_PARAMS, type VignetteParams } from '@/talk/VignetteOverlay';
import { VoiceBlob } from '@/talk/VoiceBlob';
import { DEFAULT_PARAMS as DEFAULT_SHADER, type ShaderParams } from '@/talk/shader/renderer';
import { BG_PRESETS, DEFAULT_BG, type BackgroundPreset } from '@/talk/lib/bg-presets';
import { OVERLAY_PRESETS, DEFAULT_OVERLAY, type OverlayPreset } from '@/talk/lib/overlay-presets';
import { DEFAULT_VIGNETTE } from '@/talk/lib/vignette-presets';
import {
  type AvatarMode,
  isVoiceOnly,
  isStandIn,
  sessionModeFor,
} from '@/talk/lib/modes';
import { useAnamSession } from '@/talk/hooks/use-anam-session';
import { useBanterDriver } from '@/talk/hooks/use-banter-driver';
import { useEventsStream } from '@/talk/hooks/use-events-stream';
import { usePersistedState } from '@/talk/hooks/use-persisted-state';
import { usePatRealtimeWs } from '@/talk/hooks/use-pat-realtime-ws';
import type { AvatarBackground } from '@/talk/hooks/use-anam-session';

const VIDEO_ELEMENT_ID = 'pat-anam-video';
const STAND_IN_SRC = '/placeholder-portrait.png';
// PAT: dashboard origin. Defaults to the deployed Fly app for
// prod-style use, but can be overridden via `VITE_DASHBOARD_ORIGIN`
// for local dev so the embedded dashboard iframe reads from a
// local pat-frontend (which in turn should proxy to local
// nanoclaw). Example dev setup:
//
//   pat-frontend/.env.local:
//     NANOCLAW_INTERNAL_HOST=127.0.0.1:8767
//     NANOCLAW_INTERNAL_SCHEME=http
//   pat-web/.env.local:
//     VITE_DASHBOARD_ORIGIN=http://localhost:5178
const DASHBOARD_ORIGIN =
  (import.meta.env?.VITE_DASHBOARD_ORIGIN as string | undefined) ?? 'https://pat-frontend.fly.dev';
const DASHBOARD_MIN_WIDTH = 280;
const STAGE_MIN_WIDTH = 320;

export function App() {
  // Single source of truth for "what's in the avatar slot + how the
  // backend is wired". Everything downstream (SessionMode, shader's
  // standIn, voiceOnly flag, ToolNotificationLayer gating, banter
  // driver) is a pure derivation of this one persisted value.
  const [avatarMode, setAvatarModeState] = usePersistedState<AvatarMode>(
    'pat-web:avatarMode',
    'pat',
  );
  const sessionMode = sessionModeFor(avatarMode);
  const voiceOnly = isVoiceOnly(avatarMode);
  const standIn = isStandIn(avatarMode);

  // Realtime WS hook — root of the realtime tree. Owns the stable
  // platformId, the per-call sessionId, the bearer, and the WS
  // lifecycle. `useAnamSession` is told what the IDs are and given
  // the listener / send-frame primitives it needs — no ref dance.
  const realtimeWs = usePatRealtimeWs({ enabled: sessionMode === 'pat' });

  const session = useAnamSession({
    platformId: realtimeWs.platformId,
    addRealtimeListener: realtimeWs.addListener,
    sendTurnEnded: realtimeWs.sendTurnEnded,
    sendSessionEnded: realtimeWs.sendSessionEnded,
  });

  // Shader (chroma key only — vignette is its own layer). `standIn`
  // inside the shader is now a pure derivation of avatarMode; the
  // chroma panel never sets it directly. We force it on every mode
  // change so persistence can't desync.
  const [shader, setShaderState] = usePersistedState<ShaderParams>(
    'pat-web:shader',
    DEFAULT_SHADER,
  );
  const setShader = useCallback((p: Partial<ShaderParams>) => {
    setShaderState((prev) => ({ ...prev, ...p }));
  }, [setShaderState]);
  useEffect(() => {
    setShaderState((prev) => (prev.standIn === standIn ? prev : { ...prev, standIn }));
  }, [standIn, setShaderState]);

  const setAvatarMode = useCallback(
    (m: AvatarMode) => {
      setAvatarModeState(m);
    },
    [setAvatarModeState],
  );

  // Vignette (top-layer overlay)
  const [vignette, setVignetteState] = usePersistedState<VignetteParams>(
    'pat-web:vignette',
    DEFAULT_VIGNETTE_PARAMS,
  );
  const [vignettePreset, setVignettePreset] = usePersistedState<string>(
    'pat-web:vignettePreset',
    DEFAULT_VIGNETTE.id,
  );
  const setVignette = useCallback((p: Partial<VignetteParams>) => {
    setVignetteState((prev) => ({ ...prev, ...p }));
  }, [setVignetteState]);

  // Background + overlay — persist by id only so changing a preset's
  // CSS in code doesn't strand the old value in localStorage.
  const [bgId, setBgId] = usePersistedState<string>('pat-web:bgId', DEFAULT_BG.id);
  const [overlayId, setOverlayId] = usePersistedState<string>('pat-web:overlayId', DEFAULT_OVERLAY.id);
  const [captionsEnabled, setCaptionsEnabled] = usePersistedState<boolean>('pat-web:captions', false);
  // Ambient tool-call notifications — defaults on; user can hide via
  // stage panel. Placement toggle between "behind-head" (large banner,
  // peeks past silhouette) and "upper-right" (compact corner pill).
  const [showTools, setShowTools] = usePersistedState<boolean>('pat-web:showTools', true);
  // Avatar background — server resolves the slug to a real Anam id.
  // Default 'office' matches the current Fly secret so the visual
  // doesn't change for users who never touch this setting.
  const [avatarBackground, setAvatarBackground] = usePersistedState<AvatarBackground>(
    'pat-web:avatarBackground',
    'office',
  );
  // Default 'left' (banners anchored at left-middle). usePersistedState
  // reads JSON-encoded values; legacy bare-string values from earlier
  // builds will fail to parse and fall back to the default. We also
  // normalise here in case a future stored value drifts.
  const [toolBannerPlacementRaw, setToolBannerPlacementRaw] = usePersistedState<ToolBannerPlacement>(
    'pat-web:toolBannerPlacement',
    'left',
  );
  const toolBannerPlacement = normalizeBannerPlacement(toolBannerPlacementRaw);
  const setToolBannerPlacement = setToolBannerPlacementRaw;

  // Mic input mode — open-mic (Anam default: VAD streams whatever the user
  // says) vs push-to-talk (mic muted until spacebar is held). PTT lets
  // the user share a stage with other speakers / a noisy room without
  // the avatar interrupting on every cough.
  const [inputMode, setInputMode] = usePersistedState<'open-mic' | 'ptt'>(
    'pat-web:inputMode',
    'open-mic',
  );
  // Transient: true while spacebar is held in PTT mode. Drives the
  // "mic transmitting right now" visual on the chrome toggle and gates
  // the unmute call below.
  const [pttActive, setPttActive] = useState(false);
  // Pulse experiment: after releasing PTT, the on-screen button can
  // emit a soft green pulse until Anam fires the first persona-typed
  // history update (proxy for "TTS has started"). Toggleable so we
  // can A/B whether it actually helps responsiveness perception.
  const [pttPulseEnabled, setPttPulseEnabled] = usePersistedState<boolean>(
    'pat-web:pttPulse',
    true,
  );
  const [pttPulsing, setPttPulsing] = useState(false);
  // Safety timeout: if a persona reply never lands (silent decision,
  // network drop), stop pulsing after this so the button doesn't loop
  // forever. 15 s is comfortably past Pat's typical first-token latency.
  const pulseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Embedded pat-frontend dashboard pane — off by default; only togglable
  // when a `?token=` is present on the URL (same security surface as
  // opening the dashboard directly with that token).
  const dashboardToken = useMemo(() => {
    try {
      return new URLSearchParams(window.location.search).get('token');
    } catch {
      return null;
    }
  }, []);
  // PAT: per-kiosk avatar framing (zoom + vertical offset). Persisted
  // across reloads via usePersistedState so the kiosk operator sets
  // them once and they stick. URL params (`?zoom=`, `?offsetY=`) are
  // SEED-only: on first mount, if present, they overwrite the
  // persisted value once — letting a bookmarked kiosk URL configure
  // the setting on its first visit, after which the operator can drop
  // the params and the value persists. The transform is applied inside
  // AvatarCanvas so it scopes to the visible canvas (not overlays /
  // vignette / control bar).
  //
  //   ?zoom=1.0     scale on the rendered avatar (0.5–3.0)
  //   ?offsetY=0    px shift after zoom (-500 to +500, negative = up)
  const [avatarZoom, setAvatarZoom] = usePersistedState<number>('pat-web:zoom', 1.0);
  const [avatarOffsetY, setAvatarOffsetY] = usePersistedState<number>('pat-web:offsetY', 0);
  // Seed-on-mount: read URL params once, overwrite persisted state if
  // present. Empty deps so this fires exactly once per page load — if
  // the operator visits with `?zoom=1.3` then reloads the same URL,
  // we re-seed to 1.3 (same value, no observable difference). If they
  // strip the params on a later visit, the localStorage value wins
  // because we don't touch the setter when the param is absent.
  useEffect(() => {
    const clamp = (n: number, lo: number, hi: number) =>
      Math.min(hi, Math.max(lo, n));
    try {
      const p = new URLSearchParams(window.location.search);
      const zRaw = p.get('zoom');
      const oyRaw = p.get('offsetY');
      if (zRaw !== null) {
        const n = Number(zRaw);
        if (Number.isFinite(n)) setAvatarZoom(clamp(n, 0.5, 3.0));
      }
      if (oyRaw !== null) {
        const n = Number(oyRaw);
        if (Number.isFinite(n)) setAvatarOffsetY(clamp(n, -500, 500));
      }
    } catch {
      /* no window / no search — leave persisted value untouched */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [showDashboard, setShowDashboard] = usePersistedState<boolean>('pat-web:showDashboard', false);
  const [showScenarios, setShowScenarios] = useState<boolean>(false);
  // PAT: when on, console.logs every scenario.* (tag-stream + action)
  // event AND surfaces scenario.action events as tool-style banners
  // in the overlay layer. Useful for verifying the agent is emitting
  // the right tags when bullets aren't advancing as expected.
  const [showActionStream, setShowActionStream] = usePersistedState<boolean>('pat-web:showActionStream', false);
  // When the page is loaded with ?scenario=<slug>, subscribe to that
  // scenario's slide-bus. The presenter agent's start_presentation
  // MCP tool fires {cmd:'open'} → deckOpen flips true → side-pane
  // renders an iframe of the deck.
  //
  // PAT: thread-keying for per-call sticky state. Pass the avatar
  // session's threadId so each call gets its own (slug,thread) bucket
  // on the slide-bus server. Without this, a previous call's cursor
  // replays on reload and the deck jumps to slide N.
  const presenterThreadId = realtimeWs.sessionId ? `anam-web-call-${realtimeWs.sessionId}` : null;
  const scenarioBus = useScenarioBus(presenterThreadId);
  // Stage / dashboard split width — fraction of viewport occupied by the
  // stage (0..1). Persisted across reloads so the user's split holds.
  const [stageFrac, setStageFrac] = usePersistedState<number>('pat-web:stageFrac', 0.55);
  // PAT: deck / dashboard split — fraction of the COMBINED side-pane
  // width occupied by the deck (the LEFT side pane). Dashboard gets
  // the remainder. Only used when both side panes are visible.
  const [deckFrac, setDeckFrac] = usePersistedState<number>('pat-web:deckFrac', 0.5);
  const bg = useMemo<BackgroundPreset>(
    () => BG_PRESETS.find((p) => p.id === bgId) ?? DEFAULT_BG,
    [bgId],
  );
  const overlay = useMemo<OverlayPreset>(
    () => OVERLAY_PRESETS.find((p) => p.id === overlayId) ?? DEFAULT_OVERLAY,
    [overlayId],
  );
  const setBg = useCallback((p: BackgroundPreset) => setBgId(p.id), [setBgId]);
  const setOverlay = useCallback((p: OverlayPreset) => setOverlayId(p.id), [setOverlayId]);

  // Events (simulator or live — we default to simulator until backend is up)
  const events = useEventsStream('simulator');

  // PAT-mode banter driver — no-op in demo mode. Voice avatar mode
  // rides the same Pat pipeline (sessionMode === 'pat') so the driver
  // fires for it too. dispatch is `sendUserMessage` over the WS. The
  // WS is owned by `realtimeWs` above — sessionId / platformId come
  // from there now.
  useBanterDriver(sessionMode, session.client, realtimeWs.platformId, realtimeWs.sessionId, {
    sendUserMessage: realtimeWs.sendUserMessage,
  });

  // ── Push-to-talk wiring ───────────────────────────────────────────────
  // Desired mute state derived from inputMode + transient pttActive.
  // open-mic → never mute. ptt → mute unless spacebar is held.
  const muteDesired = inputMode === 'ptt' && !pttActive;

  // Single press/release path so spacebar and on-screen button share
  // their side-effects (pulse start/stop + safety timeout cleanup).
  const stopPulse = useCallback(() => {
    setPttPulsing(false);
    if (pulseTimeoutRef.current) {
      clearTimeout(pulseTimeoutRef.current);
      pulseTimeoutRef.current = null;
    }
  }, []);
  const pressPtt = useCallback(() => {
    setPttActive(true);
    stopPulse();
  }, [stopPulse]);
  const releasePtt = useCallback(() => {
    setPttActive(false);
    if (!pttPulseEnabled || inputMode !== 'ptt') return;
    setPttPulsing(true);
    if (pulseTimeoutRef.current) clearTimeout(pulseTimeoutRef.current);
    pulseTimeoutRef.current = setTimeout(() => {
      setPttPulsing(false);
      pulseTimeoutRef.current = null;
    }, 15_000);
  }, [pttPulseEnabled, inputMode]);

  // Stop the spinner the moment nanoclaw marks TTS as busy — the
  // server-side signal that an utterance is about to play out
  // through Cartesia / Anam. More accurate than Anam's
  // MESSAGE_HISTORY_UPDATED (which fires for user-typed entries too
  // and lags the actual audio start by a frame or two).
  useEffect(() => {
    if (!pttPulseEnabled) return;
    const unsub = session.subscribeEvents((ev) => {
      if (ev.kind === 'tts.busy-marked') stopPulse();
    });
    return unsub;
  }, [session.subscribeEvents, pttPulseEnabled, stopPulse]);

  // PAT: action-stream debug. When showActionStream is on, every
  // scenario.* event lands in console with a tag-shaped prefix so
  // the operator can grep / inspect. Pre-existing tool-pre / -post
  // bubbles already show in the overlay layer; this gives parity
  // for tag-stream events so bullet/fragment failures are visible.
  useEffect(() => {
    if (!showActionStream) return;
    const unsub = session.subscribeEvents((ev) => {
      if (ev.kind === 'scenario.tag-stream-started') {
        console.log(
          '%c[action-stream]%c ⇩ stream-started',
          'color:#A36BFF;font-weight:600',
          'color:inherit',
          ev.data,
        );
      } else if (ev.kind === 'scenario.action') {
        const d = ev.data as { action_type?: string; direction?: string; fragment_direction?: string; target_slide?: number; tool_name?: string; text?: string; anchor?: string };
        const summary = [
          d.action_type,
          d.direction ?? d.fragment_direction ?? (d.target_slide !== undefined ? `→${d.target_slide}` : ''),
          d.tool_name ? `tool=${d.tool_name}` : '',
          d.anchor ? `a=${d.anchor}` : '',
          d.text ? `"${d.text.slice(0, 60)}"` : '',
        ].filter(Boolean).join(' ');
        console.log(
          '%c[action-stream]%c →',
          'color:#A36BFF;font-weight:600',
          'color:inherit',
          summary,
        );
      } else if (ev.kind === 'scenario.tag-stream-ended') {
        console.log(
          '%c[action-stream]%c ⇧ stream-ended',
          'color:#A36BFF;font-weight:600',
          'color:inherit',
          ev.data,
        );
      }
    });
    return unsub;
  }, [session.subscribeEvents, showActionStream]);

  // Cancel any in-flight pulse if PTT is turned off entirely or the
  // pulse experiment is disabled mid-flight.
  useEffect(() => {
    if (!pttPulseEnabled || inputMode !== 'ptt') stopPulse();
  }, [pttPulseEnabled, inputMode, stopPulse]);

  // Apply the desired mute state to the Anam client whenever it changes
  // or the session reconnects. We gate on status='connected' because
  // muteInputAudio throws if called before the WebRTC track is up. The
  // try/catch is a belt-and-braces for SDK versions where the audio
  // track is briefly absent (e.g. after a peer renegotiation).
  useEffect(() => {
    const client = session.client;
    if (!client || session.status !== 'connected') return;
    try {
      if (muteDesired) client.muteInputAudio();
      else client.unmuteInputAudio();
    } catch (err) {
      console.warn('[pat-web] mic toggle failed', err);
    }
  }, [muteDesired, session.client, session.status]);

  // Spacebar handler — wired ONLY while in PTT mode so open-mic users
  // get the browser's default spacebar behaviour (button activation,
  // page scroll, etc). Inside PTT mode we intercept on every keydown
  // that isn't in a text-entry context.
  //
  // The dashboard pane is an <iframe> on a different origin (pat-frontend
  // is its own Fly app). Browser key-event routing keeps keydowns inside
  // a focused cross-origin iframe out of the parent's listeners, so we
  // don't have to special-case it — typing in the observatory just
  // doesn't reach this handler.
  useEffect(() => {
    if (inputMode !== 'ptt') return;
    const isTextInput = (el: Element | null): boolean => {
      if (!el) return false;
      const tag = el.tagName;
      if (tag === 'INPUT') {
        const type = (el as HTMLInputElement).type;
        // Range / checkbox / radio / color don't have meaningful
        // spacebar defaults — let PTT capture spacebar even when one of
        // these is focused (common after dragging a slider).
        return !['range', 'checkbox', 'radio', 'color', 'button', 'submit'].includes(type);
      }
      if (tag === 'TEXTAREA') return true;
      return (el as HTMLElement).isContentEditable === true;
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' && e.key !== ' ') return;
      if (isTextInput(document.activeElement)) return;
      e.preventDefault();
      if (e.repeat) return;
      pressPtt();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space' && e.key !== ' ') return;
      if (isTextInput(document.activeElement)) return;
      e.preventDefault();
      releasePtt();
    };
    // Window-level listeners so we catch the event regardless of which
    // chrome element (or no element) is focused.
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    // If the tab loses focus mid-press (alt-tab, switch app), drop the
    // PTT state so the mic doesn't latch on indefinitely.
    const onBlur = () => setPttActive(false);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      // Releasing the spacebar latch on unmount avoids a stuck "mic
      // live" state if the user toggles back to open-mic while holding
      // space (rare, but cheap to guard).
      setPttActive(false);
    };
  }, [inputMode, pressPtt, releasePtt]);

  const onResetAll = useCallback(() => {
    // usePersistedState's write effect mirrors these setters to
    // localStorage on the next commit, so we don't need to pre-clear
    // the keys. Touch EVERY persisted slot — if you add a new
    // usePersistedState above, also reset it here.
    setShaderState(DEFAULT_SHADER);
    setVignetteState(DEFAULT_VIGNETTE_PARAMS);
    setVignettePreset(DEFAULT_VIGNETTE.id);
    setBgId(DEFAULT_BG.id);
    setOverlayId(DEFAULT_OVERLAY.id);
    setCaptionsEnabled(false);
    setShowTools(true);
    setAvatarBackground('office');
    setToolBannerPlacement('left');
    setShowDashboard(false);
    setStageFrac(0.55);
    setInputMode('open-mic');
    setPttPulseEnabled(true);
    setAvatarModeState('pat');
    setAvatarZoom(1.0);
    setAvatarOffsetY(0);
  }, [
    setShaderState,
    setVignetteState,
    setVignettePreset,
    setBgId,
    setOverlayId,
    setCaptionsEnabled,
    setShowTools,
    setAvatarBackground,
    setToolBannerPlacement,
    setShowDashboard,
    setStageFrac,
    setInputMode,
    setPttPulseEnabled,
    setAvatarModeState,
    setAvatarZoom,
    setAvatarOffsetY,
  ]);

  const startSession = useCallback(async () => {
    const videoEl = document.getElementById(VIDEO_ELEMENT_ID) as HTMLVideoElement | null;
    if (!videoEl) {
      console.warn('video element missing — AvatarCanvas not mounted yet');
      return;
    }
    // PAT: prime the video element with a gesture-tied play() before
    // kicking off the async session bootstrap. Standalone-PWA browsers
    // (esp. Android Chrome installed-app) aggressively expire user
    // gestures across awaits — by the time Anam's SDK calls .play()
    // internally after streamToVideoElement, the gesture is gone and
    // the autoplay heuristic blocks playback, leaving the video frozen
    // on the first frame. Calling play() inside the click handler
    // marks the element as "user-approved"; the actual play attempt
    // fails silently (no srcObject yet) but the marking sticks.
    videoEl.play().catch(() => {
      /* expected — no source yet, just gesture-priming */
    });
    const token = await session.start({ mode: sessionMode, videoEl, background: avatarBackground });
    // PAT (Mode C′ refactor): hand the freshly-minted sessionId +
    // bearer to the WS hook so it can open the realtime socket. In
    // demo mode the bearer is null (no realtime WS) and we skip the
    // hand-off. In pat mode the bearer must be present — the server
    // returns one bound to (sessionId, platformId).
    if (token && token.bearer && sessionMode === 'pat') {
      realtimeWs.openSession({
        sessionId: token.sessionId,
        bearer: token.bearer,
        platformId: realtimeWs.platformId,
      });
    }
  }, [session, sessionMode, avatarBackground, realtimeWs]);

  // PAT: route stop() through both the Anam session AND the realtime WS
  // hook so the socket closes when the call ends.
  const stopSession = useCallback(() => {
    session.stop();
    realtimeWs.closeSession();
  }, [session, realtimeWs]);

  // PAT: removed first-gesture back-mind prewarm 2026-05-26 — the
  // nanoclaw-side `/anam-web/prewarm-warmup` route was deleted alongside
  // the back-mind prewarm path. The prewarm blocked real chat rows for
  // the full SDK cold-start; net latency was worse than not prewarming.

  // PAT: ?autostart=1 — auto-fire startSession() on first mount. For
  // CLI-driven test loops (e.g. shell scripts that pipe macOS `say`
  // into the system audio device) where there's no human to click
  // Start. Open-mic is the default input mode so the mic unmutes
  // automatically once the WebRTC track is up. Gated on ?autostart
  // because Chrome may still block getUserMedia without a user
  // gesture depending on the origin's permission state — if it does,
  // the error lands in console and the operator clicks Start by hand.
  const autostartFiredRef = useRef(false);
  useEffect(() => {
    if (autostartFiredRef.current) return;
    if (session.status !== 'idle') return;
    try {
      if (new URLSearchParams(window.location.search).get('autostart') !== '1') return;
    } catch {
      return;
    }
    autostartFiredRef.current = true;
    startSession();
  }, [session.status, startSession]);

  // Chrome stays opaque. Auto-hide-on-idle was nice for projection but
  // unusable on touch devices (no pointermove from a tap → menu never
  // resurfaced once it faded). If we want clean-projection mode back,
  // do it as an explicit toggle, not a timer.

  // iOS / notch / dynamic-island safe-area inset for the whole visual
  // stage. The outer black gutter that results matches the chrome
  // controls' inset so the dynamic island doesn't clip the avatar's
  // head or the vignette's top edge.
  const stageInset: React.CSSProperties = {
    top: 'env(safe-area-inset-top, 0px)',
    right: 'env(safe-area-inset-right, 0px)',
    bottom: 'env(safe-area-inset-bottom, 0px)',
    left: 'env(safe-area-inset-left, 0px)',
  };

  // Dashboard side-pane state. Desktop-only (≥900px viewport) and gated
  // on a ?token= URL param.
  const isWide = useMatchesMedia('(min-width: 900px)');
  // Touch-device detection. `pointer: coarse` is true on phones / tablets
  // and false on mouse-driven desktops, even when a touch-screen Mac is
  // attached. Drives the mobile PTT button visibility — desktops have
  // spacebar PTT, phones don't have a usable keyboard.
  const isTouch = useMatchesMedia('(pointer: coarse)');
  const dashboardActive = showDashboard && isWide && Boolean(dashboardToken);
  const deckPaneActive = Boolean(scenarioBus?.deckOpen) && isWide;
  const deckPaneUrl = scenarioBus
    ? `/decks/${encodeURIComponent(scenarioBus.slug)}?bus=${encodeURIComponent(
        `/api/slide-bus/${scenarioBus.slug}/events${
          presenterThreadId ? `?thread=${encodeURIComponent(presenterThreadId)}` : ''
        }`,
      )}`
    : '';
  // PAT: dashboard URL — token-gated. If we have a live Anam
  // session, scope the dashboard to its thread; otherwise show the
  // unfiltered dashboard so the operator can see global / prior
  // activity (and so the iframe still mounts when no call is live).
  const dashboardUrl = dashboardToken
    ? `${DASHBOARD_ORIGIN}/?token=${encodeURIComponent(dashboardToken)}${realtimeWs.sessionId ? `&thread=anam-web-call-${realtimeWs.sessionId}` : ''}`
    : null;

  // Drag-resize: stageFrac (0..1) is the fraction of the inner area the
  // stage occupies. Dragging the gutter updates it.
  const splitContainerRef = useRef<HTMLDivElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const onSplitDragStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    setIsDragging(true);
    const el = splitContainerRef.current;
    if (!el) return;
    const onMove = (ev: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      const raw = (ev.clientX - rect.left) / rect.width;
      // Clamp to leave a usable amount on both sides.
      const minFrac = STAGE_MIN_WIDTH / rect.width;
      const maxFrac = 1 - DASHBOARD_MIN_WIDTH / rect.width;
      setStageFrac(Math.max(minFrac, Math.min(maxFrac, raw)));
    };
    const onUp = () => {
      setIsDragging(false);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [setStageFrac]);

  // PAT: drag handler for the deck ↔ dashboard gutter. Updates
  // deckFrac, the share of the side-pane area allocated to the
  // deck. Side-pane area = (1 - stageFrac) of the container width;
  // deck starts at (stageFrac * width) so the drag X offset within
  // the side-pane region maps to deckFrac.
  const onDeckDashDragStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    setIsDragging(true);
    const el = splitContainerRef.current;
    if (!el) return;
    const onMove = (ev: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      const sidePaneLeft = rect.left + rect.width * stageFrac;
      const sidePaneWidth = rect.width * (1 - stageFrac);
      if (sidePaneWidth <= 0) return;
      const raw = (ev.clientX - sidePaneLeft) / sidePaneWidth;
      const minFrac = 120 / sidePaneWidth; // 120px min per side pane
      const maxFrac = 1 - 120 / sidePaneWidth;
      setDeckFrac(Math.max(minFrac, Math.min(maxFrac, raw)));
    };
    const onUp = () => {
      setIsDragging(false);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [setDeckFrac, stageFrac]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-[var(--color-bg-base)]">
      {/* Split-pane container — flex when dashboard is on, sized stage
          + iframe pane + draggable gutter between them. When the
          dashboard is off we collapse to a single full-width column,
          so existing layout math (absolute inset-0 children) is
          undisturbed. */}
      <div
        ref={splitContainerRef}
        className="absolute flex flex-row"
        style={{
          ...stageInset,
          // While dragging, suppress pointer events on iframe so the
          // drag handler isn't eaten by it. (Iframes capture pointer
          // events even with pointer-events: none if they're focused.)
          ...(isDragging ? { userSelect: 'none' } : null),
        }}
      >
        {/* Stage column — sized to stageFrac of the split container
            when dashboard or deck pane is on, full width otherwise.
            Deck pane and dashboard pane are mutually exclusive in
            v0 (rarely both on; deck wins if both true). */}
        <div
          className="relative h-full"
          style={{
            flexBasis:
              dashboardActive || deckPaneActive ? `${stageFrac * 100}%` : '100%',
            flexShrink: 0,
          }}
        >
        {/* z=0 — background layer */}
        <div className="absolute inset-0 z-0">
          <BackgroundLayer
            preset={bg.id === 'events' ? (BG_PRESETS.find((p) => p.id === 'events') ?? bg) : bg}
            events={events}
          />
        </div>

        {/* z=30 — ambient tool-call notification banners. Drop down from
            the TOP edge of the video frame (either centered or in the
            upper-right corner depending on the placement toggle). Sit
            ABOVE the avatar (z=10) and the foreground scrim (z=15) so
            they're always readable; below the gesture overlay (z=35)
            so play/stop click targets aren't blocked. Only meaningful
            in pat mode, and gated by the "show tools" toggle in the
            stage panel. */}
        {sessionMode === 'pat' && showTools && (
          <ToolNotificationLayer
            subscribe={session.subscribeEvents}
            placement={toolBannerPlacement}
          />
        )}

        {/* z=10 — avatar layer (WebGL2 + hidden video). In voice mode
            we hide the canvas with `visibility: hidden` so the WebGL
            context + hidden <video> stay live (Anam keeps streaming),
            but the user sees only the blob layered above it. Image
            mode wins over voice for visibility because the chroma
            shader needs the canvas to draw the stand-in. */}
        <div
          className="absolute inset-0 z-10"
          style={voiceOnly && !standIn ? { visibility: 'hidden' } : undefined}
        >
          <AvatarCanvas
            videoElementId={VIDEO_ELEMENT_ID}
            standInSrc={STAND_IN_SRC}
            params={shader}
            zoom={avatarZoom}
            offsetY={avatarOffsetY}
          />
        </div>

        {/* z=12 — voice-reactive SVG blob. Same vertical real estate as
            the avatar canvas but rendered above it (the canvas is
            visibility:hidden in this mode anyway). Sits BELOW the
            foreground overlay (z=15) and vignette (z=20) so the stage
            mood lighting still applies to it. */}
        <div className="absolute inset-0 z-[12]">
          <VoiceBlob videoElementId={VIDEO_ELEMENT_ID} visible={voiceOnly && !standIn} />
        </div>

        {/* z=15 — foreground overlay (lighting / scrim / sparse rain) */}
        <div className="absolute inset-0 z-[15]">
          <OverlayLayer preset={overlay} />
        </div>

        {/* z=20 — vignette covering the whole composition */}
        <div className="absolute inset-0 z-20">
          <VignetteOverlay params={vignette} />
        </div>

        {/* z=30 — caption overlay (opt-in; clean stage by default) */}
        {captionsEnabled && (
          <CaptionOverlay user={session.live.user} persona={session.live.persona} />
        )}

        {/* z=35 — gesture overlays over the video region. Centered play
            button when idle (ghosted onto the black video plate); centered
            stop button that fades in on hover when a session is live.
            Both are scoped to this stage column so the dashboard pane
            isn't masked. */}
        <SessionGestureOverlay
          status={session.status}
          onStart={startSession}
          onStop={stopSession}
        />

        {/* z=36 — push-to-talk button. Visible on every device when PTT
            mode is on. On touch (no keyboard) it's the primary input
            gesture; on desktop it's a secondary control that mirrors
            spacebar — same press/release semantics, smaller footprint,
            and a visual cue ("oh, spacebar lights this up too") that
            teaches the keyboard shortcut. When the user releases, we
            optionally pulse the button until Anam's first persona
            history-update lands — a soft "waiting for the avatar to
            start" indicator. */}
        <PttButton
          visible={inputMode === 'ptt'}
          active={pttActive}
          pulsing={pttPulsing}
          compact={!isTouch}
          onPress={pressPtt}
          onRelease={releasePtt}
        />

        {/* z=40 — chrome (control bar). Lives INSIDE the stage column so
            its absolute-positioned settings panel is bounded by the
            video region — it can never visually overflow into the
            dashboard iframe pane on the right. The inner pointer-events
            wrapper is none-by-default so the panel doesn't eat
            stage-column hover targets when it's closed. */}
        <div className="pointer-events-none absolute inset-0 z-40 overflow-hidden">
          <ControlBar
            status={session.status}
            avatarMode={avatarMode}
            setAvatarMode={setAvatarMode}
            onStart={startSession}
            onStop={stopSession}
            shader={shader}
            setShader={setShader}
            vignette={vignette}
            setVignette={setVignette}
            vignettePreset={vignettePreset}
            setVignettePreset={setVignettePreset}
            zoom={avatarZoom}
            setZoom={setAvatarZoom}
            offsetY={avatarOffsetY}
            setOffsetY={setAvatarOffsetY}
            bg={bg}
            setBg={setBg}
            overlay={overlay}
            setOverlay={setOverlay}
            captionsEnabled={captionsEnabled}
            setCaptionsEnabled={setCaptionsEnabled}
            showTools={showTools}
            setShowTools={setShowTools}
            toolBannerPlacement={toolBannerPlacement}
            setToolBannerPlacement={setToolBannerPlacement}
            showDashboard={showDashboard}
            setShowDashboard={setShowDashboard}
            showScenarios={showScenarios}
            setShowScenarios={setShowScenarios}
            showActionStream={showActionStream}
            setShowActionStream={setShowActionStream}
            dashboardEligible={Boolean(dashboardToken) && isWide}
            avatarBackground={avatarBackground}
            setAvatarBackground={setAvatarBackground}
            inputMode={inputMode}
            setInputMode={setInputMode}
            pttActive={pttActive}
            pttPulseEnabled={pttPulseEnabled}
            setPttPulseEnabled={setPttPulseEnabled}
            onResetAll={onResetAll}
          />
        </div>
        </div>

        {/* Drag-resize gutter — only when a side pane is on. 6px hit
            area, 1px visible. Pointer cursor on hover. */}
        {(dashboardActive || deckPaneActive) && (
          <div
            onPointerDown={onSplitDragStart}
            className="relative h-full w-[6px] flex-shrink-0 cursor-col-resize"
            style={{ background: 'transparent' }}
            role="separator"
            aria-orientation="vertical"
            aria-label="resize dashboard pane"
          >
            <div
              className="pointer-events-none absolute left-1/2 top-0 h-full w-px -translate-x-1/2"
              style={{ background: 'var(--color-border-subtle)' }}
            />
          </div>
        )}

        {/* Presenter deck pane — the iframe is mounted as soon as we
            have a scenarioBus URL (page load with `?scenario=` query),
            but the pane is collapsed to zero width until the agent
            fires {cmd:'open'} (deckPaneActive flips true). Keeping
            the iframe warm avoids three problems we hit in dev:
              - SSE sticky-state replay races the iframe's mount
              - Reveal.js init takes ~600ms after first paint, which
                is enough to drop the first agent-driven advance
              - Iframe re-mounting on every open/close cycle wastes
                the second-or-two reveal warmup
            With width=0 + visibility:hidden + pointerEvents:none the
            iframe is invisible to the audience but its EventSource
            is already established. When deckPaneActive flips true the
            iframe just animates from width=0 to full width.

            When BOTH panes are visible, deck uses deckFrac of the
            side-pane width (so the gutter between deck and dashboard
            is draggable). When only deck is visible, it takes the
            full side-pane region via flex:1. */}
        {deckPaneUrl && (
          <div
            className="relative h-full min-w-0"
            aria-hidden={!deckPaneActive}
            style={{
              ...((!deckPaneActive || isDragging) ? { pointerEvents: 'none' as const } : {}),
              ...(deckPaneActive
                ? dashboardActive
                  ? { flexBasis: `${deckFrac * (1 - stageFrac) * 100}%`, flexShrink: 0, flexGrow: 0 }
                  : { flexGrow: 1, flexShrink: 1, flexBasis: '0%' }
                : { flexBasis: '0%', flexShrink: 0, flexGrow: 0, overflow: 'hidden', visibility: 'hidden' as const }),
            }}
          >
            <iframe
              src={deckPaneUrl}
              title={`presenter deck — ${scenarioBus?.slug}`}
              className="h-full w-full border-0"
              style={{ background: '#F2F3F0' }}
            />
          </div>
        )}

        {/* Draggable gutter between deck pane and dashboard pane —
            only when BOTH are active. Updates deckFrac (the deck's
            share of the side-pane width). 6px hit area, 1px visible. */}
        {deckPaneActive && dashboardActive && (
          <div
            onPointerDown={onDeckDashDragStart}
            className="relative h-full w-[6px] flex-shrink-0 cursor-col-resize"
            style={{ background: 'transparent' }}
            role="separator"
            aria-orientation="vertical"
            aria-label="resize deck / dashboard split"
          >
            <div
              className="pointer-events-none absolute left-1/2 top-0 h-full w-px -translate-x-1/2"
              style={{ background: 'var(--color-border-subtle)' }}
            />
          </div>
        )}

        {/* Dashboard iframe pane — always furthest right when active.
            Pointer events suppressed while dragging so the split
            handler isn't eaten. */}
        {dashboardActive && dashboardUrl && (
          <div
            className="relative h-full min-w-0"
            style={{
              ...(isDragging ? { pointerEvents: 'none' as const } : {}),
              flexGrow: 1,
              flexShrink: 1,
              flexBasis: '0%',
            }}
          >
            <iframe
              src={dashboardUrl}
              title="pat-frontend dashboard"
              className="h-full w-full border-0"
            />
          </div>
        )}
      </div>

      {/* z=50 — fullscreen toggle, deliberately almost invisible */}
      <FullscreenButton />

      {/* Scenarios — operator's prepared-experience picker.
          Distinct from the debug-dashboard pane; this is the real
          presenter feature surface. Rendered above everything when
          open so it can dim the stage behind. */}
      <ScenariosPanel open={showScenarios} onClose={() => setShowScenarios(false)} />

      {session.error && (
        <div
          className="pointer-events-auto absolute z-40 max-w-md rounded-[var(--radius)] border border-[var(--color-bad)] bg-[oklch(0.10_0.02_25)] px-3 py-2 text-[12px] text-[var(--color-bad)]"
          style={{
            top: 'calc(env(safe-area-inset-top, 0px) + 1rem)',
            left: 'calc(env(safe-area-inset-left, 0px) + 1rem)',
          }}
        >
          {session.error}
        </div>
      )}
    </div>
  );
}

/**
 * Gesture overlays anchored over the video region.
 *
 * - Idle state ('idle' | 'fetching-token' | 'error'): a large ghost play
 *   button centered on the black video plate. One click → startSession.
 *
 * - Active state ('connecting' | 'connected'): an invisible hover hit
 *   area covering the center; mousing over it fades in a stop button.
 *   Click to end the session. The hit area only catches pointer events
 *   on its own bounds so the rest of the video stays interactive.
 *
 * Why not the ControlBar's start/end buttons? Putting the canonical
 * gesture over the video lets the user start a session without first
 * opening the settings menu — which is now closed by default and
 * itself anchored to the upper-right of the video region.
 */
import type { SessionStatus } from '@/talk/hooks/use-anam-session';

function SessionGestureOverlay({
  status,
  onStart,
  onStop,
}: {
  status: SessionStatus;
  onStart: () => void;
  onStop: () => void;
}) {
  const live = status === 'connecting' || status === 'connected';
  const showPlay = !live;
  if (showPlay) {
    return (
      <button
        type="button"
        onClick={onStart}
        aria-label="start session"
        className="absolute inset-0 z-[35] flex items-center justify-center group"
        style={{ background: 'transparent', border: 0, cursor: 'pointer' }}
      >
        <span
          className="flex h-24 w-24 items-center justify-center rounded-full transition-all group-hover:scale-105"
          style={{
            background: 'oklch(1 0 0 / 0.06)',
            border: '1.5px solid oklch(1 0 0 / 0.18)',
            backdropFilter: 'blur(6px)',
            WebkitBackdropFilter: 'blur(6px)',
            boxShadow: '0 0 32px oklch(0 0 0 / 0.4)',
          }}
        >
          <Play
            size={36}
            color="oklch(0.96 0.005 250 / 0.85)"
            strokeWidth={1.5}
            // Triangle is visually right-heavy — nudge a hair left
            // so the centroid feels centered.
            style={{ marginLeft: 4 }}
          />
        </span>
      </button>
    );
  }
  // Live: invisible center-zone hover hit area. Not full-bleed so the
  // user can interact with anything else over the video without
  // accidentally hitting "stop". The button itself fades in on hover.
  // Sized to match the idle play button (h-24 w-24) so the two states
  // read as a matched pair when the user toggles a session on/off.
  return (
    <div
      className="pointer-events-none absolute inset-0 z-[35] flex items-center justify-center"
    >
      <div
        className="pointer-events-auto group flex h-40 w-40 items-center justify-center"
        title="stop session"
      >
        <button
          type="button"
          onClick={onStop}
          aria-label="stop session"
          className="flex h-24 w-24 items-center justify-center rounded-full opacity-0 transition-all duration-200 group-hover:opacity-100 hover:scale-105"
          style={{
            background: 'oklch(0.16 0.03 25 / 0.7)',
            border: '1.5px solid oklch(0.7 0.18 25 / 0.6)',
            backdropFilter: 'blur(6px)',
            WebkitBackdropFilter: 'blur(6px)',
            color: 'oklch(0.92 0.06 25)',
            cursor: 'pointer',
          }}
        >
          <Square size={30} fill="currentColor" strokeWidth={0} />
        </button>
      </div>
    </div>
  );
}

/**
 * Push-to-talk button — visible on both desktop and touch devices
 * whenever PTT mode is engaged.
 *
 * Why both surfaces:
 *   - Touch: no spacebar; this is the primary input gesture.
 *   - Desktop: secondary — mirrors spacebar's press/release so
 *     `pttActive` lights it up in sync with key holds. Reinforces
 *     "spacebar is the shortcut" without a separate hint.
 *
 * Size: `compact={true}` renders a smaller pill (matches desktop
 * proportions where the avatar dominates and we don't want the button
 * stealing focus). `compact={false}` is the full mobile-sized circle.
 *
 * Pulse: `pulsing` (and not currently `active`) renders an outer
 * green ring that scales out + fades, looping until the parent stops
 * it. Used as a "waiting for TTS to start" cue right after release.
 *
 * Pointer handling:
 *   - `touch-none` blocks browser pinch/scroll inside the button.
 *   - `setPointerCapture` keeps pointermove/up events bound here
 *     even if the finger slides off the rim — otherwise the slip
 *     would never fire release and the mic would latch open.
 *   - `pointercancel` covers OS-level interruptions (incoming call,
 *     palm-rejection) so we always drop the latch.
 */
function PttButton({
  visible,
  active,
  pulsing,
  compact,
  onPress,
  onRelease,
}: {
  visible: boolean;
  active: boolean;
  pulsing: boolean;
  compact: boolean;
  onPress: () => void;
  onRelease: () => void;
}) {
  if (!visible) return null;
  const size = compact ? 'h-14 w-14' : 'h-24 w-24';
  const iconSize = compact ? 22 : 34;
  const padBottom = compact
    ? 'calc(env(safe-area-inset-bottom, 0px) + 1.25rem)'
    : 'calc(env(safe-area-inset-bottom, 0px) + 1.75rem)';
  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-0 z-[36] flex justify-center"
      style={{ paddingBottom: padBottom }}
    >
      <div className="relative">
        {/* Waiting spinner — a thin arc orbits the button while we're
            waiting for Pat to start speaking. Replaces an earlier
            scale-out pulse because the spinner reads more
            unambiguously as "in progress, please wait" without
            implying anything is wrong. The arc itself is static; we
            rotate the wrapping SVG to drive the orbit. */}
        {pulsing && !active && (
          <svg
            aria-hidden
            viewBox="0 0 100 100"
            className="pointer-events-none absolute -inset-1.5"
            style={{ animation: 'ptt-spin 1.0s linear infinite' }}
          >
            <circle
              cx="50"
              cy="50"
              r="47"
              fill="none"
              stroke="oklch(0.78 0.20 145 / 0.7)"
              strokeWidth="3"
              strokeLinecap="round"
              /* ~22% of the circumference visible, rest is the gap.
                 Circumference = 2π·47 ≈ 295.3 → arc length ≈ 65. */
              strokeDasharray="65 230"
            />
          </svg>
        )}
        <button
          type="button"
          aria-label={active ? 'transmitting — release to mute' : 'hold to talk'}
          aria-pressed={active}
          className={`pointer-events-auto touch-none flex ${size} items-center justify-center rounded-full transition-all`}
          style={{
            background: active
              ? 'oklch(0.30 0.20 145 / 0.55)'
              : 'oklch(1 0 0 / 0.06)',
            border: active
              ? '1.5px solid oklch(0.78 0.20 145 / 0.75)'
              : '1.5px solid oklch(1 0 0 / 0.22)',
            color: active
              ? 'oklch(0.95 0.18 145)'
              : 'oklch(0.96 0.005 250 / 0.9)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            boxShadow: active
              ? '0 0 40px oklch(0.78 0.20 145 / 0.55), inset 0 0 18px oklch(0.78 0.20 145 / 0.35)'
              : '0 0 32px oklch(0 0 0 / 0.4)',
            transitionDuration: '120ms',
            transform: active ? 'scale(1.04)' : 'scale(1)',
          }}
          onPointerDown={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLButtonElement).setPointerCapture(e.pointerId);
            onPress();
          }}
          onPointerUp={(e) => {
            e.preventDefault();
            onRelease();
          }}
          onPointerCancel={() => onRelease()}
          onBlur={() => {
            if (active) onRelease();
          }}
        >
          <Mic size={iconSize} strokeWidth={1.7} />
        </button>
      </div>
      <style>{`
        @keyframes ptt-spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

/** Match a CSS media query and re-render when it changes. SSR-safe by
 *  defaulting to false; this app doesn't SSR but the guard is cheap. */
function useMatchesMedia(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}
