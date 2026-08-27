import { debug, warn } from './util/log.js';

// Plutonium's class importer reads a character's existing proficiencies straight
// out of the dnd5e actor source, and two of the four readers assume they found
// something:
//
//   existingProfsActor: MiscUtil.get(importOpts.actor, "_source", "system", "tools"),
//   …
//   const maxValue = Math.max((existingProfsActor[abv] || {}).value || 0, …);
//
// a5e has no `system.tools` — it keeps tool proficiency as a plain array under
// `system.proficiencies.tools` — so that read yields undefined and the import
// dies with "Cannot read properties of undefined (reading 'thief')" the moment a
// class grants a tool. Rogue does at 1st level, which is why it never imported.
//
// The weapon and armour readers survive the same gap because they open with
// `MiscUtil.copyFast(existingProfsActor || {})`. Only skills and tools share the
// version that dereferences first, and a5e does have `system.skills`.
//
// So the missing shape is supplied, non-enumerably: `deepClone` and `toObject`
// walk own *enumerable* keys, so this never reaches the database, is never
// written back, and shows up nowhere on the sheet. It exists purely so a read
// that expects dnd5e finds an empty answer instead of nothing at all.

const SHIMMED = ['tools'];

function stamp(actor) {
  const source = actor?._source?.system;
  if (!source) return;

  for (const key of SHIMMED) {
    if (key in source) continue;
    try {
      Object.defineProperty(source, key, {
        value: {},
        enumerable: false,
        configurable: true,
        writable: true,
      });
    } catch {
      // A sealed source: nothing to do, and not worth throwing over.
      return;
    }
  }
}

let installed = false;

/**
 * Give character actors the dnd5e-shaped proficiency fields Plutonium reads
 * before it creates anything, so its class importer does not fault on a5e.
 */
export function installActorShim() {
  if (installed) return true;

  const cls = CONFIG.Actor?.documentClass;
  if (!cls?.prototype?.prepareData) {
    warn('Could not shim actor proficiencies — Plutonium may fail to import classes that grant tools.');
    return false;
  }

  const orig = cls.prototype.prepareData;

  // `prepareData` runs on construction and after every change, which is what
  // makes it the reliable place: a source rebuilt by an update gets stamped
  // again before anything can read it.
  cls.prototype.prepareData = function prepareData(...args) {
    const result = orig.apply(this, args);
    if (this.type === 'character') stamp(this);
    return result;
  };

  for (const actor of game.actors ?? []) {
    if (actor.type === 'character') stamp(actor);
  }

  installed = true;
  debug('Actor proficiency shim installed.');
  return true;
}
