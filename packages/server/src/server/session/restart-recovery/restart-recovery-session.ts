import type pino from "pino";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import type { RestartRecoveryPlan } from "@getpaseo/protocol/restart-recovery/rpc-schemas";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { RestartRecoveryService } from "../../agent/restart-recovery/service.js";

export interface RestartRecoverySessionOptions {
  host: { emit(msg: SessionOutboundMessage): void };
  service: RestartRecoveryService | undefined;
  logger: pino.Logger;
}

type RestartRecoveryRequest = Extract<
  SessionInboundMessage,
  {
    type:
      | "agent.restart_recovery.get_plan.request"
      | "agent.restart_recovery.apply.request"
      | "agent.restart_recovery.dismiss.request";
  }
>;

/** Session controller for restart recovery's RPCs. See docs/restart-recovery.md. */
export class RestartRecoverySession {
  constructor(private readonly options: RestartRecoverySessionOptions) {}

  async handle(request: RestartRecoveryRequest): Promise<void> {
    const responseType = request.type.replace(/\.request$/, ".response") as
      | "agent.restart_recovery.get_plan.response"
      | "agent.restart_recovery.apply.response"
      | "agent.restart_recovery.dismiss.response";
    let plan: RestartRecoveryPlan | null = null;
    let error: string | null = null;
    try {
      plan = await this.run(request);
    } catch (caught) {
      error = getErrorMessage(caught);
      this.options.logger.warn(
        { err: caught, requestType: request.type },
        "Restart recovery request failed",
      );
    }
    this.options.host.emit({
      type: responseType,
      payload: { requestId: request.requestId, plan, error },
    });
  }

  private async run(request: RestartRecoveryRequest): Promise<RestartRecoveryPlan> {
    const service = this.options.service;
    if (!service) {
      throw new Error("Restart recovery is not running on this daemon");
    }
    switch (request.type) {
      case "agent.restart_recovery.get_plan.request":
        return await service.getPlan();
      case "agent.restart_recovery.apply.request":
        return await service.apply({ agentIds: request.agentIds, trigger: "request" });
      case "agent.restart_recovery.dismiss.request":
        return await service.dismiss({ agentIds: request.agentIds });
    }
  }
}
