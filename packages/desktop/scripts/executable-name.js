const fs = require("fs");
const path = require("path");

const ELECTRON_BUILDER_YML = path.join(__dirname, "..", "electron-builder.yml");
const ENV_OVERRIDE = "PASEO_DESKTOP_EXECUTABLE_NAME";

/**
 * Resolves the packaged executable/bundle name (e.g. "Paseo", "Bozeo" on a
 * rebranded fork) the same way electron-builder itself does, so afterPack/
 * afterSign hooks never hardcode a brand string that can drift from
 * electron-builder.yml.
 *
 * Mirrors app-builder-lib's own PlatformPackager#getElectronSrcDir logic:
 * LinuxPackager exposes a computed `executableName`; every other packager
 * (mac, win) falls back to `appInfo.productFilename`, which is itself
 * derived from `executableName` when configured, else the sanitized
 * `productName`. See node_modules/app-builder-lib/out/platformPackager.js.
 */
function resolveExecutableNameFromContext(context) {
  const packager = context.packager;
  return packager.executableName ?? packager.appInfo.productFilename;
}

/**
 * Reads the executable name directly out of electron-builder.yml for
 * callers that run outside an electron-builder hook (no `context.packager`
 * available), e.g. the e2e smoke script invoked standalone. Accepts an
 * env override for ad-hoc/CI use.
 */
function readExecutableNameFromConfig() {
  const override = process.env[ENV_OVERRIDE]?.trim();
  if (override) {
    return override;
  }

  const yml = fs.readFileSync(ELECTRON_BUILDER_YML, "utf8");
  const executableName = matchTopLevelScalar(yml, "executableName");
  if (executableName) {
    return executableName;
  }

  const productName = matchTopLevelScalar(yml, "productName");
  if (productName) {
    return productName;
  }

  throw new Error(
    `Could not resolve an executable name from ${ELECTRON_BUILDER_YML} (no top-level ` +
      `executableName or productName) and ${ENV_OVERRIDE} is not set.`,
  );
}

function matchTopLevelScalar(yml, key) {
  const match = yml.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m"));
  if (!match) {
    return null;
  }
  return match[1].replace(/^["']|["']$/g, "");
}

module.exports = {
  resolveExecutableNameFromContext,
  readExecutableNameFromConfig,
};
