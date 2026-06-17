# Contributing to imessage-coding

Thanks for your interest in improving `imessage-coding` — remote control and
steering for Claude Code & OpenAI Codex over iMessage. This guide covers how to
get set up, the conventions we follow, and how to land a change.

## Getting started

This is a [Bun](https://bun.sh) workspaces monorepo (no npm/pnpm). You'll need
Bun `>= 1.3.0`.

```sh
git clone https://github.com/prbe-ai/imessage-coding.git
cd imessage-coding
bun install
```

See the [README](README.md) for the full architecture, local-development, and
deployment instructions.

## Before you open a pull request

Run the full check suite from the repo root — CI runs the same:

```sh
bun run typecheck   # tsc --noEmit across all packages (and the Next type-check)
bun run lint        # eslint in the dashboard
bun test            # bun's test runner
```

All three should pass. If you touch the control plane's safety or approval path,
add or update tests that cover it — that code is fail-closed by design and
changes there carry the most risk.

## Conventions

- **TypeScript strict.** Honor `tsconfig.base.json`; don't loosen types to make an
  error go away.
- **Enums over string literals.** Shared enums and const-objects live in
  `@imsg/shared` (`packages/shared`). If a value is compared or branched on, it
  belongs there — don't hardcode the string.
- **Keep the contract in `@imsg/shared`.** Types and enums that more than one
  package needs go in the shared package so there's a single source of truth.
- **Small, scoped changes.** One logical change per PR. Keep diffs minimal and
  focused on the problem you're solving.
- **Conventional commit subjects.** Match the existing history, e.g.
  `fix(device): …`, `feat(orchestrator): …`, `chore(readme): …`.
- **Never weaken the safety model.** The approval path is fail-closed and the
  egress killswitch is fail-open; destructive prompts are described by code, not
  the LLM. Don't change those invariants without discussion in an issue first.

## Reporting bugs and requesting features

Open a [GitHub issue](https://github.com/prbe-ai/imessage-coding/issues) with
enough detail to reproduce: what you did, what you expected, what happened, and
your environment (OS, Bun version, agent — Claude Code or Codex). For security
issues, **do not** open a public issue — see [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions will be licensed under the
project's [MIT License](LICENSE).
