import { error, log, warn } from './util/log.js';

// Plutonium's sheet buttons hang off dnd5e's character sheet class, which under
// a5e is the stub this bridge installs — so they are inert, and the "import onto
// this character" route its own docs recommend is simply not there.
//
// The importer itself does not care: `ChooseImporter.pOpen({actor, modeId})` is
// exactly what those buttons call, and it works with any actor. What is missing
// is somewhere to press. The actor directory's context menu is a core Foundry
// hook, so it works whatever a5e builds its sheet out of.

const MODES = {
  class: { id: 'classes-subclasses', label: 'class or subclass' },
  feature: { id: 'classes-subclasses-features', label: 'class or subclass features' },
  optional: { id: 'other-options-and-features', label: 'options and other features' },
  spell: { id: 'spells', label: 'spells' },
  item: { id: 'items', label: 'items' },
  feat: { id: 'feats', label: 'feats' },
};

function importerApi() {
  return game.modules.get('plutonium')?.api?.importer ?? null;
}

/**
 * Open Plutonium's importer aimed at one actor — the character-sheet route,
 * reachable under a5e.
 *
 * @param {Actor|string} actor  the actor, or its id or uuid
 * @param {string} what         which importer: class, feature, optional, spell, item, feat
 */
export async function importOnto(actor, what = 'class') {
  const api = importerApi();
  if (!api?.pOpen) throw new Error('Plutonium exposes no importer API — is it enabled?');

  const target = actor instanceof Actor
    ? actor
    : (game.actors.get(actor) ?? await fromUuid(actor));
  if (!target) throw new Error(`No such actor: ${actor}`);

  const mode = MODES[what];
  if (!mode) throw new Error(`Unknown importer "${what}". One of: ${Object.keys(MODES).join(', ')}`);

  log(`Opening Plutonium's ${mode.label} importer for "${target.name}".`);
  return api.pOpen({ actor: target, modeId: mode.id });
}

/**
 * Put that on the actor directory's right-click menu.
 *
 * Both key spellings are given: Foundry 14 renamed `name` to `label` and
 * `condition` to `visible`, and still accepts the old pair — passing both keeps
 * one entry working either side of that change without a version check.
 */
export function installActorImportMenu() {
  Hooks.on('getActorContextOptions', (_app, options) => {
    const entry = {
      name: 'Import onto this actor (Plutonium)',
      label: 'Import onto this actor (Plutonium)',
      icon: '<i class="fas fa-fw fa-download"></i>',
      condition: canImport,
      visible: canImport,
      callback: (li) => {
        const actor = actorFrom(li);
        if (actor) importOnto(actor, 'class').catch((e) => error('Could not open the importer.', e));
      },
    };

    options.push(entry);
  });

  log('Added "Import onto this actor" to the actor directory menu.');
}

function actorFrom(li) {
  const id = li?.getAttribute?.('data-entry-id') ?? li?.dataset?.entryId ?? li?.dataset?.documentId;
  return id ? game.actors.get(id) : null;
}

function canImport(li) {
  if (!importerApi()?.pOpen) return false;
  const actor = actorFrom(li);
  return !!actor?.isOwner && actor.type === 'character';
}

/** Warn once if Plutonium is present but its importer API is not. */
export function checkImporterApi() {
  if (!game.modules.get('plutonium')?.active) return;
  if (importerApi()?.pOpen) return;
  warn('Plutonium is active but exposes no importer API — "import onto this actor" will not work.');
}
