import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Link2, Mail, Phone, Plus, Trash2, User as UserIcon, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { postJson, useApiData } from '@/lib/api';
import { cn } from '@/lib/utils';

interface Identifier {
  kind: string;
  value: string;
  verified: number;
}
interface PersonHandle {
  user_id: string;
  link_method: string;
}
interface PersonRow {
  id: string;
  first_name: string;
  last_name: string;
  role: string | null;
  identifiers: Identifier[];
  handles: PersonHandle[];
}
interface PeopleResp {
  people: PersonRow[];
}

interface Handle {
  user_id: string;
  kind: string;
  linked_person_id: string | null;
}
interface HandlesResp {
  kinds: string[];
  handles: Handle[];
}

const fullName = (p: PersonRow) => `${p.first_name} ${p.last_name}`.trim();

function roleBadge(role: string | null) {
  if (!role) return <Badge variant="outline">none</Badge>;
  if (role === 'admin') return <Badge>admin</Badge>;
  return <Badge variant="secondary">{role}</Badge>;
}

/** email/phone get a glyph; everything else (telegram, signal, …) shows its kind. */
function IdentifierChip({ id }: { id: Identifier }) {
  const icon =
    id.kind === 'email' ? <Mail className="size-3" /> : id.kind === 'phone' ? <Phone className="size-3" /> : null;
  return (
    <Badge variant={id.verified ? 'secondary' : 'outline'} className="font-mono">
      {icon}
      {!icon && <span className="text-muted-foreground">{id.kind}:</span>}
      {id.value}
    </Badge>
  );
}

