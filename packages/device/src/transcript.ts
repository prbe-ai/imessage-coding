/**
 * @imsg/device — Claude Code transcript tailer (byte-offset cursor).
 *
 * Ported from prbe-cc-tap-plugin's tap/transcript.py. We track BYTES (not line
 * counts) so a partial trailing line — written mid-flush by Claude Code — does
 * not advance the cursor and gets re-read next tick once the newline lands.
 *
 * Truncation/rotation is detected by comparing the file size to the persisted
 * cursor: if the file shrank below the offset we reset to 0.
 *
 * `splitLines` is pure (unit-tested directly); `readNew` is the thin fs layer.
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

const LF = 0x0a; // '\n'
const CR = 0x0d; // '\r'

export interface TailResult {
  /** Complete (newline-terminated) lines as UTF-8 strings, blanks skipped. */
  lines: string[];
  /** Cursor to persist: bytes consumed (excludes any partial trailing line). */
  newByteOffset: number;
  /** Current file size (for truncation detection next tick). */
  fileSize: number;
}

/**
 * Split a buffer into newline-terminated lines. Returns the complete lines
 * (blank lines skipped, a trailing '\r' stripped) and the count of trailing
 * PARTIAL bytes (an unterminated final line). The caller must subtract `partial`
 * from the new cursor so those bytes are re-read once the writer flushes '\n'.
 */
export function splitLines(buf: Buffer): { lines: string[]; partial: number } {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === LF) {
      let end = i;
      if (end > start && buf[end - 1] === CR) end -= 1; // strip CRLF
      if (end > start) lines.push(buf.toString('utf8', start, end)); // skip blanks
      start = i + 1;
    }
  }
  return { lines, partial: buf.length - start };
}

/**
 * Read bytes from `byteOffset` to EOF and return the complete lines. If the file
 * has shrunk below the offset (truncation/rotation), reset to 0.
 */
export function readNew(path: string, byteOffset: number): TailResult {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    let start = byteOffset;
    if (size < byteOffset) start = 0; // truncated/rotated → re-read from the top
    if (size <= start) return { lines: [], newByteOffset: start, fileSize: size };

    const length = size - start;
    const buf = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buf, read, length - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    const slice = read === length ? buf : buf.subarray(0, read);
    const { lines, partial } = splitLines(slice);
    return { lines, newByteOffset: start + (slice.length - partial), fileSize: size };
  } finally {
    closeSync(fd);
  }
}
