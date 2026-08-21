import { Outlet } from 'react-router-dom';

import { AppSidebar } from './app-sidebar';
import { CapturePhone } from './capture-phone';
import { QueryProvider } from '@/components/QueryProvider';
import { Separator } from '@/components/ui/separator';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useApiData } from '@/lib/api';

// Fires GET /api/me, which triggers the server-side login→person mint
// (idempotent; fails soft). Rendered INSIDE QueryProvider so react-query has a
// client. No UI. Embed/viewer-token callers get a harmless 403 (not operators).
function MintPerson() {
  useApiData('/api/me', null);
  return null;
}

// Client shell for the whole dashboard: shadcn sidebar frame + a thin header.
// The theme is global (html.dark) so there's no .admin-root wrapper. Route
// content (incl. the preserved Timeline) renders in the SidebarInset, which
// uses min-w-0 so wide content scrolls within its container instead of blowing
// out the page width — important for the Timeline's ResizeObserver.
export function AdminShell() {
  return (
    <QueryProvider>
      <MintPerson />
      {/* First-login phone capture — required modal inside QueryProvider so it
          has a react-query client (same constraint as MintPerson). */}
      <CapturePhone />
      <TooltipProvider delayDuration={300}>
        <SidebarProvider>
          <AppSidebar />
          <SidebarInset className="min-w-0">
            <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
              <SidebarTrigger className="-ml-1" />
              <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
              <span className="text-muted-foreground font-mono text-xs uppercase tracking-wide">
                Pat — Observability
              </span>
            </header>
            <div className="flex min-w-0 flex-1 flex-col">
              <Outlet />
            </div>
          </SidebarInset>
        </SidebarProvider>
      </TooltipProvider>
    </QueryProvider>
  );
}
