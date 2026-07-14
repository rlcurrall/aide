/**
 * Own and freeze one host static plugin definition before exporting it.
 *
 * Only plain/null-prototype records and exact Arrays are definition
 * containers. They are cloned through own descriptors, including symbols and
 * cycles, without invoking accessors. Functions are shared terminal callback
 * values: their frozen owning slot is immutable, but the function and its
 * prototype record are never traversed or frozen. Unsupported runtime objects
 * are rejected rather than cloned, traversed, or frozen.
 */
export function defineImmutableBuiltinPlugin<T extends object>(plugin: T): T {
  const owned = new WeakMap<object, object>();

  const cloneDefinitionNode = (value: unknown): unknown => {
    if (
      typeof value === 'function' ||
      typeof value !== 'object' ||
      value === null
    ) {
      return value;
    }
    if (isNodeProxy(value)) {
      throw new TypeError(
        'Immutable built-in definitions may not contain object Proxies.'
      );
    }

    const existing = owned.get(value);
    if (existing !== undefined) return existing;

    const array = Array.isArray(value);
    const prototype = Reflect.getPrototypeOf(value);
    if (
      (array && prototype !== Array.prototype) ||
      (!array && prototype !== Object.prototype && prototype !== null)
    ) {
      throw new TypeError(
        'Immutable built-in definitions may contain only records, Arrays, primitives, and callback functions.'
      );
    }

    const clone: object = array ? [] : Object.create(prototype);
    owned.set(value, clone);

    let arrayLengthDescriptor: PropertyDescriptor | undefined;
    const keys = Reflect.ownKeys(value);
    const keyLengthDescriptor = Reflect.getOwnPropertyDescriptor(
      keys,
      'length'
    );
    const keyCount =
      keyLengthDescriptor !== undefined &&
      Object.hasOwn(keyLengthDescriptor, 'value') &&
      typeof keyLengthDescriptor.value === 'number'
        ? keyLengthDescriptor.value
        : 0;
    for (let index = 0; index < keyCount; index += 1) {
      const keyDescriptor = Reflect.getOwnPropertyDescriptor(
        keys,
        String(index)
      );
      if (
        keyDescriptor === undefined ||
        !Object.hasOwn(keyDescriptor, 'value')
      ) {
        throw new TypeError('Immutable built-in definition keys changed.');
      }
      const key = keyDescriptor.value as PropertyKey;
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined) {
        throw new TypeError(
          'Immutable built-in definition descriptor changed.'
        );
      }
      if (array && key === 'length') {
        arrayLengthDescriptor = descriptor;
        continue;
      }

      const ownedDescriptor =
        'value' in descriptor
          ? {
              ...descriptor,
              value: cloneDefinitionNode(descriptor.value),
            }
          : descriptor;
      if (!Reflect.defineProperty(clone, key, ownedDescriptor)) {
        throw new TypeError(
          'Immutable built-in definition could not be owned.'
        );
      }
    }

    if (
      arrayLengthDescriptor !== undefined &&
      !Reflect.defineProperty(clone, 'length', arrayLengthDescriptor)
    ) {
      throw new TypeError(
        'Immutable built-in Array length could not be owned.'
      );
    }

    return Object.freeze(clone);
  };

  return cloneDefinitionNode(plugin) as T;
}
import { types as nodeUtilTypes } from 'node:util';

const isNodeProxy = nodeUtilTypes.isProxy;
