import { Command } from "commander";
import { withOutput } from "../../output/index.js";
import { addJsonOption } from "../../utils/command-options.js";
import { runKbSetupCommand } from "./setup.js";

export function createKbCommand(): Command {
  const kb = new Command("kb").description("Manage the project knowledge base");

  addJsonOption(
    kb.command("setup").description("Install the pinned Basic Memory release with uv"),
  ).action(withOutput(runKbSetupCommand));

  return kb;
}
