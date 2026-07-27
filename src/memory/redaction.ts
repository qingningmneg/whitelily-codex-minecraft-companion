const textPatterns: Array<[RegExp, string]> = [
  [/\b(authorization\s*:\s*)?bearer\s+[A-Za-z0-9._~-]{16,}\b/gi, "$1Bearer [REDACTED_TOKEN]"],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/gi, "[REDACTED_OPENAI_KEY]"],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[REDACTED_EMAIL]"],
  [/\b\+?\d[\d -]{7,}\d\b/g, "[REDACTED_PHONE]"],
  [
    /\b\d{1,6}[A-Za-z]?\s+[A-Za-z][A-Za-z .'-]{2,}\s+(?:Street|St\.?|Road|Rd\.?|Avenue|Ave\.?|Lane|Ln\.?|Drive|Dr\.?|Boulevard|Blvd\.?|Parkway|Pkwy\.?)\b/gi,
    "[REDACTED_ADDRESS]",
  ],
  [
    /(?:地址\s*[:：]?\s*)?(?:[\p{Script=Han}]{2,}(?:省|市|区|县|镇|路|街|巷|大道)){1,5}\d{1,4}(?:号|弄|室|栋)?/gu,
    "[REDACTED_ADDRESS]",
  ],
];

const assignmentPattern =
  /(?<![A-Za-z0-9_])(["']?)([A-Za-z][A-Za-z0-9_.-]*)(\1)\s*(?:=|:|\\u003[dD]|\\u003[aA])\s*/g;
const profilePrefixes = [
  "%userprofile%",
  "%localappdata%",
  "%appdata%",
  "%homedrive%",
  "%homepath%",
] as const;
const homePrefixes = ["${home}", "$home"] as const;
const bareProfilePrefixes = ["users", "home"] as const;

function redactText(input: string): string {
  const assignmentsRedacted = redactSensitiveAssignments(input);
  const uriCredentialsRedacted = redactUriCredentials(assignmentsRedacted);
  return textPatterns.reduce(
    (value, [pattern, replacement]) => value.replace(pattern, replacement),
    uriCredentialsRedacted,
  );
}

function redactSensitiveAssignments(input: string): string {
  let output = "";
  let cursor = 0;
  assignmentPattern.lastIndex = 0;
  for (let match = assignmentPattern.exec(input); match; match = assignmentPattern.exec(input)) {
    const key = match[2]!;
    const replacement =
      sensitiveKeyReplacement(key) ??
      (key.length > 1 && /^[A-Z][A-Z0-9_]+$/.test(key) ? "[REDACTED_ENV]" : undefined);
    if (replacement === undefined) continue;
    const valueStart = assignmentPattern.lastIndex;
    const value = consumeAssignmentValue(input, valueStart, replacement);
    if (!value) continue;
    output += input.slice(cursor, match.index);
    output += match[1]
      ? `${match[1]}${key}${match[1]}:${value.replacement}`
      : `${key}=${value.replacement}`;
    cursor = value.end;
    assignmentPattern.lastIndex = value.end;
  }
  return output + input.slice(cursor);
}

function consumeAssignmentValue(
  input: string,
  start: number,
  marker: string,
): { end: number; replacement: string } | undefined {
  if (start >= input.length) return undefined;
  const quote = input[start];
  if (quote === '"' || quote === "'") {
    let escaped = false;
    for (let index = start + 1; index < input.length; index += 1) {
      const character = input[index]!;
      if (character === quote && !escaped) {
        return { end: index + 1, replacement: `${quote}${marker}${quote}` };
      }
      escaped = character === "\\" ? !escaped : false;
    }
    return { end: input.length, replacement: `${quote}${marker}${quote}` };
  }

  let end = start;
  if (input.startsWith("[REDACTED", start)) {
    const markerEnd = input.indexOf("]", start);
    end = markerEnd < 0 ? input.length : markerEnd + 1;
    while (end < input.length && !/[\s,;}\]]/.test(input[end]!)) end += 1;
  } else {
    while (end < input.length && !/[\s,;}\]]/.test(input[end]!)) end += 1;
  }
  if (end === start) return undefined;
  const token = input.slice(start, end);
  if (/^\[REDACTED(?:_[A-Z]+)?\]/.test(token)) {
    const exactMarker = /^\[REDACTED(?:_[A-Z]+)?\]$/.test(token);
    const lineSuffix = input.slice(end).split(/\r?\n/u, 1)[0] ?? "";
    if (!exactMarker || /\S/.test(lineSuffix)) {
      while (end < input.length && input[end] !== "\r" && input[end] !== "\n") end += 1;
    }
  } else if (marker === "[REDACTED_PHONE]") {
    while (end < input.length && !/[,;}\]\r\n]/.test(input[end]!)) end += 1;
  }
  return { end, replacement: marker };
}

