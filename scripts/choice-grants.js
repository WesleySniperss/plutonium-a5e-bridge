import { FLAG_SCOPE, ordinal } from './translate/origins.js';
import { getOrCreatePack, publish } from './grant-linker.js';
import { NAME, log } from './util/log.js';

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

function chosenOptions(match, uuids) {
  if (Array.isArray(uuids) && uuids.length) {
    const wanted = new Set(uuids);
    return importedOptions().filter(({ item }) => wanted.has(item.uuid));
  }

  const pattern = String(match ?? '').toLowerCase();
  if (!pattern) throw new Error('Say which options: pass `match` or `uuids`.');

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
 * @param {string[]} [spec.uuids]  or the options themselves, explicitly
 * @param {string} [spec.label]    what the choice is called on the sheet
 * @example
 *   api.addChoiceGrant('Item.abc', { level: 2, count: 1, match: 'boon',
 *                                    label: 'Interdict Boon' });
 */
export async function addChoiceGrant(ownerUuid, {
  level, count = 1, match = '', uuids = null, label = '',
} = {}) {
  const owner = await fromUuid(ownerUuid);
  if (!owner) throw new Error(`No such item: ${ownerUuid}`);
  if (owner.type !== 'class' && owner.type !== 'archetype') {
    throw new Error(`"${owner.name}" is a "${owner.type}"; a choice belongs on a class or archetype.`);
  }
  if (!Number.isInteger(level) || level < 1 || level > 20) throw new Error('Pass a level between 1 and 20.');

  const options = chosenOptions(match, uuids);
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
