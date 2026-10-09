import { translateFormula } from './actions.js';
import { translateDescription } from './description.js';
import { DAMAGE_TYPES } from './maps.js';

// Active effects, dnd5e -> a5e.
//
// The two systems agree on almost nothing here, and a dnd5e effect carried
// across untouched is worse than a missing one:
//
// - every key names a dnd5e path. a5e's own content, read out of its packs,
//   writes `system.traits.damageResistances`, `system.attributes.ac.changes.
//   bonuses.value`, `flags.a5e.effects.bonuses.attacks` and so on;
// - a5e's change values are typed. Its roll-mode field counts the numbers -1
//   and 1, its trait lists take arrays — a string is spread into its letters,
//   "fire" into f, i, r, e — and a bonus is an object its BonusesManager reads
//   `formula` and `context` from:
//     custom: … s = `system.bonuses.${key}.${randomID()}`, c = t.value
//   so a bonus written as a JSON string is a string with no formula, and never
//   applies. a5e's own packs, as Foundry 14 has migrated them, hold objects;
//   `getStatuses()` reads a condition list only when it is an Array;
// - a5e numbers the modes differently: its own migration says
//     { 0: custom, 1: multiply, 2: add, 3: subtract, 4: downgrade, 5: upgrade,
//       6: override, 7: conditional }
//   where Foundry, and so dnd5e, has 3 downgrade, 4 upgrade, 5 override;
// - a5e decides what an item effect does from `system.effectType`, which
//   defaults to "passive", and applies every passive item effect to the owner:
//     for (let t of e.effects) (t.transfer || t.system.effectType === "passive") && (yield t);
//   so an effect meant for the *target* — Bane, Blindness — that arrives without
//   one is applied to whoever carries the item.
//
// So each change is translated to the key a5e reads, with the value in the type
// it reads, or dropped. Dropping matters as much as translating: dnd5e
// enchantments change the item they sit on — `name`, `system.properties`,
// `system.damage.base.*` — and on an a5e actor those would rename it or write
// junk into its data.
//
// The paths below are the ones a5e 1.4 *reads*, not the ones its key list
// offers: its migration renames skill and concentration roll modes to
// `skills.<id>.check.rollMode` and `concentration.roll.rollMode`, but the data
// model and the code that resolves a roll use `skills.<id>.rollMode` and
// `concentration.rollMode`.

// Foundry's core modes, which dnd5e uses, as the names a5e stores.
const CORE_MODE_TO_TYPE = {
  0: 'custom',
  1: 'multiply',
  2: 'add',
  3: 'downgrade',
  4: 'upgrade',
  5: 'override',
};

// Plutonium's side data writes modes as words before it hydrates them.
const NAMED_MODE_TO_TYPE = {
  CUSTOM: 'custom',
  MULTIPLY: 'multiply',
  ADD: 'add',
  DOWNGRADE: 'downgrade',
  UPGRADE: 'upgrade',
  OVERRIDE: 'override',
};

// An effect Foundry 14 has already migrated carries its type by name.
const TYPE_NAMES = new Set(['custom', 'multiply', 'add', 'subtract', 'downgrade', 'upgrade', 'override']);

function typeOf({ mode, type }) {
  if (typeof type === 'string') {
    const base = type.split('.')[0];
    if (TYPE_NAMES.has(base)) return base;
  }
  if (typeof mode === 'string' && NAMED_MODE_TO_TYPE[mode.toUpperCase()]) {
    return NAMED_MODE_TO_TYPE[mode.toUpperCase()];
  }
  return CORE_MODE_TO_TYPE[Number(mode)] ?? 'add';
}

const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

const SKILLS = [
  'acr', 'ani', 'arc', 'ath', 'cul', 'dec', 'eng', 'his', 'ins', 'itm', 'inv',
  'med', 'nat', 'prc', 'prf', 'per', 'rel', 'sci', 'slt', 'ste', 'sur',
];

const MOVEMENT = ['walk', 'fly', 'swim', 'climb', 'burrow'];
const SENSES = ['darkvision', 'blindsight', 'tremorsense', 'truesight'];

// a5e's condition keys; every 5e condition is among them but exhaustion.
export const A5E_CONDITIONS = new Set([
  'blinded', 'bloodied', 'charmed', 'concentration', 'confused', 'corruption',
  'dazzled', 'deafened', 'dead', 'doomed', 'encumbered', 'enervated', 'fatigue',
  'fixated', 'frightened', 'grappled', 'hungover', 'incapacitated', 'inebriated',
  'invisible', 'paralyzed', 'petrified', 'poisoned', 'prone', 'rattled',
  'restrained', 'slowed', 'strife', 'stunned', 'unconscious',
]);

