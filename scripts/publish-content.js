import { FLAG_SCOPE } from './translate/origins.js';
import { getOrCreatePack, publish } from './grant-linker.js';
import { ID, debug, log } from './util/log.js';

// Everything a5e offers you — the compendium browser, the archetype choice at
// level-up, a5e-mancer's spell and feat pickers — reads compendiums, never the
// sidebar. a5e's own archetype chooser says so plainly:
//
//   return game.packs.reduce((t, n) => {
//     if (n.metadata.type !== "Item") return t;
//     let i = n.index.reduce((t, n) => (n.type !== "archetype"
//       || n.system?.class !== e || t.push([n.uuid, n.name || ""]), t), []);
//
// It walks every Item pack, world ones included, so imported content only has
// to be *in* a compendium to be found. Classes, archetypes, their features and
// feats were already published; spells and objects were not, which is why an
// imported spell never showed up anywhere but the sidebar.

const CONTENT_PACKS = {
  spell: ['plutonium-a5e-spells', 'Plutonium ⇄ A5E: Spells'],
  object: ['plutonium-a5e-objects', 'Plutonium ⇄ A5E: Items'],
};

// What a5e puts in a pack's index, per document type, read from its own
// `FIELD_MAPPINGS`. Indexing with the wrong fields is not an error — the entries
// simply arrive without the values every filter reads, so the browser shows them
// and no filter matches.
const INDEX_FIELDS = {
  archetype: ['system.description', 'system.class', 'system.source'],
  feature: [
    'system.asi', 'system.description', 'system.classes', 'system.concentration',
    'system.featClasses', 'system.featType', 'system.featureType',
    'system.prerequisite', 'system.source', 'system.synergy',
  ],
  maneuver: [
    'system.description', 'system.exertionCost', 'system.concentration',
    'system.degree', 'system.isStance', 'system.source', 'system.tradition',
  ],
  spell: [
    'system.concentration', 'system.components', 'system.classes',
    'system.description', 'system.level', 'system.rare', 'system.ritual',
    'system.schools', 'system.source',
  ],
  object: [
    'system.requiresAttunement', 'system.bulky', 'system.objectType',
    'system.description', 'system.price', 'system.quantity', 'system.rarity',
    'system.source',
  ],
  generic: ['system.source', 'system.description'],
};

function enabled() {
  try {
    return game.settings.get(ID, 'publishArchetypes');
  } catch {
    return true;
  }
}

function mostFrequentType(pack) {
  const counts = {};
  for (const entry of pack.index) {
    if (entry?.type) counts[entry.type] = (counts[entry.type] ?? 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/**
 * Re-read a pack's index with the fields a5e's filters expect.
 *
 * a5e indexes every compendium once, in its `setup` hook — long before an import
 * has created ours. Without this a pack published mid-session stays invisible
 * until the world is reloaded, which is exactly what "it imported but nothing
 * finds it" looks like.
 */
export async function reindexPack(pack) {
  if (!pack) return;

  try {
    const type = mostFrequentType(pack);
    await pack.getIndex({ fields: INDEX_FIELDS[type] ?? INDEX_FIELDS.generic });
    pack.initializeTree?.();
    debug(`Re-indexed "${pack.metadata.label}" as ${type ?? 'generic'}.`);
  } catch (e) {
    debug(`Could not re-index "${pack?.metadata?.label}": ${e.message}`);
  }
}

function libraryKeyOf(item) {
  const flags = item.flags?.[FLAG_SCOPE] ?? {};
  return flags.spell?.hash || flags.object?.hash || flags.hash
    || item.flags?.plutonium?.hash || item.name;
}

/** Imported items of a kind this publishes, wherever they are in the world. */
function importedOfType(type) {
  return game.items.filter((item) => item.type === type && item.flags?.[FLAG_SCOPE]);
}

/**
 * Copy imported items into the compendium for their type.
 *
 * Safe to run again: `publish` matches on the library key and updates in place
 * rather than leaving a second copy for the grants to fight over.
 *
 * @param {Item[]} items  items of one type
 * @returns {Promise<number>} how many were published
 */
export async function publishItems(items) {
  const byType = new Map();
  for (const item of items) {
    if (!CONTENT_PACKS[item.type]) continue;
    if (!byType.has(item.type)) byType.set(item.type, []);
    byType.get(item.type).push(item);
  }
  if (!byType.size) return 0;

  let published = 0;
  for (const [type, list] of byType) {
    const pack = await getOrCreatePack(CONTENT_PACKS[type]);

    for (const item of list) {
      try {
        await publish(pack, item, libraryKeyOf(item));
        published += 1;
      } catch (e) {
        debug(`Could not publish "${item.name}": ${e.message}`);
      }
    }

    await reindexPack(pack);
  }

  return published;
}

/** Publish what an import just created, and say so once. */
export async function publishImportedContent(created) {
  if (!enabled() || !game.user?.isGM) return 0;

  const fresh = [created].flat()
    .map((entry) => (entry?.documentName ? entry : entry?.document))
    .filter((doc) => doc?.documentName === 'Item' && !doc.parent && CONTENT_PACKS[doc.type]);

  if (!fresh.length) return 0;

  const published = await publishItems(fresh);
  if (published) {
    ui.notifications.info(
      `Plutonium ⇄ A5E: ${published} item(s) published to a compendium, where the browser and `
      + 'the character builder look.',
    );
  }
  return published;
}

/**
 * Publish everything already imported into this world, and re-index the
 * module's compendiums so a5e sees the lot without a reload.
 *
 * @returns {Promise<number>} how many documents were published
 */
export async function publishAll() {
  let published = 0;
  for (const type of Object.keys(CONTENT_PACKS)) {
    published += await publishItems(importedOfType(type));
  }

  // The packs written by the linker and by the feat publisher were indexed when
  // a5e started, if they existed at all; bring them up to date too.
  for (const pack of game.packs) {
    if (pack.collection?.startsWith('world.plutonium-a5e-')) await reindexPack(pack);
  }

  log(`Published ${published} item(s) and re-indexed the module's compendiums.`);
  return published;
}
