import { useState } from 'react';
import { Bug, Library, Menu, Mic, MicOff } from 'lucide-react';
import { Slider } from '@/components/ui/slider';
import { Toggle } from '@/components/ui/toggle';
import { AspectSlider } from './AspectSlider';
import { BG_PRESETS, type BackgroundPreset } from './lib/bg-presets';
import { OVERLAY_PRESETS, type OverlayPreset } from './lib/overlay-presets';
import { AVATAR_MODES, type AvatarMode } from './lib/modes';
import type { ShaderParams } from './shader/renderer';
import type { ToolBannerPlacement } from './ToolNotificationLayer';
import type { VignetteParams } from './VignetteOverlay';
import type { AvatarBackground, SessionStatus } from './hooks/use-anam-session';
import { cn } from '@/lib/utils';

interface ControlBarProps {
  status: SessionStatus;
  /** Single source of truth for the avatar slot + backend wiring.
   *  ControlBar just renders / mutates this; deriving SessionMode /
   *  voiceOnly / standIn happens in App.tsx. */
  avatarMode: AvatarMode;
  setAvatarMode: (m: AvatarMode) => void;
  onStart: () => void;
  onStop: () => void;

  shader: ShaderParams;
  setShader: (p: Partial<ShaderParams>) => void;

  vignette: VignetteParams;
  setVignette: (p: Partial<VignetteParams>) => void;
  vignettePreset: string;
  setVignettePreset: (id: string) => void;

  /** Per-kiosk avatar framing — CSS transform on the rendered video,
   *  applied inside AvatarCanvas. Lives in the "frame" tab alongside
   *  the vignette geometry. Both values are persisted by App.tsx via
   *  usePersistedState; URL params (?zoom=, ?offsetY=) seed them on
   *  first mount. */
  zoom: number;
  setZoom: (v: number) => void;
  offsetY: number;
  setOffsetY: (v: number) => void;

  bg: BackgroundPreset;
  setBg: (p: BackgroundPreset) => void;

  overlay: OverlayPreset;
  setOverlay: (p: OverlayPreset) => void;

  captionsEnabled: boolean;
  setCaptionsEnabled: (v: boolean) => void;

  showTools: boolean;
  setShowTools: (v: boolean) => void;
  toolBannerPlacement: ToolBannerPlacement;
  setToolBannerPlacement: (v: ToolBannerPlacement) => void;

  /** Whether the embedded pat-frontend dashboard pane is visible. Hidden
   *  entirely when `dashboardEligible` is false (no ?token= on URL). */
  showDashboard: boolean;
  setShowDashboard: (v: boolean) => void;
  /** Scenarios — the operator's "pick a prepared agent experience"
   *  surface. Separate from the debug-dashboard pane; surfaces the
   *  list of provisioned scenarios + upload form + launch button. */
  showScenarios: boolean;
  setShowScenarios: (v: boolean) => void;
  /** Action-stream debug — console.log scenario.* events + surface
   *  scenario.action banners alongside tool calls. For verifying
   *  what tags the agent is actually emitting when behavior looks
   *  off (e.g. bullets aren't advancing). */
  showActionStream: boolean;
  setShowActionStream: (v: boolean) => void;
  dashboardEligible: boolean;

  /** Avatar background preset. Selected client-side; resolved to an
   *  Anam avatar id by the session-token endpoint. */
  avatarBackground: AvatarBackground;
  setAvatarBackground: (v: AvatarBackground) => void;

  /** Mic input mode — drives the chrome mic toggle and Anam
   *  muteInputAudio() in the parent. */
  inputMode: 'open-mic' | 'ptt';
  setInputMode: (v: 'open-mic' | 'ptt') => void;
  /** True while spacebar is held in PTT mode. Used purely for the
   *  "mic transmitting" visual — the actual mute call is owned by
   *  the parent. */
  pttActive: boolean;

  /** "Pulse on release until TTS starts" experiment. Toggleable so
   *  we can A/B whether the cue helps responsiveness perception. */
  pttPulseEnabled: boolean;
  setPttPulseEnabled: (v: boolean) => void;

  onResetAll: () => void;
}

type Section = 'avatar' | 'frame' | 'chroma' | 'bg';

