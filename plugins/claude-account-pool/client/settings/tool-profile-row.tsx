import { SettingsInput, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { TOOL_PROFILE_IDS, profileDeniedTools, type ToolProfile, type ToolProfileId } from "../../shared/tool-profiles";

export interface ToolProfileRowProps {
  roleId: string;
  profile: ToolProfile;
  disabled: boolean;
  onChange(profile: ToolProfile): void;
}

const PROFILE_LABELS: Record<ToolProfileId, string> = {
  unrestricted: "Unrestricted (default)",
  orchestrator: "Orchestrator — delegate only",
  "read-only": "Read-only",
  write: "Write — full implementer kit",
  custom: "Custom…",
};

const PROFILE_HINTS: Record<ToolProfileId, string> = {
  unrestricted: "Nothing is removed. The request passes through untouched.",
  orchestrator:
    "No file, shell, or native-subagent tools. Forces real delegation through Paseo, which is the only path that spends another account's budget.",
  "read-only": "Read, Grep, and Glob stay. Edit, Write, NotebookEdit, and Bash are removed.",
  write: "Denies nothing — file and shell tools are the point of this profile.",
  custom: "Comma-separated tool names. Denied tools are removed from the model's context entirely.",
};

/** Comma-separated -> trimmed, empty-filtered, order-preserving. */
function parseToolList(text: string): string[] {
  return text
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Per-role tool enforcement picker. Profiles are deny-lists; see shared/tool-profiles.ts. */
export function ToolProfileRow({ roleId, profile, disabled, onChange }: ToolProfileRowProps) {
  const denied = profileDeniedTools(profile);
  const deniedHint = denied.length > 0 ? `Denies: ${denied.join(", ")}` : PROFILE_HINTS[profile.kind];

  return (
    <>
      <SettingsSelect
        label="Tools"
        hint={deniedHint}
        value={profile.kind}
        options={TOOL_PROFILE_IDS.map((kind) => ({ label: PROFILE_LABELS[kind], value: kind }))}
        disabled={disabled}
        onValueChange={(kind) =>
          onChange(kind === "custom" ? { kind, deny: profile.deny ?? [], allow: profile.allow ?? [] } : { kind })
        }
        testID={`tool-profile-${roleId}`}
      />
      {profile.kind === "custom" ? (
        <>
          <SettingsInput
            label="Deny tools"
            hint={PROFILE_HINTS.custom}
            initialValue={(profile.deny ?? []).join(", ")}
            placeholder="Bash, Write, NotebookEdit"
            disabled={disabled}
            onChangeText={(text) => onChange({ ...profile, deny: parseToolList(text) })}
            testID={`tool-profile-deny-${roleId}`}
          />
          <SettingsInput
            label="Pre-approve tools"
            hint="Skips the permission prompt for these. It cannot re-enable a denied tool."
            initialValue={(profile.allow ?? []).join(", ")}
            placeholder="Read, Grep"
            disabled={disabled}
            onChangeText={(text) => onChange({ ...profile, allow: parseToolList(text) })}
            testID={`tool-profile-allow-${roleId}`}
          />
        </>
      ) : null}
    </>
  );
}
