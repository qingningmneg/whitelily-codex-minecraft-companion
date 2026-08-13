import { inflateRawSync } from "node:zlib";

export type MinecraftComponentId = "bridge" | "avatar";

export interface MinecraftComponentArtifactVersion {
  readonly fileName: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly modId: string;
  readonly version: string;
}

export interface MinecraftComponentArtifact extends MinecraftComponentArtifactVersion {
  readonly component: MinecraftComponentId;
  readonly prior: readonly MinecraftComponentArtifactVersion[];
}

export interface MinecraftComponentResourceManifest {
  readonly schemaVersion: 1;
  readonly minecraftVersion: "1.21.5";
  readonly artifacts: readonly MinecraftComponentArtifact[];
}

const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_ARTIFACTS = 8;
const MAX_PRIOR_VERSIONS = 4;
const MAX_ZIP_ENTRIES = 4_096;
const MAX_FABRIC_METADATA_BYTES = 64 * 1024;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/u;
const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}\.jar$/u;
const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function validateMinecraftComponentManifest(
  value: unknown,
): MinecraftComponentResourceManifest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["schemaVersion", "minecraftVersion", "artifacts"]) ||
    value.schemaVersion !== 1 ||
    value.minecraftVersion !== "1.21.5" ||
    !Array.isArray(value.artifacts) ||
    value.artifacts.length !== 4 ||
    value.artifacts.length > MAX_ARTIFACTS
  ) {
    throw new Error("invalid");
  }
  const names = new Set<string>();
  const artifacts = value.artifacts.map((entry) => {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, [
        "component",
        "fileName",
        "bytes",
        "sha256",
        "modId",
        "version",
        "prior",
      ]) ||
      (entry.component !== "bridge" && entry.component !== "avatar") ||
      !Array.isArray(entry.prior) ||
      entry.prior.length > MAX_PRIOR_VERSIONS
    ) {
      throw new Error("invalid");
    }
    const current = validateArtifactVersion(entry);
    const prior = entry.prior.map((item) => {
      if (
        !isRecord(item) ||
        !hasExactKeys(item, ["fileName", "bytes", "sha256", "modId", "version"])
      ) {
        throw new Error("invalid");
      }
      return validateArtifactVersion(item);
    });
    if (prior.some((item) => item.modId !== current.modId)) throw new Error("invalid");
    for (const item of [current, ...prior]) {
      if (names.has(item.fileName)) throw new Error("invalid");
      names.add(item.fileName);
    }
    return Object.freeze({ component: entry.component, ...current, prior: Object.freeze(prior) });
  });
  const bridgeArtifacts = artifacts.filter(({ component }) => component === "bridge");
  const avatarArtifacts = artifacts.filter(({ component }) => component === "avatar");
  const bridge = artifacts.find(({ modId }) => modId === "whitelily_bridge");
  const avatar = artifacts.find(({ modId }) => modId === "whitelily_avatar");
  const fabricApi = artifacts.find(({ modId }) => modId === "fabric-api");
  const geckoLib = artifacts.find(({ modId }) => modId === "geckolib");
  if (
    bridgeArtifacts.length !== 1 ||
    bridge?.component !== "bridge" ||
    bridge.version !== "0.1.2" ||
    bridge.prior.length !== 2 ||
    bridge.prior[0]?.fileName !== "whitelily-bridge-fabric-1.21.5-0.1.1.jar" ||
    bridge.prior[0]?.modId !== "whitelily_bridge" ||
    bridge.prior[0]?.version !== "0.1.1" ||
    bridge.prior[1]?.fileName !== "whitelily-bridge-fabric-1.21.5-0.1.0.jar" ||
    bridge.prior[1]?.modId !== "whitelily_bridge" ||
    bridge.prior[1]?.version !== "0.1.0" ||
    !/^whitelily-bridge-fabric-1\.21\.5-[A-Za-z0-9.+_-]+\.jar$/u.test(bridge.fileName) ||
    avatarArtifacts.length !== 3 ||
    avatar?.component !== "avatar" ||
    avatar.version !== "0.1.0" ||
    !/^whitelily-avatar-fabric-1\.21\.5-[A-Za-z0-9.+_-]+\.jar$/u.test(avatar.fileName) ||
    fabricApi?.component !== "avatar" ||
    fabricApi.version !== "0.128.2+1.21.5" ||
    fabricApi.fileName !== "fabric-api-0.128.2+1.21.5.jar" ||
    fabricApi.prior.length !== 0 ||
    geckoLib?.component !== "avatar" ||
    geckoLib.version !== "5.1.0" ||
    geckoLib.fileName !== "geckolib-fabric-1.21.5-5.1.0.jar" ||
    geckoLib.prior.length !== 0 ||
    new Set(artifacts.map(({ modId }) => modId)).size !== artifacts.length
  ) {
    throw new Error("invalid");
  }
  return Object.freeze({
    schemaVersion: 1,
    minecraftVersion: "1.21.5",
    artifacts: Object.freeze(artifacts),
  });
}