export function ControlBar(props: ControlBarProps) {
  // Settings panel: closed by default. The user previously had to
  // dismiss it on every page load; once "start session" was lifted
  // out of this panel onto the video play overlay, the panel itself
  // is purely opt-in.
  const [expanded, setExpanded] = useState(false);
  const [section, setSection] = useState<Section>('avatar');

  return (
    <div
      className="pointer-events-auto absolute z-40 flex flex-col items-end gap-2"
      style={{
        // iOS Safari + PWA: nudge below the status bar / dynamic island
        // and inset from the right of a notched display. Falls back to
        // 1rem on platforms where the env() values are 0px.
        top: 'calc(env(safe-area-inset-top, 0px) + 1rem)',
        right: 'calc(env(safe-area-inset-right, 0px) + 1rem)',
      }}
    >
      {/* Horizontal top-bar row: status pill + chrome toggles.
          Order: status pill, observatory toggle (bug, token-gated),
          settings (hamburger). The bug sits LEFT of the hamburger so
          the observability surface gets the more prominent left slot
          when present; the settings hamburger is always-rightmost. */}
      <div className="flex flex-row items-center gap-2">
        {/* PAT: the status pill is suppressed when idle. The "idle"
            label was confusing — the user already knows the session
            isn't running because the play button is visible. The pill
            now only surfaces during transitions (auth/connecting),
            during a live session (so the user knows they're streaming),
            and on error. */}
        {props.status !== 'idle' && <StatusPill status={props.status} />}

        {/* Observatory (dashboard pane) toggle. Only meaningful when
            `?token=` is present on the URL — otherwise there's no way
            to authenticate the iframe pane. */}
        {props.dashboardEligible && (
          <ChromeToggle
            icon={Bug}
            selected={props.showDashboard}
            onClick={() => props.setShowDashboard(!props.showDashboard)}
            ariaLabel={props.showDashboard ? 'hide observatory' : 'show observatory'}
            title="Observatory"
          />
        )}

        {/* Scenarios — open the operator's prepared-experience picker.
            Distinct from observability; this is a real-feature surface
            (list of provisioned packets, upload form, launch). */}
        <ChromeToggle
          icon={Library}
          selected={props.showScenarios}
          onClick={() => props.setShowScenarios(!props.showScenarios)}
          ariaLabel={props.showScenarios ? 'close scenarios' : 'open scenarios'}
          title="Scenarios"
        />


        {/* Mic input toggle.
            One click flips between open-mic and PTT. The icon + on/off
            visual collapse two states into one mental model: when the
            button looks ON, the mic is actively transmitting (either
            because we're in open-mic, or because we're in PTT *and*
            spacebar is held right now). When the button looks OFF, the
            mic is muted — which in PTT mode is the idle state. The
            `Mic` / `MicOff` glyph swap reinforces the mode itself
            independently of the transient PTT-active visual.
            Tone tints the icon: red when currently muted (calls
            attention), subtle green when transmitting. */}
        {(() => {
          const muted = props.inputMode === 'ptt' && !props.pttActive;
          return (
            <ChromeToggle
              icon={muted ? MicOff : Mic}
              selected={!muted}
              tone={muted ? 'mute-warning' : 'transmit'}
              onClick={() =>
                props.setInputMode(props.inputMode === 'open-mic' ? 'ptt' : 'open-mic')
              }
              ariaLabel={
                props.inputMode === 'open-mic'
                  ? 'switch to push-to-talk'
                  : 'switch to open mic'
              }
              title={
                props.inputMode === 'open-mic'
                  ? 'Open mic (click for push-to-talk)'
                  : 'Push-to-talk — hold spacebar (click for open mic)'
              }
            />
          );
        })()}

        <ChromeToggle
          icon={Menu}
          selected={expanded}
          onClick={() => setExpanded((v) => !v)}
          ariaLabel={expanded ? 'close settings' : 'open settings'}
          title="Settings"
        />
      </div>

      {expanded && (
        <div
          className="rounded-[var(--radius-lg)] p-3 shadow-[var(--shadow-pop)] border border-[var(--color-border)]"
          style={{
            // PAT: fully opaque dark surface. The earlier 96% / 88%
            // variants bled the avatar video and dashboard iframe
            // through the panel, washing out labels. We can keep the
            // saturated-blur backdrop for the *edge* feel but commit
            // to a solid fill behind the content.
            background: 'oklch(0.08 0.012 250)',
            backdropFilter: 'blur(12px) saturate(140%)',
            WebkitBackdropFilter: 'blur(12px) saturate(140%)',
            // Width auto-fits content so the tab row never has to wrap
            // (5 → 4 tabs after folding session into avatar). Caps so
            // sliders inside don't stretch absurdly wide on desktop.
            width: 'min(420px, calc(100vw - 2rem))',
          }}
        >
          <SectionTabs section={section} setSection={setSection} />

          {section === 'avatar' && (
            <AvatarPanel
              status={props.status}
              avatarMode={props.avatarMode}
              setAvatarMode={props.setAvatarMode}
              avatarBackground={props.avatarBackground}
              setAvatarBackground={props.setAvatarBackground}
            />
          )}
          {section === 'frame' && (
            <FramePanel
              vignette={props.vignette}
              setVignette={props.setVignette}
              vignettePreset={props.vignettePreset}
              setVignettePreset={props.setVignettePreset}
              zoom={props.zoom}
              setZoom={props.setZoom}
              offsetY={props.offsetY}
              setOffsetY={props.setOffsetY}
            />
          )}
          {section === 'chroma' && (
            <ChromaPanel shader={props.shader} setShader={props.setShader} />
          )}
          {section === 'bg' && (
            <StagePanel
              bg={props.bg}
              setBg={props.setBg}
              overlay={props.overlay}
              setOverlay={props.setOverlay}
              captionsEnabled={props.captionsEnabled}
              setCaptionsEnabled={props.setCaptionsEnabled}
              showTools={props.showTools}
              setShowTools={props.setShowTools}
              toolBannerPlacement={props.toolBannerPlacement}
              setToolBannerPlacement={props.setToolBannerPlacement}
              showActionStream={props.showActionStream}
              setShowActionStream={props.setShowActionStream}
              pttPulseEnabled={props.pttPulseEnabled}
              setPttPulseEnabled={props.setPttPulseEnabled}
            />
          )}

          {/* Panel footer — global reset. Subtle: this is destructive
              but recoverable, so it doesn't need to shout. */}
          <div className="mt-3 flex justify-end border-t border-[var(--color-border-subtle)] pt-2">
            <button
              type="button"
              onClick={() => {
                // Confirm with native dialog — single click would be
                // too easy to fire by accident while dragging sliders.
                if (window.confirm('Reset all visual settings to defaults?')) {
                  props.onResetAll();
                }
              }}
              className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-ink-3)] hover:text-[var(--color-ink-1)] transition-colors"
            >
              reset defaults
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Top-bar chrome toggle. The on/off state changes ONLY the inner
 *  fill + icon brightness — the border stays at `--color-border-subtle`
 *  in both states. Earlier we used the Button "outline" vs "default"
 *  variants, which swap the border colour as well, and that read as a
 *  "stuck visual state" after the dashboard toggle reflowed the chrome:
 *  the just-toggled bug button ended up with a brighter frame than its
 *  hamburger sibling. Keeping the frame identical makes the on/off
 *  signal subtler and prevents the post-click drift.
 *
 *  `tone` lets a specific toggle paint the icon a semantic colour
 *  while the frame stays neutral. We use this for the mic toggle so
 *  "muted" reads as a clear danger-red call-to-attention and
 *  "transmitting" reads as a subtle good-green — without colouring
 *  the frame and losing the matched-pair visual.
 *
 *  Deliberately NOT using <Button> so the variant styles can't leak
 *  back in via cn() merging. */
type ChromeToggleTone = 'neutral' | 'mute-warning' | 'transmit';

function ChromeToggle({
  icon: Icon,
  selected,
  onClick,
  ariaLabel,
  title,
  tone = 'neutral',
}: {
  icon: typeof Bug;
  selected: boolean;
  onClick: () => void;
  ariaLabel: string;
  title: string;
  tone?: ChromeToggleTone;
}) {
  // Frame stays consistent regardless of tone — only the inner icon
  // colour shifts. Mute-warning is more saturated than transmit
  // because "you're currently muted" is the state we want to call
  // attention to (matches the Zoom/Slack red-dot vocabulary).
  const iconColor =
    tone === 'mute-warning'
      ? 'oklch(0.72 0.20 25)'
      : tone === 'transmit'
        ? 'oklch(0.78 0.10 145)'
        : undefined;
  // EVERY chrome toggle gets a half-opaque dark chip background — no
  // more transparent "off" state that lets the avatar's colour bleed
  // through. The mic toggle hue-tints its background to match the
  // icon tone (subtle warm-red when muted, subtle green when
  // transmitting) — same darkness, just nudged in colour so the chip
  // feels coherent with its glyph instead of fighting it. Selected
  // vs unselected is now an icon-brightness signal only; the frame
  // never changes between states.
  const bg =
    tone === 'mute-warning'
      ? 'oklch(0.16 0.06 25 / 0.55)'
      : tone === 'transmit'
        ? 'oklch(0.14 0.04 145 / 0.55)'
        : 'oklch(0.12 0.012 250 / 0.55)';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      aria-pressed={selected}
      title={title}
      className={cn(
        'inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-sm)]',
        'border border-[var(--color-border-subtle)]',
        'outline-none transition-colors backdrop-blur',
        'focus-visible:ring-1 focus-visible:ring-[var(--color-border-strong)]',
        selected ? 'text-[var(--color-ink-1)]' : 'text-[var(--color-ink-3)] hover:text-[var(--color-ink-1)]',
      )}
      style={{
        background: bg,
        ...(iconColor ? { color: iconColor } : null),
      }}
    >
      <Icon size={14} strokeWidth={tone === 'mute-warning' ? 2.1 : 1.7} />
    </button>
  );
}

function StatusPill({ status }: { status: SessionStatus }) {
  const map: Record<SessionStatus, { label: string; color: string; dot: string }> = {
    idle:             { label: 'idle',       color: 'var(--color-ink-4)', dot: 'var(--color-ink-4)'  },
    'fetching-token': { label: 'auth',       color: 'var(--color-warn)',  dot: 'var(--color-warn)'   },
    connecting:       { label: 'connecting', color: 'var(--color-warn)',  dot: 'var(--color-warn)'   },
    connected:        { label: 'live',       color: 'var(--color-good)',  dot: 'var(--color-good)'   },
    error:            { label: 'error',      color: 'var(--color-bad)',   dot: 'var(--color-bad)'    },
  };
  const m = map[status];
  return (
    <span
      className="inline-flex items-center gap-2 rounded-full border border-[var(--color-border-subtle)] bg-[oklch(0.10_0.012_250_/_0.72)] px-2.5 py-1 text-[11px] uppercase tracking-[0.14em] backdrop-blur"
      style={{ color: m.color }}
    >
      <span
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{ background: m.dot, boxShadow: `0 0 8px ${m.dot}` }}
      />
      {m.label}
    </span>
  );
}

