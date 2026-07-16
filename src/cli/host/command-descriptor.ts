import type { ArgumentsCamelCase, CommandModule } from 'yargs';
import type { Effect } from 'effect';

import type {
  AideHostServicesTag,
  AideInternalHostServicesTag,
} from './runtime-context.js';
import type { KeyringService } from '@lib/auth-keyring.js';

export type CommandRoute = string | readonly string[];

export type CommandResult =
  | { readonly _tag: 'Text'; readonly text: string }
  | { readonly _tag: 'Empty' };

export function textResult(text: string): CommandResult {
  return { _tag: 'Text', text };
}

export const emptyResult: CommandResult = { _tag: 'Empty' };

interface AideCommandDescriptorShape<
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

const descriptorEnvironmentNominality: unique symbol = Symbol(
  'aide.command-descriptor.environment-nominality'
);

/**
 * The unexported class and its ECMAScript private fields retain runtime
 * constructor ownership and provisioning identity. The unexported symbol
 * method keeps R invariant in emitted declarations. Both members live outside
 * the enumerable own-property shape, so object spread copies neither one.
 */
class DefinedAideCommandDescriptor<
  TArgs extends object = object,
  E = unknown,
  R = AideHostServicesTag,
> implements AideCommandDescriptorShape<TArgs, E, R> {
  readonly #environmentNominality: (environment: R) => R;
  readonly #provisioning: CommandProvisioning;
  readonly id: string;
  readonly route: CommandRoute;
  readonly summary: string;
  readonly yargs?: {
    readonly builder?: CommandModule<object, TArgs>['builder'];
  };
  readonly run: (
    args: ArgumentsCamelCase<TArgs>
  ) => Effect.Effect<CommandResult, E, R>;

  [descriptorEnvironmentNominality](environment: R): (environment: R) => R {
    return () => environment;
  }

  private constructor(
    provisioning: CommandProvisioning,
    definition: AideCommandDefinition<TArgs, E, R>
  ) {
    this.#environmentNominality = (environment) => environment;
    this.#provisioning = provisioning;
    this.id = definition.id;
    this.route = Array.isArray(definition.route)
      ? Object.freeze([...definition.route])
      : definition.route;
    this.summary = definition.summary;
    if (definition.yargs !== undefined) {
      this.yargs = Object.freeze({ ...definition.yargs });
    }
    this.run = definition.run;
    Object.freeze(this);
  }

  static create<TArgs extends object, E, R>(
    provisioning: CommandProvisioning,
    definition: AideCommandDefinition<TArgs, E, R>
  ): DefinedAideCommandDescriptor<TArgs, E, R> {
    return new DefinedAideCommandDescriptor(provisioning, definition);
  }

  static provisioning(value: unknown): CommandProvisioning | undefined {
    if (typeof value !== 'object' || value === null) return undefined;

    try {
      void (value as DefinedAideCommandDescriptor).#environmentNominality;
      return (value as DefinedAideCommandDescriptor).#provisioning;
    } catch {
      return undefined;
    }
  }
}

export type AideCommandDescriptor<
  TArgs extends object = object,
  E = unknown,
  R = AideHostServicesTag,
> = DefinedAideCommandDescriptor<TArgs, E, R>;

export type AideCommandDefinition<
  TArgs extends object = object,
  E = unknown,
  R = AideHostServicesTag,
> = AideCommandDescriptorShape<TArgs, E, R>;

export type PublicAideCommandDescriptor<
  TArgs extends object = object,
  E = unknown,
  R = AideHostServicesTag,
> = AideCommandDescriptorShape<TArgs, E, R>;

export type CommandProvisioning =
  | 'none'
  | 'internal-host'
  | 'keyring'
  | 'internal-host+keyring';

export type AnyPublicAideCommandDescriptor = PublicAideCommandDescriptor<
  object,
  unknown,
  AideHostServicesTag
>;

