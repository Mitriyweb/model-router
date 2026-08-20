import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const packageJsonPath = path.join(__dirname, '../package.json');
const indexTsPath = path.join(__dirname, '../src/index.ts');

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const version = packageJson.version;

let indexTsContent = fs.readFileSync(indexTsPath, 'utf8');
indexTsContent = indexTsContent.replace(/console\.log\(`model-router v\${require\(".\/package\.json"\)\.version}`\);/, `console.log(\`model-router v${version}\`);`);

// Embed the version as a constant
const versionConstant = `const VERSION = '${version}';\n`;
indexTsContent = versionConstant + indexTsContent;

// Replace the require statement with the constant
indexTsContent = indexTsContent.replace(/console\.log\(`model-router v\${require\(".\/package\.json"\)\.version}`\);/, `console.log(\`model-router v${version}\`);`);

// Replace the require statement with the constant
indexTsContent = indexTsContent.replace(/console\.log\(`model-router v\${require\(".\/package\.json"\)\.version}`\);/, 'console.log(`model-router v${VERSION}`);');

fs.writeFileSync(indexTsPath, indexTsContent, 'utf8');

console.log(`Embedded version ${version} into index.ts`);