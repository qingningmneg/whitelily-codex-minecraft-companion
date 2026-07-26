import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/loadConfig.js";

function codePoints(value: string): number[] {
  return Array.from(value, (character) => character.codePointAt(0)!);
}

const validConfig = `
[minecraft]
host = "127.0.0.1"
port = 25565
bot_username = "WhiteLily"
owner_username = "TestOwner"

[codex]
preferred_model = "gpt-5.6-terra"
reasoning_effort = "low"
allow_api_key_fallback = false

[companion]
start_mode = "friend"
persona_name = "白百合"

[safety]
spawn_protection_radius = 16
break_confirmation_threshold = 32
place_confirmation_threshold = 128
travel_confirmation_distance = 256
`;

describe("loadConfig", () => {
  it("loads the supported Windows configuration", async () => {
    const dir = await mkdtemp(join(tmpdir(), "whitelily-config-"));
    const path = join(dir, "config.toml");
    await writeFile(path, validConfig, "utf8");

    const config = await loadConfig(path);

    expect(config.minecraft.botUsername).toBe("WhiteLily");
    expect(config.codex.allowApiKeyFallback).toBe(false);
    expect(config.companion.startMode).toBe("friend");
    expect(codePoints(config.companion.personaName)).toEqual([30333, 30334, 21512]);
    expect(config.safety.travelConfirmationDistance).toBe(256);
  });

  it("loads the public example configuration", async () => {
    const config = await loadConfig(
      fileURLToPath(new URL("../../config.example.toml", import.meta.url)),
    );

    expect(codePoints(config.companion.personaName)).toEqual([30333, 30334, 21512]);
    expect(config.minecraft.ownerUsername).toBe("YourMcName");
  });

  it("rejects non-loopback Minecraft hosts in version 0.1", async () => {
    const dir = await mkdtemp(join(tmpdir(), "whitelily-config-"));
    const path = join(dir, "config.toml");
    await writeFile(path, validConfig.replace("127.0.0.1", "0.0.0.0"), "utf8");

    await expect(loadConfig(path)).rejects.toThrow("minecraft.host must be 127.0.0.1");
  });

  it("rejects unsupported nested configuration keys", async () => {
    const dir = await mkdtemp(join(tmpdir(), "whitelily-config-"));
    const path = join(dir, "config.toml");
    await writeFile(path, `${validConfig}\nextra = true\n`, "utf8");

    await expect(loadConfig(path)).rejects.toThrow();
  });

  it("rejects unsupported root configuration keys", async () => {
    const dir = await mkdtemp(join(tmpdir(), "whitelily-config-"));
    const path = join(dir, "config.toml");
    await writeFile(path, `extra = true\n${validConfig}`, "utf8");

    await expect(loadConfig(path)).rejects.toThrow();
  });
});
