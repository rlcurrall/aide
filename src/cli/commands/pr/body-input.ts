export interface PullRequestBodyInput {
  body?: string;
  description?: string;
  bodyFile?: string;
  descriptionFile?: string;
  'body-file'?: string;
  'description-file'?: string;
}

export interface PullRequestBodyInputReaders {
  readTextFile: (path: string) => Promise<string>;
  readStdin: () => Promise<string>;
}

export type PullRequestBodyInputSource =
  | { kind: 'none' }
  | { kind: 'text'; text: string }
  | { kind: 'file'; path: string }
  | { kind: 'stdin' };

const AMBIGUOUS_BODY_INPUT_MESSAGE =
  'Use only one of --body/--description or --body-file/--description-file';

interface BodyInputCandidate {
  value: string;
  flag: string;
}

function definedString(flag: string, value: string | undefined) {
  return value === undefined ? undefined : { flag, value };
}

function resolveAliasGroup(
  candidates: Array<BodyInputCandidate | undefined>,
  message: string
): BodyInputCandidate | undefined {
  const defined = candidates.filter(
    (candidate): candidate is BodyInputCandidate => candidate !== undefined
  );
  const first = defined[0];
  if (!first) return undefined;

  const conflict = defined.find((candidate) => candidate.value !== first.value);
  if (conflict) {
    throw new Error(message);
  }

  return first;
}

export function normalizePullRequestBodyText(text: string): string {
  return text.replace(/\\n/g, '\n');
}

export function decodePullRequestBodyChunks(
  chunks: Array<Buffer | string>
): string {
  return Buffer.concat(
    chunks.map((chunk) =>
      typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    )
  ).toString('utf8');
}

export function selectPullRequestBodyInputSource(
  input: PullRequestBodyInput
): PullRequestBodyInputSource {
  const direct = resolveAliasGroup(
    [
      definedString('--body', input.body),
      definedString('--description', input.description),
    ],
    'Use only one of --body or --description'
  );

  const file = resolveAliasGroup(
    [
      definedString('--body-file', input.bodyFile),
      definedString('--body-file', input['body-file']),
      definedString('--description-file', input.descriptionFile),
      definedString('--description-file', input['description-file']),
    ],
    'Use only one of --body-file or --description-file'
  );

  if (direct && file) {
    throw new Error(AMBIGUOUS_BODY_INPUT_MESSAGE);
  }

  if (direct) {
    return {
      kind: 'text',
      text: normalizePullRequestBodyText(direct.value),
    };
  }

  if (!file) {
    return { kind: 'none' };
  }

  if (file.value === '-') {
    return { kind: 'stdin' };
  }

  if (file.value.length === 0) {
    throw new Error('PR body file path cannot be empty');
  }

  return {
    kind: 'file',
    path: file.value,
  };
}

export async function readPullRequestBodyInputSource(
  source: PullRequestBodyInputSource,
  readers: PullRequestBodyInputReaders = defaultPullRequestBodyInputReaders
): Promise<string | undefined> {
  switch (source.kind) {
    case 'none':
      return undefined;
    case 'text':
      return source.text;
    case 'file':
      return readers.readTextFile(source.path);
    case 'stdin':
      return readers.readStdin();
  }
}

export async function resolvePullRequestBodyInput(
  input: PullRequestBodyInput,
  readers?: PullRequestBodyInputReaders
): Promise<string | undefined> {
  const source = selectPullRequestBodyInputSource(input);
  return readPullRequestBodyInputSource(source, readers);
}

async function readStdin(): Promise<string> {
  const chunks: Array<Buffer | string> = [];
  for await (const chunk of process.stdin as AsyncIterable<Buffer | string>) {
    chunks.push(chunk);
  }
  return decodePullRequestBodyChunks(chunks);
}

export const defaultPullRequestBodyInputReaders: PullRequestBodyInputReaders = {
  readTextFile: (path) => Bun.file(path).text(),
  readStdin,
};
