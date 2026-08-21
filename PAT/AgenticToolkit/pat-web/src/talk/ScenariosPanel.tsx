/**
 * ScenariosPanel — operator's "pick or upload a scenario" surface.
 *
 * Lives as a dismissable side-sheet over the stage column when the
 * operator clicks the chrome's Scenarios button. Two views:
 *   - List: shows provisioned scenarios. Click "Open deck" to open the
 *     deck route in a new tab, or "Start call" to launch a fresh
 *     anam-web call against the scenario's messaging group.
 *   - Upload: drag-drop or paste a pamphlet markdown. POSTs to the
 *     pat-web upload endpoint, which translates via Opus + validates
 *     + provisions through nanoclaw. Surfaces validation issues
 *     inline.
 *
 * Styling: Palisade brand — Stone Green sheet on dark video bg,
 * Steel Grey text, DM Sans / DM Mono.
 */
import { useEffect, useState } from 'react';
import type { ComponentType } from 'react';
import { patWebHeaders } from '@/lib/pat-web-token';
import {
  X,
  FileUp,
  Loader2,
  ExternalLink,
  AlertCircle,
  Play,
  MessageSquare,
  Crosshair,
  UsersRound,
  Bot,
  Terminal,
  Server,
  Globe,
  ImagePlus,
  Mic,
  AppWindow,
  Presentation as PresentationIcon,
  Zap,
  type LucideProps,
} from 'lucide-react';

/** Capability badges shown on each scenario row. The set is open —
 *  new keys are fine; unknown keys fall back to a generic dot. */
type Capability =
  | 'signal'       // live Signal sends to audience
  | 'drone'        // live drone control (operator-driven targeting)
  | 'prompt'       // live LLM interaction on stage
  | 'code-exec'    // runs code live in front of audience
  | 'app-dev'      // builds a working application live
  | 'web-browse'   // live web browsing demo
  | 'image-gen'    // live image generation
  | 'voice'        // live voice / TTS demo
  | 'mass-channel' // multi-avatar / mass-channel reach (formerly 'influence')
  | 'self-mod';    // self-modification / model-on-model

interface CapabilityMeta {
  icon: ComponentType<LucideProps>;
  label: string;
}

const CAPABILITIES: Record<Capability, CapabilityMeta> = {
  signal: { icon: MessageSquare, label: 'Live Signal sends' },
  // PAT: Crosshair reads as remote targeting/control — closer to a
  // drone-control vibe than Plane (lucide has no literal Drone glyph).
  drone: { icon: Crosshair, label: 'Live drone control' },
  prompt: { icon: Bot, label: 'Live LLM interaction' },
  'code-exec': { icon: Terminal, label: 'Live code execution' },
  'app-dev': { icon: AppWindow, label: 'Live application build' },
  'web-browse': { icon: Globe, label: 'Live web browsing' },
  'image-gen': { icon: ImagePlus, label: 'Live image generation' },
  voice: { icon: Mic, label: 'Live voice demo' },
  // PAT: multi-avatar — UsersRound conveys "multiple personas /
  // simultaneous reach" better than Megaphone, matches the icon brief.
  'mass-channel': { icon: UsersRound, label: 'Multiple avatars' },
  'self-mod': { icon: Server, label: 'Self-modification demo' },
};

type ScenarioKind = 'presentation' | 'demo';

interface KindMeta {
  icon: ComponentType<LucideProps>;
  label: string;
}
const KIND_META: Record<ScenarioKind, KindMeta> = {
  presentation: { icon: PresentationIcon, label: 'Presentation' },
  demo: { icon: Zap, label: 'Demo' },
};

