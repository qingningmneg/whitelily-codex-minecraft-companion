import { describe, expect, it } from "vitest";
import { containsSensitiveData, redactSecrets } from "../../src/memory/redaction.js";

const openAiApiKey = ["OPENAI", "_API", "_KEY"].join("");
const codexAccessToken = ["codex", "_access", "_token"].join("");

describe("redactSecrets", () => {
  it.each([
    ["sk-test-abcdefghijklmnopqrstuvwxyz123456", "[REDACTED_OPENAI_KEY]"],
    ["SK-TEST-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456", "[REDACTED_OPENAI_KEY]"],
    ["Bearer abcdefghijklmnopqrstuvwxyz.123456", "Bearer [REDACTED_TOKEN]"],
    [
      "authorization: bearer abcdefghijklmnopqrstuvwxyz.123456",
      "authorization: Bearer [REDACTED_TOKEN]",
    ],
    ["password=hunter2", "password=[REDACTED_PASSWORD]"],
    ["PASSWORD: hunter2", "PASSWORD=[REDACTED_PASSWORD]"],
    [`${openAiApiKey}=sk-test-abcdefghijklmnopqrstuvwxyz123456`, `${openAiApiKey}=[REDACTED]`],
    [`${codexAccessToken}: abcdefghijklmnopqrstuvwxyz`, `${codexAccessToken}=[REDACTED]`],
    ["SERVICE_TOKEN=abcdefghijklmnop", "SERVICE_TOKEN=[REDACTED]"],
    ["DATABASE_URL=postgres://player:secret@localhost/world", "DATABASE_URL=[REDACTED_ENV]"],
    ["mail=player@example.invalid", "mail=[REDACTED_EMAIL]"],
    ["联系我：player@example.invalid", "联系我：[REDACTED_EMAIL]"],
    ["phone=13800138000", "phone=[REDACTED_PHONE]"],
    ["PHONE: +86 138 0013 8000", "PHONE=[REDACTED_PHONE]"],
  ])("redacts %s", (input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
    expect(containsSensitiveData(input)).toBe(true);
  });

  it.each([
    [
      `before {"client-secret":"client secret with spaces","display-name":"Public Companion"} after`,
      "client secret with spaces",
      `"display-name":"Public Companion"`,
    ],
    [
      `before {'access.token':'access token with \\'escaped quote\\' and spaces','display-name':'Public Agent'} after`,
      "access token with",
      `'display-name':'Public Agent'`,
    ],
    [
      `before {"task-lease-id":"private lease with spaces","ordinary-field":"Public Value"} after`,
      "private lease with spaces",
      `"ordinary-field":"Public Value"`,
    ],
  ])(
    "redacts normalized quoted JSON-like credential keys without changing ordinary prose: %s",
    (input, privateValue, publicValue) => {
      const output = redactSecrets(input);

      expect(output).not.toContain(privateValue);
      expect(output).toContain(publicValue);
      expect(containsSensitiveData(input)).toBe(true);
    },
  );

  it("leaves ordinary game summaries unchanged", () => {
    const summary = "玩家喜欢在山顶建家，正在收集橡木。";

    expect(redactSecrets(summary)).toBe(summary);
    expect(containsSensitiveData(summary)).toBe(false);
  });

  it.each([
    JSON.stringify({ password: "hunter2" }),
    JSON.stringify({ token: "abcdefghijklmnopqrstuvwxyz.123456" }),
    JSON.stringify({ OPENAI_API_KEY: "sk-test-abcdefghijklmnopqrstuvwxyz123456" }),
    JSON.stringify({ email: "player@example.invalid", phone: "13800138000" }),
    JSON.stringify({ note: "password=hunter2" }),
  ])("redacts sensitive JSON without making it invalid: %s", (input) => {
    const output = redactSecrets(input);

    expect(() => JSON.parse(output)).not.toThrow();
    expect(output).not.toContain("hunter2");
    expect(output).not.toContain("player@example.invalid");
    expect(output).not.toContain("13800138000");
    expect(containsSensitiveData(input)).toBe(true);
  });

  it("redacts text with an escaped assignment separator", () => {
    const input = String.raw`password\u003dhunter2`;

    expect(redactSecrets(input)).not.toContain("hunter2");
    expect(containsSensitiveData(input)).toBe(true);
  });

  it.each([
    JSON.stringify({ DATABASE_URL: "postgres://player:db-password@localhost/world" }),
    JSON.stringify({ config: { REDIS_URL: "redis://cache-user:redis-password@localhost:6379/0" } }),
  ])("redacts credential-bearing JSON environment URLs: %s", (input) => {
    const output = redactSecrets(input);

    expect(() => JSON.parse(output)).not.toThrow();
    expect(output).not.toContain("db-password");
    expect(output).not.toContain("redis-password");
    expect(containsSensitiveData(input)).toBe(true);
  });

  it("leaves an ordinary JSON URL unchanged", () => {
    const input = JSON.stringify({ website: "https://example.invalid/docs" });

    expect(redactSecrets(input)).toBe(input);
    expect(containsSensitiveData(input)).toBe(false);
  });

  it.each([
    JSON.stringify({ TOKEN: "actual-secret [REDACTED] suffix" }),
    JSON.stringify({ nested: { TOKEN: "actual-secret [REDACTED] suffix" } }),
  ])("does not trust a marker embedded in a sensitive JSON value: %s", (input) => {
    const output = redactSecrets(input);

    expect(output).not.toContain("actual-secret");
    expect(containsSensitiveData(input)).toBe(true);
  });

  it.each([
    "redis://:redis-password@localhost:6379/0",
    "redis://user:redis-password@localhost:6379/0",
  ])("redacts URI userinfo with empty or populated usernames: %s", (url) => {
    const textOutput = redactSecrets(`endpoint=${url}`);
    const jsonOutput = redactSecrets(JSON.stringify({ endpoint: url, website: url }));

    expect(textOutput).not.toContain("redis-password");
    expect(jsonOutput).not.toContain("redis-password");
    expect(containsSensitiveData(JSON.stringify({ endpoint: url }))).toBe(true);
  });

  it("scans credential-free URI authorities with linear growth and still redacts userinfo", () => {
    const measure = (colonCount: number): number => {
      const input = `https://${":".repeat(colonCount)}/public`;
      const started = performance.now();
      for (let round = 0; round < 3; round += 1) {
        expect(redactSecrets(input)).toBe(input);
      }
      return performance.now() - started;
    };
    measure(2_000);
    const small = measure(8_000);
    const large = measure(16_000);

    expect(large).toBeLessThan(small * 3.2 + 5);

    const credential = `https://user:${":".repeat(2_000)}private-password@example.invalid/world`;
    const redacted = redactSecrets(credential);
    expect(redacted).not.toContain("private-password");
    expect(redacted).toContain("https://[REDACTED_URI_CREDENTIALS]@example.invalid/world");
  });

  it.each([
    [
      "space after a credential-free authority",
      "https://public.invalid then postgres://player:db-password@localhost/database",
      "https://public.invalid then postgres://[REDACTED_URI_CREDENTIALS]@localhost/database",
    ],
    [
      "tab after a credential-free authority",
      "https://public.invalid\tpostgres://player:tab-password@localhost/database",
      "https://public.invalid\tpostgres://[REDACTED_URI_CREDENTIALS]@localhost/database",
    ],
    [
      "CRLF after a credential-free authority",
      "https://public.invalid\r\npostgres://player:crlf-password@localhost/database",
      "https://public.invalid\r\npostgres://[REDACTED_URI_CREDENTIALS]@localhost/database",
    ],
    [
      "vertical tab after a credential-free authority",
      "https://public.invalid\vpostgres://player:vertical-password@localhost/database",
      "https://public.invalid\vpostgres://[REDACTED_URI_CREDENTIALS]@localhost/database",
    ],
    [
      "form feed after a credential-free authority",
      "https://public.invalid\fpostgres://player:form-password@localhost/database",
      "https://public.invalid\fpostgres://[REDACTED_URI_CREDENTIALS]@localhost/database",
    ],
    [
      "space after a credential-free URI with a path",
      "https://public.invalid/docs then postgres://player:path-password@localhost/database",
      "https://public.invalid/docs then postgres://[REDACTED_URI_CREDENTIALS]@localhost/database",
    ],
    [
      "credential URI before a credential-free URI",
      "postgres://player:first-password@localhost/database https://public.invalid",
      "postgres://[REDACTED_URI_CREDENTIALS]@localhost/database https://public.invalid",
    ],
    [
      "two credential URIs separated by CRLF",
      "postgres://player:first-password@localhost/database\r\nredis://cache:second-password@localhost/0",
      "postgres://[REDACTED_URI_CREDENTIALS]@localhost/database\r\nredis://[REDACTED_URI_CREDENTIALS]@localhost/0",
    ],
  ])("continues scanning complete URI userinfo across %s", (_case, input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
    expect(containsSensitiveData(input)).toBe(true);
  });

  it.each(["public_url", "PUBLIC_URL"])("preserves credential-free URLs under %s", (key) => {
    const input = JSON.stringify({ [key]: "https://example.invalid/docs" });

    expect(redactSecrets(input)).toBe(input);
    expect(containsSensitiveData(input)).toBe(false);
  });

  it("is idempotent after fully redacting JSON", () => {
    const input = JSON.stringify({
      TOKEN: "actual-secret",
      endpoint: "redis://:redis-password@localhost:6379/0",
    });
    const once = redactSecrets(input);

    expect(redactSecrets(once)).toBe(once);
  });

  it.each([
    "TOKEN=[REDACTED]suffix actual-secret",
    "password=[REDACTED_PASSWORD]suffix actual-secret",
    `${openAiApiKey}=[REDACTED]suffix actual-secret`,
  ])("does not trust marker prefixes in sensitive text: %s", (input) => {
    const output = redactSecrets(input);

    expect(output).not.toContain("actual-secret");
    expect(containsSensitiveData(input)).toBe(true);
  });

  it.each(["TOKEN=[REDACTED]", "password=[REDACTED_PASSWORD]", `${openAiApiKey}=[REDACTED]`])(
    "keeps a fully redacted sensitive text value unchanged: %s",
    (input) => {
      expect(redactSecrets(input)).toBe(input);
      expect(containsSensitiveData(input)).toBe(false);
    },
  );

  it.each([
    JSON.stringify({ TOKEN: { value: "actual-secret" } }),
    JSON.stringify({ nested: { password: ["actual-secret"] } }),
  ])("replaces non-string JSON values under sensitive keys: %s", (input) => {
    const output = redactSecrets(input);

    expect(output).not.toContain("actual-secret");
    expect(containsSensitiveData(input)).toBe(true);
  });
});