export type ServiceFreeAideCommandDescriptor<
  TArgs extends object = object,
  E = unknown,
> = AideCommandDescriptor<TArgs, E, never>;

export type InternalHostAideCommandDescriptor<
  TArgs extends object = object,
  E = unknown,
> = AideCommandDescriptor<TArgs, E, AideInternalHostServicesTag>;

export type KeyringAideCommandDescriptor<
  TArgs extends object = object,
  E = unknown,
> = AideCommandDescriptor<TArgs, E, KeyringService>;

export type InternalHostAndKeyringAideCommandDescriptor<
  TArgs extends object = object,
  E = unknown,
> = AideCommandDescriptor<
  TArgs,
  E,
  AideInternalHostServicesTag | KeyringService
>;

export type AnyServiceFreeAideCommandDescriptor =
  ServiceFreeAideCommandDescriptor<object, unknown>;
export type AnyInternalHostAideCommandDescriptor =
  InternalHostAideCommandDescriptor<object, unknown>;
export type AnyKeyringAideCommandDescriptor = KeyringAideCommandDescriptor<
  object,
  unknown
>;
export type AnyInternalHostAndKeyringAideCommandDescriptor =
  InternalHostAndKeyringAideCommandDescriptor<object, unknown>;

const defineAideCommandVariants = Object.freeze({
  none<TArgs extends object, E = unknown>(
    descriptor: AideCommandDefinition<TArgs, E, never>
  ): ServiceFreeAideCommandDescriptor<TArgs, E> {
    return DefinedAideCommandDescriptor.create('none', descriptor);
  },
  internalHost<TArgs extends object, E = unknown>(
    descriptor: AideCommandDefinition<TArgs, E, AideInternalHostServicesTag>
  ): InternalHostAideCommandDescriptor<TArgs, E> {
    return DefinedAideCommandDescriptor.create('internal-host', descriptor);
  },
  keyring<TArgs extends object, E = unknown>(
    descriptor: AideCommandDefinition<TArgs, E, KeyringService>
  ): KeyringAideCommandDescriptor<TArgs, E> {
    return DefinedAideCommandDescriptor.create('keyring', descriptor);
  },
  internalHostAndKeyring<TArgs extends object, E = unknown>(
    descriptor: AideCommandDefinition<
      TArgs,
      E,
      AideInternalHostServicesTag | KeyringService
    >
  ): InternalHostAndKeyringAideCommandDescriptor<TArgs, E> {
    return DefinedAideCommandDescriptor.create(
      'internal-host+keyring',
      descriptor
    );
  },
});

export const defineAideCommand = defineAideCommandVariants;

export function assertCommandDescriptorProvisioning(
  descriptor: unknown,
  expected: CommandProvisioning
): void {
  const actual = DefinedAideCommandDescriptor.provisioning(descriptor);
  if (actual === undefined) {
    throw new TypeError(
      'Trusted command descriptors must be created by defineAideCommand'
    );
  }
  if (actual !== expected) {
    throw new TypeError(
      `Trusted command descriptor provisioning mismatch: expected '${expected}', received '${actual}'`
    );
  }
}

export function eraseCommandDescriptor<TArgs extends object, E, R>(
  descriptor: AideCommandDescriptor<TArgs, E, R>,
  provisioning: CommandProvisioning
): AideCommandDescriptor<object, E, R> {
  assertCommandDescriptorProvisioning(descriptor, provisioning);

  return DefinedAideCommandDescriptor.create<object, E, R>(provisioning, {
    id: descriptor.id,
    route: descriptor.route,
    summary: descriptor.summary,
    ...(descriptor.yargs === undefined ? {} : { yargs: descriptor.yargs }),
    run: (args) => descriptor.run(args as ArgumentsCamelCase<TArgs>),
  });
}

export function renderCommandResult(result: CommandResult): void {
  if (result._tag === 'Text') {
    console.log(result.text);
  }
}