function redactUriCredentials(input: string): string {
  let output = "";
  let cursor = 0;
  let index = 0;
  while (index < input.length) {
    const previous = index === 0 ? undefined : input[index - 1];
    if (
      !isAsciiLetter(input[index]) ||
      (previous !== undefined && isUriSchemeCharacter(previous))
    ) {
      index += 1;
      continue;
    }

    let schemeEnd = index + 1;
    while (isUriSchemeCharacter(input[schemeEnd])) schemeEnd += 1;
    if (input[schemeEnd] !== ":" || input[schemeEnd + 1] !== "/" || input[schemeEnd + 2] !== "/") {
      index = schemeEnd;
      continue;
    }

    const authorityStart = schemeEnd + 3;
    let authorityEnd = authorityStart;
    let firstAt = -1;
    let colonBeforeAt = false;
    while (authorityEnd < input.length && !isUriAuthorityBoundary(input[authorityEnd]!)) {
      const character = input[authorityEnd]!;
      if (character === "@" && firstAt < 0) {
        firstAt = authorityEnd;
      } else if (character === ":" && firstAt < 0) {
        colonBeforeAt = true;
      }
      authorityEnd += 1;
    }

    if (firstAt >= 0 && colonBeforeAt) {
      output += input.slice(cursor, authorityStart);
      output += "[REDACTED_URI_CREDENTIALS]@";
      cursor = firstAt + 1;
      index = firstAt + 1;
      continue;
    }
    index = authorityEnd;
  }
  return output + input.slice(cursor);
}

function isUriSchemeCharacter(value: string | undefined): boolean {
  return value !== undefined && (isAsciiLetter(value) || /[0-9+.-]/.test(value));
}

function isUriAuthorityBoundary(value: string): boolean {
  return (
    value === "/" ||
    value === "?" ||
    value === "#" ||
    value === "\r" ||
    value === "\n" ||
    value === '"' ||
    value === "'" ||
    value === "<" ||
    value === ">"
  );
}

function redactLocalPaths(input: string): string {
  let output = "";
  let cursor = 0;
  for (let index = 0; index < input.length; index += 1) {
    if (!isLocalPathStart(input, index)) continue;
    const previous = index === 0 ? undefined : input[index - 1];
    const quote = previous === '"' || previous === "'" ? previous : undefined;
    let end = index;
    while (end < input.length) {
      const character = input[end]!;
      if (quote !== undefined) {
        if (character === quote && !isEscaped(input, end)) break;
      } else if (character === "\r" || character === "\n") {
        break;
      }
      end += 1;
    }
    output += input.slice(cursor, index);
    output += "[REDACTED_PATH]";
    cursor = end;
    index = end - 1;
  }
  return output + input.slice(cursor);
}

