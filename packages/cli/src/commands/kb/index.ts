import { Command } from "commander";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions, addJsonOption } from "../../utils/command-options.js";
import { runKbSeedCommand } from "./seed.js";
import { runKbSetupCommand } from "./setup.js";

export function createKbCommand(): Command {
  const kb = new Command("kb").description("Manage the project knowledge base");

  addJsonOption(
    kb.command("setup").description("Install the pinned Basic Memory release with uv"),
  ).action(withOutput(runKbSetupCommand));

  addJsonAndDaemonHostOptions(
    kb
      .command("seed")
      .description("Seed the knowledge base for named projects from existing material")
      .argument("<name...>", "Project name(s) to seed")
      .option("--hint <text>", "A hint to narrow where a seed agent should look"),
  ).action(withOutput(runKbSeedCommand));

  return kb;
}
