import type { ArgumentsCamelCase, CommandModule } from 'yargs';
import type { Effect } from 'effect';

export type CommandRoute = string | readonly string[];

export type CommandResult =
  | { readonly _tag: 'Text'; readonly text: string }
  | { readonly _tag: 'Empty' };

export function textResult(text: string): CommandResult {
  return { _tag: 'Text', text };
}

export const emptyResult: CommandResult = { _tag: 'Empty' };

export interface AideCommandDescriptor<TArgs extends object = object> {
  readonly id: string;
  readonly route: CommandRoute;
  readonly summary: string;
  readonly yargs?: {
    readonly builder?: CommandModule<object, TArgs>['builder'];
  };
  readonly run: (
    args: ArgumentsCamelCase<TArgs>
  ) => Effect.Effect<CommandResult, unknown, never>;
}

export type AnyAideCommandDescriptor = AideCommandDescriptor<object>;

export function defineAideCommand<TArgs extends object>(
  descriptor: AideCommandDescriptor<TArgs>
): AideCommandDescriptor<TArgs> {
  return descriptor;
}

export function eraseCommandDescriptor<TArgs extends object>(
  descriptor: AideCommandDescriptor<TArgs>
): AnyAideCommandDescriptor {
  return descriptor as unknown as AnyAideCommandDescriptor;
}

export function renderCommandResult(result: CommandResult): void {
  if (result._tag === 'Text') {
    console.log(result.text);
  }
}
