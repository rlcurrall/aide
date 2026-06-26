/**
 * Tests for prompts.ts
 *
 * We test the orchestration layer (label formatting, validation re-prompt,
 * confirm Y/N parsing, default handling) with a ScriptedPrompter that replays
 * predetermined inputs. Real raw-mode stdin is verified via manual smoke
 * tests on each platform before release.
 */

import { describe, test, expect } from 'bun:test';
import { StringDecoder } from 'node:string_decoder';
import { PassThrough } from 'node:stream';

import {
  text,
  password,
  confirm,
  applyChar,
  classifyControlChar,
  stepRawInput,
  readRaw,
  UserCancelledError,
  type Prompter,
  type ReadLineOptions,
  type RawIo,
} from './prompts.js';

type FakeTty = PassThrough & {
  isTTY: boolean;
  isRaw: boolean;
  setRawMode: (v: boolean) => void;
};

/** A PassThrough dressed up as a raw-capable TTY for readRaw tests. */
function fakeTty(): FakeTty {
  const s = new PassThrough() as FakeTty;
  s.isTTY = true;
  s.isRaw = false;
  s.setRawMode = (v) => {
    s.isRaw = v;
  };
  return s;
}

class ScriptedPrompter implements Prompter {
  private inputs: string[];
  readonly writes: string[] = [];
  readonly readCalls: ReadLineOptions[] = [];

  constructor(inputs: string[]) {
    this.inputs = [...inputs];
  }

  async readLine(opts: ReadLineOptions): Promise<string> {
    this.readCalls.push(opts);
    const next = this.inputs.shift();
    if (next === undefined) {
      throw new Error('ScriptedPrompter exhausted - test wants another input');
    }
    return next;
  }

  writeLine(s: string): void {
    this.writes.push(s);
  }
}

describe('text', () => {
  test('returns the entered value', async () => {
    const p = new ScriptedPrompter(['hello']);
    const result = await text({ label: 'Name', prompter: p });
    expect(result).toBe('hello');
  });

  test('returns default when input is empty and default is provided', async () => {
    const p = new ScriptedPrompter(['']);
    const result = await text({
      label: 'Name',
      default: 'bob',
      prompter: p,
    });
    expect(result).toBe('bob');
  });

  test('label includes [default] marker when default is provided', async () => {
    const p = new ScriptedPrompter(['x']);
    await text({ label: 'Name', default: 'bob', prompter: p });
    expect(p.readCalls[0]?.label).toContain('[bob]');
  });

  test('requests non-masked read for text', async () => {
    const p = new ScriptedPrompter(['x']);
    await text({ label: 'Name', prompter: p });
    expect(p.readCalls[0]?.masked).toBeFalsy();
  });

  test('re-prompts on validation failure then accepts next input', async () => {
    const p = new ScriptedPrompter(['', 'ok']);
    const result = await text({
      label: 'Name',
      validate: (v) => (v.length === 0 ? 'required' : null),
      prompter: p,
    });
    expect(result).toBe('ok');
    expect(p.readCalls).toHaveLength(2);
    expect(p.writes.some((w) => w.includes('required'))).toBe(true);
  });
});

describe('password', () => {
  test('requests masked read', async () => {
    const p = new ScriptedPrompter(['secret']);
    const result = await password({ label: 'Token', prompter: p });
    expect(result).toBe('secret');
    expect(p.readCalls[0]?.masked).toBe(true);
  });

  test('re-prompts on empty input (passwords cannot be blank)', async () => {
    const p = new ScriptedPrompter(['', 'secret']);
    const result = await password({ label: 'Token', prompter: p });
    expect(result).toBe('secret');
    expect(p.readCalls).toHaveLength(2);
  });
});

describe('confirm', () => {
  test('returns true for "y"', async () => {
    const p = new ScriptedPrompter(['y']);
    expect(await confirm({ label: 'Save?', prompter: p })).toBe(true);
  });

  test('returns true for "YES" (case-insensitive)', async () => {
    const p = new ScriptedPrompter(['YES']);
    expect(await confirm({ label: 'Save?', prompter: p })).toBe(true);
  });

  test('returns false for "n"', async () => {
    const p = new ScriptedPrompter(['n']);
    expect(await confirm({ label: 'Save?', prompter: p })).toBe(false);
  });

  test('returns default when input is empty', async () => {
    const p = new ScriptedPrompter(['']);
    expect(await confirm({ label: 'Save?', default: true, prompter: p })).toBe(
      true
    );
  });

  test('re-prompts on unrecognized input', async () => {
    const p = new ScriptedPrompter(['maybe', 'y']);
    expect(await confirm({ label: 'Save?', prompter: p })).toBe(true);
    expect(p.readCalls).toHaveLength(2);
  });

  test('label shows [Y/n] when default is true', async () => {
    const p = new ScriptedPrompter(['']);
    await confirm({ label: 'Save?', default: true, prompter: p });
    expect(p.readCalls[0]?.label).toContain('[Y/n]');
  });

  test('label shows [y/N] when default is false', async () => {
    const p = new ScriptedPrompter(['']);
    await confirm({ label: 'Save?', default: false, prompter: p });
    expect(p.readCalls[0]?.label).toContain('[y/N]');
  });
});

