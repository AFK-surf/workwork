import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function readCompanionSource(entryUrl: URL): Promise<string> {
  const entryPath = fileURLToPath(entryUrl);
  const directory = path.dirname(entryPath);
  const extension = path.extname(entryPath);
  const stem = path.basename(entryPath, extension);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const sourceFiles = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => /\.(tsx?|jsx?)$/.test(name))
    .filter((name) => name === `${stem}${extension}` || name.startsWith(`${stem}-`))
    .sort((left, right) => sourceSortKey(stem, left).localeCompare(sourceSortKey(stem, right)));

  return (await Promise.all(sourceFiles.map((name) => fs.readFile(path.join(directory, name), "utf8")))).join("\n");
}

export function normalizeSourceWhitespace(source: string): string {
  return source.replace(/\s+/g, " ");
}

function sourceSortKey(stem: string, name: string): string {
  if (name === `${stem}.ts` || name === `${stem}.tsx`) return "00";
  if (name.endsWith("-base.ts") || name.endsWith("-base.tsx")) return "10";
  const layerMatch = /-layer(\d+)\.tsx?$/.exec(name);
  if (layerMatch?.[1]) return `20-${layerMatch[1].padStart(4, "0")}`;
  return `30-${name}`;
}
