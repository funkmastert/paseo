import type { PluginClientContext } from "@getpaseo/plugin/client";
import { AgentModelPolicyScreen } from "./client/settings/agent-model-policy-screen";

export default function contribute(client: PluginClientContext) {
  const unregisterSettingsScreen = client.addSettingsScreen({
    id: "agent-model-policy",
    title: "Agent Model Policy",
    icon: "Route",
    Component: AgentModelPolicyScreen,
  });

  return () => {
    unregisterSettingsScreen();
  };
}
