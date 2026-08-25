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

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const doFix = args.includes('--fix');
const dataArg = args[args.indexOf('--data') + 1];

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

/**
 * Modules live at <userData>/Data/modules/<id>, so from this file the user-data
 * root is four levels up. `--data` overrides it, and Config/options.json is
 * consulted in case Foundry was pointed somewhere else entirely.
 */
function findModulesDir() {
  if (dataArg) {
    const fromArg = resolve(dataArg);
    for (const candidate of [join(fromArg, 'Data', 'modules'), join(fromArg, 'modules')]) {
      if (existsSync(candidate)) return candidate;
    }
    console.error(`No modules folder under ${fromArg}`);
    process.exit(1);
  }

  const guess = resolve(here, '..', '..');
  if (existsSync(join(guess, 'plutonium-a5e'))) {
    // Foundry may be configured to read a different folder than the one we sit in.
    const options = readJson(resolve(guess, '..', '..', 'Config', 'options.json'));
    const configured = options?.dataPath ? join(options.dataPath, 'Data', 'modules') : null;
    if (configured && existsSync(configured) && resolve(configured) !== resolve(guess)) {
      info(`Foundry is configured to read ${configured}, not ${guess} — checking both.`);
      return configured;
    }
    return guess;
  }

  console.error('Could not work out where the modules folder is.');
  console.error('Run this from inside the installed module, or pass --data <Foundry user data folder>.');
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
      fixes.push('Restart the Foundry server — not just the browser — then enable Plutonium.');
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
  console.log('If Plutonium is still missing from the module list, the usual reason is that');
  console.log('the Foundry *server* has not been restarted since the manifest changed —');
  console.log('reloading the browser is not enough. Quit Foundry completely and start it again.');
} else {
  console.log(`${problems.length} problem(s) found.`);
  if (fixes.length) {
    console.log('\nWhat to do:');
    [...new Set(fixes)].forEach((f) => console.log(`  - ${f}`));
  }
}
console.log('');

process.exit(problems.length ? 1 : 0);
