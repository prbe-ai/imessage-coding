#!/usr/bin/env bun
/**
 * @imsg/device — CLI entrypoint.
 *
 * Usage:
 *   imsg pair <token>
 *   imsg afk on|off|toggle
 *   imsg grant edits|full|off
 *   imsg status
 *   imsg statusline
 *
 * Thin dispatcher over src/cli.ts so the command logic stays testable and the
 * channel server / hook can import the same helpers.
 */
import { afk, grant, pair, status, statusline } from '../src/cli.ts';

const USAGE = `imsg — imessage-coding device CLI

  imsg pair <token>          pair this device with a single-use token
  imsg afk on|off|toggle     set away-from-keyboard state (mirrored to cloud)
  imsg grant edits|full|off  set the session auto-approve grant
  imsg status                show pairing + local state
  imsg statusline            one-line status (for the Claude Code status bar)
`;

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'pair':
      return pair(rest[0] ?? '');
    case 'afk':
      return afk(rest[0] ?? '');
    case 'grant':
      return grant(rest[0] ?? '');
    case 'status':
      return status();
    case 'statusline':
      return statusline();
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      process.stdout.write(USAGE);
      return cmd === undefined ? 2 : 0;
    default:
      process.stderr.write(`unknown command: ${cmd}\n\n${USAGE}`);
      return 2;
  }
}

process.exit(await main());
