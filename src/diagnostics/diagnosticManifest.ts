import { redactPublicTextWithCount } from "../memory/redaction.js";
import type { RuntimeSnapshot } from "../runtime/runtimeEvents.js";

export const DIAGNOSTIC_ENTRY_NAMES = [
  "app-version.json",
  "os-summary.json",
  "dependency-versions.json",
  "minecraft-compatibility.json",
  "app-log.jsonl",
  "audit-log.jsonl",
  "config-schema-summary.json",
] as const;

export const DIAGNOSTIC_OMISSIONS = [
  "minecraft-saves",
  "authentication-data",
  "pcl2-account-data",
  "complete-companion-profile",
  "complete-memories",
  "raw-chat",
] as const;

export type DiagnosticLogicalName = (typeof DIAGNOSTIC_ENTRY_NAMES)[number];

export interface DiagnosticPreview {
  exportId: string;
  actionCapability: DiagnosticActionCapability;
  files: Array<{ logicalName: DiagnosticLogicalName; size: number; redactions: number }>;
  omitted: Array<(typeof DIAGNOSTIC_OMISSIONS)[number]>;
}

export interface DiagnosticActionCapability {
  workspaceVersion: string | null;
  state: "starting" | "ready" | "failed";
  mcpListening: boolean;
  discoveredToolCount: number;
  errorCode: string | null;
}

const workspaceVersionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const actionErrorCodePattern = /^[a-z][a-z0-9_]{0,63}$/u;

export function snapshotDiagnosticActionCapability(
  actions: RuntimeSnapshot["actions"],
): DiagnosticActionCapability {
  if (actions === null) {
    return Object.freeze({
      workspaceVersion: null,
      state: "starting",
      mcpListening: false,
      discoveredToolCount: 0,
      errorCode: null,
    });
  }
  const workspaceVersion = workspaceVersionPattern.test(actions.workspaceVersion ?? "")
    ? actions.workspaceVersion
    : null;
  if (actions.state === "starting") {
    return Object.freeze({
      workspaceVersion,
      state: "starting",
      mcpListening: false,
      discoveredToolCount: 0,
      errorCode: null,
    });
  }
  if (actions.state === "ready") {
    return Object.freeze({
      workspaceVersion,
      state: "ready",
      mcpListening: true,
      discoveredToolCount: boundedToolCount(actions.discoveredToolCount),
      errorCode: null,
    });
  }
  return Object.freeze({
    workspaceVersion,
    state: "failed",
    mcpListening: actions.mcpListening === true,
    discoveredToolCount: boundedToolCount(actions.discoveredToolCount),
    errorCode: actionErrorCodePattern.test(actions.errorCode) ? actions.errorCode : null,
  });
}

function boundedToolCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export interface DiagnosticManifestValues {
  appVersion: string;
  osSummary: Readonly<Record<string, unknown>>;
  dependencyVersions: Readonly<Record<string, unknown>>;
  compatibilityManifest: Readonly<Record<string, unknown>>;
  configSchemaSummary: Readonly<Record<string, unknown>>;
  appLog: string;
  auditLog: string;
}

export interface DiagnosticEntry {
  logicalName: DiagnosticLogicalName;
  content: Buffer;
  redactions: number;
}

const appLogScalarFields = new Set([
  "at",
  "level",
  "event",
  "code",
  "reason",
  "status",
  "kind",
  "action",
  "category",
  "setting",
  "connected",
  "enabled",
  "healthProbe",
  "port",
  "counter",
  "limit",
  "used",
  "startedAt",
  "expectedActionCategoryCount",
  "owner",
  "ownerUsername",
  "path",
  "address",
  "ip",
  "authUrl",
  "accessToken",
  "token",
  "email",
]);
const taskLimitFields = new Set([
  "maxToolCalls",
  "maxBlockChanges",
  "maxHorizontalTravel",
  "maxDurationMs",
  "maxDangerousOperations",
]);
const taskCounterFields = new Set([
  "toolCalls",
  "blockChanges",
  "horizontalTravel",
  "dangerousOperations",
]);
const auditTopLevelFields = new Set([
  "schemaVersion",
  "timestamp",
  "kind",
  "worldIdHash",
  "taskId",
]);
const auditDetailFields = new Set([
  "startedAt",
  "expectedActionCategoryCount",
  ...taskLimitFields,
  ...taskCounterFields,
  "reason",
  "status",
  "code",
  "port",
  "connected",
  "counter",
  "action",
  "category",
  "limit",
  "used",
  "healthProbe",
  "setting",
  "enabled",
  "ownerUsername",
  "path",
  "address",
  "authUrl",
  "accessToken",
  "email",
]);

export function createDiagnosticEntries(values: DiagnosticManifestValues): DiagnosticEntry[] {
  const entries: Array<[DiagnosticLogicalName, { value: string; redactions: number }]> = [
    ["app-version.json", redactPublicTextWithCount(serializeJson({ version: values.appVersion }))],
    ["os-summary.json", redactPublicTextWithCount(serializeJson(values.osSummary))],
    [
      "dependency-versions.json",
      redactPublicTextWithCount(serializeJson(values.dependencyVersions)),
    ],
    [
      "minecraft-compatibility.json",
      redactPublicTextWithCount(serializeJson(values.compatibilityManifest)),
    ],
    ["app-log.jsonl", sanitizeJsonLines(values.appLog)],
    ["audit-log.jsonl", sanitizeJsonLines(values.auditLog)],
    [
      "config-schema-summary.json",
      redactPublicTextWithCount(serializeJson(values.configSchemaSummary)),
    ],
  ];
  return entries.map(([logicalName, redacted]) => ({
    logicalName,
    content: Buffer.from(redacted.value, "utf8"),
    redactions: redacted.redactions,
  }));
}

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sanitizeJsonLines(value: string): { value: string; redactions: number } {
  if (value.length === 0) return { value: "", redactions: 0 };
  let redactions = 0;
  const lines = value.split(/\r?\n/u).map((line) => {
    if (line.length === 0) return "";
    const redacted = redactPublicTextWithCount(serializeApprovedLogRecord(line));
    redactions += redacted.redactions;
    return redacted.value;
  });
  return { value: lines.join("\n"), redactions };
}

function serializeApprovedLogRecord(line: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return JSON.stringify({ event: "unapproved_log_record" });
  }
  if (!isRecord(parsed)) return JSON.stringify({ event: "unapproved_log_record" });
  if ("schemaVersion" in parsed || "timestamp" in parsed || "detail" in parsed) {
    const approved: Record<string, unknown> = approvedPrimitiveRecord(parsed, auditTopLevelFields);
    if (isRecord(parsed.detail)) {
      approved.detail = approvedPrimitiveRecord(parsed.detail, auditDetailFields);
    }
    return JSON.stringify(approved);
  }
  const approved: Record<string, unknown> = approvedPrimitiveRecord(parsed, appLogScalarFields);
  if (isRecord(parsed.limits)) {
    approved.limits = approvedPrimitiveRecord(parsed.limits, taskLimitFields);
  }
  if (isRecord(parsed.counters)) {
    approved.counters = approvedPrimitiveRecord(parsed.counters, taskCounterFields);
  }
  return JSON.stringify(approved);
}

function approvedPrimitiveRecord(
  value: Readonly<Record<string, unknown>>,
  approvedFields: ReadonlySet<string>,
): Record<string, string | number | boolean | null> {
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string | number | boolean | null] =>
        approvedFields.has(entry[0]) && isJsonPrimitive(entry[1]),
    ),
  );
}

function isJsonPrimitive(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