const ATTACK_TYPES = {
  mwak: 'meleeWeaponAttack',
  rwak: 'rangedWeaponAttack',
  msak: 'meleeSpellAttack',
  rsak: 'rangedSpellAttack',
};

// dnd5e armour class calculations a5e can express as a base formula.
const AC_CALCS = {
  unarmoredMonk: '10 + @dex.mod + @wis.mod',
  unarmoredBarb: '10 + @dex.mod + @con.mod',
  unarmoredBard: '10 + @dex.mod + @cha.mod',
  draconic: '13 + @dex.mod',
  mage: '13 + @dex.mod',
};

// --- values ------------------------------------------------------------------

function formula(value) {
  return translateFormula(String(value ?? '').trim().replace(/^\+\s*/, ''));
}

// A number where the value is one — "+ 10" is 10 — and a formula otherwise,
// which a5e's number fields evaluate against the actor's roll data.
function scalar(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  const text = formula(value);
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return text;
}

function truthy(value) {
  if (typeof value === 'string') return !['', 'false', '0', 'no'].includes(value.trim().toLowerCase());
  return !!value;
}

// A list value as an array: dnd5e adds one entry per change, or a JSON list.
function list(value) {
  if (Array.isArray(value)) return value.map(String);
  if (value instanceof Set) return [...value].map(String);
  const text = String(value ?? '').trim();
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch { /* a plain string after all */ }
  }
  return text ? [text] : [];
}

function change(key, type, value) {
  return { key, type, value, phase: 'initial', priority: null };
}

// A list field can only be added to, overridden, or taken from.
function listType(type) {
  return type === 'override' || type === 'subtract' ? type : 'add';
}

// dnd5e counts advantage and disadvantage — ADD 1 is one source of advantage,
// ADD -1 one of disadvantage — and so does a5e's roll-mode field, which keeps
// a tally per roll. Only an explicit override silences the other sources.
function rollMode(key, type, value) {
  let n;
  if (value === true || value === 'true') n = 1;
  else n = Math.sign(Number(value) || 0);

  const t = ['override', 'upgrade', 'downgrade'].includes(type) ? type : 'add';
  if (t === 'add' && n === 0) return null;
  return [change(key, t, n)];
}

// --- a5e bonus objects, in the shape its own content writes -------------------

function abilityBonus(label, value, abilities, types) {
  return change('flags.a5e.effects.bonuses.abilities', 'custom', {
    label,
    formula: formula(value),
    context: { abilities, types, requiresProficiency: false },
    default: true,
  });
}

function skillBonus(label, value, skills, passiveOnly = false) {
  return change('flags.a5e.effects.bonuses.skills', 'custom', {
    label,
    formula: formula(value),
    context: { skills, passiveOnly, requiresProficiency: false },
    default: true,
  });
}

function attackBonus(label, value, attackTypes) {
  return change('flags.a5e.effects.bonuses.attacks', 'custom', {
    label,
    formula: formula(value),
    context: { attackTypes, spellLevels: [], requiresProficiency: false },
    default: true,
  });
}

function damageBonus(label, value, attackTypes) {
  return change('flags.a5e.effects.bonuses.damage', 'custom', {
    label,
    formula: formula(value),
    damageType: '',
    context: { attackTypes, damageTypes: [], spellLevels: [], isCritBonus: false },
    default: true,
  });
}

function initiativeBonus(label, value) {
  return change('flags.a5e.effects.bonuses.initiative', 'custom', {
    label,
    formula: formula(value),
    context: { abilities: [], skills: [] },
    default: true,
  });
}

// Spelling dnd5e itself has used for the same path over the years.
function normalizeKey(key) {
  let k = String(key ?? '').trim();
  if (/^(attributes|abilities|skills|traits|bonuses)\./.test(k)) k = `system.${k}`;
  return k
    .replace(/^system\.traits\.(dr|di|dv|ci)$/, 'system.traits.$1.value')
    .replace(/^system\.attributes\.movement\.speeds\./, 'system.attributes.movement.')
    .replace(/^system\.attributes\.senses\.ranges\./, 'system.attributes.senses.');
}

/**
 * One dnd5e change -> zero or more a5e changes.
 * @returns {object[]|null} null when the key has no a5e counterpart
 */
