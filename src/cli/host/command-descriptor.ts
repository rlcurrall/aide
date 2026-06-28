import type { ArgumentsCamelCase, CommandModule } from 'yargs';
import type { Effect } from 'effect';

import type { AideHostServicesTag } from './runtime-context.js';

export type CommandRoute = string | readonly string[];

export type CommandResult =
  | { readonly _tag: 'Text'; readonly text: string }
  | { readonly _tag: 'Empty' };

export function textResult(text: string): CommandResult {
  return { _tag: 'Text', text };
}

export const emptyResult: CommandResult = { _tag: 'Empty' };

export interface AideCommandDescriptor<
  TArgs extends object = object,
  E = unknown,
  R = AideHostServicesTag,
> {
  readonly id: string;
  readonly route: CommandRoute;
  readonly summary: string;
  readonly yargs?: {
    readonly builder?: CommandModule<object, TArgs>['builder'];
  };
  readonly run: (
    args: ArgumentsCamelCase<TArgs>
  ) => Effect.Effect<CommandResult, E, R>;
}

export type AnyAideCommandDescriptor = AideCommandDescriptor<
  object,
  unknown,
  AideHostServicesTag
>;

export type HostAideCommandDescriptor<
  TArgs extends object = object,
  E = unknown,
> = AideCommandDescriptor<TArgs, E, AideHostServicesTag>;

export type ServiceFreeAideCommandDescriptor<
  TArgs extends object = object,
  E = unknown,
> = AideCommandDescriptor<TArgs, E, never>;

export function defineAideCommand<
  TArgs extends object,
  E = unknown,
  R = AideHostServicesTag,
>(
  descriptor: AideCommandDescriptor<TArgs, E, R>
): AideCommandDescriptor<TArgs, E, R> {
  return descriptor;
}

export function eraseCommandDescriptor<TArgs extends object, E = unknown>(
  descriptor: ServiceFreeAideCommandDescriptor<TArgs, E>
): AnyAideCommandDescriptor;
export function eraseCommandDescriptor<TArgs extends object, E = unknown>(
  descriptor: HostAideCommandDescriptor<TArgs, E>
): AnyAideCommandDescriptor;
export function eraseCommandDescriptor<TArgs extends object>(
  descriptor: AideCommandDescriptor<TArgs, unknown, unknown>
): AnyAideCommandDescriptor {
  return descriptor as unknown as AnyAideCommandDescriptor;
}

export function renderCommandResult(result: CommandResult): void {
  if (result._tag === 'Text') {
    console.log(result.text);
  }
}
