import fs from "node:fs";
import path from "node:path";

function parseEnv(contents: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const line of contents.split("\n")) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;

    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }

  return values;
}

export function loadEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;

  const values = parseEnv(fs.readFileSync(filePath, "utf8"));
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export const configDirectory = path.dirname(process.execPath);
export const configFilePath = path.join(configDirectory, ".env");

loadEnvFile(configFilePath);
loadEnvFile(`${process.env.HOME || process.env.USERPROFILE || "."}/.model-router.env`);
