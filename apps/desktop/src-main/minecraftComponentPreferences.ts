import { isAbsolute, join, resolve } from "node:path";
import { AtomicJsonFile } from "../../../src/storage/atomicJsonFile.js";

export interface MinecraftComponentPreferenceValue {
  readonly schemaVersion: 1;
  readonly bridgeEnabled: boolean;
  readonly avatarEnabled: boolean;
}

const DEFAULT_MINECRAFT_COMPONENT_PREFERENCES: MinecraftComponentPreferenceValue = Object.freeze({
  schemaVersion: 1,
  bridgeEnabled: true,
  avatarEnabled: true,
});

const preferenceQueues = new Map<string, Promise<unknown>>();

function serializePreferenceOperation<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = preferenceQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  preferenceQueues.set(key, current);
  return current.finally(() => {
    if (preferenceQueues.get(key) === current) preferenceQueues.delete(key);
  });
}

export class MinecraftComponentPreferences {
  readonly #file: AtomicJsonFile<MinecraftComponentPreferenceValue>;

  constructor(options: { dataRoot: string }) {
    if (!isAbsolute(options.dataRoot)) {
      throw new Error("invalid Minecraft component preferences");
    }
    const dataRoot = resolve(options.dataRoot);
    this.#file = new AtomicJsonFile({
      rootDirectory: dataRoot,
      path: join(dataRoot, "config", "minecraft-components.json"),
      validate: validateMinecraftComponentPreferences,
      recoverFrom: () => false,
    });
  }

  async initializeDefaults(): Promise<MinecraftComponentPreferenceValue> {
    try {
      const key = await this.#file.coordinatorKey();
      return await serializePreferenceOperation(key, async () =>
        Object.freeze(await this.#file.writeIfAbsent(DEFAULT_MINECRAFT_COMPONENT_PREFERENCES)),
      );
    } catch (error) {
      throw new Error("invalid Minecraft component preferences", { cause: error });
    }
  }
}

function validateMinecraftComponentPreferences(value: unknown): MinecraftComponentPreferenceValue {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).sort().join(",") !== "avatarEnabled,bridgeEnabled,schemaVersion" ||
    Reflect.get(value, "schemaVersion") !== 1 ||
    typeof Reflect.get(value, "bridgeEnabled") !== "boolean" ||
    typeof Reflect.get(value, "avatarEnabled") !== "boolean"
  ) {
    throw new Error("invalid Minecraft component preferences");
  }
  return Object.freeze({
    schemaVersion: 1,
    bridgeEnabled: Reflect.get(value, "bridgeEnabled") as boolean,
    avatarEnabled: Reflect.get(value, "avatarEnabled") as boolean,
  });
}
