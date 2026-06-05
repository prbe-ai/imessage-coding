"use client";

/**
 * Top-right account menu. Trigger is the signed-in user's email; the dropdown
 * has a "Settings" link and a "Sign out" action that revokes the Better Auth
 * session and bounces to /sign-in. Renders nothing when unauthenticated.
 */

import { useRouter } from "next/navigation";
import { LogOut, Settings } from "lucide-react";

import { signOut } from "@/lib/idp/better-auth-client";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function AccountMenu({ email }: { email: string | null }) {
  const router = useRouter();
  if (!email) return null;
  async function onSignOut() {
    await signOut();
    window.location.href = "/sign-in";
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="onb-account-trigger"
          aria-label="Account menu"
        >
          <span className="onb-account-email">{email}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={8}
        className="onb-account-menu min-w-44"
      >
        <DropdownMenuItem
          onSelect={() => router.push("/settings")}
          className="onb-account-item cursor-pointer gap-2"
        >
          <Settings className="size-4" aria-hidden="true" />
          <span>Settings</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={onSignOut}
          className="onb-account-item cursor-pointer gap-2"
        >
          <LogOut className="size-4" aria-hidden="true" />
          <span>Sign out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