function isLocalPathStart(input: string, index: number): boolean {
  if (startsWithAsciiIgnoreCase(input, index, "file:") && isPathSeparator(input[index + 5])) {
    return true;
  }
  for (const prefix of profilePrefixes) {
    if (!startsWithAsciiIgnoreCase(input, index, prefix)) continue;
    const next = input[index + prefix.length];
    if (next === undefined || isPathSeparator(next)) return true;
  }
  for (const prefix of homePrefixes) {
    if (
      startsWithAsciiIgnoreCase(input, index, prefix) &&
      isPathSeparator(input[index + prefix.length])
    ) {
      return true;
    }
  }
  if (input[index] === "~" && isPathSeparator(input[index + 1])) return true;
  if (
    isAsciiLetter(input[index]) &&
    input[index + 1] === ":" &&
    isPathSeparator(input[index + 2])
  ) {
    return true;
  }

  const previous = index === 0 ? undefined : input[index - 1];
  const atBoundary = previous === undefined || !/[A-Za-z0-9:/\\]/.test(previous);
  if (atBoundary) {
    for (const prefix of bareProfilePrefixes) {
      if (
        startsWithAsciiIgnoreCase(input, index, prefix) &&
        isPathSeparator(input[index + prefix.length])
      ) {
        return true;
      }
    }
  }
  if (
    atBoundary &&
    isPathSeparator(input[index]) &&
    isPathSeparator(input[index + 1]) &&
    input[index + 2] !== undefined &&
    !isPathSeparator(input[index + 2])
  ) {
    return true;
  }
  const next = input[index + 1];
  return (
    atBoundary && input[index] === "/" && next !== undefined && next !== "/" && !/\s/.test(next)
  );
}

function startsWithAsciiIgnoreCase(input: string, index: number, expected: string): boolean {
  if (index + expected.length > input.length) return false;
  for (let offset = 0; offset < expected.length; offset += 1) {
    const actualCode = input.charCodeAt(index + offset);
    const expectedCode = expected.charCodeAt(offset);
    const foldedActual = actualCode >= 65 && actualCode <= 90 ? actualCode + 32 : actualCode;
    if (foldedActual !== expectedCode) return false;
  }
  return true;
}

function isAsciiLetter(value: string | undefined): boolean {
  if (value === undefined) return false;
  const code = value.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isPathSeparator(value: string | undefined): boolean {
  return value === "/" || value === "\\";
}

function isEscaped(input: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && input[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function sensitiveKeyReplacement(key: string): string | undefined {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLocaleLowerCase();
  if (/(?:password|passwd|pwd)/.test(normalized)) return "[REDACTED_PASSWORD]";
  if (/(?:email|mail)/.test(normalized)) return "[REDACTED_EMAIL]";
  if (/(?:phone|mobile|telephone|tel)/.test(normalized)) return "[REDACTED_PHONE]";
  if (/^(?:lease(?:id)?|(?:task|turn)lease(?:id)?)$/.test(normalized)) {
    return "[REDACTED_LEASE]";
  }
  if (/(?:key|token|secret|credential|dsn|connectionstring)/.test(normalized)) {
    return "[REDACTED]";
  }
  return undefined;
}

function isRecognizedMarker(value: string): boolean {
  return /^\[REDACTED(?:_[A-Z]+)*\]$/.test(value) || value === "Bearer [REDACTED_TOKEN]";
}

function redactJsonValue(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactJsonValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => {
        const replacement = sensitiveKeyReplacement(key);
        return [
          key,
          replacement === undefined
            ? redactJsonValue(nested)
            : typeof nested === "string" && isRecognizedMarker(nested)
              ? nested
              : replacement,
        ];
      }),
    );
  }
  return value;
}

function parseJson(input: string): { parsed: unknown; redacted: unknown } | undefined {
  try {
    const parsed = JSON.parse(input) as unknown;
    return { parsed, redacted: redactJsonValue(parsed) };
  } catch {
    return undefined;
  }
}

export function redactSecrets(input: string): string {
  const json = parseJson(input);
  return json === undefined ? redactText(input) : JSON.stringify(json.redacted);
}

export function redactPublicText(input: string): string {
  return redactLocalPaths(redactSecrets(input));
}

export function containsSensitiveData(input: string): boolean {
  const json = parseJson(input);
  if (json === undefined) return redactText(input) !== input;
  return JSON.stringify(json.parsed) !== JSON.stringify(json.redacted);
}
