import { en } from "./en";
import type { Locale, MessageCatalog, MessageKey } from "./messageKeys";
import { zhCN } from "./zh-CN";

export type InterpolationParams = Readonly<Record<string, string | number>>;

const catalogs: Readonly<Record<Locale, MessageCatalog>> = Object.freeze({
  "zh-CN": zhCN,
  en,
});
const placeholderPattern = /\{([A-Za-z][A-Za-z0-9]*)\}/gu;

export function translate(
  locale: Locale,
  key: MessageKey,
  params: InterpolationParams = {},
): string {
  const template = catalogs[locale][key];
  const required = placeholders(template);
  const supplied = Object.keys(params);

  for (const name of required) {
    if (!Object.hasOwn(params, name)) {
      throw new Error(`missing interpolation parameter: ${name}`);
    }
  }
  for (const name of supplied) {
    if (!required.has(name)) {
      throw new Error(`unexpected interpolation parameter: ${name}`);
    }
  }

  return template.replace(placeholderPattern, (_placeholder, name: string) => {
    return String(params[name]);
  });
}

function placeholders(template: string): ReadonlySet<string> {
  return new Set([...template.matchAll(placeholderPattern)].map((match) => match[1]!));
}
