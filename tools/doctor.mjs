#!/usr/bin/env node
// Checks a Foundry install from the outside — no Foundry, no browser, no world
// needed. Run it on the machine where something is wrong.
//
//   node tools/doctor.mjs                 report what it finds
//   node tools/doctor.mjs --fix           report, and repair what it can
//   node tools/doctor.mjs --data <path>   point it at a Foundry user-data folder
//                                         (the one holding Config/ Data/ Logs/)

import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// `import.meta.url` is not a real path when the script is piped in, which is how
// it is run on a remote server:
//   curl -sL <raw url>/tools/doctor.mjs | node - --fix
let here = null;
try { here = dirname(fileURLToPath(import.meta.url)); } catch { /* piped in */ }

const args = process.argv.slice(2);
const doFix = args.includes('--fix');
// `indexOf` returns -1 when the flag is absent, and -1 + 1 is 0 — which would
// quietly take the *first* argument as the path, so `--fix` alone was read as a
// folder name. Only look for a value when the flag is actually there.
const dataIndex = args.indexOf('--data');
const dataArg = dataIndex >= 0 ? args[dataIndex + 1] : null;

const problems = [];
const notes = [];
const fixes = [];

function ok(msg) { console.log(`  ok    ${msg}`); }
function bad(msg, fix) { console.log(`  WRONG ${msg}`); problems.push(msg); if (fix) fixes.push(fix); }
function info(msg) { console.log(`  ...   ${msg}`); notes.push(msg); }

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

// --- find the install -------------------------------------------------------

