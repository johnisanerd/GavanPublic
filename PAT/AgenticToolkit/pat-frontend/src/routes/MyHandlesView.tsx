import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { QRCodeSVG } from 'qrcode.react';
import { ExternalLink, Link2, Mail, MessageSquare, Phone, Plus, Send, User as UserIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { postJson, useApiData } from '@/lib/api';

type PairingChannelId = 'signal' | 'telegram' | 'slack' | 'phone';
interface PairingTarget {
  id: PairingChannelId;
  label: string;
  contact: string;
  linkTemplate: string | null;
  prefill: boolean;
  instructions: string;
}

const CHANNEL_ICON: Record<PairingChannelId, typeof Phone> = {
  signal: MessageSquare,
  telegram: Send,
  slack: MessageSquare,
  phone: Phone,
};

// Operator-only routes authenticate on the same-origin Clerk session cookie, so
// these calls pass token=null (the cookie rides along automatically).

interface Identifier {
  kind: string;
  value: string;
  verified: number;
}
interface Handle {
  user_id: string;
  kind: string;
  link_method: string;
}
interface Me {
  email: string;
  firstName?: string;
  person: { id: string; first_name: string; last_name: string } | null;
  identifiers: Identifier[];
  handles: Handle[];
}

interface PairingCode {
  id: string;
  code: string;
  expires_at: string;
  // present on the poll once paired:
  consumed_at?: string | null;
  linked_user_id?: string | null;
}

/** Platform prefix → a glyph/label. email/phone get an icon; the rest show kind. */
function HandleChip({ userId, kind, method }: { userId: string; kind: string; method?: string }) {
  const icon =
    kind === 'email' ? <Mail className="size-3" /> : kind === 'phone' ? <Phone className="size-3" /> : (
      <UserIcon className="size-3" />
    );
  return (
    <span className="bg-muted flex items-center gap-1.5 rounded-md px-2 py-1 font-mono text-xs">
      {icon}
      <span>{userId}</span>
      {method && <span className="text-muted-foreground/60">({method})</span>}
    </span>
  );
}

export function MyHandlesView() {
  const meQ = useApiData<Me>('/api/me', null);
  const [pairOpen, setPairOpen] = useState(false);

  const me = meQ.data;
  const handles = me?.handles ?? [];
  const identifiers = me?.identifiers ?? [];

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 p-4">
      <div className="flex items-center gap-3">
        <span className="font-mono text-sm">my handles</span>
        {me && <Badge variant="secondary">{handles.length}</Badge>}
        <p className="text-muted-foreground font-mono text-[10px] uppercase tracking-wide">
          channels linked to you
        </p>
        <div className="ml-auto">
          <Button size="sm" className="gap-1.5" disabled={!me?.person} onClick={() => setPairOpen(true)}>
            <Plus className="size-3.5" />
            Link new handle
          </Button>
        </div>
      </div>

      {meQ.error && (
        <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-xs">
          {meQ.error.message}
        </div>
      )}

      <div className="min-h-0 min-w-0 flex-1 overflow-auto rounded-md border p-3">
        {meQ.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-2/3" />
          </div>
        ) : (
          <div className="space-y-4">
            {/* Identifiers — how Pat recognizes you (phone / email). */}
            <section className="space-y-2">
              <p className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
                Identifiers
              </p>
              {identifiers.length === 0 ? (
                <p className="text-muted-foreground text-xs">None yet.</p>
              ) : (
                <ul className="flex flex-wrap gap-1.5">
                  {identifiers.map((id) => (
                    <li key={`${id.kind}:${id.value}`}>
                      <HandleChip userId={id.value} kind={id.kind} />
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* Linked handles — the channels you can talk to Pat from. */}
            <section className="space-y-2">
              <p className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
                Linked handles
              </p>
              {handles.length === 0 ? (
                <div className="text-muted-foreground flex flex-col items-start gap-2 text-xs">
                  <p>No channels linked yet.</p>
                  <Button size="sm" variant="outline" className="gap-1.5" disabled={!me?.person} onClick={() => setPairOpen(true)}>
                    <Link2 className="size-3.5" />
                    Link your first handle
                  </Button>
                </div>
              ) : (
                <ul className="flex flex-wrap gap-1.5">
                  {handles.map((h) => (
                    <li key={h.user_id}>
                      <HandleChip userId={h.user_id} kind={h.kind} method={h.link_method} />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </div>

      <PairingDialog open={pairOpen} onClose={() => setPairOpen(false)} />
    </div>
  );
}

const PAIR_WINDOW_MS = 5 * 60 * 1000;

/**
 * "Link new handle" modal. On open it mints a pairing code, shows it with a
 * countdown, and polls until a handle consumes it (then flips to success). The
 * operator messages the code FROM the new channel; nanoclaw links it on the
 * inbound path.
 */
function PairingDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const targetsQ = useApiData<{ targets: PairingTarget[] }>('/api/pairing-targets', null);
  const targets = targetsQ.data?.targets ?? [];
  const [tab, setTab] = useState<PairingChannelId>('signal');
  const [code, setCode] = useState<PairingCode | null>(null);
  const [paired, setPaired] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const mint = useMutation({
    mutationFn: () => postJson<PairingCode>('/api/pairing-codes', {}, null),
    onSuccess: (c) => {
      setCode(c);
      setPaired(null);
      setNow(Date.now());
    },
  });

  // Mint a fresh code each time the dialog opens; tear everything down on close.
  useEffect(() => {
    if (open) {
      mint.mutate();
    } else {
      setCode(null);
      setPaired(null);
      mint.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const expiresAt = code ? new Date(code.expires_at).getTime() : 0;
  const remainingMs = Math.max(0, expiresAt - now);
  const expired = !!code && remainingMs === 0;

  // 1s countdown ticker while a live, unpaired code is on screen.
  useEffect(() => {
    if (!open || !code || paired || expired) return;
    tickRef.current = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, [open, code, paired, expired]);

  // Poll the code's status until it's consumed or expires. On success, refetch
  // /api/me so the My Handles list shows the freshly linked handle.
  useEffect(() => {
    if (!open || !code || paired || expired) return;
    const id = code.id;
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/pairing-codes/${encodeURIComponent(id)}`);
        if (!res.ok) return;
        const row = (await res.json()) as PairingCode;
        if (row.linked_user_id) {
          setPaired(row.linked_user_id);
          qc.invalidateQueries({ queryKey: ['api', '/api/me', null] });
        }
      } catch {
        /* transient — keep polling */
      }
    }, 2000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [open, code, paired, expired, qc]);

  const mmss = useMemo(() => {
    const s = Math.ceil(remainingMs / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, [remainingMs]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Link a new handle</DialogTitle>
          <DialogDescription>
            Send a message containing this code <strong>from the new channel</strong> (Signal,
            Telegram, a phone text, …). Pat links it to you the moment it arrives.
          </DialogDescription>
        </DialogHeader>

        {paired ? (
          <div className="space-y-3 py-2 text-center">
            <div className="text-2xl">✓</div>
            <p className="text-sm font-medium">Paired</p>
            <p className="text-muted-foreground font-mono text-xs break-all">{paired}</p>
            <Button className="w-full" onClick={onClose}>
              Done
            </Button>
          </div>
        ) : mint.isPending || !code ? (
          <div className="space-y-3 py-2">
            <Skeleton className="mx-auto h-14 w-48" />
            <Skeleton className="mx-auto h-4 w-24" />
          </div>
        ) : mint.error ? (
          <div className="space-y-3 py-2">
            <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-xs">
              {mint.error.message}
            </div>
            <Button variant="outline" className="w-full" onClick={() => mint.mutate()}>
              Try again
            </Button>
          </div>
        ) : expired ? (
          <div className="space-y-3 py-4 text-center">
            <div className="font-mono text-4xl font-bold tracking-[0.3em] tabular-nums opacity-40">
              {code.code}
            </div>
            <p className="text-muted-foreground text-xs">This code expired.</p>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => mint.mutate()}>
              <Plus className="size-3.5" />
              New code
            </Button>
          </div>
        ) : (
          <div className="space-y-3 py-1">
            {/* The code — readable at a glance + manual fallback for any channel.
                Dimmed on the Phone tab, where Pat links by caller ID (no code). */}
            <div
              className={`text-center font-mono text-3xl font-bold tracking-[0.3em] tabular-nums transition-opacity ${
                tab === 'phone' ? 'opacity-25' : ''
              }`}
            >
              {code.code}
            </div>

            <Tabs value={tab} onValueChange={(v) => setTab(v as PairingChannelId)}>
              <TabsList className="w-full">
                {targets.map((t) => {
                  const Icon = CHANNEL_ICON[t.id];
                  return (
                    <TabsTrigger key={t.id} value={t.id} className="gap-1">
                      <Icon className="size-3.5" />
                      {t.label}
                    </TabsTrigger>
                  );
                })}
              </TabsList>

              {targets.map((t) => {
                const link = t.linkTemplate?.replace('{code}', encodeURIComponent(code.code)) ?? null;
                return (
                  <TabsContent key={t.id} value={t.id} className="pt-1">
                    <div className="flex flex-col items-center gap-3 text-center">
                      {link && t.id !== 'slack' ? (
                        <a
                          href={link}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded-lg border bg-white p-2.5"
                          aria-label={`Open ${t.label}`}
                        >
                          <QRCodeSVG value={link} size={140} marginSize={0} />
                        </a>
                      ) : (
                        <div className="text-muted-foreground bg-muted/40 flex size-[160px] items-center justify-center rounded-lg border p-4 text-xs">
                          {t.label} has no scan link — DM the bot below.
                        </div>
                      )}

                      <p className="text-muted-foreground text-xs leading-snug">{t.instructions}</p>

                      {link ? (
                        <Button asChild variant="outline" size="sm" className="gap-1.5">
                          <a href={link} target="_blank" rel="noreferrer">
                            <ExternalLink className="size-3.5" />
                            {t.id === 'phone' ? `Call ${t.contact}` : `Open ${t.label}`}
                          </a>
                        </Button>
                      ) : (
                        <span className="bg-muted rounded-md px-2 py-1 font-mono text-xs">{t.contact}</span>
                      )}
                    </div>
                  </TabsContent>
                );
              })}
            </Tabs>

            <p className="text-muted-foreground text-center font-mono text-xs">
              expires in {mmss}
              <span className="mx-1.5">·</span>
              <span className="inline-flex items-center gap-1">
                <span className="bg-primary inline-block size-1.5 animate-pulse rounded-full" />
                waiting…
              </span>
            </p>
            {/* thin progress bar of the remaining window */}
            <div className="bg-muted h-1 w-full overflow-hidden rounded-full">
              <div
                className="bg-primary h-full transition-[width] duration-1000 ease-linear"
                style={{ width: `${(remainingMs / PAIR_WINDOW_MS) * 100}%` }}
              />
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
