/**
 * Tests for prompts.ts
 *
 * We test the orchestration layer (label formatting, validation re-prompt,
 * confirm Y/N parsing, default handling) with a ScriptedPrompter that replays
 * predetermined inputs. Real raw-mode stdin is verified via manual smoke
 * tests on each platform before release.
 */

import { describe, test, expect } from 'bun:test';

import {
  text,
  password,
  confirm,
  type Prompter,
  type ReadLineOptions,
} from './prompts.js';

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
    expect(
      await confirm({ label: 'Save?', default: true, prompter: p })
    ).toBe(true);
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