interface ScenarioRow {
  slug: string;
  kind: ScenarioKind;
  title: string;
  agent_group_id?: string;
  messaging_group_id?: string;
  created_at: string;
  display?: {
    slide_count?: number;
    duration_budget_s?: number;
    cover_title?: string;
  };
  /** Hardcoded illustrative rows that point at dev-fixture decks
   *  rather than provisioned agent groups. Shown alongside real
   *  scenarios with a subdued visual treatment. */
  placeholder?: boolean;
  /** Where "Preview slides" goes — overrides the default
   *  /decks/<slug>?bus=... URL when the row points at a /_dev/*
   *  fixture route. Presentations only. */
  deck_url?: string;
  /** Capability badges shown on the row — what live affordances this
   *  scenario uses (Signal sends, drone control, code exec, …).
   *  Decorative for v0; speculative real implementation later. */
  capabilities?: Capability[];
}

/** Illustrative scenario rows the presenter system is being built for.
 *  The self-replication one ships with a rendered preview deck via
 *  /_dev/palisade; the others are unimplemented affordances clicked
 *  through the unimplemented modal. */
const PLACEHOLDER_SCENARIOS: ScenarioRow[] = [
  {
    slug: '_shutdown-resistance',
    kind: 'presentation',
    title: 'Shutdown Resistance',
    created_at: '2026-05-16T00:00:00Z',
    placeholder: true,
  },
  {
    slug: '_mass-influence',
    kind: 'demo',
    title: 'Mass Influence Campaigns',
    created_at: '2026-05-16T00:00:00Z',
    placeholder: true,
    capabilities: ['mass-channel'],
  },
  {
    slug: '_weaponized-drones',
    kind: 'demo',
    title: 'Weaponized Drone Manufacture',
    created_at: '2026-05-16T00:00:00Z',
    placeholder: true,
    capabilities: ['drone'],
  },
  {
    slug: '_recursive-self-improvement',
    kind: 'demo',
    title: 'Recursive Self Improvement',
    created_at: '2026-05-16T00:00:00Z',
    placeholder: true,
    capabilities: ['self-mod'],
  },
  {
    slug: '_application-development',
    kind: 'demo',
    title: 'Application Development',
    created_at: '2026-05-16T00:00:00Z',
    placeholder: true,
    capabilities: ['app-dev'],
  },
];

interface UploadState {
  busy: boolean;
  pamphlet: string;
  title: string;
  errorMsg?: string;
  issues?: string[];
  lastSuccess?: string;
}

export interface ScenariosPanelProps {
  open: boolean;
  onClose: () => void;
}

const PALETTE = {
  stone: '#F2F3F0',
  steel: '#29303E',
  steelMuted: 'rgba(41, 48, 62, 0.55)',
  steelHairline: 'rgba(41, 48, 62, 0.2)',
};

const FONT_SANS = '"DM Sans", system-ui, -apple-system, sans-serif';
const FONT_MONO = '"DM Mono", ui-monospace, "SF Mono", Menlo, monospace';

/** Lazy-load brand fonts when the panel mounts the first time. */
function ensureBrandFonts(): void {
  if (typeof document === 'undefined') return;
  if (document.querySelector('link[data-pat-fonts]')) return;
  const pc1 = document.createElement('link');
  pc1.rel = 'preconnect';
  pc1.href = 'https://fonts.googleapis.com';
  pc1.setAttribute('data-pat-fonts', 'pc1');
  const pc2 = document.createElement('link');
  pc2.rel = 'preconnect';
  pc2.href = 'https://fonts.gstatic.com';
  pc2.crossOrigin = 'anonymous';
  pc2.setAttribute('data-pat-fonts', 'pc2');
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href =
    'https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&display=swap';
  css.setAttribute('data-pat-fonts', 'css');
  document.head.appendChild(pc1);
  document.head.appendChild(pc2);
  document.head.appendChild(css);
}

/** Display title: drop everything after a colon-space subtitle marker.
 *  "AI Self-Replication: From Theory to Demonstration" → "AI Self-Replication".
 *  Cards stay compact and consistent without making authors rewrite
 *  manifest.yaml titles. */
function displayTitle(title: string): string {
  const idx = title.indexOf(': ');
  return idx > 0 ? title.slice(0, idx) : title;
}

