const path = require("node:path");

const { smokePackagedDesktopApp } = require("../e2e/packaged-app-smoke.js");
const { resolveExecutableNameFromContext } = require("./executable-name.js");

exports.default = async function afterSign(context) {
  if (process.env.PASEO_DESKTOP_SMOKE !== "1") {
    return;
  }

  if (context.electronPlatformName !== "darwin") {
    return;
  }

  const executableName = resolveExecutableNameFromContext(context);

  await smokePackagedDesktopApp({
    appPath: path.join(context.appOutDir, `${executableName}.app`),
    executableName,
  });
};
