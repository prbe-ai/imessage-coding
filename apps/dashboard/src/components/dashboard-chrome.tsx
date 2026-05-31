"use client";

/**
 * Signed-in chrome: a sticky top bar with the product mark (left), a small
 * Home / Integrations nav, and the account menu (right). Light, warm-neutral
 * TopBar (h-16, sticky, bottom border, bg-surface).
 */

import Link from "next/link";
import { usePathname } from "next/navigation";

import { BrandMark } from "@/components/icons";
import { AccountMenu } from "@/components/account-menu";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/home", label: "Home" },
  { href: "/integrations", label: "Integrations" },
] as const;

export function DashboardChrome({
  email,
  children,
}: {
  email: string | null;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  return (
    <div className="min-h-screen bg-surface text-on-surface">
      <header className="sticky top-0 z-30 h-16 border-b border-outline-variant/40 bg-surface/95 backdrop-blur">
        <div className="mx-auto flex h-full max-w-3xl items-center justify-between px-6">
          <div className="flex items-center gap-6">
            <Link
              href="/home"
              aria-label="Home"
              className="flex items-center gap-1.5"
            >
              <span className="inline-flex size-7 text-ink">
                <BrandMark />
              </span>
            </Link>
            <nav className="flex items-center gap-4">
              {NAV.map((item) => {
                const active = pathname === item.href;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      "text-sm transition-colors",
                      active
                        ? "font-semibold text-on-surface"
                        : "text-on-surface-variant hover:text-on-surface",
                    )}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          </div>
          <AccountMenu email={email} />
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-6 py-8">{children}</main>
    </div>
  );
}