export function translateChange(source, { label = '' } = {}) {
  const key = normalizeKey(source?.key);
  const type = typeOf(source ?? {});
  const { value } = source ?? {};
  let m;

  // Damage and condition traits: lists in both systems, under other names.
  if ((m = key.match(/^system\.traits\.(dr|di|dv)\.value$/))) {
    const to = { dr: 'damageResistances', di: 'damageImmunities', dv: 'damageVulnerabilities' }[m[1]];
    const types = list(value).map((v) => v.toLowerCase()).filter((v) => DAMAGE_TYPES.has(v));
    return types.length ? [change(`system.traits.${to}`, listType(type), types)] : null;
  }
  if (key === 'system.traits.ci.value') {
    const ids = list(value).map((v) => v.toLowerCase()).filter((v) => A5E_CONDITIONS.has(v));
    return ids.length ? [change('system.traits.conditionImmunities', listType(type), ids)] : null;
  }
  if (key === 'system.traits.languages.value') {
    const ids = list(value);
    return ids.length ? [change('system.proficiencies.languages', listType(type), ids)] : null;
  }

  // Speeds and senses are a number in dnd5e, a { distance, unit } in a5e.
  if ((m = key.match(/^system\.attributes\.movement\.([a-z]+)$/)) && MOVEMENT.includes(m[1])) {
    return type === 'custom' ? null : [change(`system.attributes.movement.${m[1]}.distance`, type, scalar(value))];
  }
  if (key === 'system.attributes.movement.hover') {
    return [change('system.attributes.movement.traits.hover', 'override', truthy(value))];
  }
  if (key === 'system.attributes.movement.bonus') {
    return [change('system.attributes.movement.walk.distance', 'add', scalar(value))];
  }
  if (key === 'system.attributes.movement.multiplier' && (type === 'override' || type === 'multiply')) {
    // a5e expands this key onto every speed it has.
    return [change('flags.a5e.effects.movement.allDistances', 'multiply', scalar(value))];
  }
  if ((m = key.match(/^system\.attributes\.senses\.([a-z]+)$/)) && SENSES.includes(m[1])) {
    return type === 'custom' ? null : [change(`system.attributes.senses.${m[1]}.distance`, type, scalar(value))];
  }

  // Armour class.
  if (key === 'system.attributes.ac.bonus') {
    return [change('system.attributes.ac.changes.bonuses.value', type === 'subtract' ? 'subtract' : 'add', scalar(value))];
  }
  if (key === 'system.attributes.ac.flat') {
    return [change('system.attributes.ac.baseFormula', 'override', String(formula(value)))];
  }

  // Hit points: a5e derives its maximum, and its own content adds to it there.
  if (key === 'system.attributes.hp.max' || key === 'system.attributes.hp.tempmax') {
    return type === 'custom' ? null : [change('system.attributes.hp.max', type, scalar(value))];
  }
  if (key === 'system.attributes.hp.bonuses.overall') {
    return [change('system.attributes.hp.max', 'add', scalar(value))];
  }
  if (key === 'system.attributes.hp.bonuses.level') {
    const per = formula(value);
    return per ? [change('system.attributes.hp.max', 'add', `(${per}) * @details.level`)] : null;
  }
  if (key === 'system.attributes.hp.temp') {
    return [change('system.attributes.hp.temp', type, scalar(value))];
  }

  // Initiative, proficiency, attunement.
  if (key === 'system.attributes.init.bonus' || key === 'system.attributes.init.total') {
    return [initiativeBonus(label, value)];
  }
  if (key === 'system.attributes.prof') {
    return [change('system.attributes.prof', type, scalar(value))];
  }
  if (key === 'system.attributes.attunement.max') {
    return [change('system.attributes.attunement.max', type, scalar(value))];
  }

  // Ability scores live at the same path in both.
  if ((m = key.match(/^system\.abilities\.([a-z]{3})\.value$/)) && ABILITIES.includes(m[1])) {
    return type === 'custom' ? null : [change(key, type, scalar(value))];
  }

  // Advantage and disadvantage.
  if ((m = key.match(/^system\.abilities\.([a-z]{3})\.(save|check)\.roll\.mode$/)) && ABILITIES.includes(m[1])) {
    return rollMode(`system.abilities.${m[1]}.${m[2]}.rollMode`, type, value);
  }
  if ((m = key.match(/^system\.skills\.([a-z]{3})\.roll\.mode$/)) && SKILLS.includes(m[1])) {
    return rollMode(`system.skills.${m[1]}.rollMode`, type, value);
  }
  if (key === 'system.attributes.concentration.roll.mode') {
    return rollMode('system.attributes.concentration.rollMode', type, value);
  }
  if (key === 'system.attributes.death.roll.mode') {
    return rollMode('system.rolls.death.rollMode', type, value);
  }
  if (key === 'system.attributes.init.roll.mode' || key === 'flags.dnd5e.initiativeAdv') {
    return rollMode('system.attributes.initiative.rollMode', type, value);
  }
  // dnd5e 5's actor-wide modes; a5e spreads these keys over every roll of the kind.
  if (key === 'system.rolls.attack.mode') {
    return rollMode('flags.a5e.effects.rollMode.attack.all', type, value);
  }
  if ((m = key.match(/^system\.rolls\.ability\.(check|save)\.mode$/))) {
    const all = m[1] === 'check' ? 'abilityCheck' : 'abilitySave';
    return rollMode(`flags.a5e.effects.rollMode.${all}.all`, type, value);
  }

  // Reliable minimums.
  if ((m = key.match(/^system\.abilities\.([a-z]{3})\.(save|check)\.roll\.min$/)) && ABILITIES.includes(m[1])) {
    return [change(`system.abilities.${m[1]}.${m[2]}.minRoll`, type, scalar(value))];
  }
  if ((m = key.match(/^system\.skills\.([a-z]{3})\.roll\.min$/)) && SKILLS.includes(m[1])) {
    return [change(`system.skills.${m[1]}.minRoll`, type, scalar(value))];
  }
  if (key === 'system.attributes.concentration.roll.min') {
    return [change('system.attributes.concentration.minRoll', type, scalar(value))];
  }
  if (key === 'system.attributes.init.roll.min') {
    return [change('system.attributes.initiative.minRoll', type, scalar(value))];
  }

  // Skill proficiency: 0 / 0.5 / 1 / 2 in dnd5e, no half-proficiency in a5e.
  if ((m = key.match(/^system\.skills\.([a-z]{3})\.value$/)) && SKILLS.includes(m[1])) {
    const n = Number(value);
    return [change(`system.skills.${m[1]}.proficient`, type === 'custom' ? 'override' : type, n >= 2 ? 2 : n >= 1 ? 1 : 0)];
  }

  // Bonuses: flat strings in dnd5e, structured entries in a5e.
  if ((m = key.match(/^system\.bonuses\.(mwak|rwak|msak|rsak)\.attack$/))) {
    return [attackBonus(label, value, [ATTACK_TYPES[m[1]]])];
  }
  if ((m = key.match(/^system\.bonuses\.(mwak|rwak|msak|rsak)\.damage$/))
    || (m = key.match(/^system\.rolls\.damage\.(mwak|rwak|msak|rsak)\.bonus$/))) {
    return [damageBonus(label, value, [ATTACK_TYPES[m[1]]])];
  }
  if ((m = key.match(/^system\.bonuses\.abilities\.(save|check)$/))) {
    // A global ability bonus in a5e names all six abilities; anything less is
    // read as a specific one.
    return [abilityBonus(label, value, [...ABILITIES], [m[1]])];
  }
  if ((m = key.match(/^system\.abilities\.([a-z]{3})\.bonuses\.(save|check)$/)) && ABILITIES.includes(m[1])) {
    return [abilityBonus(label, value, [m[1]], [m[2]])];
  }
  if (key === 'system.bonuses.abilities.skill') {
    return [skillBonus(label, value, [...SKILLS])];
  }
  if ((m = key.match(/^system\.skills\.([a-z]{3})\.bonuses\.(check|passive)$/)) && SKILLS.includes(m[1])) {
    return [skillBonus(label, value, [m[1]], m[2] === 'passive')];
  }
  if (key === 'system.bonuses.spell.dc') {
    return [change('system.bonuses.spellDC', 'add', scalar(value))];
  }

  // Critical thresholds: a5e reads these flags off the actor.
  if (key === 'flags.dnd5e.weaponCriticalThreshold') {
    return [change('flags.a5e.criticalHitThresholdWeapon', type, scalar(value))];
  }
  if (key === 'flags.dnd5e.spellCriticalThreshold') {
    return [change('flags.a5e.criticalHitThresholdSpell', type, scalar(value))];
  }

  // Light and vision on the token: a5e prefixes these with `@token.`.
  if ((m = key.match(/^(?:token|ATL)\.(.+)$/))) {
    return [change(`@token.${m[1]}`, type === 'custom' ? 'override' : type, scalar(value))];
  }

  return null;
}

