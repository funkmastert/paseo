import type { PluginServerContext } from "@getpaseo/plugin/server";
// Wiring only: hook registration that starts this cache from a lifecycle
// event (and RPC exposure of its accessor) lands in a later unit.
import { createPoolCache } from "./server/pool";

export default function contribute(_server: PluginServerContext) {
  void createPoolCache;
  return () => {};
}