function formatDuration(seconds?: number): string {
  if (!seconds) return '—';
  const m = Math.round(seconds / 60);
  return `~${m}m`;
}

function relativeTime(iso: string): string {
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return iso;
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function ScenariosPanel({ open, onClose }: ScenariosPanelProps) {
  useEffect(() => {
    if (open) ensureBrandFonts();
  }, [open]);

  const [scenarios, setScenarios] = useState<ScenarioRow[]>([]);
  const [view, setView] = useState<'list' | 'upload'>('list');
  const [refreshTick, setRefreshTick] = useState(0);
  const [upload, setUpload] = useState<UploadState>({
    busy: false,
    pamphlet: '',
    title: '',
  });

  // Refresh the list whenever the panel opens or after an upload.
  // Real scenarios (server-provisioned, actually launchable) lead;
  // placeholders ("coming soon" illustrations) trail.
  useEffect(() => {
    if (!open) return;
    let mounted = true;
    fetch('/api/scenarios')
      .then((r) => r.json())
      .then((data) => {
        if (!mounted) return;
        const real = (data?.scenarios ?? []) as ScenarioRow[];
        setScenarios([...real, ...PLACEHOLDER_SCENARIOS]);
      })
      .catch(() => {
        if (mounted) setScenarios([...PLACEHOLDER_SCENARIOS]);
      });
    return () => {
      mounted = false;
    };
  }, [open, refreshTick]);

  async function submitUpload(): Promise<void> {
    if (!upload.pamphlet.trim()) {
      setUpload((u) => ({ ...u, errorMsg: 'paste a pamphlet first' }));
      return;
    }
    setUpload((u) => ({ ...u, busy: true, errorMsg: undefined, issues: undefined }));
    try {
      const res = await fetch('/api/scenarios/upload', {
        method: 'POST',
        headers: patWebHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          pamphlet: upload.pamphlet,
          title: upload.title || undefined,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string; issues?: string[] } | null;
        setUpload((u) => ({
          ...u,
          busy: false,
          errorMsg: body?.error ?? `upload failed (${res.status})`,
          issues: body?.issues,
        }));
        return;
      }
      const body = (await res.json()) as { scenario: ScenarioRow };
      setUpload({
        busy: false,
        pamphlet: '',
        title: '',
        lastSuccess: body.scenario.slug,
      });
      setRefreshTick((t) => t + 1);
      setView('list');
    } catch (e) {
      setUpload((u) => ({
        ...u,
        busy: false,
        errorMsg: e instanceof Error ? e.message : String(e),
      }));
    }
  }

  const [unimplementedTitle, setUnimplementedTitle] = useState<string | null>(null);

  function launchScenario(row: ScenarioRow): void {
    // Placeholders never launch — even if they have a deck_url
    // (which only powers "Preview slides"). Real scenarios have a
    // provisioned agent_group_id + messaging_group_id; placeholders
    // don't, so launching one would route the avatar session to a
    // non-existent mg and fail with "cannot auto-provision."
    if (row.placeholder) {
      setUnimplementedTitle(row.title);
      return;
    }
    // Navigate pat-web to scenario-mode for this slug. The full
    // reload is intentional — it ensures the Anam session restarts
    // against the scenario's messaging group (the platform_id
    // routing key flips to anam-web:scenario-<slug>) and the deck
    // pane subscribes to the scenario's slide-bus.
    const url = new URL(window.location.href);
    url.searchParams.set('scenario', row.slug);
    url.hash = '';
    window.location.assign(url.toString());
  }

  function previewDeckOnly(row: ScenarioRow): void {
    if (row.placeholder && !row.deck_url) {
      setUnimplementedTitle(row.title);
      return;
    }
    const url = row.deck_url ?? `/decks/${row.slug}`;
    window.open(url, '_blank', 'noopener');
  }

  if (!open) return null;

  return (
    <div
      className="absolute inset-0 z-50 flex"
      style={{ pointerEvents: 'auto', fontFamily: FONT_SANS }}
      onClick={onClose}
    >
      {/* Dim the avatar behind. */}
      <div
        style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)' }}
      />
      <aside
        onClick={(e) => e.stopPropagation()}
        style={{
          marginLeft: 'auto',
          width: 'min(640px, 100%)',
          height: '100%',
          background: PALETTE.stone,
          color: PALETTE.steel,
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '-12px 0 32px rgba(0,0,0,0.35)',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <Header view={view} setView={setView} onClose={onClose} />
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '0 32px 24px' }}>
          {view === 'list' && (
            <ListView
              scenarios={scenarios}
              onLaunch={launchScenario}
              onPreviewDeck={previewDeckOnly}
              onUploadNew={() => setView('upload')}
            />
          )}
          {view === 'upload' && (
            <UploadView state={upload} setState={setUpload} onSubmit={submitUpload} />
          )}
        </div>
        {unimplementedTitle && (
          <UnimplementedModal
            title={unimplementedTitle}
            onClose={() => setUnimplementedTitle(null)}
          />
        )}
      </aside>
    </div>
  );
}