describe('UserCancelledError', () => {
  test('UserCancelledError has exitCode 130', () => {
    const err = new UserCancelledError();
    expect(err.exitCode).toBe(130);
    expect(err.name).toBe('UserCancelledError');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('classifyControlChar (line-terminator and control-code classification)', () => {
  test('treats CR as submit (raw-mode Enter delivers a lone CR)', () => {
    expect(classifyControlChar('\r')).toBe('submit');
  });

  test('treats LF as submit', () => {
    expect(classifyControlChar('\n')).toBe('submit');
  });

  test('treats Ctrl+C as cancel', () => {
    expect(classifyControlChar(String.fromCharCode(0x03))).toBe('cancel');
  });

  test('treats backspace (0x08) as backspace', () => {
    expect(classifyControlChar(String.fromCharCode(0x08))).toBe('backspace');
  });

  test('treats DEL (0x7f) as backspace', () => {
    expect(classifyControlChar(String.fromCharCode(0x7f))).toBe('backspace');
  });

  test('returns none for printable ASCII', () => {
    expect(classifyControlChar('a')).toBe('none');
  });

  test('returns none for accented characters', () => {
    expect(classifyControlChar('é')).toBe('none');
  });

  test('returns none for emoji', () => {
    expect(classifyControlChar('😀')).toBe('none');
  });
});

describe('stepRawInput (line-terminator loop state transitions)', () => {
  test('bare \\r submits the typed buffer (the real raw-mode Enter keystroke)', () => {
    // In raw mode the terminal driver does not translate CR->LF (ICRNL is
    // cleared), so pressing Enter delivers a lone \r. It must submit.
    let state = stepRawInput('', 'a', false);
    expect(state.action).toBe('continue');
    expect(state.buf).toBe('a');
    expect(state.writeToTty).toBe('a');

    state = stepRawInput(state.buf, '\r', false);
    expect(state.action).toBe('submit');
    expect(state.buf).toBe('a'); // CR must not append to the buffer
  });

  test('CR submits with the existing buffer intact', () => {
    const state = stepRawInput('hello', '\r', false);
    expect(state.action).toBe('submit');
    expect(state.buf).toBe('hello');
  });

  test('Ctrl+C returns cancel action', () => {
    const state = stepRawInput('partial', '\x03', false);
    expect(state.action).toBe('cancel');
  });

  test('LF submits immediately', () => {
    const state = stepRawInput('done', '\n', false);
    expect(state.action).toBe('submit');
    expect(state.buf).toBe('done');
  });

  test('backspace erases last char and emits erase sequence (unmasked)', () => {
    const state = stepRawInput('ab', '\x7f', false);
    expect(state.action).toBe('continue');
    expect(state.buf).toBe('a');
    expect(state.writeToTty).toBe('\b \b');
  });

  test('backspace in masked mode does not emit erase (hides caret movement)', () => {
    const state = stepRawInput('ab', '\x7f', true);
    expect(state.buf).toBe('a');
    expect(state.writeToTty).toBe('');
  });

  test('masked printable char updates buffer but does not echo', () => {
    const state = stepRawInput('', 'p', true);
    expect(state.buf).toBe('p');
    expect(state.writeToTty).toBe('');
  });

  test('regression: typed text then Enter (lone CR) submits the full buffer', () => {
    // End-to-end: the loop submits 'hi' as soon as the lone CR arrives,
    // before any (nonexistent) trailing LF is seen.
    let buf = '';
    for (const ch of ['h', 'i', '\r']) {
      const s = stepRawInput(buf, ch, false);
      buf = s.buf;
      if (s.action === 'submit') {
        expect(buf).toBe('hi');
        return;
      }
    }
    throw new Error('expected submit');
  });
});

describe('readRaw (sequential prompts share one stdin)', () => {
  test('two prompts read in sequence without tearing down the stream', async () => {
    const input = fakeTty();
    const io: RawIo = { input, output: () => {} };

    const p1 = readRaw(false, io);
    input.write('https://x.atlassian.net\r');
    expect(await p1).toBe('https://x.atlassian.net');

    // The stream must survive the first read so the next prompt can use it.
    // (for-await + early return destroyed it, aborting the second prompt.)
    expect(input.destroyed).toBe(false);

    const p2 = readRaw(false, io);
    input.write('me@example.com\r');
    expect(await p2).toBe('me@example.com');

    expect(input.listenerCount('data')).toBe(0); // listener cleaned up
  });

  test('Ctrl+C rejects with UserCancelledError and leaves the stream usable', async () => {
    const input = fakeTty();
    const io: RawIo = { input, output: () => {} };

    const p1 = readRaw(false, io);
    input.write('\x03');
    await expect(p1).rejects.toBeInstanceOf(UserCancelledError);
    expect(input.destroyed).toBe(false);

    const p2 = readRaw(false, io);
    input.write('recovered\r');
    expect(await p2).toBe('recovered');
  });

  test('a throw while handling input still restores raw mode and detaches', async () => {
    const input = fakeTty();
    const boom = new Error('kaboom');
    // output throws on the first echo; the read must not leave the terminal in
    // raw mode with a dangling listener (the dropped for-await `finally`).
    const io: RawIo = {
      input,
      output: () => {
        throw boom;
      },
    };

    const p = readRaw(false, io);
    input.write('a');
    await expect(p).rejects.toBe(boom);

    expect(input.isRaw).toBe(false); // raw mode restored
    expect(input.listenerCount('data')).toBe(0);
    expect(input.destroyed).toBe(false);
  });

  test('a stream error rejects and restores raw mode', async () => {
    const input = fakeTty();
    const io: RawIo = { input, output: () => {} };
    const err = new Error('stdin exploded');

    const p = readRaw(false, io);
    input.emit('error', err);
    await expect(p).rejects.toBe(err);

    expect(input.isRaw).toBe(false);
    expect(input.listenerCount('data')).toBe(0);
    expect(input.listenerCount('error')).toBe(0);
  });

  test('end-of-stream resolves the buffered input', async () => {
    const input = fakeTty();
    const io: RawIo = { input, output: () => {} };

    const p = readRaw(false, io);
    input.write('partial');
    input.end();
    expect(await p).toBe('partial');

    expect(input.isRaw).toBe(false);
    expect(input.listenerCount('data')).toBe(0);
  });
});

describe('applyChar (UTF-8 code-point handling)', () => {
  test('accumulates ASCII characters correctly', () => {
    let buf = '';
    for (const ch of 'hello') {
      ({ buf } = applyChar(buf, ch, false));
    }
    expect(buf).toBe('hello');
  });

  test('accumulates multi-byte UTF-8 characters correctly', () => {
    // StringDecoder correctly reassembles these from raw bytes before we iterate.
    const input = 'café'; // 'é' is U+00E9, two UTF-8 bytes
    let buf = '';
    for (const ch of input) {
      ({ buf } = applyChar(buf, ch, false));
    }
    expect(buf).toBe('café');
    expect(Array.from(buf)).toHaveLength(4); // 4 code points, not 5 bytes
  });

  test('backspace removes the last code point, not a raw byte', () => {
    // Build up a buffer with an emoji (U+1F600, surrogate pair in UTF-16).
    const emoji = '\u{1F600}'; // represented as 2 UTF-16 code units
    let buf = emoji; // pre-loaded

    // Applying backspace should remove the whole emoji.
    const { buf: after } = applyChar(buf, '\x7f', false);
    expect(after).toBe('');
  });

  test('backspace on a string ending with surrogate pair removes full emoji', () => {
    let buf = 'hi\u{1F600}'; // "hi" + emoji
    ({ buf } = applyChar(buf, '\x7f', false));
    expect(buf).toBe('hi');
  });

  test('StringDecoder reassembles multi-byte sequence split across chunks', () => {
    // 'é' (U+00E9) encoded as two bytes [0xc3, 0xa9].
    const decoder = new StringDecoder('utf8');
    const firstChunk = decoder.write(Buffer.from([0xc3])); // incomplete sequence
    const secondChunk = decoder.write(Buffer.from([0xa9])); // completes it
    const combined = firstChunk + secondChunk;
    // After reassembly the single code point 'é' must be present.
    expect(combined).toBe('é');
    expect(Array.from(combined)).toHaveLength(1);
  });

  test('masked mode suppresses TTY echo but still accumulates buffer', () => {
    let buf = '';
    let echoed = '';
    for (const ch of 'secret') {
      const result = applyChar(buf, ch, true);
      buf = result.buf;
      echoed += result.writeToTty;
    }
    expect(buf).toBe('secret');
    expect(echoed).toBe(''); // nothing echoed in masked mode
  });
});
