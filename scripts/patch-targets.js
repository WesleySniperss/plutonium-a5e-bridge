import { error, log, warn } from './util/log.js';

// `Patcher_ActorSheet.init()` registers three libWrapper patches against
// `game.system.applications.actor.CharacterActorSheet.prototype` — dnd5e's
// character sheet. a5e has no such class, libWrapper refuses to patch a target
// it cannot resolve, and the throw takes down the rest of Plutonium's
// `handleReady()` with it: every importer, the Handlebars templates, its API.
//
// Intercepting libWrapper is not an option. It freezes its own class and then
// installs itself as a non-configurable global with a setter that throws:
//
//   Object.freeze(lw); delete globalThis.libWrapper;
//   Object.defineProperty(globalThis, "libWrapper", {
//     get: () => lw, set: () => { throw ... }, configurable: false });
//
// So instead of stopping the patch, we give it something to patch. The stub is a
// class a5e never instantiates, so the wrappers register and then sit idle.
//
// Everything else Plutonium patches is either core Foundry, or already behind
// its own `game.system.id !== "dnd5e"` check — including the facility data model
// and the spell-list registry, both of which sit inside guarded classes.

class CharacterActorSheetStub {
  async _onDrop() {}

  _initializeApplicationOptions(options) { return options; }

  async _onDropCreateItems() { return []; }
}

const created = [];

/** Names of the stubs this session installed, for troubleshooting. */
export function getInstalledStubs() {
  return [...created];
}

/**
 * Must run before Plutonium's `Patcher.init()`, which happens in its `ready`
 * handler — so `init` is early enough and `game.system` already exists.
 */
export function installPatchTargets() {
  if (game.system?.id !== 'a5e') return;

  try {
    const applications = (game.system.applications ??= {});
    const actorApps = (applications.actor ??= {});

    if (!actorApps.CharacterActorSheet) {
      actorApps.CharacterActorSheet = CharacterActorSheetStub;
      created.push('game.system.applications.actor.CharacterActorSheet');
    }
  } catch (e) {
    error(
      'Could not create the sheet stub Plutonium patches — its startup will fail. '
      + 'Report this with the message below.',
      e,
    );
    return;
  }

  if (created.length) log(`Created ${created.length} stub patch target(s) for Plutonium.`);
  else warn('Plutonium’s patch targets already existed — nothing stubbed.');
}
