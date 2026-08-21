"use client";

import * as React from "react";
import Link from "next/link";
import { FlaskConical, BarChart3 } from "lucide-react";

import { Logomark } from "../logomark";
import { NavMain, type NavItem } from "./nav-main";
import { NavUser } from "./nav-user";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";

// Sidebar holds only sections/views — categories (Research, Analysis) with their
// views beneath. Content (experiments, cohorts, responses) lives in the main
// area, reached by drilling into a view.
const NAV: NavItem[] = [
  {
    title: "Research",
    icon: FlaskConical,
    defaultOpen: true,
    items: [
      { title: "Live Results", url: "/admin/live" },
      { title: "Experiments", url: "/admin" },
      { title: "Questions", url: "/admin/questions" },
    ],
  },
  {
    title: "Analysis",
    icon: BarChart3,
    items: [{ title: "Results", url: "/admin/analysis" }],
  },
];

export function AppSidebar({
  viewer,
  ...props
}: React.ComponentProps<typeof Sidebar> & { viewer: string }) {
  return (
    <Sidebar collapsible="icon" {...props}>
      {/* Brand lockup (replaces sidebar-07's TeamSwitcher). */}
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link href="/admin">
                <div className="flex aspect-square size-8 items-center justify-center">
                  <Logomark size={24} />
                </div>
                <div className="grid flex-1 text-left leading-tight">
                  <span className="truncate font-medium">The Test</span>
                  <span className="text-muted-foreground truncate font-mono text-xs uppercase tracking-wide">
                    Palisade Research
                  </span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <NavMain items={NAV} />
      </SidebarContent>

      <SidebarFooter>
        <NavUser email={viewer} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
