export { DoctorSession, type DoctorSessionOptions } from "./doctor-session.js";
export { buildDoctorContext, readRawConfig, validateConfigAgainstBuild } from "./facts.js";
export { runDoctorChecks, DOCTOR_CHECKS } from "./runner.js";
export type { DoctorContext, DoctorFacts, DoctorProbes, DoctorCheck } from "./context.js";
