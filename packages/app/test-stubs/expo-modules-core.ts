export function requireOptionalNativeModule<T>(): T | null {
  return null;
}

export function requireNativeModule<T>(): T {
  throw new Error("Native modules are unavailable in this environment.");
}
