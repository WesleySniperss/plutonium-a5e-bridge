import { FLAG_SCOPE } from './translate/origins.js';
import { adoptExistingFeatures, rebuildArchetypeGrants, rebuildClassGrants } from './grant-linker.js';
import { repairUseConsumers } from './repair.js';
import { addAsiGrants } from './asi-grants.js';
import { backfillCommonManeuvers } from './maneuvers.js';
import { publishAll } from './publish-content.js';
import { translateDescription } from './translate/description.js';
import { translateEffect } from './translate/effects.js';
import { ID, error, log, warn } from './util/log.js';

// Content imported by an earlier version of this bridge is missing things the
// current one writes at import time: the tag that says a feature belongs to a
// class, the consumer that spends charges, the grants that hand features out on
// level-up. All of it can be recovered from what is already on the documents —
// so it is, once, rather than being left as homework.

const CURRENT = 8;
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

// A levelled spell imported before the fix scales by slot in name only: a5e's
// slot scaling reads `config.value` — its own Fireball carries
// `{ mode: "spellLevel", formula: "1d6", config: { value: "1d6" } }` — and
// without it casting from a higher slot added nothing.
export function repairedUpcastActions(item) {
  if (item.type !== 'spell' || !(Number(item.system?.level) > 0)) return null;

  const actions = foundry.utils.deepClone(item.system?.actions ?? {});
  let changed = false;

  for (const action of Object.values(actions)) {
    for (const roll of Object.values(action?.rolls ?? {})) {
      if (roll?.scaling?.mode !== 'spellLevel' || roll.scaling.config?.value) continue;
      const step = String(roll.scaling.formula || '').trim();
      if (!step) continue;
      roll.scaling = { ...roll.scaling, config: { ...(roll.scaling.config ?? {}), value: step } };
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

    const actions = repairedCantripActions(item) ?? repairedUpcastActions(item);
    if (actions) update['system.actions'] = actions;

    const description = repairedDescription(item);
    if (description != null) update['system.description'] = description;

    if (!Object.keys(update).length) continue;

    if (await safeUpdate(item, update)) fixed += 1;
  }

  return fixed;
}

// --- effects -------------------------------------------------------------------

// An action whose effects land on the one using it.
function actionTargetsSelf(action) {
  if (action?.target?.type === 'self') return true;
  if (action?.area?.shape) return false;
  return Object.values(action?.ranges ?? {}).some((r) => r?.range === 'self');
}

/**
 * The effect updates that bring an earlier import's effects into a5e's shape,
 * and the effect ids to hand to its one action.
 *
 * Effects imported before the translator existed kept dnd5e's keys — Foundry 14
 * only moved them into `system.changes` — and a5e took every one of them for
 * "passive": a Blindness spell blinded whoever owned it, Rage's resistances
 * pointed at a path a5e never reads. The activity that delivered each one is
 * gone, so when the item has a single action, that action is taken to deliver
 * what it applies: an effect dnd5e did not transfer, or one it kept disabled
 * until used, which is how Rage is built.
 */
// Keys only a5e writes. An effect holding one was made, or already fixed, in
// a5e — by the GM on the sheet, say — and is not ours to translate.
const A5E_KEY = /^(flags\.a5e\.|@token\.)|\.(distance|rollMode|minRoll|expertiseDice)$|^system\.(traits\.(damage|condition)|proficiencies\.|attributes\.ac\.(changes|baseFormula)|bonuses\.(spellDC|maneuverDC))/;

function isEarlierImport(effect) {
  if (effect.flags?.[FLAG_SCOPE]?.converted) return false;
  // a5e gives every effect it has not been told about "passive"; anything else
  // was chosen on a5e's own sheet.
  if ((effect.system?.effectType ?? 'passive') !== 'passive') return false;
  return !(effect.system?.changes ?? []).some((c) => A5E_KEY.test(String(c?.key ?? '')));
}

export function repairedEffects(doc, parent = 'Item') {
  // On a creature, an effect with nothing but a status — a5e's own Bloodied,
  // say — already works as it is.
  const stale = [...(doc.effects ?? [])].filter((e) => isEarlierImport(e)
    && (parent === 'Item' || (e.system?.changes ?? []).length));
  if (!stale.length) return null;

  const actions = Object.entries(doc.system?.actions ?? {});
  const [onlyId, only] = actions.length === 1 ? actions[0] : [];

  const updates = [];
  const linked = [];
  for (const effect of stale) {
    const source = typeof effect.toObject === 'function' ? effect.toObject() : foundry.utils.deepClone(effect);

    let delivery = null;
    if (parent === 'Item' && only && (!source.transfer || source.disabled)) {
      delivery = { self: source.transfer ? true : actionTargetsSelf(only) };
    }

    const out = translateEffect(source, { delivery, parent });
    if (!out) continue;

    updates.push({
      _id: source._id,
      statuses: out.statuses,
      transfer: out.transfer,
      disabled: out.disabled,
      system: out.system,
      flags: { [FLAG_SCOPE]: out.flags[FLAG_SCOPE] },
    });
    if (delivery) linked.push(source._id);
  }

  if (!updates.length) return null;

  let actionUpdate = null;
  if (linked.length) {
    const have = new Set(only.effects ?? []);
    const add = linked.filter((id) => !have.has(id));
    if (add.length) actionUpdate = { [`system.actions.${onlyId}.effects`]: [...have, ...add] };
  }
  return { updates, actionUpdate };
}

async function repairEffectsOn(doc, parent) {
  const repaired = repairedEffects(doc, parent);
  if (!repaired) return false;

  try {
    await doc.updateEmbeddedDocuments('ActiveEffect', repaired.updates);
  } catch (e) {
    const where = doc.parent ? `"${doc.name}" on "${doc.parent.name}"` : `"${doc.name}"`;
    skipped.push(where);
    log(`Could not update the effects of ${where}: ${String(e.message).split('\n')[0]}`);
    return false;
  }
  if (repaired.actionUpdate) await safeUpdate(doc, repaired.actionUpdate);
  return true;
}

// Plutonium recommends importing into a compendium, which can be any of the
// world's own; only the documents this bridge converted are loaded.
async function convertedInWorldPacks(documentName) {
  const out = [];
  for (const pack of game.packs) {
    if (pack.documentName !== documentName || pack.locked) continue;
    if (pack.metadata?.packageType !== 'world') continue;
    try {
      const index = await pack.getIndex({ fields: [`flags.${FLAG_SCOPE}.converted`] });
      const ids = index.filter((e) => foundry.utils.getProperty(e, `flags.${FLAG_SCOPE}.converted`)).map((e) => e._id);
      if (ids.length) out.push(...await pack.getDocuments({ _id__in: ids }));
    } catch (e) {
      log(`Could not read "${pack.collection}": ${e.message}`);
    }
  }
  return out;
}

async function repairEffects() {
  let fixed = 0;
  const seen = new Set();

  const items = [...game.items];
  const actors = [...game.actors].filter((a) => a.flags?.[FLAG_SCOPE]);
  for (const actor of game.actors) items.push(...actor.items);
  items.push(...await convertedInWorldPacks('Item'));
  for (const actor of await convertedInWorldPacks('Actor')) {
    actors.push(actor);
    items.push(...actor.items);
  }

  for (const item of items) {
    if (!item.flags?.[FLAG_SCOPE] || seen.has(item.uuid)) continue;
    seen.add(item.uuid);
    if (await repairEffectsOn(item, 'Item')) fixed += 1;
  }
  for (const actor of actors) {
    if (seen.has(actor.uuid)) continue;
    seen.add(actor.uuid);
    if (await repairEffectsOn(actor, 'Actor')) fixed += 1;
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
  const effects = await step('effects', repairEffects);
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

  return { tagged, consumers, wired, references, asi, maneuvers, spellsAndText, effects, publishedContent };
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
      tagged, consumers, wired, references, asi, maneuvers, spellsAndText, effects, publishedContent,
    } = await repairImportedContent();
    await game.settings.set(ID, 'migration', CURRENT);

    if (tagged || consumers || wired || references || asi || maneuvers || spellsAndText || effects || publishedContent) {
      const parts = [];
      if (tagged) parts.push(`tagged ${tagged} feature(s)`);
      if (consumers) parts.push(`restored ${consumers} charge consumer(s)`);
      if (wired) parts.push(`wired ${wired} class/archetype grant set(s)`);
      if (references) parts.push(`repointed ${references} scaling formula set(s)`);
      if (asi) parts.push(`gave ${asi} class(es) their ability score increases`);
      if (maneuvers) parts.push(`gave ${maneuvers} creature(s) the common manoeuvres`);
      if (spellsAndText) parts.push(`fixed spell scaling or description text on ${spellsAndText} item(s)`);
      if (effects) parts.push(`translated the effects of ${effects} document(s)`);
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
