import { expect, test } from "vitest";
import { createPaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { PluginHookHandlers } from "./index.js";

const paseo = createPaseoApi(
  new DaemonClient({ url: "ws://127.0.0.1:1/ws", clientId: "lifecycle-unit" }),
);

test("removing an old registration twice preserves a newer registration for the same hook", async () => {
  const hooks = new PluginHookHandlers(() => {});
  const remove = hooks.before("workspace.create", ({ request }) => {
    return { ...request, title: "old" };
  });
  remove();
  hooks.before("workspace.create", ({ request }) => {
    return { ...request, title: "new" };
  });
  remove();
  const output = await hooks.invoke(
    "operation",
    "before",
    "workspace.create",
    {
      source: { kind: "directory", path: "/project" },
    },
    paseo,
  );
  expect(output).toEqual({ source: { kind: "directory", path: "/project" }, title: "new" });
});

test("before hooks compose returned requests and preserve the original input", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.before("workspace.create", ({ request }) => {
    return { ...request, title: "first" };
  });
  hooks.before("workspace.create", () => {
    return;
  });
  hooks.before("workspace.create", ({ request }) => {
    return { ...request, title: request.title + ":second" };
  });
  const input = { source: { kind: "directory", path: "/project" } };
  expect(await hooks.invoke("operation", "before", "workspace.create", input, paseo)).toEqual({
    source: { kind: "directory", path: "/project" },
    title: "first:second",
  });
  expect(input).toEqual({ source: { kind: "directory", path: "/project" } });
});

test("teardown aborts an active callback and removes its registrations", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.before("workspace.create", async (_input, context) => {
    await new Promise<void>((_resolve, reject) => {
      context.signal.addEventListener(
        "abort",
        () => {
          reject(new Error("Hook aborted"));
        },
        { once: true },
      );
    });
  });
  const invocation = hooks.invoke(
    "operation",
    "before",
    "workspace.create",
    {
      source: { kind: "directory", path: "/project" },
    },
    paseo,
  );
  hooks.close();
  await expect(invocation).rejects.toThrow("Hook aborted");
  expect(hooks.catalog()).toEqual({ events: [], before: [] });
});

test("agent.create hooks receive callerAgentId and can pass it through unchanged", async () => {
  const hooks = new PluginHookHandlers(() => {});
  let observedCallerAgentId: string | undefined;
  hooks.before("agent.create", ({ request }) => {
    observedCallerAgentId = request.callerAgentId;
    return request;
  });
  const output = await hooks.invoke(
    "operation",
    "before",
    "agent.create",
    {
      config: { provider: "claude", cwd: "/project" },
      callerAgentId: "agent-parent",
    },
    paseo,
  );
  expect(observedCallerAgentId).toBe("agent-parent");
  expect(output).toMatchObject({ callerAgentId: "agent-parent" });
});

test("agent.create hooks omit callerAgentId for a create with no caller", async () => {
  const hooks = new PluginHookHandlers(() => {});
  let observedCallerAgentId: string | undefined = "unset";
  hooks.before("agent.create", ({ request }) => {
    observedCallerAgentId = request.callerAgentId;
    return request;
  });
  await hooks.invoke(
    "operation",
    "before",
    "agent.create",
    { config: { provider: "claude", cwd: "/project" } },
    paseo,
  );
  expect(observedCallerAgentId).toBeUndefined();
});

test("agent.create hooks reject changes to callerAgentId instead of silently ignoring them", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.before("agent.create", ({ request }) => {
    return { ...request, callerAgentId: "agent-other" };
  });
  await expect(
    hooks.invoke(
      "operation",
      "before",
      "agent.create",
      {
        config: { provider: "claude", cwd: "/project" },
        callerAgentId: "agent-parent",
      },
      paseo,
    ),
  ).rejects.toThrow("agent.create hooks cannot change callerAgentId");
});

test("agent.create hooks that omit callerAgentId from their returned object preserve the original value", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.before("agent.create", ({ request }) => {
    return { config: request.config, env: request.env };
  });
  const output = await hooks.invoke(
    "operation",
    "before",
    "agent.create",
    {
      config: { provider: "claude", cwd: "/project" },
      callerAgentId: "agent-parent",
    },
    paseo,
  );
  expect(output).toMatchObject({ callerAgentId: "agent-parent" });
});

test("a chain of agent.create hooks preserves callerAgentId across a hook that omits it", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.before("agent.create", ({ request }) => {
    return { config: request.config, env: request.env };
  });
  let observedBySecondHook: string | undefined;
  hooks.before("agent.create", ({ request }) => {
    observedBySecondHook = request.callerAgentId;
    return request;
  });
  await hooks.invoke(
    "operation",
    "before",
    "agent.create",
    {
      config: { provider: "claude", cwd: "/project" },
      callerAgentId: "agent-parent",
    },
    paseo,
  );
  expect(observedBySecondHook).toBe("agent-parent");
});

test("agent.create hooks reject adding callerAgentId when the request had none", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.before("agent.create", ({ request }) => {
    return { ...request, callerAgentId: "agent-injected" };
  });
  await expect(
    hooks.invoke(
      "operation",
      "before",
      "agent.create",
      { config: { provider: "claude", cwd: "/project" } },
      paseo,
    ),
  ).rejects.toThrow("agent.create hooks cannot change callerAgentId");
});

test("session-open hooks reject changes to session identity instead of silently ignoring them", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.before("agent.session_open", ({ request }) => {
    return { ...request, provider: "another-provider" };
  });
  await expect(
    hooks.invoke(
      "operation",
      "before",
      "agent.session_open",
      {
        agentId: "agent",
        workspaceId: "workspace",
        provider: "claude",
        cwd: "/project",
        reason: "resume",
        purpose: "interactive",
        env: {},
      },
      paseo,
    ),
  ).rejects.toThrow("agent.session_open hooks can only change env");
});
