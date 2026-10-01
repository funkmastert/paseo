import type pino from "pino";
import { HUMAN_WORK_ITEM_OWNER } from "@getpaseo/protocol/coordination/queue-schemas";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import {
  CoordinationUnavailableError,
  type CoordinationRuntime,
} from "../../coordination/runtime.js";
import { QueueConflictError, QueueNotFoundError } from "../../coordination/queue/store.js";
import { QueueValidationError } from "../../coordination/queue/state-machine.js";

// Serves the `coordination.*` RPCs (docs/work-queue.md#surfaces) from the daemon's coordination
// runtime. Errors come back in the payload as `error` + `errorCode`, never as rpc_error, so a CLI
// or app can tell "disabled" from "invalid" and show the daemon's own explanation.

export interface CoordinationSessionHost {
  emit(msg: SessionOutboundMessage): void;
}

export interface CoordinationSessionOptions {
  host: CoordinationSessionHost;
  coordination: Pick<CoordinationRuntime, "require">;
  logger: pino.Logger;
}

type CoordinationRequestType =
  | "coordination.queue.create.request"
  | "coordination.queue.claim.request"
  | "coordination.queue.transition.request"
  | "coordination.queue.update.request"
  | "coordination.queue.handoff.request"
  | "coordination.queue.list.request"
  | "coordination.queue.show.request"
  | "coordination.stream.list.request";

export type CoordinationRequest = Extract<SessionInboundMessage, { type: CoordinationRequestType }>;

type Request<T extends CoordinationRequestType> = Extract<SessionInboundMessage, { type: T }>;

const COORDINATION_REQUEST_TYPES = new Set<string>([
  "coordination.queue.create.request",
  "coordination.queue.claim.request",
  "coordination.queue.transition.request",
  "coordination.queue.update.request",
  "coordination.queue.handoff.request",
  "coordination.queue.list.request",
  "coordination.queue.show.request",
  "coordination.stream.list.request",
]);

export function isCoordinationRequest(msg: SessionInboundMessage): msg is CoordinationRequest {
  return COORDINATION_REQUEST_TYPES.has(msg.type);
}

export function coordinationErrorCode(error: unknown): string {
  if (error instanceof CoordinationUnavailableError) return "disabled";
  if (error instanceof QueueNotFoundError) return "not_found";
  if (error instanceof QueueConflictError) return "conflict";
  if (error instanceof QueueValidationError) return "invalid";
  return "internal";
}

export class CoordinationSession {
  constructor(private readonly options: CoordinationSessionOptions) {}

  handle(msg: CoordinationRequest): Promise<void> {
    switch (msg.type) {
      case "coordination.queue.create.request":
        return this.handleCreate(msg);
      case "coordination.queue.claim.request":
        return this.handleClaim(msg);
      case "coordination.queue.transition.request":
        return this.handleTransition(msg);
      case "coordination.queue.update.request":
        return this.handleUpdate(msg);
      case "coordination.queue.handoff.request":
        return this.handleHandoff(msg);
      case "coordination.queue.list.request":
        return this.handleList(msg);
      case "coordination.queue.show.request":
        return this.handleShow(msg);
      case "coordination.stream.list.request":
        return this.handleStreamList(msg);
    }
  }

  private async handleCreate(msg: Request<"coordination.queue.create.request">): Promise<void> {
    await this.respond(msg, "coordination.queue.create.response", async () => {
      const { queue } = await this.options.coordination.require();
      const result = await queue.create({
        ...(msg.id ? { id: msg.id } : {}),
        title: msg.title,
        ...(msg.body !== undefined ? { body: msg.body } : {}),
        owner: msg.owner,
        createdBy: actorOf(msg.actor),
        ...(msg.tags ? { tags: msg.tags } : {}),
      });
      return { item: result.item, changed: result.changed };
    });
  }

  private async handleClaim(msg: Request<"coordination.queue.claim.request">): Promise<void> {
    await this.respond(msg, "coordination.queue.claim.response", async () => {
      const { queue } = await this.options.coordination.require();
      const result = await queue.claim(msg.id, {
        actor: actorOf(msg.actor),
        ...(msg.note !== undefined ? { note: msg.note } : {}),
      });
      return { item: result.item, changed: result.changed };
    });
  }

