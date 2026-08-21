import { Show, SignInButton, UserButton } from '@clerk/react';

import { SidebarMenu, SidebarMenuItem } from '@/components/ui/sidebar';

// Footer identity row: Clerk's UserButton (account menu + sign-out) when signed
// in, a sign-in button otherwise. (Ported from TheTest's nav-user: @clerk/nextjs
// → @clerk/react with the v6 <Show> gate.)
export function NavUser() {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <div className="flex w-full min-w-0 items-center gap-2 rounded-md p-1.5">
          <Show when="signed-in">
            <UserButton appearance={{ elements: { userButtonAvatarBox: 'h-7 w-7' } }} />
            <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs group-data-[collapsible=icon]:hidden">
              Operator
            </span>
          </Show>
          <Show when="signed-out">
            <SignInButton mode="modal">
              <button className="text-muted-foreground hover:text-foreground min-w-0 flex-1 truncate text-left font-mono text-xs group-data-[collapsible=icon]:hidden">
                Sign in
              </button>
            </SignInButton>
          </Show>
        </div>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
