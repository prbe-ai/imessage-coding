/**
 * "How to use it" — the three-step flow for actually using the product once a
 * device is paired: open a coding agent, turn on AFK, then you're good (the
 * agent texts you, and you can text it back). Shared by the Integrations page
 * and the onboarding install step so the guidance reads identically; the
 * install.sh post-install message mirrors the same three steps in plain text.
 */

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-surface-container px-1 py-0.5 font-mono text-[0.85em] text-on-surface">
      {children}
    </code>
  );
}

export function UsageSteps() {
  return (
    <section className="rounded-lg border border-status-info/30 bg-status-info/5 p-4">
      <h2 className="text-sm font-semibold text-on-surface">How to use it</h2>
      <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm text-on-surface-variant">
        <li>
          <span className="font-medium text-on-surface">
            Open a coding agent
          </span>{" "}
          — start Claude Code or Codex, or pick a session you&apos;ve already got
          running.
        </li>
        <li>
          <span className="font-medium text-on-surface">Turn on AFK mode</span> —
          run <Code>/afk</Code> in Claude Code (or <Code>$afk</Code> in Codex).
          You can also toggle it from your dashboard.
        </li>
        <li>
          <span className="font-medium text-on-surface">That&apos;s it</span> —
          the agent texts you when it needs you, and you can text it back anytime
          from your phone.
        </li>
      </ol>
      <p className="mt-3 text-xs text-outline">
        Just installed? If you don&apos;t see it yet, reload your plugins or
        restart your coding session to pick up the change.
      </p>
    </section>
  );
}
