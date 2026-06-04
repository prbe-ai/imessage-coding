import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";
import { Toaster } from "sonner";

import { TooltipProvider } from "@/components/ui/tooltip";

import "./globals.css";

// Auth-gated client shells read no static data, but the auth surface + route
// handlers are request-time only, so render dynamically.
export const dynamic = "force-dynamic";

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "Probe — iMessage for Claude Code & Codex",
  description:
    "Steer your Claude Code and Codex sessions from iMessage. Approve, answer, and stay in flow from your phone.",
  // Theme-adaptive favicon (separate light/dark variants).
  icons: { icon: "/logo-light.svg" },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body
        className={`${jetbrainsMono.variable} font-sans antialiased bg-surface text-on-surface`}
      >
        <TooltipProvider>{children}</TooltipProvider>
        <Toaster
          theme="light"
          toastOptions={{
            style: {
              background: "#ffffff",
              border: "1px solid #c7c7c0",
              color: "#1b1c1a",
            },
          }}
        />
      </body>
    </html>
  );
}
