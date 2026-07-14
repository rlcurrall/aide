import { inspect } from 'node:util';

export const backendFailureSentinels = Object.freeze([
  'RAW_MESSAGE_SENTINEL_4f21',
  'RAW_STACK_SENTINEL_08d3',
  'NESTED_CAUSE_SENTINEL_c929',
  'ENUMERABLE_SENTINEL_6ea4',
  'HIDDEN_SENTINEL_182b',
  'SYMBOL_SENTINEL_d771',
  'ARRAY_SENTINEL_a05c',
  'TO_JSON_SENTINEL_773e',
  'CUSTOM_INSPECT_SENTINEL_f19a',
  'HOSTILE_GETTER_SENTINEL_596d',
] as const);

export interface MaliciousFailureFixture {
  readonly failure: Error;
  readonly getterReads: () => number;
}

export function maliciousBackendFailure(
  additionalSecrets: readonly string[] = []
): MaliciousFailureFixture {
  let getterReadCount = 0;
  const nested = new Error(backendFailureSentinels[2]);
  Object.defineProperty(nested, 'stack', {
    configurable: true,
    value: `${backendFailureSentinels[1]} nested ${additionalSecrets.join(' ')}`,
  });

  const failure = new Error(
    `${backendFailureSentinels[0]} ${additionalSecrets.join(' ')}`,
    { cause: nested }
  );
  Object.defineProperty(failure, 'stack', {
    configurable: true,
    value: `${backendFailureSentinels[1]} ${additionalSecrets.join(' ')}`,
  });
  Object.defineProperty(failure, 'enumerablePayload', {
    configurable: true,
    enumerable: true,
    value: {
      marker: backendFailureSentinels[3],
      secrets: [...additionalSecrets],
      values: [backendFailureSentinels[6]],
    },
  });
  Object.defineProperty(failure, 'hiddenPayload', {
    configurable: true,
    value: `${backendFailureSentinels[4]} ${additionalSecrets.join(' ')}`,
  });
  Object.defineProperty(failure, Symbol(backendFailureSentinels[5]), {
    configurable: true,
    enumerable: true,
    value: backendFailureSentinels[5],
  });
  Object.defineProperty(failure, 'hostileGetter', {
    configurable: true,
    enumerable: false,
    get() {
      getterReadCount += 1;
      return backendFailureSentinels[9];
    },
  });
  Object.defineProperty(failure, 'toJSON', {
    configurable: true,
    enumerable: false,
    value: () => ({ marker: backendFailureSentinels[7] }),
  });
  Object.defineProperty(failure, inspect.custom, {
    configurable: true,
    enumerable: false,
    value: () => backendFailureSentinels[8],
  });

  return {
    failure,
    getterReads: () => getterReadCount,
  };
}

function propertyKeyText(key: PropertyKey): string {
  return typeof key === 'symbol'
    ? `Symbol(${key.description ?? ''})`
    : String(key);
}

/** Traverse own data properties only; accessor functions are never invoked. */
export function reachableOwnDataText(root: unknown): string {
  const output: string[] = [];
  const queue: unknown[] = [root];
  const seen = new Set<object>();

  while (queue.length > 0) {
    const value = queue.shift();
    if (
      (typeof value !== 'object' && typeof value !== 'function') ||
      value === null
    ) {
      if (typeof value === 'string' || typeof value === 'symbol') {
        output.push(String(value));
      }
      continue;
    }
    if (seen.has(value)) continue;
    seen.add(value);

    for (const key of Reflect.ownKeys(value)) {
      output.push(propertyKeyText(key));
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor !== undefined && Object.hasOwn(descriptor, 'value')) {
        queue.push(descriptor.value);
      }
    }
  }

  return output.join('\n');
}

export function exportedErrorText(error: Error): string {
  const descriptors = Object.fromEntries(
    Reflect.ownKeys(error).map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(error, key);
      return [propertyKeyText(key), descriptor];
    })
  );

  return [
    String(error),
    error.name,
    error.message,
    error.stack ?? '',
    JSON.stringify(Object.keys(error)),
    JSON.stringify(Reflect.ownKeys(error).map(propertyKeyText)),
    inspect(descriptors, { depth: 20, getters: false, showHidden: true }),
    JSON.stringify(error),
    inspect(error, { depth: 20, getters: false, showHidden: true }),
    reachableOwnDataText(error),
  ].join('\n');
}
