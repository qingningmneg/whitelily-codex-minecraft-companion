import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { init, parse } from "es-module-lexer";

if (process.argv.length !== 3) {
  throw new Error("PACKAGED_MAIN_PATH_REQUIRED");
}

const mainPath = resolve(process.argv[2]);
const source = await readFile(mainPath, "utf8");

await init;
const [imports] = parse(source);
const forbiddenImports = [
  ...new Set(
    imports
      .filter((entry) => entry.d !== -2)
      .map((entry) => entry.n ?? "<dynamic-import>")
      .filter((specifier) => specifier !== "electron" && !specifier.startsWith("node:")),
  ),
].sort((left, right) => left.localeCompare(right, "en"));

if (forbiddenImports.length > 0) {
  throw new Error(`PACKAGED_MAIN_BARE_IMPORTS: ${forbiddenImports.join(", ")}`);
}

process.stdout.write(
  `${JSON.stringify({ mainPath, checkedImports: imports.length, status: "ok" })}\n`,
);
