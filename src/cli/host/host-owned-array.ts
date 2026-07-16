export type OwnArrayDataValue<T> =
  | { readonly found: true; readonly value: T }
  | { readonly found: false };

const hasOwn = Object.hasOwn;
const objectCreate = Object.create;
const objectDefineProperty = Object.defineProperty;
const objectFreeze = Object.freeze;
const reflectGetOwnPropertyDescriptor = Reflect.getOwnPropertyDescriptor;

/** Read an Array's own numeric length data property without prototype access. */
export function ownArrayLength(source: object): number | undefined {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = reflectGetOwnPropertyDescriptor(source, 'length');
  } catch {
    return undefined;
  }
  return descriptor !== undefined && hasOwn(descriptor, 'value')
    ? (descriptor.value as number)
    : undefined;
}

/**
 * Read one Array index without consulting its prototype or invoking an own
 * accessor. Callers retain domain-specific handling for a missing/non-data
 * entry.
 */
export function ownArrayDataValue<T>(
  source: object,
  index: number
): OwnArrayDataValue<T> {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = reflectGetOwnPropertyDescriptor(source, String(index));
  } catch {
    return { found: false };
  }
  return descriptor !== undefined && hasOwn(descriptor, 'value')
    ? { found: true, value: descriptor.value as T }
    : { found: false };
}

/** Define one ordinary Array index without invoking inherited setters. */
export function defineHostArrayIndex<T>(
  target: T[],
  index: number,
  value: T
): void {
  objectDefineProperty(target, String(index), {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

/** Flatten host-owned dense Array groups without late prototype dispatch. */
export function flattenHostArrayGroups<T>(
  groups: readonly (readonly T[])[]
): T[] {
  const flattened: T[] = [];
  const groupCount = ownArrayLength(groups) ?? 0;
  let outputIndex = 0;
  for (let groupIndex = 0; groupIndex < groupCount; groupIndex += 1) {
    const group = ownArrayDataValue<readonly T[]>(groups, groupIndex);
    if (!group.found) continue;
    const entryCount = ownArrayLength(group.value) ?? 0;
    for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
      const entry = ownArrayDataValue<T>(group.value, entryIndex);
      if (!entry.found) continue;
      defineHostArrayIndex(flattened, outputIndex, entry.value);
      outputIndex += 1;
    }
  }
  return flattened;
}

/** Filter own Array data entries into a fresh dense host-owned Array. */
export function filterHostArray<T>(
  source: readonly T[],
  predicate: (value: T) => boolean
): T[] {
  const filtered: T[] = [];
  const length = ownArrayLength(source) ?? 0;
  let outputIndex = 0;
  for (let index = 0; index < length; index += 1) {
    const entry = ownArrayDataValue<T>(source, index);
    if (!entry.found || !predicate(entry.value)) continue;
    defineHostArrayIndex(filtered, outputIndex, entry.value);
    outputIndex += 1;
  }
  return filtered;
}

/** Map own Array data entries while preserving source length and holes. */
export function mapHostArray<T, U>(
  source: readonly T[],
  mapper: (value: T) => U
): U[] {
  const mapped: U[] = [];
  const length = ownArrayLength(source) ?? 0;
  for (let index = 0; index < length; index += 1) {
    const entry = ownArrayDataValue<T>(source, index);
    if (!entry.found) continue;
    defineHostArrayIndex(mapped, index, mapper(entry.value));
  }
  objectDefineProperty(mapped, 'length', { value: length });
  return mapped;
}

export interface HighestPriorityHostArraySelection<T> {
  readonly winner: T | undefined;
  readonly tied: readonly T[];
}

/** Collect the first highest-priority entry and its stable-order ties. */
export function selectHighestPriorityHostArray<T>(
  source: readonly T[],
  priority: (value: T) => number
): HighestPriorityHostArraySelection<T> {
  let hasWinner = false;
  let winner: T | undefined;
  let winnerPriority = 0;
  let tied: T[] = [];
  const length = ownArrayLength(source) ?? 0;
  for (let index = 0; index < length; index += 1) {
    const entry = ownArrayDataValue<T>(source, index);
    if (!entry.found) continue;
    const entryPriority = priority(entry.value);
    if (!hasWinner || entryPriority > winnerPriority) {
      hasWinner = true;
      winner = entry.value;
      winnerPriority = entryPriority;
      tied = [];
      defineHostArrayIndex(tied, 0, entry.value);
      continue;
    }
    if (entryPriority === winnerPriority) {
      const tiedLength = ownArrayLength(tied) ?? 0;
      defineHostArrayIndex(tied, tiedLength, entry.value);
    }
  }
  return { winner, tied };
}

/** Expose a dense own-data Array through an own iterator implementation. */
export function hostArrayIterable<T>(source: readonly T[]): Iterable<T> {
  const iterable = objectCreate(null) as Record<PropertyKey, unknown>;
  objectDefineProperty(iterable, Symbol.iterator, {
    configurable: false,
    enumerable: false,
    value: () => {
      const length = ownArrayLength(source) ?? 0;
      let index = 0;
      return {
        next(): IteratorResult<T> {
          if (index >= length) return { done: true, value: undefined };
          const entry = ownArrayDataValue<T>(source, index);
          index += 1;
          return entry.found
            ? { done: false, value: entry.value }
            : { done: true, value: undefined };
        },
      };
    },
    writable: false,
  });
  return objectFreeze(iterable) as unknown as Iterable<T>;
}
