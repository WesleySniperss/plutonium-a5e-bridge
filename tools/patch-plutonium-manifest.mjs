#!/usr/bin/env node
// Foundry hides a module whose `relationships.systems` does not list the active
// system, and it does that before any module code runs — so this one line cannot
// be fixed from our side at runtime. Adding "a5e" to Plutonium's manifest is the
// only edit this bridge needs to make to Plutonium itself.
//
// Re-run it after every Plutonium update. It is idempotent and keeps a backup.
//
//   node tools/patch-plutonium-manifest.mjs [path/to/modules/plutonium/module.json]
//   node tools/patch-plutonium-manifest.mjs --revert [path]

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const revert = args.includes('--revert');
const explicit = args.find((a) => !a.startsWith('--'));

const manifest = resolve(explicit ?? join(here, '..', '..', 'plutonium', 'module.json'));
const backup = `${manifest}.pre-a5e.bak`;

if (!existsSync(manifest)) {
  console.error(`Not found: ${manifest}`);
  console.error('Pass the path to plutonium/module.json as an argument.');
  process.exit(1);
}

if (revert) {
  if (!existsSync(backup)) {
    console.error(`No backup at ${backup} — nothing to revert.`);
    process.exit(1);
  }
  copyFileSync(backup, manifest);
  console.log(`Reverted ${manifest} from backup.`);
  process.exit(0);
}

const raw = readFileSync(manifest, 'utf8');
const json = JSON.parse(raw);

json.relationships ??= {};
json.relationships.systems ??= [];

if (json.relationships.systems.some((s) => s.id === 'a5e')) {
  console.log('Already patched — "a5e" is listed in relationships.systems.');
  process.exit(0);
}

if (!existsSync(backup)) copyFileSync(manifest, backup);

json.relationships.systems.push({ id: 'a5e', type: 'system' });

// Match the file's existing indentation so the diff stays one line.
const indent = /^\t/m.test(raw) ? '\t' : 2;
writeFileSync(manifest, `${JSON.stringify(json, null, indent)}\n`, 'utf8');

console.log(`Added "a5e" to ${manifest}`);
console.log(`Backup written to ${backup}`);
console.log('Restart Foundry, then enable Plutonium in Manage Modules.');
