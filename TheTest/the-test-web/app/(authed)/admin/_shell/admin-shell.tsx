"use client";

import { QueryProvider } from "../query-provider";
import { AppSidebar } from "./app-sidebar";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { TooltipProvider } from "@/components/ui/tooltip";

// Client shell for the whole admin surface. The theme is now global (dark on
// <html>, tokens on :root in globals.css); `.admin-root` just marks the admin
// subtree for admin-only base styling (table zebra striping).
// Everything lives inside one QueryProvider so the page islands share a cache.
export function AdminShell({
  viewer,
  children,
}: {
  viewer: string;
  children: React.ReactNode;
}) {
  return (
    <QueryProvider>
      <TooltipProvider delayDuration={300}>
      <div className="admin-root">
        <SidebarProvider>
          <AppSidebar viewer={viewer} />
          <SidebarInset className="min-w-0">
            <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
              <SidebarTrigger className="-ml-1" />
              <Separator
                orientation="vertical"
                className="mr-2 data-[orientation=vertical]:h-4"
              />
              <span className="text-muted-foreground font-mono text-xs uppercase tracking-wide">
                The Test
              </span>
            </header>
            {/* min-w-0 lets wide tables scroll within their container instead of
                blowing out the page width (flex children default to min-w:auto). */}
            <div className="flex min-w-0 flex-1 flex-col">{children}</div>
          </SidebarInset>
        </SidebarProvider>
      </div>
      </TooltipProvider>
    </QueryProvider>
  );
}
