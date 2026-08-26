import { ID, error, log, warn } from './util/log.js';

// a5e-mancer decides whether a class gets combat maneuvers by looking its name
// up in a table it ships:
//
//   const table = CLASS_MANEUVER_TABLES[key];
//   if (!table) return null;
//
// That table lists a5e's own classes. An imported class is not in it, so the
// maneuver step never appears — and it cannot be derived, because 5e has no
// maneuvers at all: no traditions, no degrees, no "known at level N" column.
// Someone has to decide what an imported class should get.
//
// The table is a plain exported object that mancer itself adds to at load time,
// so entries can simply be added to it. That keeps the decision here, as world
// data, rather than as an edit inside a5e-mancer.

const MANEUVER_SERVICE = 'modules/a5e-mancer/scripts/utils/maneuverService.js';

function route(path) {
  const get = foundry?.utils?.getRoute;
  return typeof get === 'function' ? get(path) : `/${path}`;
}

async function maneuverTables() {
  if (!game.modules.get('a5e-mancer')?.active) return null;

  try {
    const module = await import(route(MANEUVER_SERVICE));
    return module?.CLASS_MANEUVER_TABLES ?? null;
  } catch (e) {
    warn('Could not reach a5e-mancer\'s maneuver tables — its layout may have changed.', e);
    return null;
  }
}

function setting() {
  try {
    return game.settings.get(ID, 'classManeuvers') ?? {};
  } catch {
    return {};
  }
}

/**
 * Turn one configured entry into a table mancer understands.
 *
 * `basedOn` copies another class's progression, which is the honest way to do
 * this: pick the a5e class the imported one is closest to and say so, rather
 * than inventing a column of numbers. Anything given explicitly wins.
 */
function resolve(entry, tables) {
  const base = entry.basedOn ? tables[String(entry.basedOn).toLowerCase()] : null;
  if (entry.basedOn && !base) throw new Error(`no class "${entry.basedOn}" to base it on`);

  const table = {
    traditions: entry.traditions ?? base?.traditions ?? 2,
    allowedTraditions: entry.allowedTraditions ?? base?.allowedTraditions ?? null,
    maneuversKnown: entry.maneuversKnown ?? base?.maneuversKnown,
    maxDegree: entry.maxDegree ?? base?.maxDegree,
  };

  if (!Array.isArray(table.maneuversKnown) || !Array.isArray(table.maxDegree)) {
    throw new Error('needs either basedOn, or both maneuversKnown and maxDegree');
  }
  return table;
}

/** Add every configured class to a5e-mancer's maneuver table. */
export async function applyClassManeuvers() {
  const configured = setting();
  const slugs = Object.keys(configured);
  if (!slugs.length) return;

  const tables = await maneuverTables();
  if (!tables) return;

  const added = [];
  for (const slug of slugs) {
    try {
      tables[slug.toLowerCase()] = resolve(configured[slug], tables);
      added.push(slug);
    } catch (e) {
      error(`Cannot give "${slug}" maneuvers — ${e.message}.`);
    }
  }

  if (added.length) log(`a5e-mancer will offer maneuvers to: ${added.join(', ')}.`);
}

/** The a5e classes whose progression can be copied. */
export async function maneuverTemplates() {
  const tables = await maneuverTables();
  return tables ? Object.keys(tables).sort() : [];
}

/**
 * Give an imported class combat maneuvers in a5e-mancer.
 *
 * @param {string} slug     the class's slug, as `system.slug` has it
 * @param {object} entry    { basedOn } and/or { traditions, allowedTraditions,
 *                          maneuversKnown, maxDegree }; null removes it
 * @example
 *   api.setClassManeuvers('illrigger', {
 *     basedOn: 'herald',
 *     allowedTraditions: ['sanguineKnot', 'temperedIron', 'adamantMountain'],
 *   });
 */
export async function setClassManeuvers(slug, entry) {
  if (!slug) throw new Error('Which class? Pass its slug.');

  const key = String(slug).toLowerCase();
  const configured = { ...setting() };

  if (entry === null) delete configured[key];
  else configured[key] = entry;

  await game.settings.set(ID, 'classManeuvers', configured);
  await applyClassManeuvers();

  log(entry === null
    ? `"${key}" will no longer be offered maneuvers.`
    : `"${key}" configured for maneuvers. Reopen the level-up dialog to see it.`);

  return configured;
}
