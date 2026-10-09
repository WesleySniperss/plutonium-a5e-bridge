import { CLASS_SLUG } from './translate/maps.js';
import { debug, warn } from './util/log.js';

// dnd5e formulas, in an a5e world.
//
// Plutonium's Foundry data writes formulas against dnd5e's roll data — 225
// distinct shapes across its spells, items, features and creatures:
//
//   (floor(((@details.level + @attributes.spell.level) + 1) / 6))d8   Booming Blade
//   @scale.monk.die + @mod                                            Unarmed Strike
//   (@item.level - 2)d10, @classes.warlock.levels, @attributes.spell.dc …
//
// a5e names the same numbers differently, or not at all, and Foundry does not
// fail on a reference it cannot resolve — `Roll.parse` substitutes zero:
//
//   const replaced = this.replaceFormulaData(formula, data, { missing: "0" });
//
// so every one of them silently rolled as if the character were level 0.
// Booming Blade became `0d8`. Rewriting 225 shapes at import would never be
// complete, so instead the names are supplied: each a5e roll-data object gains
// the dnd5e ones, with the values dnd5e 6 gives them —
//
//   cantrip scaling   Math.floor((cantripLevel + 1) / 6)
//   cantripLevel      a character's level; an NPC's spellcasting level
//   @mod              the ability modifier of the activity rolling
//
// Nothing a5e already defines is overwritten, and nothing shared is mutated:
// a5e's roll data is a shallow copy of the actor's system data, so a branch is
// copied before a name is added to it.

// a5e slug -> the dnd5e identifiers that mean it.
const DND5E_IDS_FOR_SLUG = Object.entries(CLASS_SLUG).reduce((out, [id, slug]) => {
  (out[slug] ??= []).push(id);
  return out;
}, {});

