import { NAME, log, warn } from './util/log.js';

// "Plutonium is not in my module list" has several possible causes and they look
// identical from the outside. Rather than have people guess, this asks each
// question directly and reports what it found.

const MANIFEST = 'modules/plutonium/module.json';

function route(path) {
  const get = foundry?.utils?.getRoute;
  return typeof get === 'function' ? get(path) : `/${path}`;
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [...value];
}

function listsA5e(relationships) {
  return asArray(relationships?.systems).some((s) => s?.id === 'a5e');
}

/**
 * What systems Plutonium's manifest names.
 *
 * Foundry parses every manifest at startup and ships the result to the client,
 * so the package object is the authority. Fetching the file is only a fallback
 * for when Foundry does not know the package at all — and it must bypass the
 * HTTP cache, or the browser hands back a copy from before the manifest was
 * patched and the diagnosis blames the wrong thing.
 */
async function readSystems(module) {
  if (module?.relationships) {
    return { ok: true, source: 'package data', relationships: module.relationships };
  }

  try {
    const response = await fetch(route(MANIFEST), { cache: 'no-store' });
    if (!response.ok) return { ok: false, status: response.status };
    const manifest = await response.json();
    return { ok: true, source: 'manifest file', relationships: manifest?.relationships, manifest };
  } catch (e) {
    return { ok: false, error: e };
  }
}

const FLAG = 'plutonium-a5e';

/** Every class and archetype this bridge imported, wherever it ended up. */
function importedOrigins() {
  const out = [];
  const seen = new Set();

  const consider = (item) => {
    if (!item || seen.has(item.uuid)) return;
    if (item.type !== 'class' && item.type !== 'archetype') return;
    const flags = item.flags?.[FLAG];
    if (!flags?.class && !flags?.archetype) return;
    seen.add(item.uuid);
    out.push(item);
  };

  for (const item of game.items) consider(item);
  for (const actor of game.actors) for (const item of actor.items) consider(item);
  return out;
}

/**
 * Whether each imported class and archetype actually got its feature grants.
 *
 * This is the question behind "levelling up does nothing". A class hands out its
 * features through `system.grants`; if those are empty, nothing arrives at level
 * 2 and it looks like the bridge does not work at all. It usually means the
 * class was imported before grants existed, or its features were never in the
 * library to point at.
 */
async function inspectImported(findings) {
  const rows = [];

  for (const item of importedOrigins()) {
    const grants = Object.values(item.system?.grants ?? {});
    const featureGrants = grants.filter((g) => g?.grantType === 'feature');
    const levels = featureGrants.map((g) => g.level).sort((a, b) => a - b);

    const row = {
      name: item.name,
      type: item.type,
      uuid: item.uuid,
      on: item.parent?.name ?? 'the item directory',
      classLevels: item.system?.classLevels,
      archetypeLevel: item.system?.archetypeLevel,
      featureGrants: featureGrants.length,
      levels: levels.join(', ') || '—',
      resources: (item.system?.resources ?? []).length,
    };
    rows.push(row);

    if (!featureGrants.length) {
      const rebuild = item.type === 'class' ? 'rebuildClassGrants' : 'rebuildArchetypeGrants';
      findings.problems.push(
        `"${item.name}" has no feature grants, so levelling up adds nothing. `
        + `Rebuild them: game.modules.get('${FLAG}').api.${rebuild}('${item.uuid}')`,
      );
    }
  }

  return rows;
}

/**
 * Work out why Plutonium is not usable, if it is not.
 * @returns {Promise<object>} the findings, also printed to the console
 */