function SectionTabs({
  section,
  setSection,
}: {
  section: Section;
  setSection: (s: Section) => void;
}) {
  const tabs: Array<{ id: Section; label: string }> = [
    { id: 'avatar', label: 'avatar' },
    { id: 'frame',  label: 'frame'  },
    { id: 'chroma', label: 'chroma' },
    { id: 'bg',     label: 'stage'  },
  ];
  return (
    // Single row, no wrapping — the panel width auto-fits these 4 tabs.
    <div className="mb-3 flex flex-nowrap gap-1 border-b border-[var(--color-border-subtle)] pb-2">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => setSection(t.id)}
          className={cn(
            'rounded-[var(--radius-sm)] px-2 py-1 text-[11px] uppercase tracking-[0.14em] transition-colors',
            section === t.id
              ? 'bg-[var(--color-bg-elevated)] text-[var(--color-ink-1)]'
              : 'text-[var(--color-ink-3)] hover:text-[var(--color-ink-1)]',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function AvatarPanel({
  status,
  avatarMode,
  setAvatarMode,
  avatarBackground,
  setAvatarBackground,
}: {
  status: SessionStatus;
  avatarMode: AvatarMode;
  setAvatarMode: (m: AvatarMode) => void;
  avatarBackground: AvatarBackground;
  setAvatarBackground: (v: AvatarBackground) => void;
}) {
  const live = status === 'connected' || status === 'connecting';
  const description =
    AVATAR_MODES.find((m) => m.id === avatarMode)?.description ?? '';

  const bgPresets: Array<{ id: AvatarBackground; label: string }> = [
    { id: 'green-screen', label: 'green screen' },
    { id: 'office', label: 'office' },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="mb-1 text-[10px] uppercase tracking-[0.18em] text-[var(--color-ink-3)]">
          mode
        </div>
        <div className="inline-flex rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] overflow-hidden">
          {AVATAR_MODES.map((m) => (
            <button
              key={m.id}
              onClick={() => setAvatarMode(m.id)}
              className={cn(
                'px-3 py-1 text-[11px] uppercase tracking-[0.14em] transition-colors',
                avatarMode === m.id
                  ? 'bg-[var(--color-bg-elevated)] text-[var(--color-ink-1)]'
                  : 'text-[var(--color-ink-3)] hover:text-[var(--color-ink-1)]',
              )}
            >
              {m.label}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-[10px] leading-snug text-[var(--color-ink-3)]">
          {description}
        </p>
      </div>

      <div>
        <div className="mb-1 text-[10px] uppercase tracking-[0.18em] text-[var(--color-ink-3)]">
          background
        </div>
        <div className="inline-flex rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] overflow-hidden">
          {bgPresets.map((p) => (
            <button
              key={p.id}
              disabled={live}
              onClick={() => setAvatarBackground(p.id)}
              title={live ? 'End the session before switching' : `Switch to ${p.label}`}
              className={cn(
                'px-3 py-1 text-[11px] uppercase tracking-[0.14em] transition-colors',
                avatarBackground === p.id
                  ? 'bg-[var(--color-bg-elevated)] text-[var(--color-ink-1)]'
                  : 'text-[var(--color-ink-3)] hover:text-[var(--color-ink-1)]',
                live && 'opacity-40',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-[10px] leading-snug text-[var(--color-ink-3)]">
          Takes effect on the next session start.
        </p>
      </div>
    </div>
  );
}

function FramePanel({
  vignette,
  setVignette,
  zoom,
  setZoom,
  offsetY,
  setOffsetY,
}: {
  vignette: VignetteParams;
  setVignette: (p: Partial<VignetteParams>) => void;
  vignettePreset: string;
  setVignettePreset: (id: string) => void;
  zoom: number;
  setZoom: (v: number) => void;
  offsetY: number;
  setOffsetY: (v: number) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      {/* PAT: per-kiosk avatar framing. Sits at the top of the frame
          tab — it's the transform applied to the rendered avatar
          itself, so it's "more upstream" than the vignette geometry
          below. The vignette has its own `offsetY` (a small fractional
          % shift on the dark ring) — disambiguated here as "Vertical
          offset (px)" vs the vignette block's "offset Y". */}
      <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-ink-3)]">
        avatar framing
      </div>
      <Slider
        label="zoom"
        value={zoom}
        min={0.5} max={3.0} step={0.01}
        format={(v) => `${v.toFixed(2)}×`}
        onChange={setZoom}
      />
      <Slider
        label="vertical offset (px)"
        value={offsetY}
        min={-500} max={500} step={5}
        format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(0)} px`}
        onChange={setOffsetY}
      />

      <div className="mt-1 border-t border-[var(--color-border-subtle)] pt-3" />

      <Toggle
        label="vignette"
        checked={vignette.enabled}
        onChange={(v) => setVignette({ enabled: v })}
      />
      <AspectSlider
        aspect={vignette.aspect}
        onChange={(a) => setVignette({ aspect: a })}
      />
      <Slider
        label="inner"
        value={vignette.inner}
        min={0} max={1.5} step={0.01}
        onChange={(v) => setVignette({ inner: v })}
      />
      <Slider
        label="outer"
        value={vignette.outer}
        min={0} max={2} step={0.01}
        onChange={(v) => setVignette({ outer: v })}
      />
      <Slider
        label="power"
        value={vignette.power}
        min={1} max={12} step={0.1}
        onChange={(v) => setVignette({ power: v })}
      />
      <Slider
        label="intensity"
        value={vignette.intensity}
        min={0} max={1} step={0.01}
        format={(v) => `${Math.round(v * 100)}%`}
        onChange={(v) => setVignette({ intensity: v })}
      />
      <Slider
        label="offset Y"
        value={vignette.offsetY}
        min={-0.4} max={0.4} step={0.005}
        format={(v) => `${(v * 100).toFixed(1)}%`}
        onChange={(v) => setVignette({ offsetY: v })}
      />
      <Toggle
        label="dither"
        checked={vignette.dither}
        onChange={(v) => setVignette({ dither: v })}
      />
    </div>
  );
}

function ChromaPanel({
  shader,
  setShader,
}: {
  shader: ShaderParams;
  setShader: (p: Partial<ShaderParams>) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <Toggle
        label="chroma key"
        checked={shader.keyEnabled}
        onChange={(v) => setShader({ keyEnabled: v })}
      />
      <p className="text-[10px] leading-snug text-[var(--color-ink-3)]">
        Green-screen avatar (Anam Lab) or stand-in image only — stock avatars won't key.
      </p>
      <div className="flex items-center gap-2">
        <label className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-ink-3)]">
          key color
        </label>
        <input
          type="color"
          value={rgbToHex(shader.keyColor)}
          onChange={(e) => setShader({ keyColor: hexToRgb(e.target.value) })}
          className="h-6 w-8 cursor-pointer rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-transparent"
        />
      </div>
      <Slider
        label="similarity"
        value={shader.similarity}
        min={0} max={1} step={0.005}
        onChange={(v) => setShader({ similarity: v })}
      />
      <Slider
        label="smoothness"
        value={shader.smoothness}
        min={0} max={0.5} step={0.005}
        onChange={(v) => setShader({ smoothness: v })}
      />
      <Slider
        label="spill"
        value={shader.spill}
        min={0} max={1} step={0.01}
        onChange={(v) => setShader({ spill: v })}
      />
      <Slider
        label="choke"
        value={shader.choke}
        min={-0.2} max={0.2} step={0.005}
        format={(v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`}
        onChange={(v) => setShader({ choke: v })}
      />
      <Slider
        label="edge despill"
        value={shader.edgeDespill}
        min={0} max={2} step={0.01}
        onChange={(v) => setShader({ edgeDespill: v })}
      />
      <Slider
        label="edge color restore"
        value={shader.edgeColorRestore}
        min={0} max={1} step={0.01}
        onChange={(v) => setShader({ edgeColorRestore: v })}
      />
      <Slider
        label="alpha gamma"
        value={shader.alphaGamma}
        min={0.5} max={2} step={0.01}
        onChange={(v) => setShader({ alphaGamma: v })}
      />

      <div className="mt-2 flex flex-col gap-3 border-t border-[var(--color-border-subtle)] pt-3">
        <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-ink-3)]">
          source quality
        </div>
        <Slider
          label="deblock"
          value={shader.denoise}
          min={0} max={1} step={0.01}
          onChange={(v) => setShader({ denoise: v })}
        />
        <Slider
          label="deblock tolerance"
          value={shader.denoiseSigma}
          min={0.02} max={0.4} step={0.005}
          onChange={(v) => setShader({ denoiseSigma: v })}
        />
        <Slider
          label="sharpen"
          value={shader.sharpen}
          min={0} max={1} step={0.01}
          onChange={(v) => setShader({ sharpen: v })}
        />
        <Slider
          label="render scale"
          value={shader.maxDpr}
          min={0.5} max={3} step={0.1}
          format={(v) => `${v.toFixed(1)}×`}
          onChange={(v) => setShader({ maxDpr: v })}
        />
      </div>
    </div>
  );
}

function StagePanel({
  bg,
  setBg,
  overlay,
  setOverlay,
  captionsEnabled,
  setCaptionsEnabled,
  showTools,
  setShowTools,
  toolBannerPlacement,
  setToolBannerPlacement,
  showActionStream,
  setShowActionStream,
  pttPulseEnabled,
  setPttPulseEnabled,
}: {
  bg: BackgroundPreset;
  setBg: (p: BackgroundPreset) => void;
  overlay: OverlayPreset;
  setOverlay: (p: OverlayPreset) => void;
  captionsEnabled: boolean;
  setCaptionsEnabled: (v: boolean) => void;
  showTools: boolean;
  setShowTools: (v: boolean) => void;
  toolBannerPlacement: ToolBannerPlacement;
  setToolBannerPlacement: (v: ToolBannerPlacement) => void;
  showActionStream: boolean;
  setShowActionStream: (v: boolean) => void;
  pttPulseEnabled: boolean;
  setPttPulseEnabled: (v: boolean) => void;
}) {
  const placements: Array<{ id: ToolBannerPlacement; label: string }> = [
    { id: 'top', label: 'top' },
    { id: 'left', label: 'left' },
  ];
  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="mb-1 text-[10px] uppercase tracking-[0.18em] text-[var(--color-ink-3)]">
          background — behind the avatar
        </div>
        <div className="grid grid-cols-2 gap-1">
          {BG_PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => setBg(p)}
              className={cn(
                'rounded-[var(--radius-sm)] border px-2 py-1.5 text-left text-[11px] transition-colors',
                bg.id === p.id
                  ? 'border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[var(--color-ink-1)]'
                  : 'border-[var(--color-border-subtle)] text-[var(--color-ink-3)] hover:text-[var(--color-ink-1)]',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-1 text-[10px] uppercase tracking-[0.18em] text-[var(--color-ink-3)]">
          overlay — in front of the avatar
        </div>
        <div className="grid grid-cols-2 gap-1">
          {OVERLAY_PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => setOverlay(p)}
              className={cn(
                'rounded-[var(--radius-sm)] border px-2 py-1.5 text-left text-[11px] transition-colors',
                overlay.id === p.id
                  ? 'border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[var(--color-ink-1)]'
                  : 'border-[var(--color-border-subtle)] text-[var(--color-ink-3)] hover:text-[var(--color-ink-1)]',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <Toggle
        label="captions"
        checked={captionsEnabled}
        onChange={setCaptionsEnabled}
      />
      <Toggle
        label="show tools"
        checked={showTools}
        onChange={setShowTools}
      />
      <p className="text-[10px] leading-snug text-[var(--color-ink-3)]">
        Notification banners showing what Pat is doing right now. Pat-mode only.
      </p>
      <Toggle
        label="show action stream (debug)"
        checked={showActionStream}
        onChange={setShowActionStream}
      />
      <p className="text-[10px] leading-snug text-[var(--color-ink-3)]">
        Console-logs every <code>scenario.*</code> event (tag-stream start/end, every
        <code>scenario.action</code>: prose, verbatim splice, slide-nav, fragment, tool).
        Useful for verifying the agent is emitting the right tags when bullets aren't
        advancing as expected.
      </p>
      {showTools && (
        <div className="grid grid-cols-2 gap-1">
          {placements.map((opt) => (
            <button
              key={opt.id}
              onClick={() => setToolBannerPlacement(opt.id)}
              className={cn(
                'rounded-[var(--radius-sm)] border px-2 py-1.5 text-left text-[11px] transition-colors',
                toolBannerPlacement === opt.id
                  ? 'border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[var(--color-ink-1)]'
                  : 'border-[var(--color-border-subtle)] text-[var(--color-ink-3)] hover:text-[var(--color-ink-1)]',
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}

      <div className="mt-1 border-t border-[var(--color-border-subtle)] pt-3 flex flex-col gap-1">
        <Toggle
          label="ptt spinner"
          checked={pttPulseEnabled}
          onChange={setPttPulseEnabled}
        />
        <p className="text-[10px] leading-snug text-[var(--color-ink-3)]">
          Orbiting spinner on the PTT button after release, until Pat starts speaking.
        </p>
      </div>
    </div>
  );
}

function rgbToHex(rgb: [number, number, number]): string {
  const toByte = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  const r = toByte(rgb[0]).toString(16).padStart(2, '0');
  const g = toByte(rgb[1]).toString(16).padStart(2, '0');
  const b = toByte(rgb[2]).toString(16).padStart(2, '0');
  return `#${r}${g}${b}`;
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return [0, 1, 0];
  const v = m[1]!;
  return [
    parseInt(v.slice(0, 2), 16) / 255,
    parseInt(v.slice(2, 4), 16) / 255,
    parseInt(v.slice(4, 6), 16) / 255,
  ];
}
