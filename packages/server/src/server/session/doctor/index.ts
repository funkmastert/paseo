export { DoctorSession, type DoctorSessionOptions } from "./doctor-session.js";
export { buildDoctorContext, readRawConfig, validateConfigAgainstBuild } from "./facts.js";
export { runDoctorChecks, DOCTOR_CHECKS } from "./runner.js";
export type { DoctorContext, DoctorFacts, DoctorProbes, DoctorCheck } from "./context.js";
export {
  countSeverities,
  renderTokenAuditTable,
  runTokenAudit,
  TOKEN_AUDIT_CHECKS,
  TOKEN_DOCTOR_CHECKS,
  type TokenAuditRow,
  type TokenSeverity,
} from "./tokens/index.js";
