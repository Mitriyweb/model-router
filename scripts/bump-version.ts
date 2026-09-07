import fs from 'node:fs/promises';
import path from 'node:path';

const packagePath = path.resolve(process.cwd(), 'package.json');
const bumpType = process.argv[2];

if (!['major', 'minor', 'patch'].includes(bumpType ?? '')) {
  console.error('Usage: bun run bump:version -- <major|minor|patch>');
  process.exit(1);
}

const packageJson = JSON.parse(await fs.readFile(packagePath, 'utf8')) as {
  version?: string;
  [key: string]: unknown;
};

const versionMatch = packageJson.version?.match(/^(\d+)\.(\d+)\.(\d+)$/);
if (!versionMatch) {
  throw new Error(`Invalid package version: ${packageJson.version ?? '(missing)'}`);
}

const versionParts = versionMatch.slice(1).map(Number);
if (bumpType === 'major') versionParts[0] += 1;
if (bumpType === 'minor') {
  versionParts[1] += 1;
  versionParts[2] = 0;
}
if (bumpType === 'patch') versionParts[2] += 1;

const nextVersion = versionParts.join('.');
packageJson.version = nextVersion;
await fs.writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
console.log(`${versionMatch[0]} -> ${nextVersion}`);
