import { FLAG_SCOPE } from './translate/origins.js';
import { ID, debug, log } from './util/log.js';

// a5e gives every creature the same six combat manoeuvres — Disarm, Grab On,
// Grapple, Knockdown, Overrun and Shove. They are not a class feature or a
// monster trait; they are what anyone can attempt, so the system's own
// conversion puts them on all 324 of its dnd5e monsters, the identical set every
// time. A statblock never mentions them, so an import cannot learn of them: they
// have to be added, or an imported monster is missing options a native one has.
//
// They are picked out by rule rather than by id: in a5e's `maneuvers` pack, the
// universal ones are exactly those of degree 0 with no tradition — 6 of 416,
// against 92 at first degree and up. That survives the pack being reissued with
// new ids, which a hardcoded list would not.

const MANEUVER_PACK = 'a5e.a5e-maneuvers';

function isUniversal(entry) {
  return Number(entry?.system?.degree) === 0 && !entry?.system?.tradition;
}

// Held against the pack it was read from rather than on its own: importing a
// hundred creatures should not re-read the compendium a hundred times, but a
// cache that outlives its source is a cache that goes stale silently.
let cached = null;
let cachedFrom = null;

/** The manoeuvres anyone can attempt, straight from the system's own pack. */
export async function universalManeuvers() {
  const pack = game.packs?.get(MANEUVER_PACK);
  if (cached && cachedFrom === pack) return cached;

  if (!pack) {
    debug(`No "${MANEUVER_PACK}" compendium — common manoeuvres will not be added.`);
    return [];
  }

  const index = await pack.getIndex({ fields: ['name', 'type', 'system.degree', 'system.tradition'] });
  const wanted = [...index].filter((entry) => entry.type === 'maneuver' && isUniversal(entry));

  const found = [];
  for (const entry of wanted) {
    const doc = await pack.getDocument(entry._id);
    if (doc) found.push(doc);
  }

  cached = found;
  cachedFrom = pack;
  return cached;
}

function enabled() {
  try {
    return game.settings.get(ID, 'commonManeuvers');
  } catch {
    return true;
  }
}

function existing(actor) {
  return new Set(actor.items.filter((i) => i.type === 'maneuver').map((i) => i.name));
}

/**
 * Give an actor the manoeuvres anyone can attempt.
 *
 * Skips any it already has by name, so re-importing the same creature does not
 * hand it a second Grapple.
 *
 * @returns {Promise<number>} how many were added
 */
export async function addCommonManeuvers(actor) {
  if (actor?.documentName !== 'Actor') return 0;

  const known = existing(actor);
  const missing = (await universalManeuvers()).filter((m) => !known.has(m.name));
  if (!missing.length) return 0;

  const payload = missing.map((m) => {
    const data = m.toObject();
    delete data._id;
    foundry.utils.setProperty(data, `flags.${FLAG_SCOPE}.commonManeuver`, true);
    return data;
  });

  await actor.createEmbeddedDocuments('Item', payload, { keepId: false });
  return payload.length;
}

/** Called for every actor an import creates. */
export async function addCommonManeuversTo(created) {
  if (!enabled() || !game.user?.isGM) return;

  for (const entry of [created].flat()) {
    const doc = entry?.documentName ? entry : entry?.document;
    if (doc?.documentName !== 'Actor' || doc.type !== 'npc') continue;

    try {
      const added = await addCommonManeuvers(doc);
      if (added) debug(`Gave "${doc.name}" ${added} common manoeuvre(s).`);
    } catch (e) {
      debug(`Could not add common manoeuvres to "${doc.name}": ${e.message}`);
    }
  }
}

/** Bring monsters imported before this existed up to the same. */
export async function backfillCommonManeuvers() {
  let touched = 0;
  for (const actor of game.actors) {
    if (actor.type !== 'npc') continue;
    if (!actor.flags?.[FLAG_SCOPE]?.converted) continue;

    try {
      if (await addCommonManeuvers(actor)) touched += 1;
    } catch (e) {
      debug(`Could not backfill "${actor.name}": ${e.message}`);
    }
  }

  if (touched) log(`Gave ${touched} imported creature(s) the common manoeuvres.`);
  return touched;
}