function CapabilityIcons({ capabilities }: { capabilities: Capability[] }) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
      {capabilities.map((c) => {
        const meta = CAPABILITIES[c];
        if (!meta) return null;
        const Icon = meta.icon;
        return (
          <span
            key={c}
            title={meta.label}
            aria-label={meta.label}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 26,
              height: 26,
              border: `1px solid ${PALETTE.steelHairline}`,
              background: 'rgba(255,255,255,0.5)',
              color: PALETTE.steel,
              borderRadius: 999,
            }}
          >
            <Icon size={13} strokeWidth={1.8} />
          </span>
        );
      })}
    </div>
  );
}

function UnimplementedModal({
  title,
  onClose,
}: {
  title: string;
  onClose: () => void;
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'absolute',
        inset: 0,
        background: 'rgba(41, 48, 62, 0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        zIndex: 10,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: PALETTE.stone,
          color: PALETTE.steel,
          padding: '28px 32px',
          maxWidth: 440,
          width: '100%',
          boxShadow: '0 12px 36px rgba(0,0,0,0.4)',
          fontFamily: FONT_SANS,
        }}
      >
        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: 11,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: PALETTE.steelMuted,
          }}
        >
          Coming soon
        </div>
        <h3 style={{ fontSize: 22, fontWeight: 500, margin: '4px 0 12px 0', letterSpacing: '-0.015em' }}>
          {title}
        </h3>
        <p style={{ margin: '0 0 20px 0', fontSize: 14, lineHeight: 1.55, color: PALETTE.steel }}>
          This scenario isn't authored yet. Drop a pamphlet into the
          {' '}<strong>Upload</strong> tab to create a real version.
        </p>
        <button
          onClick={onClose}
          style={{
            background: PALETTE.steel,
            color: PALETTE.stone,
            border: 0,
            padding: '8px 16px',
            cursor: 'pointer',
            fontFamily: FONT_MONO,
            fontSize: 11,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
          }}
        >
          Got it
        </button>
      </div>
    </div>
  );
}

function Header({
  view,
  setView,
  onClose,
}: {
  view: 'list' | 'upload';
  setView: (v: 'list' | 'upload') => void;
  onClose: () => void;
}) {
  return (
    <div
      style={{
        padding: '16px 32px 12px',
        borderBottom: `1px solid ${PALETTE.steelHairline}`,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0, fontSize: 28, fontWeight: 500, letterSpacing: '-0.015em' }}>
          Scenarios
        </h2>
        <button
          onClick={onClose}
          aria-label="close scenarios"
          style={{
            background: 'transparent',
            border: 0,
            cursor: 'pointer',
            color: PALETTE.steelMuted,
            padding: 8,
            margin: -8,
          }}
        >
          <X size={18} />
        </button>
      </div>
      <nav style={{ display: 'flex', gap: 4 }}>
        {(['list', 'upload'] as const).map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            style={{
              background: 'transparent',
              border: 0,
              cursor: 'pointer',
              padding: '6px 0',
              marginRight: 18,
              fontFamily: FONT_MONO,
              fontSize: 11,
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: view === v ? PALETTE.steel : PALETTE.steelMuted,
              borderBottom: view === v ? `2px solid ${PALETTE.steel}` : '2px solid transparent',
            }}
          >
            {v}
          </button>
        ))}
      </nav>
    </div>
  );
}

