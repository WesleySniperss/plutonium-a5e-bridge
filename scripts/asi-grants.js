import { FLAG_SCOPE, ordinal } from './translate/origins.js';
import { debug, log } from './util/log.js';

// The ability score increase is not something a5e automates from the level
// number — it is carried by the class, as grants. Read straight out of the
// system's own `a5e-classes` pack, every class but three holds ten of them:
//
//   { grantType: "ability", level: 4, levelType: "class", optional: true,
//     label: "4th Level ASI (1st Point)", bonus: "1",
//     abilities: { options: ["str","dex","con","int","wis","cha"], total: 1, base: [] },
//     context: { types: ["base"], requiresProficiency: false, default: true },
//     img: "" }
//
// Two per level, one per point, at 4/8/12/16/19 — 27 of the 30 classes exactly
// so. An imported class has none of them, and dnd5e's own "Ability Score
// Improvement" feature arrives instead, which does nothing under a5e. That is
// the whole reason a5e's own classes offered an ASI or feat at 4th level and an
// imported one did not.

const ASI_LEVELS = [4, 8, 12, 16, 19];
const POINTS_PER_LEVEL = 2;
const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

function abilityGrant(level, point) {
  const _id = foundry.utils.randomID();
  return {
    _id,
    grantType: 'ability',
    level,
    levelType: 'class',
    // Optional, because the point can be spent on a feat instead.
    optional: true,
    label: `${ordinal(level)} Level ASI (${ordinal(point)} Point)`,
    bonus: '1',
    abilities: { options: [...ABILITIES], total: 1, base: [] },
    context: { types: ['base'], requiresProficiency: false, default: true },
    img: '',
  };
}

function buildAsiGrants() {
  const grants = {};
  for (const level of ASI_LEVELS) {
    for (let point = 1; point <= POINTS_PER_LEVEL; point += 1) {
      const grant = abilityGrant(level, point);
      grants[grant._id] = grant;
    }
  }
  return grants;
}

function hasAbilityGrants(item) {
  return Object.values(item?.system?.grants ?? {}).some((g) => g?.grantType === 'ability');
}

/**
 * Give a class the ability-score grants a5e's own classes carry.
 *
 * Does nothing when the class already has some — a5e's native classes do, and so
 * does one this has already been run on, so it is safe to call again.
 *
 * @param {Item} item  a class item, in the world or on an actor
 * @returns {Promise<boolean>} whether anything was added
 */
export async function ensureAsiGrants(item) {
  if (item?.type !== 'class') return false;
  if (hasAbilityGrants(item)) {
    debug(`"${item.name}" already has ability grants; left alone.`);
    return false;
  }

  const grants = buildAsiGrants();
  await item.update({
    'system.grants': grants,
    [`flags.${FLAG_SCOPE}.asiGrantIds`]: Object.keys(grants),
  });

  log(`"${item.name}": ASI grants added at level ${ASI_LEVELS.join(', ')}.`);
  return true;
}

/** Every imported class in the world and on actors, so none is missed. */
function importedClasses() {
  const seen = new Set();
  const out = [];

  const consider = (item) => {
    if (item?.type !== 'class' || seen.has(item.uuid)) return;
    if (!item.flags?.[FLAG_SCOPE]?.class) return;
    seen.add(item.uuid);
    out.push(item);
  };

  for (const item of game.items) consider(item);
  for (const actor of game.actors) for (const item of actor.items) consider(item);
  return out;
}

/**
 * Bring every imported class up to what a5e's own classes offer.
 * @returns {Promise<number>} how many classes gained the grants
 */
export async function addAsiGrants() {
  let added = 0;
  for (const item of importedClasses()) {
    try {
      if (await ensureAsiGrants(item)) added += 1;
    } catch (e) {
      debug(`Could not add ASI grants to "${item.name}": ${e.message}`);
    }
  }
  return added;
}
