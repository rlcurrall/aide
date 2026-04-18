/**
 * Small prompt helpers for interactive commands.
 *
 * The Prompter interface exists so tests can inject scripted input without
 * touching real stdin. TerminalPrompter uses Node's raw-mode stdin so we can
 * suppress echo for password fields and handle Ctrl+C cleanly.
 */

import { StringDecoder } from 'node:string_decoder';

export interface ReadLineOptions {
  label: string;
  masked?: boolean;
}

export interface Prompter {
  readLine(opts: ReadLineOptions): Promise<string>;
  writeLine(s: string): void;
}

export class TerminalPrompter implements Prompter {
  async readLine(opts: ReadLineOptions): Promise<string> {
    process.stdout.write(opts.label);
    return await readRaw(Boolean(opts.masked));
  }

  writeLine(s: string): void {
    process.stderr.write(s + '\n');
  }
}

const defaultPrompter: Prompter = new TerminalPrompter();

// ---------------------------------------------------------------------------
// text
// ---------------------------------------------------------------------------

export interface TextOptions {
  label: string;
  default?: string;
  validate?: (value: string) => string | null;
  prompter?: Prompter;
}

export async function text(opts: TextOptions): Promise<string> {
  const prompter = opts.prompter ?? defaultPrompter;
  const label =
    opts.default !== undefined
      ? `${opts.label} [${opts.default}]: `
      : `${opts.label}: `;

  for (;;) {
    const raw = await prompter.readLine({ label });
    const value = raw.length === 0 && opts.default !== undefined ? opts.default : raw;
    const err = opts.validate?.(value);
    if (err) {
      prompter.writeLine(`  ${err}`);
      continue;
    }
    return value;
  }
}

// ---------------------------------------------------------------------------
// password
// ---------------------------------------------------------------------------

export interface PasswordOptions {
  label: string;
  prompter?: Prompter;
}

export async function password(opts: PasswordOptions): Promise<string> {
  const prompter = opts.prompter ?? defaultPrompter;
  const label = `${opts.label}: `;

  for (;;) {
    const value = await prompter.readLine({ label, masked: true });
    if (value.length === 0) {
      prompter.writeLine('  value required');
      continue;
    }
    return value;
  }
}

// ---------------------------------------------------------------------------
// confirm
// ---------------------------------------------------------------------------

export interface ConfirmOptions {
  label: string;
  default?: boolean;
  prompter?: Prompter;
}

export async function confirm(opts: ConfirmOptions): Promise<boolean> {
  const prompter = opts.prompter ?? defaultPrompter;
  const hint =
    opts.default === true ? '[Y/n]' : opts.default === false ? '[y/N]' : '[y/n]';
  const label = `${opts.label} ${hint}: `;

  for (;;) {
    const raw = (await prompter.readLine({ label })).trim().toLowerCase();
    if (raw.length === 0 && opts.default !== undefined) {
      return opts.default;
    }
    if (raw === 'y' || raw === 'yes') return true;
    if (raw === 'n' || raw === 'no') return false;
    prompter.writeLine('  please answer y or n');
  }
}

// ---------------------------------------------------------------------------
// Raw stdin reader
// ---------------------------------------------------------------------------
//
// Reads a single line from stdin using raw mode so we can suppress echo for
// masked input and handle Ctrl+C cleanly. Printable chars are echoed as they
// arrive when masked=false, and suppressed (no asterisks) when masked=true.
// Backspace deletes the last char. Enter terminates. Ctrl+C exits with 130.
//
// StringDecoder is used so that multi-byte UTF-8 sequences (accented chars,
// CJK, emoji) are decoded correctly before we iterate code points.
// \r is discarded; \n submits the line (handles both LF and CRLF terminals).

/**
 * Apply a single decoded code point to the buffer. Exported for unit testing.
 *
 * Returns the new buffer string and any bytes to write back to the TTY.
 */
export function applyChar(
  buf: string,
  ch: string,
  masked: boolean
): { buf: string; writeToTty: string } {
  const code = ch.charCodeAt(0);

  // Backspace / DEL
  if (code === 0x7f || code === 0x08) {
    if (buf.length === 0) return { buf, writeToTty: '' };
    const newBuf = Array.from(buf).slice(0, -1).join('');
    const tty = masked ? '' : '\b \b';
    return { buf: newBuf, writeToTty: tty };
  }

  // Ignore control characters (except the special ones handled in readRaw)
  if (code < 0x20) return { buf, writeToTty: '' };

  const newBuf = buf + ch;
  const tty = masked ? '' : ch;
  return { buf: newBuf, writeToTty: tty };
}

async function readRaw(masked: boolean): Promise<string> {
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  if (!stdin.isTTY) {
    // Non-TTY (piped input): fall back to a whole-line read.
    return await readPipedLine();
  }

  stdin.setRawMode(true);
  stdin.resume();

  const decoder = new StringDecoder('utf8');
  let buf = '';
  try {
    for await (const chunk of stdin as AsyncIterable<Buffer>) {
      const decoded = decoder.write(chunk);
      for (const ch of decoded) {
        const code = ch.charCodeAt(0);

        // Ctrl+C: restore terminal state before exiting so raw mode isn't
        // left enabled on compiled Windows binaries.
        if (code === 0x03) {
          process.stdout.write('\n');
          stdin.setRawMode(wasRaw);
          stdin.pause();
          process.exit(130);
        }

        // Submit on LF; discard CR (handles both LF-only and CRLF terminals).
        if (code === 0x0a) {
          process.stdout.write('\n');
          return buf;
        }
        if (code === 0x0d) continue; // discard CR

        const result = applyChar(buf, ch, masked);
        buf = result.buf;
        if (result.writeToTty) process.stdout.write(result.writeToTty);
      }
    }
    return buf;
  } finally {
    stdin.setRawMode(wasRaw);
    stdin.pause();
  }
}

async function readPipedLine(): Promise<string> {
  let buf = '';
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    buf += chunk.toString('utf8');
    const newline = buf.indexOf('\n');
    if (newline !== -1) return buf.slice(0, newline).replace(/\r$/, '');
  }
  return buf.replace(/\r$/, '');
}