export async function diagnose() {
  const findings = {
    system: game.system.id,
    systemVersion: game.system.version,
    foundry: game.version,
    plutoniumInstalled: false,
    plutoniumListsA5e: null,
    plutoniumActive: false,
    plutoniumApi: false,
    libWrapperActive: !!game.modules.get('lib-wrapper')?.active,
    bridgeVersion: game.modules.get('plutonium-a5e')?.version ?? '?',
    problems: [],
    fix: null,
  };

  const module = game.modules.get('plutonium');
  findings.plutoniumInstalled = !!module;
  findings.plutoniumActive = !!module?.active;
  findings.plutoniumApi = !!(module?.api?.salphar?.UtilDocuments ?? globalThis.plutonium?.salphar?.UtilDocuments);

  const read = await readSystems(module);

  if (!read.ok) {
    // Foundry does not know the package and its manifest is not on disk either.
    findings.problems.push('Plutonium does not appear to be installed — no modules/plutonium/module.json.');
    findings.fix = 'Install Plutonium, then re-run this check.';
  } else {
    findings.plutoniumVersion = module?.version;
    findings.readFrom = read.source;
    findings.plutoniumSystems = asArray(read.relationships?.systems).map((s) => s?.id).filter(Boolean);
    findings.plutoniumListsA5e = listsA5e(read.relationships);

    if (!findings.plutoniumListsA5e) {
      findings.problems.push(
        'Plutonium is installed, but its manifest does not list "a5e" in relationships.systems. '
        + 'Foundry hides a module that does not name the active system, and it decides that before '
        + 'any module code runs — so this cannot be fixed from inside Foundry.',
      );
      findings.fix = [
        'From the Foundry data folder, run:',
        '  node modules/plutonium-a5e/tools/patch-plutonium-manifest.mjs',
        '',
        'Or edit modules/plutonium/module.json by hand and add to relationships.systems:',
        '  { "id": "a5e", "type": "system" }',
        '',
        'Then restart Foundry — not just the browser — and enable Plutonium.',
        'Re-run this after every Plutonium update; an update replaces the manifest.',
      ].join('\n');
    }
  }

  if (findings.system !== 'a5e') {
    findings.problems.push(`The active system is "${findings.system}", not "a5e" — the bridge stays idle.`);
  }
  if (!findings.libWrapperActive) {
    findings.problems.push('libWrapper is not active. Plutonium requires it and will refuse to start.');
  }
  if (findings.plutoniumInstalled && !findings.plutoniumActive && findings.plutoniumListsA5e) {
    findings.problems.push(
      `Plutonium is installed and its manifest is correct (${findings.plutoniumSystems.join(', ')}), `
      + 'but it is not enabled in this world. Switch it on in Manage Modules.',
    );
    findings.fix ??= [
      'Settings → Manage Modules → tick Plutonium → Save Module Settings.',
      '',
      'If it is not in that list at all, the Foundry *server* has probably not been',
      'restarted since the manifest was changed — quit Foundry entirely and start it',
      'again; reloading the browser is not enough.',
      '',
      'To check the install from outside Foundry, run in the Foundry data folder:',
      '  node modules/plutonium-a5e/tools/doctor.mjs',
    ].join('\n');
  }
  if (findings.plutoniumActive && !findings.plutoniumApi) {
    findings.problems.push(
      'Plutonium is enabled but never finished starting — its API is missing. '
      + 'Look for an error logged with the "Plutonium" tag.',
    );
  }

  findings.imported = await inspectImported(findings);

  console.group(`${NAME} — diagnosis`);
  console.log(findings);
  if (findings.imported.length) {
    console.log('Imported classes and archetypes:');
    console.table(findings.imported);
  }
  if (!findings.problems.length) console.log('%cNothing wrong found.', 'color: #4caf50; font-weight: bold;');
  else findings.problems.forEach((p) => console.warn(p));
  if (findings.fix) console.info(`\nHow to fix it:\n${findings.fix}`);
  console.groupEnd();

  return findings;
}

/**
 * Run on startup when Plutonium is not usable, so the reason reaches the GM
 * instead of only the console.
 */
export async function reportIfBroken() {
  if (!game.user.isGM) return;

  const module = game.modules.get('plutonium');
  if (module?.active) return;

  const findings = await diagnose();
  const headline = findings.problems[0] ?? 'Plutonium is not enabled.';

  ui.notifications.warn(
    `${NAME}: ${headline} Run game.modules.get('plutonium-a5e').api.diagnose() for the details.`,
    { permanent: true },
  );
  log('Run api.diagnose() for the full report.');
  warn(headline);
}
