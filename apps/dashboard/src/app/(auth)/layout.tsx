import type { Metadata } from "next";

/**
 * Route-group layout for the auth pages (sign-in). Route-group layouts in the
 * App Router don't get their own <html>/<body> — the root layout provides
 * those. Auth pages are noindex.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function AuthLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return <>{children}</>;
}
