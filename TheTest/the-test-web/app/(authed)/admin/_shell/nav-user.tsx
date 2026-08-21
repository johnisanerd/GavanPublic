"use client";

import { UserButton } from "@clerk/nextjs";

import { SidebarMenu, SidebarMenuItem } from "@/components/ui/sidebar";
import { DEV_NO_AUTH } from "@/lib/dev-no-auth";

// Footer identity row: Clerk's UserButton (account menu + sign-out) + the
// viewer's email, truncated. min-w-0 keeps a long email from blowing out the
// rail. In local no-auth dev the provider is skipped, so show a plain avatar.
export function NavUser({ email }: { email: string }) {
  const devNoAuth = DEV_NO_AUTH;
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <div className="flex w-full min-w-0 items-center gap-2 rounded-md p-1.5">
          {devNoAuth ? (
            <div className="bg-sidebar-accent text-sidebar-accent-foreground flex size-7 shrink-0 items-center justify-center rounded-full text-[11px] font-medium">
              {email[0]?.toUpperCase() ?? "?"}
            </div>
          ) : (
            <UserButton
              appearance={{ elements: { userButtonAvatarBox: "h-7 w-7" } }}
            />
          )}
          <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs group-data-[collapsible=icon]:hidden">
            {email}
          </span>
        </div>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
