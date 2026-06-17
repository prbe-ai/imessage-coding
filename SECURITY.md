# Security Policy

`imessage-coding` relays coding-agent approvals between a developer's machine and
their phone, so we take security reports seriously. Thank you for helping keep
users safe.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, report them privately through GitHub's
[Security Advisories](https://github.com/prbe-ai/imessage-coding/security/advisories/new)
("Report a vulnerability"). Include:

- a description of the issue and its impact,
- steps to reproduce (a proof of concept if possible),
- affected versions/components, and
- any suggested mitigation.

We'll acknowledge your report, investigate, and keep you updated on the fix. We
ask that you give us a reasonable window to remediate before any public
disclosure.

## Scope

The trust boundary is the **control plane** — the device only ever relays a
verdict it was explicitly handed, and the approval path is fail-closed by design.
Reports that are especially valuable include:

- ways to make the device relay a verdict it was **not** handed,
- ways to coerce a destructive `allow` without an explicit user decision,
- bypasses of the deterministic destructive-tool classification
  (`isDestructiveTool`) or the tap-back binding,
- HMAC/webhook verification bypasses on `POST /api/agentphone/webhook`,
- pairing/token weaknesses (e.g. recovering a `device_token` from logs or
  egress), and
- secret leakage past the egress sanitizer.

The [Safety model](README.md#safety-model) section of the README documents the
intended invariants — reports that break one of them are in scope.
