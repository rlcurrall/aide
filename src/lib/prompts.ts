/**
 * Small prompt helpers for interactive commands.
 *
 * The Prompter interface exists so tests can inject scripted input without
 * touching real stdin. TerminalPrompter uses Node's raw-mode stdin so we can
 * suppress echo for password fields and handle Ctrl+C cleanly.
 */

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
// withSpinner
// ---------------------------------------------------------------------------
//
// Minimal ASCII spinner for network calls during login. Writes to stderr so
// it doesn't pollute stdout when a command's result is piped.

const SPINNER_FRAMES = ['-', '\\', '|', '/'];

export async function withSpinner<T>(
  label: string,
  fn: () => Promise<T>
): Promise<T> {
  if (!process.stderr.isTTY) {
    return fn();
  }
  let frame = 0;
  const interval = setInterval(() => {
    process.stderr.write(`\r${SPINNER_FRAMES[frame]} ${label}`);
    frame = (frame + 1) % SPINNER_FRAMES.length;
  }, 80);
  try {
    const result = await fn();
    return result;
  } finally {
    clearInterval(interval);
    process.stderr.write(`\r${' '.repeat(label.length + 2)}\r`);
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

async function readRaw(masked: boolean): Promise<string> {
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  if (!stdin.isTTY) {
    // Non-TTY (piped input): fall back to a whole-line read.
    return await readPipedLine();
  }

  stdin.setRawMode(true);
  stdin.resume();

  let buf = '';
  try {
    for await (const chunk of stdin as AsyncIterable<Buffer>) {
      for (const byte of chunk) {
        if (byte === 0x03) {
          // Ctrl+C
          process.stdout.write('\n');
          process.exit(130);
        }
        if (byte === 0x0d || byte === 0x0a) {
          process.stdout.write('\n');
          return buf;
        }
        if (byte === 0x7f || byte === 0x08) {
          // Backspace / DEL
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            if (!masked) process.stdout.write('\b \b');
          }
          continue;
        }
        if (byte < 0x20) continue; // ignore other control chars
        const ch = String.fromCharCode(byte);
        buf += ch;
        if (!masked) process.stdout.write(ch);
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