/** Collapse dnd5e's armour-class calculation into the formula a5e wants. */
function armorChange(changes) {
  const calc = changes.find((c) => normalizeKey(c?.key) === 'system.attributes.ac.calc');
  if (!calc) return null;

  const id = String(calc.value ?? '').trim();
  if (id === 'custom') {
    const own = changes.find((c) => normalizeKey(c?.key) === 'system.attributes.ac.formula');
    return own ? change('system.attributes.ac.baseFormula', 'override', String(formula(own.value))) : null;
  }
  return AC_CALCS[id] ? change('system.attributes.ac.baseFormula', 'override', AC_CALCS[id]) : null;
}

const AC_PARTS = /^system\.attributes\.ac\.(calc|formula)$/;

/**
 * Translate one dnd5e active effect into a5e's shape.
 *
 * @param {object} effect  dnd5e effect data — or one Foundry 14 has already
 *                         migrated, its changes moved to `system.changes`
 * @param {object} [opts]
 * @param {{ self: boolean }} [opts.delivery]  set when one of the item's
 *                         activities applies the effect, and to whom
 * @param {string} [opts.parent]  "Actor" for an effect on the actor itself
 * @returns {object|null}  null for an effect a5e has no way to represent
 */
export function translateEffect(effect, { delivery = null, parent = 'Item' } = {}) {
  if (!effect || typeof effect !== 'object') return null;

  // Already in a5e's shape.
  if (effect.flags?.['plutonium-a5e']?.converted) return effect;

  // An enchantment changes the item it sits on, which a5e has no mechanism for;
  // applied to an actor its changes would rename it or corrupt its data.
  if (effect.type === 'enchantment') return null;

  const label = String(effect.name ?? '');
  const source = Array.isArray(effect.changes) && effect.changes.length
    ? effect.changes
    : (effect.system?.changes ?? []);
  const changes = [];
  const droppedKeys = [];

  for (const c of source) {
    if (!c?.key || AC_PARTS.test(normalizeKey(c.key))) continue;
    const out = translateChange(c, { label });
    if (out) changes.push(...out);
    else droppedKeys.push(c.key);
  }

  const ac = armorChange(source);
  if (ac) changes.push(ac);

  // Conditions: a5e's own effects carry them twice — as Foundry statuses, which
  // the token shows, and as a change, which a5e's rules read.
  const statuses = [...new Set([...(effect.statuses ?? [])].map((s) => String(s).toLowerCase()))]
    .filter((s) => A5E_CONDITIONS.has(s));
  if (statuses.length) {
    changes.push(change('flags.a5e.effects.statusConditions', 'custom', statuses));
  }

  // Who the effect is for. An activity that names it delivers it — to its user
  // when the activity targets the user, otherwise to whoever it is aimed at —
  // so it is a5e's "on use" and must not sit on the owner as well; dnd5e keeps
  // such an effect disabled until the activity copies it out, a5e copies it as
  // it is, so it is enabled here. Otherwise dnd5e's `transfer` says whether the
  // owner carries it. An effect on the actor itself is simply in force.
  let effectType;
  let applyToSelf = false;
  let disabled = !!effect.disabled;
  if (parent === 'Actor') {
    effectType = 'passive';
  } else if (delivery) {
    effectType = 'onUse';
    applyToSelf = !!delivery.self;
    disabled = false;
  } else {
    effectType = effect.transfer ? 'passive' : 'onUse';
  }

  const { changes: _core, system: _system, type: _type, ...rest } = effect;

  const out = {
    ...rest,
    type: 'base',
    statuses,
    transfer: effectType === 'passive',
    disabled,
    system: {
      changes,
      effectType,
      applyToSelf,
      default: true,
    },
    flags: {
      ...(effect.flags ?? {}),
      'plutonium-a5e': {
        ...(effect.flags?.['plutonium-a5e'] ?? {}),
        converted: true,
        // Kept so what was dropped can be seen, not inferred.
        droppedKeys,
      },
    },
  };
  if (typeof effect.description === 'string' && effect.description) {
    out.description = translateDescription(effect.description);
  }
  return out;
}

/**
 * Translate an effects array, keeping only those a5e can represent.
 * @param {object[]} effects
 * @param {object} [opts]
 * @param {Map<string, {self: boolean}>} [opts.delivery]  by effect id
 * @param {string} [opts.parent]
 */
export function translateEffects(effects, { delivery = null, parent = 'Item' } = {}) {
  return (Array.isArray(effects) ? effects : [])
    .map((e) => translateEffect(e, { delivery: delivery?.get(e?._id) ?? null, parent }))
    .filter(Boolean);
}
