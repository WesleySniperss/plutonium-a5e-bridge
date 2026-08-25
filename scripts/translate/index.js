import { actorRollContext, translateActor } from './actor.js';
import { translateItem } from './item.js';
import { attachSpellBook, spellBookIdOf } from '../spellbook.js';
import { debug, error } from '../util/log.js';

/**
 * Translate a whole Actor payload, including any items embedded in it.
 * Plutonium usually creates the actor first and its items afterwards, but the
 * multi-import path sometimes inlines them, so both are covered.
 */
export function translateActorDocument(data) {
  const out = translateActor(data);
  if (!Array.isArray(data.items) || !data.items.length) return out;

  const ctx = actorRollContext(out) ?? {};

  // The actor does not exist yet, so a spell inlined on it cannot look up a
  // spell book — give the payload one now and file the spells under it.
  if (data.items.some((item) => item?.type === 'spell')) ctx.spellBookId = attachSpellBook(out);

  out.items = data.items.map((item) => safe(() => translateItem(item, ctx), item, 'Item'));
  return out;
}

export function translateItemDocument(data, parent = null) {
  if (parent?.documentName !== 'Actor') return translateItem(data, {});

  const ctx = actorRollContext(parent) ?? {};
  ctx.spellBookId = spellBookIdOf(parent);
  return translateItem(data, ctx);
}

/**
 * Entry point used by the bridge.
 * @param {string} documentName  "Actor", "Item", …
 * @param {object} data          expanded document data
 * @param {Document|null} parent the document it is being embedded in, if any
 */
export function translateDocument(documentName, data, parent = null) {
  if (!data || typeof data !== 'object') return data;

  switch (documentName) {
    case 'Actor':
      return safe(() => translateActorDocument(data), data, 'Actor');
    case 'Item':
      return safe(() => translateItemDocument(data, parent), data, 'Item');
    default:
      // Journals, roll tables, scenes, macros and playlists are system-agnostic.
      return data;
  }
}

// A conversion crash must never take the import down with it: fall back to the
// untranslated payload, which at worst imports as an unusable document the user
// can see and report, rather than an aborted import.
function safe(fn, fallback, label) {
  try {
    return fn();
  } catch (e) {
    error(`Failed to translate ${label} "${fallback?.name ?? '?'}" — importing untranslated.`, e);
    return fallback;
  }
}

/**
 * Drop `system.*` keys the target document's schema does not know about.
 * Plutonium issues follow-up updates in dnd5e terms (activities, advancement,
 * preparation…); dropping them keeps the update valid instead of throwing.
 */
// A handful of dnd5e update paths have a real a5e counterpart at a different
// shape, and are worth carrying over rather than dropping. dnd5e's experience is
// an object (`{value, min, max, pct}`); a5e's `details.xp` is a plain number, and
// `value` is the one that means "experience so far".
const REMAP = {
  'system.details.xp.value': 'system.details.xp',
  // Plutonium sets a class's level after creating it — under a different name in
  // a5e, where it is what decides which grants have been reached.
  'system.levels': 'system.classLevels',
};

export function pruneUpdate(doc, update) {
  const schema = doc?.system?.schema;
  if (!schema?.getField) return update;

  const flat = foundry.utils.flattenObject(update);
  const kept = {};
  let dropped = 0;

  for (const [rawKey, value] of Object.entries(flat)) {
    const key = REMAP[rawKey] ?? rawKey;

    if (!key.startsWith('system.')) {
      kept[key] = value;
      continue;
    }
    if (hasField(schema, key.slice(7))) kept[key] = value;
    else dropped++;
  }

  if (dropped) debug(`Dropped ${dropped} dnd5e-only key(s) from an update to "${doc.name}".`);
  return foundry.utils.expandObject(kept);
}

function hasField(schema, path) {
  try {
    if (schema.getField(path)) return true;

    // The path may still be valid *inside* a field that holds arbitrary keys —
    // an ObjectField, or one of a5e's RecordFields, which extend it. It is not
    // valid under a leaf: dnd5e writes `details.xp.pct`, a5e's `details.xp` is a
    // number, and keeping that key makes Foundry reject the whole update with
    // "xp: must be a number" — which is how a class drop used to fail.
    const parts = path.split('.');
    for (let i = parts.length - 1; i > 0; i--) {
      const ancestor = schema.getField(parts.slice(0, i).join('.'));
      if (ancestor) return holdsArbitraryKeys(ancestor);
    }
  } catch {
    return true;
  }
  return false;
}

function holdsArbitraryKeys(field) {
  // A SchemaField knows every key it has, and `getField` already said this is
  // not one of them.
  if (field?.fields) return false;

  const ObjectField = foundry?.data?.fields?.ObjectField;
  if (!ObjectField) return true;
  return field instanceof ObjectField;
}
