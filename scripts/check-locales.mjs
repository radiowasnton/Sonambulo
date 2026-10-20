// Verifies that every locale defines exactly the same keys as English and keeps its placeholders.
// Usage: node scripts/check-locales.mjs
import { readdirSync, readFileSync } from 'node:fs';

const root = new URL('../extension/_locales/', import.meta.url);
const read = (code) => JSON.parse(readFileSync(new URL(`${code}/messages.json`, root), 'utf8'));
const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();

const source = read('en');
const keys = Object.keys(source);
const problems = [];

for (const code of readdirSync(root)) {
  const messages = read(code);
  for (const key of keys) {
    const text = messages[key]?.message;
    if (!text) problems.push(`${code}: missing "${key}"`);
    else if (placeholders(text) !== placeholders(source[key].message)) problems.push(`${code}: placeholders differ in "${key}"`);
  }
  for (const key of Object.keys(messages)) if (!(key in source)) problems.push(`${code}: unknown key "${key}"`);
  if (messages.extDescription && [...messages.extDescription.message].length > 132) problems.push(`${code}: extDescription exceeds 132 characters`);
  if (messages.extName && [...messages.extName.message].length > 75) problems.push(`${code}: extName exceeds 75 characters`);
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`OK: ${readdirSync(root).length} locales × ${keys.length} messages`);
