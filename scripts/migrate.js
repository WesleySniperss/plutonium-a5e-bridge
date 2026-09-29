import { FLAG_SCOPE } from './translate/origins.js';
import { adoptExistingFeatures, rebuildArchetypeGrants, rebuildClassGrants } from './grant-linker.js';
import { repairUseConsumers } from './repair.js';
import { addAsiGrants } from './asi-grants.js';
import { backfillCommonManeuvers } from './maneuvers.js';
import { publishAll } from './publish-content.js';
import { translateDescription } from './translate/description.js';
import { ID, error, log, warn } from './util/log.js';

// Content imported by an earlier version of this bridge is missing things the
// current one writes at import time: the tag that says a feature belongs to a
// class, the consumer that spends charges, the grants that hand features out on
// level-up. All of it can be recovered from what is already on the documents —
// so it is, once, rather than being left as homework.

const CURRENT = 7;
// What a step could not touch, named so the GM can find it. Kept for one run.
const skipped = [];

// An ordinary, recursive update — never `recursive: false`. In Foundry 14 that
// option turns every root key into a ForcedReplacement:
//
//   if ( options.recursive === false ) DataModel.#performNonRecursiveUpdate(changes);
//
// so `{ 'system.actions': … }` replaced the item's *whole* `system` with just its
// actions, which validation then rejects — "may not be undefined" for every
// other field. The keys written here are always the ones already present, so a
// recursive merge gives the same result without touching anything else.
//
// One document that cannot be written must not stop the rest: a single broken
// actor used to abort the whole migration, which then ran again, and failed
// again, on every load.
async function safeUpdate(doc, update) {
  try {
    await doc.update(update);
    return true;
  } catch (e) {
    const where = doc.parent ? `"${doc.name}" on "${doc.parent.name}"` : `"${doc.name}"`;
    skipped.push(where);
    log(`Could not update ${where}: ${String(e.message).split('\n')[0]}`);
    return false;
  }
}

// Each repair runs on its own: one that fails must not cost the others, nor
// keep the migration from being recorded as done.
async function step(label, fn, fallback = 0) {
  try {
    return await fn();
  } catch (e) {
    skipped.push(label);
    error(`Migration step "${label}" failed; the others still ran.`, e);
    return fallback;
  }
}


/** Every class and archetype this bridge imported, wherever it ended up. */
function importedOrigins() {
  const seen = new Set();
  const out = [];

  const consider = (item) => {
    if (!item || seen.has(item.uuid)) return;
    if (item.type !== 'class' && item.type !== 'archetype') return;
    const flags = item.flags?.[FLAG_SCOPE];
    if (!flags?.class && !flags?.archetype) return;
    seen.add(item.uuid);
    out.push(item);
  };

  for (const item of game.items) consider(item);
  for (const actor of game.actors) for (const item of actor.items) consider(item);
  return out;
}

function hasFeatureGrants(item) {
  return Object.values(item.system?.grants ?? {}).some((g) => g?.grantType === 'feature');
}

// An earlier bridge turned `@scale.rogue.sneak-attack` into `@sneakattack`,
// which a5e does not resolve: it gathers class resources onto the actor as
// `classResources`, and nothing sits at the top level under the slug alone. The
// formula evaluated to zero without ever complaining.
//
// Rewriting every bare `@word` would be guesswork, so only the slugs that are
// actually class resources in this world are touched.
function classResourceSlugs() {
  const slugs = new Set();

  const consider = (item) => {
    if (item?.type !== 'class' && item?.type !== 'archetype') return;
    for (const resource of item.system?.resources ?? []) {
      const slug = String(resource?.slug ?? '').trim();
      if (slug) slugs.add(slug);
    }
  };

  for (const item of game.items) consider(item);
  for (const actor of game.actors) for (const item of actor.items) consider(item);
  return slugs;
}

function repointFormulas(value, slugs) {
  if (typeof value === 'string') {
    return value.replace(/@([a-z][a-z0-9]*)\b/gi, (whole, slug) => (
      slugs.has(slug.toLowerCase()) ? `@classResources.${slug}` : whole
    ));
  }
  if (Array.isArray(value)) return value.map((v) => repointFormulas(v, slugs));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, repointFormulas(v, slugs)]),
    );
  }
  return value;
}

async function repairResourceReferences() {
  const slugs = classResourceSlugs();
  if (!slugs.size) return 0;

  let fixed = 0;

  const consider = async (item) => {
    const actions = item.system?.actions;
    if (!actions || !Object.keys(actions).length) return;

    const repointed = repointFormulas(actions, slugs);
    if (JSON.stringify(repointed) === JSON.stringify(actions)) return;

    await safeUpdate(item, { 'system.actions': repointed });
    fixed += 1;
  };

  for (const item of game.items) await consider(item);
  for (const actor of game.actors) for (const item of actor.items) await consider(item);

  return fixed;
}