function validateArtifactVersion(
  value: Record<string, unknown>,
): MinecraftComponentArtifactVersion {
  if (
    typeof value.fileName !== "string" ||
    !FILE_NAME_PATTERN.test(value.fileName) ||
    typeof value.bytes !== "number" ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 1 ||
    value.bytes > MAX_ARTIFACT_BYTES ||
    typeof value.sha256 !== "string" ||
    !HASH_PATTERN.test(value.sha256) ||
    typeof value.modId !== "string" ||
    !/^[a-z][a-z0-9_-]{1,63}$/u.test(value.modId) ||
    typeof value.version !== "string" ||
    !VERSION_PATTERN.test(value.version)
  ) {
    throw new Error("invalid");
  }
  return Object.freeze({
    fileName: value.fileName,
    bytes: value.bytes,
    sha256: value.sha256,
    modId: value.modId,
    version: value.version,
  });
}

export function readFabricMetadata(bytes: Buffer): Readonly<{ id: string; version: string }> {
  const endOffset = findEndOfCentralDirectory(bytes);
  const entries = bytes.readUInt16LE(endOffset + 10);
  const centralSize = bytes.readUInt32LE(endOffset + 12);
  const centralOffset = bytes.readUInt32LE(endOffset + 16);
  if (
    entries < 1 ||
    entries > MAX_ZIP_ENTRIES ||
    centralOffset + centralSize !== endOffset ||
    centralOffset > bytes.byteLength
  ) {
    throw new Error("invalid");
  }
  let offset = centralOffset;
  let metadata: Buffer | undefined;
  for (let index = 0; index < entries; index += 1) {
    assertBufferRange(bytes, offset, 46);
    if (bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error("invalid");
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const crc = bytes.readUInt32LE(offset + 16);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    assertBufferRange(bytes, offset + 46, nameLength + extraLength + commentLength);
    const name = strictUtf8(bytes.subarray(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
    if (name !== "fabric.mod.json") continue;
    if (
      metadata !== undefined ||
      (flags & ~(0x0800 | 0x0008)) !== 0 ||
      (method !== 0 && method !== 8) ||
      compressedSize > MAX_FABRIC_METADATA_BYTES ||
      uncompressedSize > MAX_FABRIC_METADATA_BYTES
    ) {
      throw new Error("invalid");
    }
    if (localOffset >= centralOffset) throw new Error("invalid");
    assertBufferRange(bytes, localOffset, 30);
    if (bytes.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("invalid");
    const localFlags = bytes.readUInt16LE(localOffset + 6);
    const localMethod = bytes.readUInt16LE(localOffset + 8);
    const localCrc = bytes.readUInt32LE(localOffset + 14);
    const localCompressedSize = bytes.readUInt32LE(localOffset + 18);
    const localUncompressedSize = bytes.readUInt32LE(localOffset + 22);
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    assertBufferRange(bytes, localOffset + 30, localNameLength + localExtraLength);
    const localName = strictUtf8(
      bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength),
    );
    const usesDataDescriptor = (flags & 0x0008) !== 0;
    if (
      localName !== name ||
      localFlags !== flags ||
      localMethod !== method ||
      (usesDataDescriptor
        ? localCrc !== 0 || localCompressedSize !== 0 || localUncompressedSize !== 0
        : localCrc !== crc ||
          localCompressedSize !== compressedSize ||
          localUncompressedSize !== uncompressedSize)
    ) {
      throw new Error("invalid");
    }
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressedSize > centralOffset) throw new Error("invalid");
    assertBufferRange(bytes, dataOffset, compressedSize);
    if (usesDataDescriptor) {
      const descriptorOffset = dataOffset + compressedSize;
      assertBufferRange(bytes, descriptorOffset, 16);
      if (
        descriptorOffset + 16 > centralOffset ||
        bytes.readUInt32LE(descriptorOffset) !== 0x08074b50 ||
        bytes.readUInt32LE(descriptorOffset + 4) !== crc ||
        bytes.readUInt32LE(descriptorOffset + 8) !== compressedSize ||
        bytes.readUInt32LE(descriptorOffset + 12) !== uncompressedSize
      ) {
        throw new Error("invalid");
      }
    }
    const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize);
    metadata =
      method === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: MAX_FABRIC_METADATA_BYTES });
    if (metadata.byteLength !== uncompressedSize || crc32(metadata) !== crc) {
      throw new Error("invalid");
    }
  }
  if (offset !== centralOffset + centralSize || metadata === undefined) throw new Error("invalid");
  const metadataText = strictUtf8(metadata);
  assertNoDuplicateJsonObjectKeys(metadataText);
  const value: unknown = JSON.parse(metadataText);
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.version !== "string") {
    throw new Error("invalid");
  }
  return Object.freeze({ id: value.id, version: value.version });
}

