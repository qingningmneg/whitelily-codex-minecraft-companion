import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { redactPublicText, redactSecrets } from "../memory/redaction.js";

const writeQueues = new Map<string, Promise<unknown>>();

function serializeByPath<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(path) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  writeQueues.set(path, current);
  return current.finally(() => {
    if (writeQueues.get(path) === current) writeQueues.delete(path);
  });
}

function isFullChatField(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLocaleLowerCase();
  return (
    normalized.includes("chat") ||
    normalized.includes("message") ||
    normalized.includes("conversation")
  );
}

export function sanitizeLogValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactPublicText(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    return "[UNSERIALIZABLE]";
  }
  if (value instanceof Error) {
    if (seen.has(value)) return "[CIRCULAR_REFERENCE]";
    seen.add(value);
    try {
      const code = (value as Error & { code?: unknown }).code;
      return {
        name: redactPublicText(value.name),
        ...(code === undefined ? {} : { code: sanitizeLogValue(code, seen) }),
      };
    } finally {
      seen.delete(value);
    }
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[CIRCULAR_REFERENCE]";
    seen.add(value);
    try {
      return value.map((item) => sanitizeLogValue(item, seen));
    } finally {
      seen.delete(value);
    }
  }
  if (value !== null && typeof value === "object") {
    if (seen.has(value)) return "[CIRCULAR_REFERENCE]";
    seen.add(value);
    try {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => !isFullChatField(key))
          .map(([key, nested]) => [key, sanitizeLogValue(nested, seen)]),
      );
    } finally {
      seen.delete(value);
    }
  }
  return value;
}

function safeEvent(event: string): string {
  return /^[a-z0-9_.-]{1,64}$/.test(event) ? event : "invalid_event";
}

export class SafeLogger {
  constructor(private readonly path: string) {}

  info(event: string, fields: Record<string, unknown> = {}): Promise<void> {
    return this.write("info", event, fields);
  }

  error(event: string, fields: Record<string, unknown> = {}): Promise<void> {
    return this.write("error", event, fields);
  }

  private write(
    level: "info" | "error",
    event: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    return serializeByPath(this.path, async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const safeFields = JSON.parse(
        redactSecrets(JSON.stringify(sanitizeLogValue(fields))),
      ) as Record<string, unknown>;
      const line = JSON.stringify({
        ...safeFields,
        at: new Date().toISOString(),
        level,
        event: safeEvent(event),
      });
      await appendFile(this.path, `${line}\n`, "utf8");
    });
  }
}
