export function requireOptionalNativeModule<T>(): T | null {
  return null;
}

export function requireNativeModule<T>(): T {
  throw new Error("Native modules are unavailable in this environment.");
}

// Every test here runs web-only, so `OS` is always "web" and `select` only ever needs the
// "web"/"default" branches real callers (expo-asset, expo-haptics) read.
export const Platform = {
  OS: "web" as const,
  select: <T>(specifics: { web?: T; default?: T; [key: string]: T | undefined }): T | undefined =>
    specifics.web ?? specifics.default,
};

export class UnavailabilityError extends Error {
  constructor(moduleName: string, propertyName: string) {
    super(
      `The method or property ${moduleName}.${propertyName} is not available in this environment.`,
    );
    this.name = "UnavailabilityError";
  }
}
