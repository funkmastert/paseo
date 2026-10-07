export const cacheDirectory: string | null = null;

export const EncodingType = {
  UTF8: "utf8",
  Base64: "base64",
} as const;

async function notAvailable(): Promise<never> {
  throw new Error("expo-file-system is unavailable in this environment.");
}

export const getInfoAsync = notAvailable;
export const makeDirectoryAsync = notAvailable;
export const copyAsync = notAvailable;
export const readAsStringAsync = notAvailable;
export const deleteAsync = notAvailable;
export const readDirectoryAsync = notAvailable;
