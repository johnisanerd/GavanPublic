import { SignInButton } from '@clerk/react';

import { Logomark } from '@/components/shell/logomark';
import { Button } from '@/components/ui/button';

/** Full-page gate shown when there's no operator session. The dashboard UI is
 *  never rendered behind this — sign in (Clerk OAuth, @palisaderesearch.org) to
 *  proceed. */
export function LoginPage() {
  return (
    <div className="bg-background flex min-h-screen items-center justify-center p-6">
      <div className="bg-card flex w-full max-w-sm flex-col items-center gap-6 rounded-xl border p-8">
        <Logomark size={40} />
        <div className="text-center">
          <h1 className="font-medium">Pat</h1>
          <p className="text-muted-foreground font-mono text-xs uppercase tracking-wide">
            Palisade Research · Observability
          </p>
        </div>
        <SignInButton mode="modal">
          <Button className="w-full">Sign in</Button>
        </SignInButton>
        <p className="text-muted-foreground text-center text-xs">
          Operators only — an @palisaderesearch.org account is required.
        </p>
      </div>
    </div>
  );
}
