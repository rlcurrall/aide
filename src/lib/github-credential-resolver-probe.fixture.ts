import { resolveGitHubAuthRequest } from './github-auth.js';
import { validateGitHubAuthProbeResult } from './github-credential-resolver.js';

type FixtureMode = 'reachability-control' | 'production';

const mode = process.argv[2] as FixtureMode | undefined;
if (mode !== 'reachability-control' && mode !== 'production') {
  throw new Error('Expected a credential resolver probe fixture mode');
}

const request = resolveGitHubAuthRequest({ host: 'github.com' });
if (!request.ok) {
  throw new Error(`Unexpected fixture request failure: ${request.reason}`);
}

const originalValueDescriptor = Object.getOwnPropertyDescriptor(
  Object.prototype,
  'value'
);
let prototypeValueGets = 0;
let kindGetterGets = 0;

const probe = Object.create(null) as Record<string, unknown>;
Object.defineProperty(probe, 'kind', {
  configurable: true,
  get() {
    kindGetterGets += 1;
    return 'authenticated';
  },
});
Object.defineProperty(probe, 'host', {
  configurable: true,
  value: 'GITHUB.COM',
});

const hostileValueDescriptor = Object.create(null) as PropertyDescriptor;
hostileValueDescriptor.configurable = true;
hostileValueDescriptor.enumerable = false;
hostileValueDescriptor.get = () => {
  prototypeValueGets += 1;
  return 'ATTACKER-PROTOTYPE-VALUE';
};

function descriptorsEqual(
  left: PropertyDescriptor | undefined,
  right: PropertyDescriptor | undefined
) {
  if (left === undefined || right === undefined) return left === right;
  for (const key of [
    'configurable',
    'enumerable',
    'value',
    'writable',
    'get',
    'set',
  ] as const) {
    const leftField = Object.getOwnPropertyDescriptor(left, key);
    const rightField = Object.getOwnPropertyDescriptor(right, key);
    if (leftField === undefined || rightField === undefined) {
      if (leftField !== rightField) return false;
      continue;
    }
    if (!Object.is(leftField.value, rightField.value)) return false;
  }
  return true;
}

let controlReached = false;
let result: ReturnType<typeof validateGitHubAuthProbeResult> | null = null;
let restored = false;
try {
  Object.defineProperty(Object.prototype, 'value', hostileValueDescriptor);
  if (mode === 'reachability-control') {
    const descriptor = Object.getOwnPropertyDescriptor(probe, 'kind');
    if (descriptor !== undefined && 'value' in descriptor) {
      void descriptor.value;
      controlReached = true;
    }
  } else {
    result = validateGitHubAuthProbeResult(request, probe);
  }
} finally {
  const deleted = Reflect.deleteProperty(Object.prototype, 'value');
  if (originalValueDescriptor !== undefined) {
    Object.defineProperty(Object.prototype, 'value', originalValueDescriptor);
  }
  restored =
    deleted &&
    descriptorsEqual(
      Object.getOwnPropertyDescriptor(Object.prototype, 'value'),
      originalValueDescriptor
    );
}

console.log(
  JSON.stringify({
    schemaVersion: 1,
    mode,
    controlReached,
    result,
    kindGetterGets,
    prototypeValueGets,
    restored,
  })
);
