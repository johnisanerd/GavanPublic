// Intentionally minimal public root: just the instrument name, large and
// centered. No operator branding is surfaced here — the owner is deliberately
// kept off the public face. The actual dashboard lives behind /admin (gated).
export default function Home() {
  return (
    <main className="bg-background text-foreground flex min-h-dvh items-center justify-center p-8 text-center">
      <h1 className="text-[clamp(3rem,13vw,9rem)] font-normal leading-none tracking-tight">
        The Test
      </h1>
    </main>
  );
}
