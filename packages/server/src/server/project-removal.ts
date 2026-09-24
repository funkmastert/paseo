import type { Logger } from "pino";

import { removeProjectCustomIcon } from "../utils/project-custom-icon.js";
import type { ProjectRegistry } from "./workspace-registry.js";

/**
 * The two steps that delete a project record, shared by a person's `project.remove.request` and
 * the done janitor's empty-project rule. The registry's mutation subscription is what tells every
 * connected session, so neither caller has to.
 */
export async function removeProjectRecord(input: {
  projectRegistry: Pick<ProjectRegistry, "remove">;
  paseoHome: string;
  projectId: string;
  logger: Logger;
}): Promise<void> {
  const { projectRegistry, paseoHome, projectId, logger } = input;
  await projectRegistry.remove(projectId);
  await removeProjectCustomIcon({ paseoHome, projectId }).catch((error) => {
    logger.warn({ err: error, projectId }, "Failed to clean up removed project icon");
  });
}