function slugOf(text) {
  return String(text ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// dnd5e exposes a dice scale value as an object: the whole value prints as
// "1d8", and `.die`, `.number` and `.faces` reach its parts.
function scaleValue(value) {
  if (typeof value !== 'string') return value;
  const m = value.trim().match(/^(\d*)\s*d\s*(\d+)$/i);
  if (!m) return value;

  const number = Number(m[1] || 1);
  const faces = Number(m[2]);
  const formula = `${number}d${faces}`;
  return {
    number,
    faces,
    die: `d${faces}`,
    denom: `d${faces}`,
    formula,
    toString() { return formula; },
  };
}

function scaleValues(rollData) {
  return Object.fromEntries(Object.entries(rollData ?? {}).map(([k, v]) => [k, scaleValue(v)]));
}

function identifiersOf(item, kind) {
  const ids = new Set();
  const flags = item.flags?.['plutonium-a5e']?.[kind];
  if (flags?.classIdentifier && kind === 'class') ids.add(flags.classIdentifier);
  if (flags?.identifier) ids.add(flags.identifier);

  const own = item.system?.slug || slugOf(item.name);
  ids.add(own);
  for (const id of DND5E_IDS_FOR_SLUG[own] ?? []) ids.add(id);
  ids.add(slugOf(item.name));

  return [...ids].filter(Boolean);
}

function characterLevel(actor, rd) {
  return Number(rd.level ?? actor.levels?.character ?? actor.system?.details?.level) || 0;
}

function hitDiceFaces(actor) {
  const faces = [];
  if (actor.type === 'character') {
    for (const item of actor.items ?? []) {
      if (item.type !== 'class') continue;
      const f = Number(item.system?.hp?.hitDiceSize);
      if (f) faces.push(f);
    }
  }
  if (!faces.length) {
    for (const [die, entry] of Object.entries(actor.system?.attributes?.hitDice ?? {})) {
      if (Number(entry?.total) > 0) faces.push(Number(String(die).replace(/^d/, '')));
    }
  }
  return faces.filter((f) => Number.isFinite(f) && f > 0);
}

// dnd5e's `@mod` is the ability of whatever is rolling: a spell's spellcasting
// ability, an attack's attacking ability, nothing for a plain feature.
function activityMod(item, rd) {
  if (!item) return 0;
  if (item.type === 'spell') return Number(rd.spellcasting?.mod ?? rd.spell?.mod) || 0;

  for (const action of Object.values(item.system?.actions ?? {})) {
    for (const roll of Object.values(action?.rolls ?? {})) {
      if (roll?.type === 'attack' && roll.ability) return Number(rd.abilities?.[roll.ability]?.mod) || 0;
    }
  }
  return 0;
}

// a5e's movement and senses are { distance, unit }; dnd5e's are plain numbers.
// Printing the distance keeps `@attributes.movement.walk` working for dnd5e
// formulas while `.distance` still works for a5e's own.
function withPrintedDistances(branch) {
  if (!branch || typeof branch !== 'object') return branch;
  const out = { ...branch };
  for (const [key, entry] of Object.entries(branch)) {
    if (entry && typeof entry === 'object' && 'distance' in entry) {
      out[key] = { ...entry, toString() { return String(Number(this.distance) || 0); } };
    }
  }
  return out;
}

/**
 * Add dnd5e's roll-data names to an a5e roll-data object, in place.
 * @param {Actor} actor
 * @param {Item|null} item  the item rolling, as a5e passes it
 * @param {object} rd       the roll data a5e built
 */
export function addDnd5eAliases(actor, item, rd) {
  if (!actor || !rd || typeof rd !== 'object') return rd;

  const isCharacter = actor.type === 'character';
  const level = isCharacter ? characterLevel(actor, rd) : 0;
  const casterLevel = isCharacter ? 0 : Number(actor.system?.attributes?.casterLevel) || 0;
  const prof = Number(rd.prof) || 0;
  const spellMod = Number(rd.spellcasting?.mod ?? rd.spell?.mod) || 0;

  // @details.level — a character's level; an NPC has none in dnd5e terms.
  rd.details = { ...(rd.details ?? {}) };
  if (isCharacter) rd.details.level = level;
  else rd.details.level ??= 0;

  // @attributes.spell.*, @attributes.hd.*, and speeds that print as numbers.
  rd.attributes = { ...(rd.attributes ?? {}) };
  rd.attributes.spell ??= {
    level: casterLevel,
    mod: spellMod,
    dc: Number(rd.spellDC) || 0,
    attack: spellMod + prof,
  };
  const faces = hitDiceFaces(actor);
  if (faces.length && !rd.attributes.hd) {
    const largest = Math.max(...faces);
    const smallest = Math.min(...faces);
    rd.attributes.hd = {
      largestFace: largest,
      smallestFace: smallest,
      largest: `d${largest}`,
      smallest: `d${smallest}`,
    };
  }
  rd.attributes.movement = withPrintedDistances(rd.attributes.movement);
  rd.attributes.senses = withPrintedDistances(rd.attributes.senses);

  // @classes.<identifier>.levels, by a5e slug and by every dnd5e identifier.
  rd.classes = { ...(rd.classes ?? {}) };
  for (const [slug, entry] of Object.entries(rd.classes)) {
    rd.classes[slug] = { ...entry, levels: entry?.level ?? 0 };
  }
  const scale = {};
  for (const cls of actor.items?.filter((i) => i.type === 'class') ?? []) {
    const slug = cls.slug ?? cls.system?.slug;
    const entry = rd.classes[slug];
    const values = scaleValues(cls.resources?.rollData);
    for (const id of identifiersOf(cls, 'class')) {
      if (entry && !rd.classes[id]) rd.classes[id] = entry;
      scale[id] ??= values;
    }
  }
  // A subclass's scale values are reached by the subclass's own identifier —
  // `@scale.battle-master.superiority.die`.
  for (const sub of actor.items?.filter((i) => i.type === 'archetype') ?? []) {
    const values = scaleValues(sub.resources?.rollData);
    for (const id of identifiersOf(sub, 'archetype')) scale[id] ??= values;
  }
  rd.scale ??= scale;

  rd.mod ??= activityMod(item, rd);

  // @scaling: a cantrip's increase is known from the caster; a spell cast from
  // a higher slot is not, at this point, so it reads as the base level.
  if (rd.scaling === undefined) {
    let scaling = 0;
    if (item?.type === 'spell' && Number(item.system?.level) === 0) {
      const cantripLevel = isCharacter ? level : (casterLevel || Number(actor.system?.details?.cr) || 0);
      scaling = Math.floor((cantripLevel + 1) / 6);
    }
    rd.scaling = scaling;
  }

  // @item.uses.spent — dnd5e 5 counts what is used, a5e what is left.
  if (rd.item && typeof rd.item === 'object' && rd.item.uses && typeof rd.item.uses === 'object') {
    const max = Number(rd.item.uses.max);
    const value = Number(rd.item.uses.value);
    if (Number.isFinite(max) && Number.isFinite(value) && rd.item.uses.spent === undefined) {
      rd.item = { ...rd.item, uses: { ...rd.item.uses, spent: Math.max(0, max - value) } };
    }
  }

  return rd;
}

const wrapped = new WeakSet();

/** Wrap a5e's actor roll data so dnd5e formulas resolve. Installed at `ready`. */
export function installRollDataShim() {
  const byType = CONFIG.A5E?.Actor?.documentClasses;
  const classes = byType ? Object.values(byType) : [];
  if (!classes.length && CONFIG.Actor?.documentClass) classes.push(CONFIG.Actor.documentClass);

  let count = 0;
  for (const cls of classes) {
    const proto = cls?.prototype;
    if (!proto?.getRollData || wrapped.has(proto)) continue;
    wrapped.add(proto);

    const orig = proto.getRollData;
    proto.getRollData = function getRollData(...args) {
      const rd = orig.apply(this, args);
      // A failure here must never cost a5e its own roll.
      try {
        addDnd5eAliases(this, args[0] ?? null, rd);
      } catch (e) {
        debug(`Roll data aliases skipped for "${this?.name}": ${e.message}`);
      }
      return rd;
    };
    count += 1;
  }

  if (!count) {
    warn('Could not extend a5e roll data — dnd5e formulas from Plutonium will read as zero.');
    return false;
  }
  debug(`dnd5e roll-data names added to ${count} a5e actor class(es).`);
  return true;
}