  private async handleTransition(
    msg: Request<"coordination.queue.transition.request">,
  ): Promise<void> {
    await this.respond(msg, "coordination.queue.transition.response", async () => {
      const { queue } = await this.options.coordination.require();
      const result = await queue.transition(msg.id, {
        to: msg.to,
        ...(msg.closure ? { closure: msg.closure } : {}),
        ...(msg.note !== undefined ? { note: msg.note } : {}),
        actor: actorOf(msg.actor),
        ...(msg.expectedRevision !== undefined ? { expectedRevision: msg.expectedRevision } : {}),
      });
      return { item: result.item, changed: result.changed };
    });
  }

  private async handleUpdate(msg: Request<"coordination.queue.update.request">): Promise<void> {
    await this.respond(msg, "coordination.queue.update.response", async () => {
      const { queue } = await this.options.coordination.require();
      const result = await queue.update(msg.id, {
        ...(msg.title !== undefined ? { title: msg.title } : {}),
        ...(msg.body !== undefined ? { body: msg.body } : {}),
        ...(msg.tags ? { tags: msg.tags } : {}),
        ...(msg.expectedRevision !== undefined ? { expectedRevision: msg.expectedRevision } : {}),
      });
      return { item: result.item, changed: result.changed };
    });
  }

  private async handleHandoff(msg: Request<"coordination.queue.handoff.request">): Promise<void> {
    await this.respond(msg, "coordination.queue.handoff.response", async () => {
      const { queue } = await this.options.coordination.require();
      const result = await queue.handoff(msg.id, {
        to: msg.to,
        actor: actorOf(msg.actor),
        ...(msg.note !== undefined ? { note: msg.note } : {}),
        ...(msg.title !== undefined ? { title: msg.title } : {}),
        ...(msg.body !== undefined ? { body: msg.body } : {}),
      });
      return { item: result.source, successor: result.successor, changed: result.changed };
    });
  }

  private async handleList(msg: Request<"coordination.queue.list.request">): Promise<void> {
    await this.respond(msg, "coordination.queue.list.response", async () => {
      const { queue } = await this.options.coordination.require();
      const page = await queue.list(msg.filter ?? {});
      return { items: page.items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
    });
  }

  private async handleShow(msg: Request<"coordination.queue.show.request">): Promise<void> {
    await this.respond(msg, "coordination.queue.show.response", async () => {
      const { queue } = await this.options.coordination.require();
      const found = await queue.get(msg.id);
      if (!found) throw new QueueNotFoundError(msg.id);
      return { item: found.item, transitions: found.transitions };
    });
  }

  private async handleStreamList(msg: Request<"coordination.stream.list.request">): Promise<void> {
    await this.respond(msg, "coordination.stream.list.response", async () => {
      const { stream } = await this.options.coordination.require();
      const page = await stream.list(msg.filter ?? {});
      return {
        entries: page.entries,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
    });
  }

  private async respond<T extends CoordinationResponseType>(
    msg: CoordinationRequest,
    type: T,
    run: () => Promise<Omit<ResponsePayload<T>, "requestId">>,
  ): Promise<void> {
    let payload: ResponsePayload<T>;
    try {
      payload = { requestId: msg.requestId, ...(await run()) } as ResponsePayload<T>;
    } catch (error) {
      const errorCode = coordinationErrorCode(error);
      const message = error instanceof Error ? error.message : String(error);
      if (errorCode === "internal") {
        this.options.logger.error({ err: error, requestType: msg.type }, "Coordination RPC failed");
      }
      payload = { requestId: msg.requestId, error: message, errorCode } as ResponsePayload<T>;
    }
    this.options.host.emit({ type, payload } as Extract<SessionOutboundMessage, { type: T }>);
  }
}

type CoordinationResponseType = Extract<
  SessionOutboundMessage["type"],
  `coordination.${string}.response`
>;

type ResponsePayload<T extends CoordinationResponseType> = Extract<
  SessionOutboundMessage,
  { type: T }
>["payload"];

/** A host without coordination (only a test) answers every request as disabled. */
export function createCoordinationSession(
  options: Omit<CoordinationSessionOptions, "coordination"> & {
    coordination: CoordinationSessionOptions["coordination"] | undefined;
  },
): CoordinationSession {
  return new CoordinationSession({
    ...options,
    coordination: options.coordination ?? {
      require: () => Promise.reject(new CoordinationUnavailableError("Coordination is not wired.")),
    },
  });
}

function actorOf(actor: string | undefined): string {
  return actor?.trim() ? actor : HUMAN_WORK_ITEM_OWNER;
}
