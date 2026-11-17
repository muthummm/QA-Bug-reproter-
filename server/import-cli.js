// Usage: npm run import -- "path/to/bugs.csv" --project "Project name"
import fs from 'node:fs';
import path from 'node:path';
import { importCsv } from './importer.js';
import { projectByName } from './db.js';

const args = process.argv.slice(2);
const pIdx = args.indexOf('--project');
const projectName = pIdx >= 0 ? args.splice(pIdx, 2)[1] : null;
const file = args[0];
if (!file) {
  console.error('Usage: npm run import -- "path/to/bugs.csv" --project "Project name"');
  process.exit(1);
}
const name = (projectName || path.basename(file, path.extname(file))).trim();
const result = importCsv(fs.readFileSync(file, 'utf8'), projectByName(name));
console.log(`Project "${name}": imported ${result.imported} bug(s). Skipped ${result.skipped} row(s) without a description. ${result.duplicates} already existed.`);
for (const u of result.createdUsers)
  console.log(`Added assignee "${u.name}". They sign in by choosing "Create an account" with username "${u.username}".`);
