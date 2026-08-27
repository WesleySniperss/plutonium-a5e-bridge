import { actorRollContext, translateActor } from './actor.js';
import {
  ARMOR_PROFICIENCY,
  TOOL_PROFICIENCY,
  WEAPON_PROFICIENCY,
  mapProficiencies,
} from './maps.js';
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

// Update paths that have a real a5e counterpart under a different name or shape.
// Without these the value is simply dropped, which is what made importing a class
// onto a character lose everything its Charactermancer asked about — the skills,
// saves, armour and weapons it hands out are all written in dnd5e's vocabulary.
//
// `$1` in a target picks up the first capture, so one rule covers all six
// abilities or all eighteen skills.
const UPDATE_RULES = [
  // dnd5e experience is an object; a5e's `details.xp` is a plain number, and
  // `value` is the one that means "experience so far".
  { from: /^system\.details\.xp\.value$/, to: 'system.details.xp' },

  // Plutonium sets a class's level after creating it — under a different name in
  // a5e, where it is what decides which grants have been reached.
  { from: /^system\.levels$/, to: 'system.classLevels' },

  // a5e derives `hp.max`; `baseMax` is the one that is written.
  { from: /^system\.attributes\.hp\.max$/, to: 'system.attributes.hp.baseMax' },

  {
    from: /^system\.traits\.armorProf\.value$/,
    to: 'system.proficiencies.armor',
    value: (v) => mapProficiencies(v, ARMOR_PROFICIENCY),
  },
  {
    from: /^system\.traits\.weaponProf\.value$/,
    to: 'system.proficiencies.weapons',
    value: (v) => mapProficiencies(v, WEAPON_PROFICIENCY),
  },
  {
    from: /^system\.traits\.languages\.value$/,
    to: 'system.proficiencies.languages',
    value: (v) => [v ?? []].flat(),
  },

  // dnd5e grades each tool separately under `system.tools.<id>.value`; a5e keeps
  // a flat list of the ones you are proficient with. Anything above 0 counts.
  {
    from: /^system\.tools\.([A-Za-z0-9_]+)\.value$/,
    to: 'system.proficiencies.tools',
    value: (v, match, doc, held) => {
      const list = [held ?? []].flat();
      if (!(Number(v) >= 1)) return list;

      const id = TOOL_PROFICIENCY[match[1]] ?? match[1];
      return list.includes(id) ? list : [...list, id];
    },
  },

  // dnd5e grades a skill 0 / 0.5 / 1 / 2; a5e has no half-proficiency.
  {
    from: /^system\.skills\.([a-z]{3})\.value$/,
    to: 'system.skills.$1.proficient',
    value: (v) => (Number(v) >= 2 ? 2 : Number(v) >= 1 ? 1 : 0),
  },

  // dnd5e keeps save proficiency on the ability; a5e keeps it on the save.
  {
    from: /^system\.abilities\.([a-z]{3})\.proficient$/,
    to: 'system.abilities.$1.save.proficient',
    value: (v) => Number(v) >= 1,
  },
];

// `kept` is passed in because several dnd5e keys can collapse onto one a5e key —
// each tool is graded separately in dnd5e, while a5e keeps a single list — and
// then the rule has to build on what earlier keys in the same update produced,
// not just on what the document already holds.
function remap(key, value, { doc, kept } = {}) {
  for (const rule of UPDATE_RULES) {
    const match = key.match(rule.from);
    if (!match) continue;

    const to = rule.to.replace(/\$(\d)/g, (_, index) => match[Number(index)]);
    if (!rule.value) return [to, value];

    const held = Object.hasOwn(kept ?? {}, to)
      ? kept[to]
      : foundry.utils.getProperty(doc ?? {}, to);

    return [to, rule.value(value, match, doc, held)];
  }
  return [key, value];
}

/**
 * Drop `system.*` keys the target document's schema does not know about, after
 * rewriting the ones that do have an a5e counterpart. Plutonium issues follow-up
 * updates in dnd5e terms (activities, advancement, proficiencies…); dropping
 * what does not translate keeps the update valid instead of throwing.
 */
export function pruneUpdate(doc, update) {
  const schema = doc?.system?.schema;
  if (!schema?.getField) return update;

  const flat = foundry.utils.flattenObject(update);
  const kept = {};
  let dropped = 0;

  for (const [rawKey, rawValue] of Object.entries(flat)) {
    const [key, value] = remap(rawKey, rawValue, { doc, kept });

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