/** Does this look like a Foundry user-data folder, or the Data folder inside one? */
function modulesUnder(root) {
  for (const candidate of [join(root, 'Data', 'modules'), join(root, 'modules')]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function findModulesDir() {
  if (dataArg) {
    const found = modulesUnder(resolve(dataArg));
    if (found) return found;
    console.error(`No modules folder under ${resolve(dataArg)}`);
    process.exit(1);
  }

  // Installed alongside the other modules: <userData>/Data/modules/plutonium-a5e/tools
  if (here) {
    const guess = resolve(here, '..', '..');
    if (existsSync(join(guess, 'plutonium-a5e'))) {
      // Foundry may be configured to read a different folder than the one we sit in.
      const options = readJson(resolve(guess, '..', '..', 'Config', 'options.json'));
      const configured = options?.dataPath ? join(options.dataPath, 'Data', 'modules') : null;
      if (configured && existsSync(configured) && resolve(configured) !== resolve(guess)) {
        info(`Foundry is configured to read ${configured}, not ${guess} — checking that one.`);
        return configured;
      }
      return guess;
    }
  }

  // Piped in, or run from somewhere else: try the working directory, then the
  // places a Linux install usually keeps its data.
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const candidates = [
    process.cwd(),
    resolve(process.cwd(), '..'),
    join(home, 'foundrydata'),
    join(home, 'foundryuserdata'),
    join(home, '.local', 'share', 'FoundryVTT'),
    '/data',
    '/foundrydata',
    '/home/foundry/foundrydata',
  ];

  for (const root of candidates) {
    if (!root) continue;
    const found = modulesUnder(root);
    if (found) {
      info(`Found a Foundry data folder at ${root}`);
      return found;
    }
  }

  console.error('Could not work out where the modules folder is.');
  console.error('Run this from the Foundry data folder, or pass --data <path to it>.');
  console.error('That is the folder holding Config/, Data/ and Logs/.');
  process.exit(1);
}

const modules = findModulesDir();

console.log(`\nPlutonium ⇄ A5E — checking ${modules}\n`);

// --- the bridge itself ------------------------------------------------------

console.log('This bridge');
const bridge = readJson(join(modules, 'plutonium-a5e', 'module.json'));
if (!bridge) bad('The bridge is not installed in this modules folder.');
else ok(`installed, version ${bridge.version}`);

// --- libWrapper -------------------------------------------------------------

console.log('\nlibWrapper');
const libWrapper = readJson(join(modules, 'lib-wrapper', 'module.json'));
if (!libWrapper) {
  bad('Not installed. Plutonium requires it and refuses to start without it.',
    'Install the libWrapper module.');
} else {
  ok(`installed, version ${libWrapper.version}`);
}

// --- Plutonium --------------------------------------------------------------

console.log('\nPlutonium');
const plutoniumDir = join(modules, 'plutonium');
const manifestPath = join(plutoniumDir, 'module.json');
const plutonium = readJson(manifestPath);

if (!plutonium) {
  bad(`Not installed — no ${manifestPath}.`, 'Install Plutonium first.');
} else {
  ok(`installed, version ${plutonium.version}`);

  const systems = plutonium.relationships?.systems ?? [];
  const names = systems.map((s) => s?.id).filter(Boolean);

  if (names.includes('a5e')) {
    ok(`its manifest lists a5e (${names.join(', ')})`);
  } else {
    bad(
      `its manifest lists ${names.join(', ') || 'no systems'} — not a5e. `
      + 'Foundry hides a module that does not name the active system, which is why it is '
      + 'missing from the module list.',
      doFix ? null : 'Re-run this with --fix, or run tools/patch-plutonium-manifest.mjs.',
    );

    if (doFix) {
      const raw = readFileSync(manifestPath, 'utf8');
      const backup = `${manifestPath}.pre-a5e.bak`;
      if (!existsSync(backup)) copyFileSync(manifestPath, backup);

      plutonium.relationships ??= {};
      plutonium.relationships.systems ??= [];
      plutonium.relationships.systems.push({ id: 'a5e', type: 'system' });

      const indent = /^\t/m.test(raw) ? '\t' : 2;
      writeFileSync(manifestPath, `${JSON.stringify(plutonium, null, indent)}\n`, 'utf8');
      console.log(`  FIXED added a5e; backup at ${backup}`);
      problems.pop();
      fixes.push(
        'Foundry has the old manifest cached. Restart the Foundry service, or drop the\n'
        + '    cache without restarting: Return to Setup, then in the browser console run\n'
        + '    await fetch("setup", { method: "POST",\n'
        + '      headers: { "Content-Type": "application/json" },\n'
        + '      body: JSON.stringify({ action: "resetPackages" }) }).then(r => r.json())\n'
        + '    Reload the page, then enable Plutonium in Manage Modules.',
      );
    }
  }

  if (!existsSync(join(plutoniumDir, 'js', 'Bundle.js'))) {
    bad('js/Bundle.js is missing — the install looks incomplete.', 'Reinstall Plutonium.');
  }
}

// --- which worlds have it switched on ---------------------------------------

console.log('\nWorlds');
const worldsDir = resolve(modules, '..', 'worlds');
if (!existsSync(worldsDir)) {
  info('No worlds folder found here.');
} else {
  for (const world of readdirSync(worldsDir)) {
    const settings = join(worldsDir, world, 'data', 'settings');
    if (!existsSync(settings)) continue;

    const meta = readJson(join(worldsDir, world, 'world.json'));
    if (meta?.system && meta.system !== 'a5e') continue;

    // The settings store is a database; the module list is plain text inside it,
    // and the last write wins, so the final match is the current one.
    let blob = '';
    for (const file of readdirSync(settings)) {
      if (!/\.(log|ldb)$/.test(file)) continue;
      blob += readFileSync(join(settings, file), 'latin1');
    }

    const enabled = [...blob.matchAll(/"(plutonium|plutonium-a5e|lib-wrapper)\\":(true|false)/g)];
    if (!enabled.length) { info(`${world}: no module configuration recorded yet.`); continue; }

    const state = {};
    for (const [, id, value] of enabled) state[id] = value === 'true';

    const off = Object.entries(state).filter(([, on]) => !on).map(([id]) => id);
    if (off.length) bad(`world "${world}": ${off.join(', ')} switched off.`, 'Enable them in Manage Modules.');
    else ok(`world "${world}": plutonium, the bridge and libWrapper are all on`);
  }
}

// --- verdict ----------------------------------------------------------------

console.log('');
if (!problems.length) {
  console.log('Nothing wrong found on disk.');
  console.log('');
  console.log('If Plutonium is still missing from the module list, Foundry is serving a');
  console.log('cached copy of the manifests: it scans them once and keeps them for the life');
  console.log('of the process, so editing the file changes nothing on its own.');
  console.log('');
  console.log('Drop that cache without restarting: Return to Setup, then in the browser');
  console.log('console on the setup screen run');
  console.log('');
  console.log('  await fetch("setup", { method: "POST",');
  console.log('    headers: { "Content-Type": "application/json" },');
  console.log('    body: JSON.stringify({ action: "resetPackages" }) }).then(r => r.json())');
  console.log('');
  console.log('Reload the page afterwards. Restarting the server does the same thing.');
} else {
  console.log(`${problems.length} problem(s) found.`);
  if (fixes.length) {
    console.log('\nWhat to do:');
    [...new Set(fixes)].forEach((f) => console.log(`  - ${f}`));
  }
}
console.log('');

process.exit(problems.length ? 1 : 0);
