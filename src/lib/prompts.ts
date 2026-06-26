/**
 * Small prompt helpers for interactive commands.
 *
 * The Prompter interface exists so tests can inject scripted input without
 * touching real stdin. TerminalPrompter uses Node's raw-mode stdin so we can
 * suppress echo for password fields and handle Ctrl+C cleanly.
 */

import { StringDecoder } from 'node:string_decoder';

export class UserCancelledError extends Error {
  readonly exitCode = 130;
  override readonly name = 'UserCancelledError';
  constructor() {
    super('Cancelled by user');
    Object.setPrototypeOf(this, UserCancelledError.prototype);
  }
}

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
    const value =
      raw.length === 0 && opts.default !== undefined ? opts.default : raw;
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
    opts.default === true
      ? '[Y/n]'
      : opts.default === false
        ? '[y/N]'
        : '[y/n]';
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
//
// Both CR and LF submit the line. In raw mode the terminal driver does not
// translate CR->LF (ICRNL is cleared by setRawMode), so the Enter key delivers
// a lone CR (0x0d) on macOS and Linux - it never arrives as LF. Treating CR as
// a no-op would make Enter do nothing. A CRLF pair (\r\n) submits on the CR;
// readRaw swallows the paired LF so it does not submit the next line as empty.

/**
 * Classify a single decoded code point for the raw-mode input loop.
 *
 * Returns one of:
 *  - 'submit'    - end of input (CR or LF)
 *  - 'cancel'    - Ctrl+C
 *  - 'backspace' - delete last character (BS or DEL)
 *  - 'none'      - printable character, pass to applyChar
 *
 * Exported for unit testing.
 */
export function classifyControlChar(
  ch: string
): 'submit' | 'cancel' | 'backspace' | 'none' {
  const code = ch.charCodeAt(0);
  if (code === 0x03) return 'cancel';
  if (code === 0x0a || code === 0x0d) return 'submit';
  if (code === 0x08 || code === 0x7f) return 'backspace';
  return 'none';
}

export interface StepResult {
  buf: string;
  writeToTty: string;
  action: 'continue' | 'submit' | 'cancel';
}

/**
 * Apply a single decoded code point to the raw-input state. Pure function
 * combining classifyControlChar + applyChar with the loop's branching
 * behavior (submit on CR or LF, cancel on Ctrl+C). Exported for unit testing
 * so the line-terminator contract is exercised end-to-end.
 */
export function stepRawInput(
  buf: string,
  ch: string,
  masked: boolean
): StepResult {
  const kind = classifyControlChar(ch);
  if (kind === 'cancel') return { buf, writeToTty: '', action: 'cancel' };
  if (kind === 'submit') return { buf, writeToTty: '', action: 'submit' };
  const applied = applyChar(buf, ch, masked);
  return {
    buf: applied.buf,
    writeToTty: applied.writeToTty,
    action: 'continue',
  };
}

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

// Set when a line was submitted by a bare CR, so the next readRaw can swallow a
// leading LF that is the trailing half of a CRLF pair split across reads.
let pendingCrlfLf = false;

/**
 * The slice of stdin readRaw depends on. Declared structurally so tests can
 * inject a plain stream (e.g. PassThrough) in place of the real TTY.
 */
export interface RawInputStream {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode(mode: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  removeListener(event: 'data', listener: (chunk: Buffer) => void): unknown;
  removeListener(event: 'error', listener: (err: Error) => void): unknown;
  removeListener(event: 'end', listener: () => void): unknown;
}

export interface RawIo {
  input: RawInputStream;
  output: (s: string) => void;
}

function defaultIo(): RawIo {
  return {
    input: process.stdin as unknown as RawInputStream,
    output: (s) => process.stdout.write(s),
  };
}

/**
 * Read a single line from a raw-mode TTY. Exported for unit testing via the
 * injectable `io` seam.
 *
 * Input is consumed with a persistent `data` listener that is removed (not the
 * stream destroyed) when the line completes. An earlier version used
 * `for await (const chunk of stdin)`, but returning early from that loop calls
 * the async iterator's `return()`, which destroys/aborts stdin - so the *next*
 * readRaw threw "The operation was aborted." A `data` listener leaves the
 * stream intact for subsequent prompts.
 *
 * Every exit path - submit, cancel, a throw while decoding, or a stream
 * error/end - runs through `settle`, which restores raw mode, pauses stdin and
 * detaches all listeners exactly once. Without this the for-await version's
 * `finally` guarantee was lost: a throw inside the data handler would leave the
 * terminal stuck in raw mode with a dangling listener and the promise pending.
 */
export function readRaw(
  masked: boolean,
  io: RawIo = defaultIo()
): Promise<string> {
  const { input, output } = io;
  if (!input.isTTY) {
    // Non-TTY (piped input): fall back to a whole-line read.
    return readPipedLine();
  }

  const wasRaw = Boolean(input.isRaw);
  input.setRawMode(true);
  input.resume();

  const decoder = new StringDecoder('utf8');
  let buf = '';
  // True only for the first code point of this read, when the previous line was
  // submitted by a CR. A CRLF terminal sends \r\n; we submit on the \r, so a
  // leading \n here is the other half of that pair and must be swallowed rather
  // than submitting an empty line. (A \r\n arriving within one read is already
  // handled: we submit on the \r before the \n in the same chunk.)
  let skipLeadingLf = pendingCrlfLf;
  pendingCrlfLf = false;

  return new Promise<string>((resolve, reject) => {
    let settled = false;

    // Single teardown for every outcome: detach listeners, restore the prior
    // raw-mode state and pause stdin, then deliver the result. Idempotent so a
    // late error after submit/cancel is ignored rather than double-settling.
    const settle = (deliver: () => void) => {
      if (settled) return;
      settled = true;
      input.removeListener('data', onData);
      input.removeListener('error', onError);
      input.removeListener('end', onEnd);
      input.setRawMode(wasRaw);
      input.pause();
      deliver();
    };

    const onData = (chunk: Buffer) => {
      try {
        const decoded = decoder.write(chunk);
        for (const ch of decoded) {
          if (skipLeadingLf) {
            skipLeadingLf = false;
            if (ch === '\n') continue;
          }
          const step = stepRawInput(buf, ch, masked);
          if (step.action === 'cancel') {
            output('\n');
            settle(() => reject(new UserCancelledError()));
            return;
          }
          if (step.action === 'submit') {
            pendingCrlfLf = ch === '\r';
            output('\n');
            settle(() => resolve(step.buf));
            return;
          }
          buf = step.buf;
          if (step.writeToTty) output(step.writeToTty);
        }
      } catch (err) {
        settle(() =>
          reject(err instanceof Error ? err : new Error(String(err)))
        );
      }
    };

    // A stream-level error must reject (the old for-await would have thrown);
    // an unexpected end resolves whatever was typed, matching the prior
    // fall-through-and-return-buf behavior.
    const onError = (err: Error) => settle(() => reject(err));
    const onEnd = () => settle(() => resolve(buf));

    input.on('data', onData);
    input.on('error', onError);
    input.on('end', onEnd);
  });
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
