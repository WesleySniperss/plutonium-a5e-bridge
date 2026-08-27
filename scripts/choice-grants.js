import { FLAG_SCOPE, ordinal } from './translate/origins.js';
import { getOrCreatePack, publish } from './grant-linker.js';
import { NAME, error, log } from './util/log.js';

// Some features do not hand you anything — they let you pick. "You learn one
// interdict boon of your choice", "choose a Fighting Style". 5etools keeps the
// things you pick from on a separate page, and the number you get per level in a
// column of the class table, which is rendered as HTML and never as data.
//
// So the options can be imported, but *how many at which level* cannot be read
// from anywhere. That part is stated here and turned into an a5e grant with its
// `options` filled in and a `total` — which is exactly what makes a5e ask.

const OPTION_PACK = ['plutonium-a5e-options', 'Plutonium ⇄ A5E: Options'];

function flagsOf(doc) {
  return doc?.flags?.[FLAG_SCOPE] ?? null;
}

/** Every option this bridge has imported, wherever it ended up. */
export function importedOptions() {
  const seen = new Set();
  const out = [];

  const all = [...game.items];
  for (const actor of game.actors) all.push(...actor.items);

  for (const item of all) {
    const meta = flagsOf(item)?.optionalFeature;
    if (!meta || seen.has(item.uuid)) continue;
    seen.add(item.uuid);
    out.push({ item, meta });
  }
  return out;
}

/** Show what is available to choose between, so a filter can be written. */
export function listOptions(match = '') {
  const pattern = String(match).toLowerCase();

  const rows = importedOptions()
    .filter(({ item, meta }) => !pattern
      || item.name.toLowerCase().includes(pattern)
      || String(meta.group).toLowerCase().includes(pattern))
    .map(({ item, meta }) => ({ name: item.name, group: meta.group || '—', uuid: item.uuid }));

  console.group(`${NAME} — options`);
  if (rows.length) console.table(rows);
  else console.log('None imported. Use api.importOnto(actor, "optional") to bring them in.');
  console.groupEnd();

  return rows;
}

function chosenOptions(match, uuids, names) {
  if (Array.isArray(uuids) && uuids.length) {
    const wanted = new Set(uuids);
    return importedOptions().filter(({ item }) => wanted.has(item.uuid));
  }

  // Names are the practical way in: homebrew rarely fills in the group, so two
  // sets of options arrive from one import looking identical, and the only thing
  // that tells them apart is which list the book prints them under.
  if (Array.isArray(names) && names.length) {
    const wanted = new Set(names.map((n) => String(n).toLowerCase().trim()));
    return importedOptions().filter(({ item }) => wanted.has(item.name.toLowerCase().trim()));
  }

  const pattern = String(match ?? '').toLowerCase();
  if (!pattern) throw new Error('Say which options: pass `names`, `match` or `uuids`.');

  return importedOptions().filter(({ item, meta }) => item.name.toLowerCase().includes(pattern)
    || String(meta.group).toLowerCase().includes(pattern));
}

/**
 * Give a class or archetype a level at which the player picks from a set.
 *
 * @param {string} ownerUuid       the class or archetype
 * @param {object} spec
 * @param {number} spec.level      the class level the choice happens at
 * @param {number} [spec.count=1]  how many to pick
 * @param {string} [spec.match]    name or group substring identifying the options
 * @param {string[]} [spec.names]  or the option names, as the book lists them
 * @param {string[]} [spec.uuids]  or the options themselves, explicitly
 * @param {string} [spec.label]    what the choice is called on the sheet
 * @example
 *   api.addChoiceGrant('Item.abc', { level: 2, count: 1, match: 'boon',
 *                                    label: 'Interdict Boon' });
 */
