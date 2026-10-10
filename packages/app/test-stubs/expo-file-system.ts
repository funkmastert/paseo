// No file system here: no directory resolves, nothing exists, and reading throws — the same
// answers the legacy stub gives (`cacheDirectory: null`, `notAvailable`).

type PathPart = string | { uri: string } | null;

function joinUri(parts: PathPart[]): string {
  return parts
    .filter((part): part is string | { uri: string } => part !== null)
    .map((part) => (typeof part === "string" ? part : part.uri))
    .join("/");
}

async function notAvailable(): Promise<never> {
  throw new Error("expo-file-system is unavailable in this environment.");
}

export const Paths: { cache: Directory | null; document: Directory | null } = {
  cache: null,
  document: null,
};

export class File {
  readonly uri: string;
  readonly exists = false;

  constructor(...parts: PathPart[]) {
    this.uri = joinUri(parts);
  }

  write(_bytes: Uint8Array): void {}

  bytes(): Promise<Uint8Array> {
    return notAvailable();
  }
}

export class Directory {
  readonly uri: string;
  readonly exists = false;

  constructor(...parts: PathPart[]) {
    this.uri = joinUri(parts);
  }
}
