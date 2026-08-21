import * as React from 'react';
import { Link } from 'react-router-dom';
import { Radio, Database as DatabaseIcon } from 'lucide-react';

import { Logomark } from './logomark';
import { NavMain, type NavItem } from './nav-main';
import { NavUser } from './nav-user';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar';

// Sidebar holds only sections/views. Data (above Session) currently holds a
// single drillable Database; Session owns the realtime views (Timeline + Logs),
// with its session selector in the view's toolbar, not the nav.
const NAV: NavItem[] = [
  {
    title: 'Data',
    icon: DatabaseIcon,
    defaultOpen: true,
    items: [
      { title: 'Database', url: '/database' },
      { title: 'People', url: '/people' },
      { title: 'My Handles', url: '/my-handles' },
    ],
  },
  {
    title: 'Session',
    icon: Radio,
    defaultOpen: true,
    items: [
      { title: 'Timeline', url: '/session/timeline' },
      { title: 'Logs', url: '/session/logs' },
    ],
  },
];

export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link to="/database">
                <div className="flex aspect-square size-8 items-center justify-center">
                  <Logomark size={24} />
                </div>
                <div className="grid flex-1 text-left leading-tight">
                  <span className="truncate font-medium">Pat</span>
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
        <NavUser />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
