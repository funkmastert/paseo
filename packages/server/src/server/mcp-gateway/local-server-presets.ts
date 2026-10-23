/**
 * Local servers the daemon knows how to install and run for the in-app setup form
 * (docs/mcp-gateway.md "Setting up a server that cannot sign in"). The client names a preset id;
 * it never sends a command, so what the daemon spawns is decided here and nowhere else.
 */
export interface LocalServerPreset {
  id: string;
  /** npm package, installed at exactly `version`. */
  package: string;
  version: string;
  /** The entry file inside the install directory, as path segments. */
  entry: readonly string[];
  /** Arguments after the entry file. */
  args: readonly string[];
  /** The environment variable the stored token is handed to the server in. */
  tokenEnv: string;
  /** Lowest Node the package supports, as `[major, minor]`. */
  minNode: readonly [number, number];
}

export const LOCAL_SERVER_PRESETS: Readonly<Record<string, LocalServerPreset>> = {
  // Framelink (MIT) reads the Figma REST API with a personal access token. Figma's hosted MCP
  // server refuses every client outside its catalog, so this is the way in. Telemetry is on by
  // default and the image tool writes into the daemon's working directory, hence both flags.
  figma: {
    id: "figma",
    package: "figma-developer-mcp",
    version: "0.13.2",
    entry: ["node_modules", "figma-developer-mcp", "dist", "bin.js"],
    args: ["--stdio", "--no-telemetry", "--skip-image-downloads"],
    tokenEnv: "FIGMA_API_KEY",
    minNode: [20, 20],
  },
};

export function getLocalServerPreset(id: string): LocalServerPreset | undefined {
  return Object.hasOwn(LOCAL_SERVER_PRESETS, id) ? LOCAL_SERVER_PRESETS[id] : undefined;
}