function ListView({
  scenarios,
  onLaunch,
  onPreviewDeck,
  onUploadNew,
}: {
  scenarios: ScenarioRow[];
  onLaunch: (row: ScenarioRow) => void;
  onPreviewDeck: (row: ScenarioRow) => void;
  onUploadNew: () => void;
}) {
  if (scenarios.length === 0) {
    return (
      <div style={{ paddingTop: 64, textAlign: 'center', color: PALETTE.steelMuted }}>
        <p style={{ fontSize: 14, margin: '0 0 12px 0' }}>No scenarios yet.</p>
        <button
          onClick={onUploadNew}
          style={{
            background: PALETTE.steel,
            color: PALETTE.stone,
            border: 0,
            padding: '8px 16px',
            cursor: 'pointer',
            fontFamily: FONT_MONO,
            fontSize: 11,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
          }}
        >
          Upload a pamphlet
        </button>
      </div>
    );
  }
  return (
    <div style={{ paddingTop: 8 }}>
      {scenarios.map((s) => {
        const isReady = Boolean(s.deck_url) || !s.placeholder;
        const kindMeta = KIND_META[s.kind];
        const KindIcon = kindMeta.icon;
        const showPreviewSlides = s.kind === 'presentation' && (Boolean(s.deck_url) || !s.placeholder);
        return (
          <article
            key={s.slug}
            style={{
              padding: '10px 0',
              borderBottom: `1px solid ${PALETTE.steelHairline}`,
              display: 'flex',
              gap: 12,
              alignItems: 'center',
              opacity: isReady ? 1 : 0.7,
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              {/* Top row: kind icon + capability icons (small) */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                <span
                  title={kindMeta.label}
                  aria-label={kindMeta.label}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 22,
                    height: 22,
                    color: PALETTE.steelMuted,
                  }}
                >
                  <KindIcon size={14} strokeWidth={1.8} />
                </span>
                {s.capabilities && s.capabilities.length > 0 && (
                  <CapabilityIcons capabilities={s.capabilities} />
                )}
                {s.kind === 'presentation' && s.display?.slide_count != null && (
                  <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: PALETTE.steelMuted, letterSpacing: '0.06em' }}>
                    {s.display.slide_count} slides · {formatDuration(s.display.duration_budget_s)}
                  </span>
                )}
                {!s.placeholder && (
                  <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: PALETTE.steelMuted, letterSpacing: '0.06em' }}>
                    {relativeTime(s.created_at)}
                  </span>
                )}
              </div>
              <h3 style={{ fontSize: 17, fontWeight: 500, margin: 0, letterSpacing: '-0.01em', lineHeight: 1.25 }}>
                {displayTitle(s.title)}
              </h3>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0, alignItems: 'flex-end' }}>
              <button
                onClick={() => onLaunch(s)}
                style={{
                  background: PALETTE.steel,
                  border: `1px solid ${PALETTE.steel}`,
                  color: PALETTE.stone,
                  padding: '6px 12px',
                  cursor: 'pointer',
                  fontFamily: FONT_MONO,
                  fontSize: 10,
                  letterSpacing: '0.16em',
                  textTransform: 'uppercase',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  whiteSpace: 'nowrap',
                }}
              >
                <Play size={12} /> Launch
              </button>
              {showPreviewSlides && (
                <button
                  onClick={() => onPreviewDeck(s)}
                  style={{
                    background: 'transparent',
                    border: 0,
                    color: PALETTE.steelMuted,
                    padding: 0,
                    cursor: 'pointer',
                    fontFamily: FONT_MONO,
                    fontSize: 9,
                    letterSpacing: '0.14em',
                    textTransform: 'uppercase',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    whiteSpace: 'nowrap',
                  }}
                >
                  <ExternalLink size={10} /> Preview
                </button>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}

function UploadView({
  state,
  setState,
  onSubmit,
}: {
  state: UploadState;
  setState: (u: UploadState | ((s: UploadState) => UploadState)) => void;
  onSubmit: () => void;
}) {
  return (
    <div style={{ paddingTop: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5, color: PALETTE.steel }}>
        Paste a pamphlet in markdown — script + slide content + off-script notes. The translator (Opus)
        converts it into a typed slide deck, validates content budgets, and provisions an agent group
        that can deliver it.
      </p>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ fontFamily: FONT_MONO, fontSize: 11, letterSpacing: '0.16em', textTransform: 'uppercase', color: PALETTE.steelMuted }}>
          Optional title override
        </span>
        <input
          type="text"
          value={state.title}
          onChange={(e) => setState((s) => ({ ...s, title: e.target.value }))}
          placeholder="Derived from manifest if blank"
          style={{
            padding: '10px 12px',
            background: 'rgba(255,255,255,0.5)',
            border: `1px solid ${PALETTE.steelHairline}`,
            borderRadius: 0,
            color: PALETTE.steel,
            fontFamily: FONT_SANS,
            fontSize: 14,
            outline: 'none',
          }}
        />
      </label>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
        <span style={{ fontFamily: FONT_MONO, fontSize: 11, letterSpacing: '0.16em', textTransform: 'uppercase', color: PALETTE.steelMuted }}>
          Pamphlet markdown
        </span>
        <textarea
          value={state.pamphlet}
          onChange={(e) => setState((s) => ({ ...s, pamphlet: e.target.value }))}
          placeholder="# Briefing title&#10;&#10;## Slide 1 — ..."
          rows={18}
          style={{
            padding: '12px 14px',
            background: 'rgba(255,255,255,0.5)',
            border: `1px solid ${PALETTE.steelHairline}`,
            borderRadius: 0,
            color: PALETTE.steel,
            fontFamily: FONT_MONO,
            fontSize: 12,
            lineHeight: 1.5,
            resize: 'vertical',
            outline: 'none',
          }}
        />
      </label>

      {state.errorMsg && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', background: 'rgba(198, 75, 42, 0.1)', padding: 12, color: '#7a2a18', fontSize: 13 }}>
          <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600 }}>{state.errorMsg}</div>
            {state.issues && state.issues.length > 0 && (
              <ul style={{ margin: '6px 0 0 18px', padding: 0, fontFamily: FONT_MONO, fontSize: 11 }}>
                {state.issues.slice(0, 10).map((iss, i) => (
                  <li key={i}>{iss}</li>
                ))}
                {state.issues.length > 10 && <li>… {state.issues.length - 10} more</li>}
              </ul>
            )}
          </div>
        </div>
      )}

      <button
        onClick={onSubmit}
        disabled={state.busy}
        style={{
          background: PALETTE.steel,
          color: PALETTE.stone,
          border: 0,
          padding: '12px 18px',
          cursor: state.busy ? 'wait' : 'pointer',
          fontFamily: FONT_MONO,
          fontSize: 11,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          display: 'inline-flex',
          gap: 8,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: state.busy ? 0.6 : 1,
          alignSelf: 'flex-start',
        }}
      >
        {state.busy ? <Loader2 size={14} className="animate-spin" /> : <FileUp size={14} />}
        {state.busy ? 'Translating + provisioning…' : 'Translate & provision'}
      </button>
    </div>
  );
}