// Cantrips imported before the fix carry `spellLevel` scaling, which a cantrip
// never triggers — it cannot be cast from a higher slot — so their damage stayed
// at first-level dice for good. That scaling on a level-0 spell is always wrong,
// so it is rewritten into the shape a5e's own Fire Bolt carries. Descriptions
// still holding dnd5e-only enrichers are rewritten the same way new imports are.
export function repairedCantripActions(item) {
  if (item.type !== 'spell' || Number(item.system?.level) !== 0) return null;

  const actions = foundry.utils.deepClone(item.system?.actions ?? {});
  let changed = false;

  for (const action of Object.values(actions)) {
    for (const roll of Object.values(action?.rolls ?? {})) {
      if (roll?.scaling?.mode !== 'spellLevel') continue;
      const step = String(roll.scaling.formula || '').trim();
      roll.scaling = step ? { mode: 'cantrip', formula: step, config: { value: step } } : {};
      changed = true;
    }
  }

  return changed ? actions : null;
}

function repairedDescription(item) {
  const text = item.system?.description;
  if (typeof text !== 'string') return null;
  const fixed = translateDescription(text);
  return fixed === text ? null : fixed;
}

/** Imported items in the world, on actors, and in the module's own packs. */
async function importedItemsEverywhere() {
  const out = [...game.items];
  for (const actor of game.actors) out.push(...actor.items);

  for (const pack of game.packs) {
    if (pack.documentName !== 'Item' || pack.locked) continue;
    if (!pack.collection?.startsWith('world.plutonium-a5e-')) continue;
    out.push(...await pack.getDocuments());
  }

  return out.filter((item) => item.flags?.[FLAG_SCOPE]);
}

async function repairSpellsAndText() {
  let fixed = 0;

  for (const item of await importedItemsEverywhere()) {
    const update = {};

    const actions = repairedCantripActions(item);
    if (actions) update['system.actions'] = actions;

    const description = repairedDescription(item);
    if (description != null) update['system.description'] = description;

    if (!Object.keys(update).length) continue;

    if (await safeUpdate(item, update)) fixed += 1;
  }

  return fixed;
}

async function repairImportedContent() {
  const { tagged } = await step('tagging features', adoptExistingFeatures, { tagged: 0 });
  const { consumers } = await step('charge consumers', repairUseConsumers, { consumers: 0 });
  const references = await step('scaling formulas', repairResourceReferences);
  const asi = await step('ability score increases', addAsiGrants);
  const maneuvers = await step('common manoeuvres', backfillCommonManeuvers);
  const spellsAndText = await step('cantrips and descriptions', repairSpellsAndText);
  const publishedContent = await step('publishing', publishAll);

  let wired = 0;
  for (const owner of importedOrigins()) {
    if (hasFeatureGrants(owner)) continue;
    try {
      if (owner.type === 'class') await rebuildClassGrants(owner.uuid);
      else await rebuildArchetypeGrants(owner.uuid);
      wired += 1;
    } catch (e) {
      // Nothing to build from is a normal outcome here, not a failure worth
      // shouting about — the import simply never brought that owner's features.
      log(`Left "${owner.name}" alone: ${e.message}`);
    }
  }

  return { tagged, consumers, wired, references, asi, maneuvers, spellsAndText, publishedContent };
}

/**
 * Bring a world imported by an older bridge up to what the current one produces.
 * Runs once, for the GM, and is safe to run again — every step checks before it
 * writes.
 */
export async function runMigrations() {
  if (!game.user.isGM) return;

  let done = 0;
  try {
    done = Number(game.settings.get(ID, 'migration')) || 0;
  } catch {
    return;
  }
  if (done >= CURRENT) return;

  try {
    const {
      tagged, consumers, wired, references, asi, maneuvers, spellsAndText, publishedContent,
    } = await repairImportedContent();
    await game.settings.set(ID, 'migration', CURRENT);

    if (tagged || consumers || wired || references || asi || maneuvers || spellsAndText || publishedContent) {
      const parts = [];
      if (tagged) parts.push(`tagged ${tagged} feature(s)`);
      if (consumers) parts.push(`restored ${consumers} charge consumer(s)`);
      if (wired) parts.push(`wired ${wired} class/archetype grant set(s)`);
      if (references) parts.push(`repointed ${references} scaling formula set(s)`);
      if (asi) parts.push(`gave ${asi} class(es) their ability score increases`);
      if (maneuvers) parts.push(`gave ${maneuvers} creature(s) the common manoeuvres`);
      if (spellsAndText) parts.push(`fixed cantrip scaling or description text on ${spellsAndText} item(s)`);
      if (publishedContent) parts.push(`published ${publishedContent} item(s) to a compendium`);
      ui.notifications.info(`Plutonium ⇄ A5E: repaired earlier imports — ${parts.join(', ')}.`);
      log(`Migration complete: ${parts.join(', ')}.`);
    } else {
      log('Migration found nothing to repair.');
    }

    if (skipped.length) {
      const list = [...new Set(skipped)];
      warn(`Migration left ${list.length} thing(s) alone: ${list.join(', ')}.`);
      ui.notifications.warn(
        `Plutonium ⇄ A5E: could not update ${list.length} item(s) or step(s) — ${list.slice(0, 5).join(', ')}`
        + `${list.length > 5 ? ', …' : ''}. The rest was repaired; see the console.`,
      );
    }
  } catch (e) {
    error('Could not repair earlier imports. Run api.diagnose() for the details.', e);
  }
}
