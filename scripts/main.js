import {
  adoptExistingFeatures,
  openFeatureImporter,
  verifyGrants,
  linkPending,
  rebuildArchetypeGrants,
  rebuildClassGrants,
  scheduleLink,
} from './grant-linker.js';
import { installPlutoniumBridge } from './bridge.js';
import { diagnose, report, reportIfBroken } from './diagnose.js';
import { repairUseConsumers } from './repair.js';
import { runMigrations } from './migrate.js';
import { applyClassManeuvers, maneuverTemplates, setClassManeuvers } from './mancer-classes.js';
import {
  checkImporterApi,
  importOnto,
  installActorImportMenu,
  installSheetImportButton,
} from './actor-import.js';
import { getUnmappedConfigPaths, installDnd5eGameShim, installDnd5eShim } from './config-shim.js';
import { getInstalledStubs, installPatchTargets } from './patch-targets.js';
import { registerSettings } from './settings.js';
import { ID, log, warn } from './util/log.js';
import { translateDocument } from './translate/index.js';

// `CONFIG.DND5E` has to be there before anything Plutonium runs reads it, and
// Plutonium's module script sorts ahead of ours by id. Module scripts all
// execute before the `init` hook, so this is still early enough: the first
// thing Plutonium does with the config is in its own `init` handler.
installDnd5eShim();

Hooks.once('init', () => {
  registerSettings();
  installDnd5eGameShim();

  // The dnd5e-only sheet class Plutonium libWraps is only needed by
  // `Patcher.init()`, which runs in its `ready` handler — `init` is early enough.
  installPatchTargets();

  // Plutonium assigns its API at import time, so the bridge can go in this early
  // — well before the first import can possibly be started.
  installPlutoniumBridge();
});

Hooks.once('ready', () => {
  if (game.system.id !== 'a5e') return;

  // Expose the diagnosis first: when Plutonium is missing, that is the one call
  // worth having available.
  game.modules.get(ID).api = { diagnose, report };

  if (!game.modules.get('plutonium')?.active) {
    reportIfBroken();
    return;
  }

  // Late retry, in case Plutonium was loaded in an unusual order.
  installPlutoniumBridge();

  // Plutonium assigns its `api` at the very end of its own `ready` handler. That
  // handler is async and one long sequential chain, so if anything in it threw,
  // `api` is missing — a reliable signal that its startup did not finish. The
  // object itself exists from import time, so hand it over regardless.
  const plutonium = game.modules.get('plutonium');
  if (!plutonium.api && globalThis.plutonium) {
    plutonium.api = globalThis.plutonium;
    warn(
      'Plutonium did not finish its own startup — its importers and UI may be incomplete. '
      + 'Check the console for an error logged with the "Plutonium" tag.',
    );
  }

  // An archetype's grants can only be wired up once the import has produced the
  // feature documents they point at.
  const api = plutonium.api;
  if (api?.hooks?.on) api.hooks.on('importComplete', () => scheduleLink());
  else warn('Plutonium exposes no hooks API — archetype grants will need a manual rebuild.');

  game.modules.get(ID).api = {
    diagnose,
    report,
    translateDocument,
    getUnmappedConfigPaths,
    getInstalledStubs,
    installPlutoniumBridge,
    adoptExistingFeatures,
    openFeatureImporter,
    verifyGrants,
    importOnto,
    setClassManeuvers,
    maneuverTemplates,
    repairUseConsumers,
    rebuildArchetypeGrants,
    rebuildClassGrants,
    linkPending,
  };

  // Bring a world imported by an older bridge up to what this one produces.
  runMigrations();

  // Teach a5e-mancer about any imported classes the GM has given maneuvers to.
  applyClassManeuvers();

  // Plutonium's own sheet buttons cannot appear under a5e; give the importer
  // another way in.
  installSheetImportButton();
  installActorImportMenu();
  checkImporterApi();

  log('Ready.');
});
