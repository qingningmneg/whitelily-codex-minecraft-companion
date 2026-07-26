const escapedAssignment = String.raw`(?:=|:|\\u003[dD]|\\u003[aA])`;
const markerPrefixedValue = String.raw`\[REDACTED(?:_[A-Z]+)?\][^\r\n]*`;
const markerPrefixWithSuffix = String.raw`\[REDACTED(?:_[A-Z]+)?\](?=\S|\s+\S)[^\r\n]*`;
const exactMarkerValue = String.raw`\[REDACTED(?:_[A-Z]+)?\](?:\s|$)`;

const textPatterns: Array<[RegExp, string]> = [
  [
    new RegExp(
      String.raw`\b(CODEX_ACCESS_TOKEN|OPENAI_API_KEY|CODEX_API_KEY)\s*${escapedAssignment}\s*${markerPrefixedValue}`,
      "gi",
    ),
    "$1=[REDACTED]",
  ],
  [
    new RegExp(
      String.raw`\b(password|passwd|pwd)\s*${escapedAssignment}\s*${markerPrefixedValue}`,
      "gi",
    ),
    "$1=[REDACTED_PASSWORD]",
  ],
  [
    new RegExp(
      String.raw`\b([A-Za-z][A-Za-z0-9_]*(?:key|token|secret|credential))\s*${escapedAssignment}\s*${markerPrefixedValue}`,
      "gi",
    ),
    "$1=[REDACTED]",
  ],
  [
    new RegExp(
      String.raw`\b([A-Z][A-Z0-9_]+)\s*${escapedAssignment}\s*${markerPrefixWithSuffix}`,
      "g",
    ),
    "$1=[REDACTED_ENV]",
  ],
  [
    new RegExp(
      String.raw`\b(CODEX_ACCESS_TOKEN|OPENAI_API_KEY|CODEX_API_KEY)\s*${escapedAssignment}\s*\S+`,
      "gi",
    ),
    "$1=[REDACTED]",
  ],
  [
    new RegExp(String.raw`\b(password|passwd|pwd)\s*${escapedAssignment}\s*\S+`, "gi"),
    "$1=[REDACTED_PASSWORD]",
  ],
  [
    new RegExp(
      String.raw`\b([A-Za-z][A-Za-z0-9_]*(?:key|token|secret|credential))\s*${escapedAssignment}\s*(?!${exactMarkerValue})\S+`,
      "gi",
    ),
    "$1=[REDACTED]",
  ],
  [/(authorization\s*:\s*)?bearer\s+[A-Za-z0-9._~-]{16,}\b/gi, "$1Bearer [REDACTED_TOKEN]"],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/gi, "[REDACTED_OPENAI_KEY]"],
  [/\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/:@]*:[^\s/@]+@/g, "$1[REDACTED_URI_CREDENTIALS]@"],
  [
    new RegExp(
      String.raw`\b(mail|email)\s*${escapedAssignment}\s*[^\s@]+@[^\s@]+\.[^\s@]+\b`,
      "gi",
    ),
    "$1=[REDACTED_EMAIL]",
  ],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[REDACTED_EMAIL]"],
  [
    new RegExp(
      String.raw`\b(phone|mobile|telephone|tel)\s*${escapedAssignment}\s*\+?\d[\d -]{7,}\d\b`,
      "gi",
    ),
    "$1=[REDACTED_PHONE]",
  ],
  [
    /(手机号|手机|电话)\s*(?:=|:|：|\\u003[dD]|\\u003[aA])\s*\+?\d[\d -]{7,}\d/g,
    "$1=[REDACTED_PHONE]",
  ],
  [/\b\+?\d[\d -]{7,}\d\b/g, "[REDACTED_PHONE]"],
  [
    /\b\d{1,6}[A-Za-z]?\s+[A-Za-z][A-Za-z .'-]{2,}\s+(?:Street|St\.?|Road|Rd\.?|Avenue|Ave\.?|Lane|Ln\.?|Drive|Dr\.?|Boulevard|Blvd\.?|Parkway|Pkwy\.?)\b/gi,
    "[REDACTED_ADDRESS]",
  ],
  [
    /(?:地址\s*[:：]?\s*)?(?:[\u4e00-\u9fff]{2,}(?:省|市|区|县|镇|路|街|巷|大道)){1,5}\d{1,4}(?:号|弄|室|栋)/g,
    "[REDACTED_ADDRESS]",
  ],
  [
    new RegExp(
      String.raw`\b([A-Z][A-Z0-9_]+)\s*${escapedAssignment}\s*(?!${exactMarkerValue})\S+`,
      "g",
    ),
    "$1=[REDACTED_ENV]",
  ],
];

function redactText(input: string): string {
  return textPatterns.reduce(
    (value, [pattern, replacement]) => value.replace(pattern, replacement),
    input,
  );
}

function sensitiveKeyReplacement(key: string): string | undefined {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLocaleLowerCase();
  if (/(?:password|passwd|pwd)/.test(normalized)) return "[REDACTED_PASSWORD]";
  if (/(?:email|mail)/.test(normalized)) return "[REDACTED_EMAIL]";
  if (/(?:phone|mobile|telephone|tel)/.test(normalized)) return "[REDACTED_PHONE]";
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

export function containsSensitiveData(input: string): boolean {
  const json = parseJson(input);
  if (json === undefined) return redactText(input) !== input;
  return JSON.stringify(json.parsed) !== JSON.stringify(json.redacted);
}
