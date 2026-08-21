# The Test — project notes for Claude

## UI: default to shadcn/ui — don't hand-roll

**Before building any UI, reach for shadcn first:**

1. **Components** — check `components/ui/` for an existing shadcn component. If it's
   not there, add it with `npx shadcn@latest add <name>` rather than writing your own.
2. **Blocks** — for larger compositions (sidebars, dashboards, login, etc.), use a
   shadcn **block** (e.g. `npx shadcn@latest add sidebar-07`) as the starting point and
   adapt it. Don't reinvent layouts the blocks already solve.
3. Only build a custom component when shadcn genuinely has no fit — and compose it from
   the existing primitives.

Hand-rolling UI is how we ended up with broken contrast, stray borders, and link styling
that fought the theme. The shadcn defaults are well-tuned; stay close to them and apply
brand as a thin theme layer.

## Icons: lucide-react (then react-icons)

- The icon library is **`lucide-react`** (shadcn's default). Use it for all icons.
- If a needed icon isn't in lucide, add **`react-icons`** and pull it from there. Don't
  draw custom SVG icons.

## Styling architecture (don't relearn this) — UNIFIED as of 2026-06-23

- **One global theme** — shadcn/ui + Tailwind v4 in `app/globals.css` (imported by the
  root layout), applied to BOTH admin AND public pages. Stock shadcn dark theme + brand
  accents (Science Green `--primary` #c7e09c; Verified Green `--success`; brightened
  `--muted-foreground` #b4b4b4 for a11y); fonts DM Sans / DM Mono. `dark` is on `<html>`.
- **Theme tokens live on `:root`** (NOT `.admin-root`). This is load-bearing: Radix
  Dialog/Popover/Tooltip portal to `document.body`, so tokens scoped to `.admin-root`
  would resolve to nothing (transparent) for portaled content. Keep tokens on `:root`.
- The old split is GONE: `admin.css` is deleted, and the public `--ps-*` token system
  (and its `:not(.admin-root *)` scoping) is removed. `.admin-root` survives only as a
  marker on the admin shell for admin-only table zebra-striping.
- Public pages (`/`, `/completed`, `/sign-in`) use the same theme (e.g. `bg-background`,
  `text-foreground`, `text-primary`). No separate public CSS system.
- The sidebar holds only **sections/views** (Research, Analysis) — never content
  (experiments/cohorts/responses), which live in the main area via breadcrumbs + drill-down.
