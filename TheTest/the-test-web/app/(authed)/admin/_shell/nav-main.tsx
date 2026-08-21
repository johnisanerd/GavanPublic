"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight, type LucideIcon } from "lucide-react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";

export type NavItem = {
  title: string;
  icon?: LucideIcon;
  defaultOpen?: boolean;
  items: { title: string; url: string; disabled?: boolean }[];
};

// sidebar-07 NavMain: collapsible category rows (Research, Analysis) that expand
// to their sub-views. The category is a toggle; the sub-items are the links.
export function NavMain({ items }: { items: NavItem[] }) {
  const pathname = usePathname();

  const isActive = (url: string) =>
    url === "/admin"
      ? pathname === "/admin" || pathname.startsWith("/admin/e")
      : pathname === url || pathname.startsWith(url + "/");

  return (
    <SidebarGroup>
      <SidebarMenu>
        {items.map((item) => (
          <Collapsible
            key={item.title}
            asChild
            defaultOpen={
              item.defaultOpen ||
              item.items.some((s) => !s.disabled && isActive(s.url))
            }
            className="group/collapsible"
          >
            <SidebarMenuItem>
              <CollapsibleTrigger asChild>
                <SidebarMenuButton tooltip={item.title}>
                  {item.icon && <item.icon />}
                  <span>{item.title}</span>
                  <ChevronRight className="ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
                </SidebarMenuButton>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <SidebarMenuSub>
                  {item.items.map((sub) => (
                    <SidebarMenuSubItem key={sub.title}>
                      <SidebarMenuSubButton
                        asChild={!sub.disabled}
                        isActive={!sub.disabled && isActive(sub.url)}
                        className={
                          sub.disabled ? "pointer-events-none opacity-50" : ""
                        }
                      >
                        {sub.disabled ? (
                          <span>{sub.title}</span>
                        ) : (
                          <Link href={sub.url}>
                            <span>{sub.title}</span>
                          </Link>
                        )}
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                  ))}
                </SidebarMenuSub>
              </CollapsibleContent>
            </SidebarMenuItem>
          </Collapsible>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  );
}
