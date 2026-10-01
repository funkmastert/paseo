import { Command } from "commander";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import {
  runQueueBlockCommand,
  runQueueClaimCommand,
  runQueueCreateCommand,
  runQueueDoneCommand,
  runQueueHandoffCommand,
  runQueueLsCommand,
  runQueueShowCommand,
} from "./queue.js";

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

const AS_HELP = 'Act as this agent id or "human" (default: $PASEO_AGENT_ID, else human)';

export function createQueueCommand(): Command {
  const queue = new Command("queue").description(
    "Work queue: owned work items that must be closed with a reason (docs/work-queue.md)",
  );

  addJsonAndDaemonHostOptions(
    queue
      .command("ls")
      .description("List open work items")
      .option("--owner <id>", 'Only items this owner holds ("me" for yourself)')
      .option("--state <state>", "Only items in this state (repeatable)", collect)
      .option("--all", "Include closed items")
      .option("--limit <n>", "Maximum items to list")
      .option("--full", "Show delivery and update time; whole items with --json")
      .option("--as <actor>", AS_HELP),
  ).action(withOutput(runQueueLsCommand));

  addJsonAndDaemonHostOptions(
    queue
      .command("show")
      .description("Show a work item and its recent transitions")
      .argument("<id>", "Work item id")
      .option("--full", "Show the whole body and every transition"),
  ).action(withOutput(runQueueShowCommand));

  addJsonAndDaemonHostOptions(
    queue
      .command("create")
      .description("Create a work item; an agent owner gets it as a prompt")
      .argument("<title>", "What the work is")
      .requiredOption("--owner <id>", 'Agent id, or "human"')
      .option("--body <text>", "Details")
      .option("--tag <tag>", "Tag (repeatable)", collect)
      .option("--id <id>", "Your own id, so a retry cannot create a duplicate")
      .option("--as <actor>", AS_HELP),
  ).action(withOutput(runQueueCreateCommand));

  addJsonAndDaemonHostOptions(
    queue
      .command("claim")
      .description("Claim a work item: you own it and it is in progress")
      .argument("<id>", "Work item id")
      .option("--as <actor>", AS_HELP),
  ).action(withOutput(runQueueClaimCommand));

  addJsonAndDaemonHostOptions(
    queue
      .command("done")
      .description("Close a work item as done, saying where the work went")
      .argument("<id>", "Work item id")
      .option(
        "--closure <reason[=target]>",
        "no-follow-on, handed_off_to=<owner>, blocked_on=<target>, escalation=<target>, denied, canceled",
      )
      .option("--note <text>", "Why")
      .option("--as <actor>", AS_HELP),
  ).action(withOutput(runQueueDoneCommand));

  addJsonAndDaemonHostOptions(
    queue
      .command("block")
      .description("Mark a work item blocked on something else")
      .argument("<id>", "Work item id")
      .requiredOption("--on <target>", "What it waits on: an item id, agent id or free text")
      .option("--note <text>", "Why")
      .option("--as <actor>", AS_HELP),
  ).action(withOutput(runQueueBlockCommand));

  addJsonAndDaemonHostOptions(
    queue
      .command("handoff")
      .description("Hand a work item to a new owner; a successor item carries the work")
      .argument("<id>", "Work item id")
      .requiredOption("--to <owner>", 'Agent id, or "human"')
      .option("--note <text>", "Why")
      .option("--as <actor>", AS_HELP),
  ).action(withOutput(runQueueHandoffCommand));

  return queue;
}