function assertNoDuplicateJsonObjectKeys(text: string): void {
  let offset = 0;
  const skipWhitespace = () => {
    while (/\s/u.test(text[offset] ?? "")) offset += 1;
  };
  const readString = (): string => {
    if (text[offset] !== '"') throw new Error("invalid");
    const start = offset;
    offset += 1;
    while (offset < text.length) {
      if (text[offset] === "\\") {
        offset += 2;
        continue;
      }
      if (text[offset] === '"') {
        offset += 1;
        return JSON.parse(text.slice(start, offset)) as string;
      }
      offset += 1;
    }
    throw new Error("invalid");
  };
  const readValue = (): void => {
    skipWhitespace();
    if (text[offset] === "{") {
      offset += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (text[offset] === "}") {
        offset += 1;
        return;
      }
      for (;;) {
        skipWhitespace();
        const key = readString();
        if (keys.has(key)) throw new Error("invalid");
        keys.add(key);
        skipWhitespace();
        if (text[offset] !== ":") throw new Error("invalid");
        offset += 1;
        readValue();
        skipWhitespace();
        if (text[offset] === "}") {
          offset += 1;
          return;
        }
        if (text[offset] !== ",") throw new Error("invalid");
        offset += 1;
      }
    }
    if (text[offset] === "[") {
      offset += 1;
      skipWhitespace();
      if (text[offset] === "]") {
        offset += 1;
        return;
      }
      for (;;) {
        readValue();
        skipWhitespace();
        if (text[offset] === "]") {
          offset += 1;
          return;
        }
        if (text[offset] !== ",") throw new Error("invalid");
        offset += 1;
      }
    }
    if (text[offset] === '"') {
      readString();
      return;
    }
    const start = offset;
    while (offset < text.length && !/[\s,\]}]/u.test(text[offset]!)) offset += 1;
    if (offset === start) throw new Error("invalid");
  };
  readValue();
  skipWhitespace();
  if (offset !== text.length) throw new Error("invalid");
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  const minimum = Math.max(0, bytes.byteLength - 65_557);
  for (let offset = bytes.byteLength - 22; offset >= minimum; offset -= 1) {
    if (bytes.readUInt32LE(offset) !== 0x06054b50) continue;
    assertBufferRange(bytes, offset, 22);
    const commentLength = bytes.readUInt16LE(offset + 20);
    if (
      offset + 22 + commentLength === bytes.byteLength &&
      bytes.readUInt16LE(offset + 4) === 0 &&
      bytes.readUInt16LE(offset + 6) === 0 &&
      bytes.readUInt16LE(offset + 8) === bytes.readUInt16LE(offset + 10)
    ) {
      return offset;
    }
  }
  throw new Error("invalid");
}

function assertBufferRange(bytes: Buffer, offset: number, length: number): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > bytes.byteLength
  ) {
    throw new Error("invalid");
  }
}

function strictUtf8(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new Error("invalid");
  }
  return strictUtf8Decoder.decode(bytes);
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareOrdinal);
  const sortedExpected = [...expected].sort(compareOrdinal);
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
