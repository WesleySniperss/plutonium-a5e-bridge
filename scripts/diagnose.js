import { NAME, log, warn } from './util/log.js';

// "Plutonium is not in my module list" has several possible causes and they look
// identical from the outside. Rather than have people guess, this asks each
// question directly and reports what it found.

const MANIFEST = 'modules/plutonium/module.json';

function route(path) {
  const get = foundry?.utils?.getRoute;
  return typeof get === 'function' ? get(path) : `/${path}`;
}

/** Read Plutonium's manifest over Foundry's own file route. */
async function readPlutoniumManifest() {
  try {
    const response = await fetch(route(MANIFEST));
    if (!response.ok) return { ok: false, status: response.status };
    return { ok: true, manifest: await response.json() };
  } catch (e) {
    return { ok: false, error: e };
  }
}

function listsA5e(manifest) {
  const systems = manifest?.relationships?.systems ?? [];
  return systems.some((s) => s?.id === 'a5e');
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

  const read = await readPlutoniumManifest();

  if (!read.ok) {
    // The manifest is served by Foundry itself, so a miss means it is not on disk.
    findings.problems.push('Plutonium does not appear to be installed — no modules/plutonium/module.json.');
    findings.fix = 'Install Plutonium, then re-run this check.';
  } else {
    findings.plutoniumVersion = read.manifest?.version;
    findings.plutoniumListsA5e = listsA5e(read.manifest);

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
      'Plutonium is installed and visible to this world, but not enabled. '
      + 'Turn it on in Manage Modules.',
    );
  }
  if (findings.plutoniumActive && !findings.plutoniumApi) {
    findings.problems.push(
      'Plutonium is enabled but never finished starting — its API is missing. '
      + 'Look for an error logged with the "Plutonium" tag.',
    );
  }

  console.group(`${NAME} — diagnosis`);
  console.log(findings);
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
