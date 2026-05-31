import type { Metadata } from "next";

/**
 * Route-group layout for the signed-in product surface (Home, Integrations).
 * Passthrough — the root layout provides <html>/<body> and global CSS. The
 * pages themselves gate on the Better Auth session client-side.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function DashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return <>{children}</>;
}