export async function addChoiceGrant(ownerUuid, {
  level, count = 1, match = '', uuids = null, names = null, label = '',
} = {}) {
  const owner = await fromUuid(ownerUuid);
  if (!owner) throw new Error(`No such item: ${ownerUuid}`);
  if (owner.type !== 'class' && owner.type !== 'archetype') {
    throw new Error(`"${owner.name}" is a "${owner.type}"; a choice belongs on a class or archetype.`);
  }
  if (!Number.isInteger(level) || level < 1 || level > 20) throw new Error('Pass a level between 1 and 20.');

  const options = chosenOptions(match, uuids, names);
  if (!options.length) throw new Error('None of the imported options matched. Try api.listOptions().');

  // Published so the grant points at something stable: a grant that references a
  // loose world item breaks the moment that item is tidied away.
  const pack = await getOrCreatePack(OPTION_PACK);
  const published = [];
  for (const { item, meta } of options) {
    published.push(await publish(pack, item, meta.hash || item.name));
  }

  const _id = foundry.utils.randomID();
  const grant = {
    _id,
    grantType: 'feature',
    level,
    levelType: 'class',
    optional: false,
    img: '',
    label: label || `${ordinal(level)} Level Choice`,
    features: {
      base: [],
      options: published.map((uuid) => ({ uuid, limitedReselection: true, selectionLimit: 1 })),
      // What makes a5e ask rather than hand everything over.
      total: Math.max(1, Number(count) || 1),
    },
  };

  const mine = flagsOf(owner)?.choiceGrantIds ?? [];
  await owner.update({
    [`system.grants.${_id}`]: grant,
    [`flags.${FLAG_SCOPE}.choiceGrantIds`]: [...mine, _id],
  });

  log(`"${owner.name}": level ${level} now picks ${grant.features.total} of ${published.length} option(s).`);
  return grant;
}

/** Remove the choices this bridge added to a class or archetype. */
export async function clearChoiceGrants(ownerUuid) {
  const owner = await fromUuid(ownerUuid);
  if (!owner) throw new Error(`No such item: ${ownerUuid}`);

  const mine = flagsOf(owner)?.choiceGrantIds ?? [];
  const present = mine.filter((id) => owner.system?.grants?.[id]);
  if (!present.length) return 0;

  const ForcedDeletion = foundry?.data?.operators?.ForcedDeletion;
  const update = Object.fromEntries(present.map((id) => (ForcedDeletion
    ? [`system.grants.${id}`, new ForcedDeletion()]
    : [`system.grants.-=${id}`, null])));
  update[`flags.${FLAG_SCOPE}.choiceGrantIds`] = [];

  await owner.update(update);
  log(`Removed ${present.length} choice(s) from "${owner.name}".`);
  return present.length;
}

// A class on an actor is a copy, made when it was dragged across. Editing the
// class in the world sidebar changes nothing for a character who already has it
// — so a choice has to be written to both, and then applied.
//
// a5e will apply it retroactively: `createInitialGrants` walks every grant whose
// level is at or below the current class level and skips the ones already
// recorded, so a grant added after the fact is picked up on the next call
// without disturbing anything that was granted before.

/** The world item and every actor's copy of it, for a class or archetype name. */
export function ownersNamed(name) {
  const wanted = String(name).toLowerCase().trim();
  const isOwner = (i) => (i.type === 'class' || i.type === 'archetype')
    && i.name.toLowerCase().trim() === wanted;

  const out = game.items.filter(isOwner).map((item) => ({ item, actor: null }));
  for (const actor of game.actors) {
    for (const item of actor.items.filter(isOwner)) out.push({ item, actor });
  }
  return out;
}

/**
 * Put the same choice on a class wherever it lives, and apply it to characters
 * who already have that class.
 *
 * @param {string} name  the class or archetype, as it is named on the sheet
 * @param {object} spec  as `addChoiceGrant`
 * @example
 *   api.addChoiceEverywhere('Illrigger', { level: 2, count: 1,
 *                                          names: ['Telekinetic Seal'],
 *                                          label: 'Interdict Boon' });
 */
export async function addChoiceEverywhere(name, spec = {}) {
  const owners = ownersNamed(name);
  if (!owners.length) throw new Error(`Nothing named "${name}" is a class or archetype here.`);

  const done = [];
  for (const { item, actor } of owners) {
    await addChoiceGrant(item.uuid, spec);
    done.push(actor ? `${actor.name}'s copy` : 'the world item');

    if (!actor) continue;
    try {
      await actor.grants?.createInitialGrants?.(actor.items.get(item.id) ?? item);
      log(`a5e applied the new choice to "${actor.name}".`);
    } catch (e) {
      error(`a5e could not apply the new choice to "${actor.name}".`, e);
    }
  }

  log(`"${name}": choice added to ${done.join(', ')}.`);
  return done.length;
}
