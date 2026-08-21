import Link from "next/link";

export function Header() {
  return (
    <header className="glass flex-shrink-0 z-50">
      <div className="max-w-7xl mx-auto px-6 lg:px-10">
        <div className="flex items-center justify-between h-16">
          <Link href="/" className="flex items-center gap-3">
            <div className="h-9 w-9 bg-navy flex items-center justify-center flex-shrink-0">
              <span className="text-white font-serif font-bold text-sm tracking-tight">AC</span>
            </div>
            <span className="font-serif text-xl font-bold text-ink tracking-tight">Aisle Crosser</span>
          </Link>
        </div>
      </div>
    </header>
  );
}
