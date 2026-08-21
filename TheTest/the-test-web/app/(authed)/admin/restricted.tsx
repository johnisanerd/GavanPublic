import { SignOutButton } from "@clerk/nextjs";
import { Logomark } from "./logomark";
import { Button } from "@/components/ui/button";

// Shared access-restricted fallback for any admin page when the viewer is not a
// @palisaderesearch.org account. (proxy.ts already gates auth; this is the
// belt-and-suspenders domain gate's UI.)
export function Restricted() {
  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        padding: "4rem 1.5rem",
      }}
    >
      <Logomark size={28} />
      <h1 style={{ fontSize: "1.6rem", fontWeight: 400, margin: "20px 0 10px" }}>
        Access restricted
      </h1>
      <p className="text-muted-foreground mt-2 max-w-sm text-sm leading-relaxed">
        The Test admin is limited to <b>@palisaderesearch.org</b> accounts. Sign
        out and use your Palisade Google account.
      </p>
      <SignOutButton>
        <Button variant="outline" className="mt-5">
          Sign out
        </Button>
      </SignOutButton>
    </main>
  );
}