export function PeopleView({ token }: { token: string | null }) {
  const peopleQ = useApiData<PeopleResp>('/api/people', token);
  const [manage, setManage] = useState<PersonRow | null>(null);
  const [deleting, setDeleting] = useState<PersonRow | null>(null);

  const people = peopleQ.data?.people ?? [];

  // Keep the open dialog's data fresh after a refetch (link/unlink mutates the
  // person's handle set). Re-resolve from the latest list by id rather than
  // holding a stale snapshot.
  const managed = manage ? (people.find((p) => p.id === manage.id) ?? manage) : null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 p-4">
      <div className="flex items-center gap-3">
        <span className="font-mono text-sm">people</span>
        {peopleQ.data && <Badge variant="secondary">{people.length}</Badge>}
        <p className="text-muted-foreground font-mono text-[10px] uppercase tracking-wide">
          identities &amp; linked handles
        </p>
      </div>

      {peopleQ.error && (
        <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-xs">
          {peopleQ.error.message}
        </div>
      )}

      <div className="min-h-0 min-w-0 flex-1 overflow-auto rounded-md border">
        {peopleQ.isLoading ? (
          <div className="space-y-2 p-3">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : people.length === 0 ? (
          <p className="text-muted-foreground p-4 text-xs">No people yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Identifiers</TableHead>
                <TableHead>Handles</TableHead>
                <TableHead className="w-0" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {people.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">{fullName(p) || '—'}</TableCell>
                  <TableCell>{roleBadge(p.role)}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {p.identifiers.length === 0 ? (
                        <span className="text-muted-foreground text-xs">—</span>
                      ) : (
                        p.identifiers.map((id) => <IdentifierChip key={`${id.kind}:${id.value}`} id={id} />)
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="text-muted-foreground font-mono text-xs">{p.handles.length}</span>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1.5">
                      <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setManage(p)}>
                        <Link2 className="size-3.5" />
                        Manage handles
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Delete ${fullName(p)}`}
                        className="text-muted-foreground hover:text-destructive size-8 p-0"
                        onClick={() => setDeleting(p)}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <ManageHandlesDialog person={managed} token={token} onClose={() => setManage(null)} />
      <DeletePersonDialog person={deleting} token={token} onClose={() => setDeleting(null)} />
    </div>
  );
}

/**
 * Destructive delete with a GitHub-repo-style confirmation: the operator must
 * type the person's full display name exactly to enable the Delete button.
 * Deleting cascades — every linked handle is fully deregistered (reverted to
 * unknown/unapproved). Shared group chats are kept; the cascade report comes
 * back in the response.
 */
function DeletePersonDialog({
  person,
  token,
  onClose,
}: {
  person: PersonRow | null;
  token: string | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState('');

  const expected = person ? fullName(person) : '';
  const matches = confirm.trim() === expected && expected.length > 0;
  const handleCount = person?.handles.length ?? 0;

  const del = useMutation({
    mutationFn: () => postJson(`/api/people/${person!.id}/delete`, {}, token),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['api', '/api/people', token] });
      qc.invalidateQueries({ queryKey: ['api'], predicate: (q) => String(q.queryKey[1]).startsWith('/api/handles') });
      onClose();
    },
  });

  return (
    <Dialog
      open={person !== null}
      onOpenChange={(o) => {
        if (!o) {
          setConfirm('');
          del.reset();
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-destructive flex items-center gap-2 font-mono text-sm">
            <AlertTriangle className="size-4" />
            Delete {expected || 'person'}
          </DialogTitle>
          <DialogDescription>
            This permanently deletes the person and <strong>fully deregisters all {handleCount} linked handle
            {handleCount === 1 ? '' : 's'}</strong> — membership, roles, DM cache, dedicated 1:1 DM channels, and
            in-flight approvals are removed, reverting each handle to an unknown / unapproved sender. Shared group chats
            are kept. This cannot be undone.
          </DialogDescription>
        </DialogHeader>

        {del.error && (
          <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-xs">
            {del.error.message}
          </div>
        )}

        <div className="space-y-2">
          <label className="text-muted-foreground text-xs">
            To confirm, type <span className="text-foreground font-mono font-medium">{expected}</span> below:
          </label>
          <Input
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder={expected}
            autoComplete="off"
            className="h-9 font-mono text-xs"
          />
        </div>

        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setConfirm('');
              del.reset();
              onClose();
            }}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            className="gap-1.5"
            disabled={!matches || del.isPending}
            onClick={() => del.mutate()}
          >
            <Trash2 className="size-3.5" />
            {del.isPending ? 'Deleting…' : 'Delete person'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ManageHandlesDialog({
  person,
  token,
  onClose,
}: {
  person: PersonRow | null;
  token: string | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [idKind, setIdKind] = useState<'phone' | 'email'>('phone');
  const [idValue, setIdValue] = useState('');

  // Type list + matching handles. Query keys are stable (path string carries
  // kind+q), so useApiData/react-query own the loop — no setState-in-render.
  const handlesPath =
    person && kind !== null
      ? `/api/handles?kind=${encodeURIComponent(kind)}&q=${encodeURIComponent(query)}&limit=50`
      : person
        ? `/api/handles?limit=50`
        : null;
  const handlesQ = useApiData<HandlesResp>(handlesPath, token);
  const kinds = handlesQ.data?.kinds ?? [];

  // Default the active type to the first one the server reports.
  const activeKind = kind ?? kinds[0] ?? null;

  const refetch = () => {
    qc.invalidateQueries({ queryKey: ['api', '/api/people', token] });
    qc.invalidateQueries({ queryKey: ['api'], predicate: (q) => String(q.queryKey[1]).startsWith('/api/handles') });
  };

  const link = useMutation({
    mutationFn: (userId: string) => postJson(`/api/people/${person!.id}/link`, { user_id: userId }, token),
    onSuccess: refetch,
  });
  const unlink = useMutation({
    mutationFn: (userId: string) => postJson(`/api/people/${person!.id}/unlink`, { user_id: userId }, token),
    onSuccess: refetch,
  });
  const addId = useMutation({
    mutationFn: (v: { kind: string; value: string }) =>
      postJson(`/api/people/${person!.id}/identifier`, { ...v, verified: true }, token),
    onSuccess: () => {
      setIdValue('');
      refetch();
    },
  });
  const removeId = useMutation({
    mutationFn: (v: { kind: string; value: string }) =>
      postJson(`/api/people/${person!.id}/identifier/remove`, v, token),
    onSuccess: refetch,
  });
  const mutError = link.error ?? unlink.error ?? addId.error ?? removeId.error;

  // Linked-handle ids for "already linked to THIS person" marking in the picker.
  const linkedHere = useMemo(
    () => new Set((person?.handles ?? []).map((h) => h.user_id)),
    [person],
  );

  // The picker shows handles for the active type; the server already filters by
  // kind+q when we pass them, so render the list as-is.
  const matches = handlesQ.data?.handles ?? [];

  return (
    <Dialog
      open={person !== null}
      onOpenChange={(o) => {
        if (!o) {
          setKind(null);
          setQuery('');
          setIdValue('');
          link.reset();
          unlink.reset();
          addId.reset();
          removeId.reset();
          onClose();
        }
      }}
    >
      <DialogContent className="max-h-[80vh] overflow-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">
            {person ? fullName(person) : '—'} · identity
          </DialogTitle>
          <DialogDescription>
            Manage identifiers (phone / email) and linked platform handles for this person.
          </DialogDescription>
        </DialogHeader>

        {mutError && (
          <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-xs">
            {mutError.message}
          </div>
        )}

        {/* Identifiers (phone / email) — how this person is recognized + auto-enrolled. */}
        <section className="space-y-2">
          <p className="text-muted-foreground text-xs font-medium uppercase tracking-wide">Identifiers</p>
          {person && person.identifiers.length === 0 ? (
            <p className="text-muted-foreground text-xs">None yet.</p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {person?.identifiers.map((id) => (
                <li key={`${id.kind}:${id.value}`}>
                  <span className="bg-muted flex items-center gap-1 rounded-md px-2 py-1 font-mono text-xs">
                    <span className="text-muted-foreground/60">{id.kind}</span>
                    {id.value}
                    {!id.verified && <span className="text-muted-foreground/60">(unverified)</span>}
                    <button
                      className="hover:text-destructive ml-0.5 disabled:opacity-50"
                      aria-label={`Remove ${id.value}`}
                      disabled={removeId.isPending}
                      onClick={() => removeId.mutate({ kind: id.kind, value: id.value })}
                    >
                      <X className="size-3.5" />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {/* Add a phone / email identifier (nanoclaw normalizes + validates the value). */}
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              const v = idValue.trim();
              if (v) addId.mutate({ kind: idKind, value: v });
            }}
          >
            <select
              value={idKind}
              onChange={(e) => setIdKind(e.target.value as 'phone' | 'email')}
              className="border-input bg-background h-8 rounded-md border px-2 font-mono text-xs"
            >
              <option value="phone">phone</option>
              <option value="email">email</option>
            </select>
            <Input
              value={idValue}
              onChange={(e) => setIdValue(e.target.value)}
              placeholder={idKind === 'phone' ? '+15551234567' : 'name@example.com'}
              className="h-8 flex-1 font-mono text-xs"
            />
            <Button type="submit" size="sm" className="h-8 gap-1" disabled={addId.isPending || !idValue.trim()}>
              <Plus className="size-3.5" />
              Add
            </Button>
          </form>
        </section>

        {/* Currently-linked handles. */}
        <section className="space-y-2">
          <p className="text-muted-foreground text-xs font-medium uppercase tracking-wide">Linked handles</p>
          {person && person.handles.length === 0 ? (
            <p className="text-muted-foreground text-xs">None yet.</p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {person?.handles.map((h) => (
                <li key={h.user_id}>
                  <span className="bg-muted flex items-center gap-1 rounded-md px-2 py-1 font-mono text-xs">
                    <UserIcon className="size-3 shrink-0 opacity-60" />
                    {h.user_id}
                    <span className="text-muted-foreground/60">({h.link_method})</span>
                    <button
                      className="hover:text-destructive ml-0.5 disabled:opacity-50"
                      aria-label={`Unlink ${h.user_id}`}
                      disabled={unlink.isPending}
                      onClick={() => unlink.mutate(h.user_id)}
                    >
                      <X className="size-3.5" />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Link a new handle: type selector + search. */}
        <section className="space-y-2">
          <p className="text-muted-foreground text-xs font-medium uppercase tracking-wide">Link a handle</p>

          {handlesQ.isLoading && kinds.length === 0 ? (
            <Skeleton className="h-8 w-full" />
          ) : kinds.length === 0 ? (
            <p className="text-muted-foreground text-xs">No active handle types.</p>
          ) : (
            <>
              {/* Type list (platform prefixes). */}
              <div className="flex flex-wrap gap-1">
                {kinds.map((k) => (
                  <button
                    key={k}
                    onClick={() => {
                      setKind(k);
                      setQuery('');
                    }}
                    className={cn(
                      'rounded-md px-2.5 py-1 font-mono text-xs transition-colors',
                      activeKind === k
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-muted-foreground hover:bg-muted/70',
                    )}
                  >
                    {k}
                  </button>
                ))}
              </div>

              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={activeKind ? `Search ${activeKind} handles…` : 'Search handles…'}
                className="h-8 font-mono text-xs"
              />

              <div className="max-h-56 overflow-auto rounded-md border">
                {handlesQ.isLoading ? (
                  <div className="space-y-1 p-2">
                    <Skeleton className="h-6 w-full" />
                    <Skeleton className="h-6 w-full" />
                  </div>
                ) : matches.length === 0 ? (
                  <p className="text-muted-foreground p-3 text-xs">No matching handles.</p>
                ) : (
                  <ul className="divide-y">
                    {matches.map((h) => {
                      const linkedElsewhere = h.linked_person_id && !linkedHere.has(h.user_id);
                      const linkedToThis = linkedHere.has(h.user_id);
                      return (
                        <li
                          key={h.user_id}
                          className="flex items-center justify-between gap-2 px-2 py-1.5"
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="truncate font-mono text-xs">{h.user_id}</span>
                            {linkedToThis && (
                              <Badge variant="secondary" className="shrink-0">
                                linked here
                              </Badge>
                            )}
                            {linkedElsewhere && (
                              <Badge variant="outline" className="text-muted-foreground shrink-0">
                                linked → {h.linked_person_id}
                              </Badge>
                            )}
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 shrink-0 gap-1"
                            disabled={link.isPending || linkedToThis}
                            onClick={() => link.mutate(h.user_id)}
                          >
                            <Plus className="size-3.5" />
                            {linkedElsewhere ? 'Relink' : 'Link'}
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </>
          )}
        </section>
      </DialogContent>
    </Dialog>
  );
}
