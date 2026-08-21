import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Phone } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { postJson, useApiData } from '@/lib/api';

interface Identifier {
  kind: string;
  value: string;
  verified: number;
}
interface Person {
  id: string;
  first_name: string;
  last_name: string;
}
interface Me {
  email: string;
  firstName?: string;
  lastName?: string;
  person: Person | null;
  identifiers: Identifier[];
}

// The embed/viewer-token path (machine + pat-web iframe) isn't an operator and
// gets a 403 from /api/me — never prompt it for a phone. Detected the same way
// App.tsx gates the auth path.
const HAS_EMBED_TOKEN = new URLSearchParams(window.location.search).has('token');

/**
 * First-login phone capture. Required modal shown when a signed-in operator's
 * person has no `phone` identifier — email + name come free from Google OAuth,
 * but the phone must be asked so the person can be auto-recognized across
 * phone/Signal later.
 *
 * Rendered INSIDE QueryProvider (alongside MintPerson) so useApiData has a
 * client. Loop-safe: stable query key, no setState in render. There is no
 * dismiss affordance — the operator can't reach the dashboard until a phone is
 * added; the modal auto-hides once /api/me reports a phone identifier.
 */
export function CapturePhone() {
  // Reuses MintPerson's cache entry (['api','/api/me',null]) — no extra fetch.
  const meQ = useApiData<Me>(HAS_EMBED_TOKEN ? null : '/api/me', null);
  const qc = useQueryClient();
  const [phone, setPhone] = useState('');

  const me = meQ.data;
  const person = me?.person ?? null;
  const hasPhone = (me?.identifiers ?? []).some((i) => i.kind === 'phone');

  const addPhone = useMutation({
    mutationFn: (value: string) =>
      postJson(`/api/people/${person!.id}/identifier`, { kind: 'phone', value, verified: true }, null),
    // Refetch /api/me — the modal auto-hides once a phone identifier exists.
    onSuccess: () => qc.invalidateQueries({ queryKey: ['api', '/api/me', null] }),
  });

  // Show only for a signed-in operator with a person and no phone yet.
  const open = !HAS_EMBED_TOKEN && !!person && !hasPhone;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const v = phone.trim();
    if (v) addPhone.mutate(v);
  };

  return (
    // Required: no close button, and onOpenChange close is ignored so the
    // operator can't escape to the dashboard without adding a phone.
    <Dialog open={open}>
      <DialogContent showCloseButton={false} onEscapeKeyDown={(e) => e.preventDefault()} onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>Add your phone number</DialogTitle>
          <DialogDescription>
            One more thing before you continue. We use your phone number to recognize you across
            phone and Signal. Your name and email came from Google.
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-3" onSubmit={submit}>
          {/* Name + email from Google — shown read-only / grayed. */}
          <div className="grid grid-cols-2 gap-2">
            <ReadOnlyField label="First name" value={me?.firstName ?? ''} />
            <ReadOnlyField label="Last name" value={me?.lastName ?? ''} />
          </div>
          <ReadOnlyField label="Email" value={me?.email ?? ''} />

          <div className="space-y-1">
            <label className="text-muted-foreground text-xs font-medium uppercase tracking-wide">Phone</label>
            <div className="flex items-center gap-1.5">
              <Phone className="text-muted-foreground size-4 shrink-0" />
              <Input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+15551234567"
                autoFocus
                required
                inputMode="tel"
                className="font-mono"
              />
            </div>
          </div>

          {addPhone.error && (
            <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-xs">
              {addPhone.error.message}
            </div>
          )}

          <Button type="submit" className="w-full" disabled={addPhone.isPending || !phone.trim()}>
            {addPhone.isPending ? 'Saving…' : 'Save phone number'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ReadOnlyField({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <label className="text-muted-foreground text-xs font-medium uppercase tracking-wide">{label}</label>
      <div className="border-input bg-muted text-muted-foreground rounded-md border px-3 py-2 text-sm">
        {value || '—'}
      </div>
    </div>
  );
}
