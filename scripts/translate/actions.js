import {
  ACTIVATION,
  AREA_SHAPE,
  DAMAGE_TYPES,
  DISTANCE_UNITS,
  DURATION_UNITS,
  NAMED_FEET_RANGES,
  RECOVERY_PERIOD,
  TARGET_TYPE,
  pick,
} from './maps.js';

// dnd5e 5.x hangs everything rollable off `system.activities`: a keyed record of
// activity objects, each with its own activation, range, target and roll data.
// a5e's equivalent is `system.actions`, also a keyed record, but it splits rolls
// (things the item's owner rolls) from prompts (things it asks targets for).
//
// This module is the whole reason imported content stays clickable: an attack
// activity has to come out the other side as an a5e action with an `attack` roll
// and `damage` rolls, or the item is just a block of text on the sheet.

const id = () => foundry.utils.randomID();

/**
 * a5e has no "+1 weapon" field — its own magic items write the bonus straight
 * into the formula (its +2 plate is literally `"18 + 2"`). dnd5e keeps it apart
 * in `system.magicalBonus`, so folding it in here is what makes an imported +1
 * longsword actually hit and hurt for one more.
 */
export function withMagic(value, magic) {
  const bonus = Number(magic) || 0;
  if (!bonus) return String(value ?? '');

  const base = String(value ?? '').trim();
  if (!base) return String(bonus);
  return bonus > 0 ? `${base} + ${bonus}` : `${base} - ${Math.abs(bonus)}`;
}

/** dnd5e damage part -> a dice formula string. */
export function damageFormula(part) {
  if (!part) return '';
  if (part.custom?.enabled) return String(part.custom.formula ?? '').trim();

  const number = Number(part.number) || 0;
  const denom = Number(part.denomination) || 0;
  const bonus = String(part.bonus ?? '').trim();

  const dice = number && denom ? `${number}d${denom}` : '';
  if (dice && bonus) return `${dice} + ${bonus}`;
  return dice || bonus;
}

function damageTypeOf(part) {
  const types = part?.types ?? [];
  const first = Array.isArray(types) ? types[0] : [...(types ?? [])][0];
  return DAMAGE_TYPES.has(first) ? first : '';
}

/** dnd5e scaling block -> a5e roll scaling. Only per-slot-level scaling survives. */
function scalingOf(part, { isSpell }) {
  const mode = part?.scaling?.mode;
  const number = Number(part?.scaling?.number) || 0;
  if (!mode || !number) return {};

  if (mode === 'whole' || mode === 'half') {
    return isSpell
      ? { mode: 'spellLevel', formula: `${number}d${part.denomination ?? 6}` }
      : {};
  }
  if (mode === 'cantrip') {
    return { mode: 'cantrip', formula: `${number}d${part.denomination ?? 6}` };
  }
  return {};
}

function rollBase(label, isDefault = true) {
  return { default: isDefault, label: label ?? '' };
}

function attackTypeOf(attack) {
  const melee = (attack?.type?.value ?? 'melee') !== 'ranged';
  const spell = attack?.type?.classification === 'spell';
  if (melee) return spell ? 'meleeSpellAttack' : 'meleeWeaponAttack';
  return spell ? 'rangedSpellAttack' : 'rangedWeaponAttack';
}

// dnd5e leaves `ability` empty to mean "whatever the item implies"; a5e wants a
// concrete key, and the system's own dnd5e conversions always name one.
function attackAbilityOf(attack, ctx) {
  const abl = attack?.ability;
  if (abl && !['none', 'spellcasting', 'mod', ''].includes(abl)) return abl;
  if (attack?.type?.classification === 'spell') return ctx?.spellcastingAbility || 'int';

  const dflt = attack?.type?.value === 'ranged' ? 'dex' : 'str';

  // A statblock only prints the total, so the ability behind it is a guess. When
  // we know the creature, prefer the one that reproduces the printed number with
  // no leftover bonus — that is how a finesse attacker ends up on dex.
  const total = Number(String(attack?.bonus ?? '').replace(/^\+/, ''));
  if (!attack?.flat || !Number.isFinite(total) || !ctx?.abilityMod) return dflt;

  const candidates = dflt === 'dex' ? ['dex', 'str'] : ['str', 'dex'];
  const exact = candidates.find((c) => ctx.abilityMod(c) + (ctx.profBonus || 0) === total);
  return exact ?? dflt;
}

// A statblock attack is a single flat number ("+4 to hit"), while a5e always
// rolls ability + proficiency + bonus. When we know the actor we can solve for
// the residual bonus so the total still matches the printed statblock; without
// an actor we keep whatever dnd5e had.
function attackBonusOf(attack, ability, ctx) {
  const raw = String(attack?.bonus ?? '').trim();
  if (!attack?.flat) return raw;

  const total = Number(raw.replace(/^\+/, ''));
  if (!Number.isFinite(total) || !ctx?.abilityMod) return raw;

  const delta = total - ctx.abilityMod(ability) - (ctx.profBonus || 0);
  return delta ? String(delta) : '';
}

function addDamageRolls(rolls, parts, {
  isSpell, canCrit = true, critBonus = '', impliedAbility = null, magicBonus = 0,
}) {
  (parts ?? []).forEach((part) => {
    let formula = damageFormula(part);
    if (!formula) return;

    // A weapon's dnd5e damage is just the dice — the system adds the ability
    // modifier at roll time. a5e does not, so it has to go into the formula.
    // Statblock damage already carries a flat bonus, and is left exactly as-is.
    const hasBonus = !!String(part.bonus ?? '').trim() || part.custom?.enabled;
    if (impliedAbility && !hasBonus) formula = `${formula} + @${impliedAbility}.mod`;
    formula = withMagic(formula, magicBonus);

    rolls[id()] = {
      ...rollBase(''),
      type: 'damage',
      formula,
      damageType: damageTypeOf(part),
      canCrit,
      critBonus: critBonus ?? '',
      scaling: scalingOf(part, { isSpell }),
    };
  });
}

function addHealingRoll(rolls, healing, { isSpell }) {
  const formula = damageFormula(healing);
  if (!formula) return;
  const types = healing?.types ?? [];
  const isTemp = (Array.isArray(types) ? types : [...types]).includes('temphp');
  rolls[id()] = {
    ...rollBase(''),
    type: 'healing',
    formula,
    healingType: isTemp ? 'temporaryHealing' : 'healing',
    scaling: scalingOf(healing, { isSpell }),
  };
}

function savePrompt(save, onSave) {
  const abilities = Array.isArray(save?.ability) ? save.ability : [save?.ability];
  const ability = abilities.filter(Boolean)[0] ?? 'con';
  const calc = save?.dc?.calculation;

  return {
    ...rollBase(''),
    type: 'savingThrow',
    ability,
    saveDC: {
      // dnd5e uses "" for a flat DC and an ability key or "spellcasting" otherwise.
      type: !calc ? 'custom' : calc === 'spellcasting' ? 'spellcasting' : calc,
      bonus: String(save?.dc?.formula ?? ''),
    },
    // a5e stores this as display text, and its own content says "Half damage".
    onSave: onSave === 'half' ? 'Half damage' : '',
  };
}

// a5e expends spell slots (or spell points) through an explicit consumer on the
// action; without one, casting an imported spell costs nothing.
const SPELL_POINT_COST = { 0: 0, 1: 2, 2: 3, 3: 5, 4: 6, 5: 7, 6: 9, 7: 10, 8: 11, 9: 13 };

function spellConsumer(level) {
  const lvl = Number(level) || 0;
  if (!lvl) return null;
  return {
    type: 'spell',
    mode: 'variable',
    spellLevel: lvl,
    points: SPELL_POINT_COST[lvl] ?? 0,
    charges: 0,
    default: true,
    label: '',
  };
}

function rangeRecord(range) {
  if (!range) return {};
  const units = range.units;

  if (units === 'self') return { [id()]: { range: 'self', unit: '' } };
  if (units === 'touch') return { [id()]: { range: 'touch', unit: '' } };
  if (units === 'spec' || units === 'any') {
    const text = String(range.special ?? '').trim();
    return text ? { [id()]: { range: text, unit: '' } } : {};
  }

  const unit = pick(DISTANCE_UNITS, units, 'feet');
  const value = Number(range.value);
  if (!value) return {};

  const named = unit === 'feet' ? NAMED_FEET_RANGES[value] : null;
  return { [id()]: { range: named ?? value, unit: named ? 'feet' : unit } };
}

function areaOf(target) {
  const tpl = target?.template;
  const shape = pick(AREA_SHAPE, tpl?.type, null);
  if (!shape) return undefined;

  const size = Number(tpl.size) || 0;
  const width = Number(tpl.width) || 0;
  const height = Number(tpl.height) || 0;

  const area = { shape, quantity: Number(tpl.count) || 1, scaling: {}, default: true, label: '' };

  switch (shape) {
    case 'circle':
    case 'sphere':
    case 'emanation':
    case 'cylinder':
      area.radius = size;
      if (shape === 'cylinder') area.height = height;
      break;
    case 'cone':
      area.length = size;
      break;
    case 'line':
      area.length = size;
      area.width = width || 5;
      break;
    case 'cube':
    case 'square':
      area.width = size;
      break;
    case 'wall':
      area.length = size;
      area.width = width || 5;
      area.height = height || 10;
      break;
    default:
      break;
  }

  return area;
}

function targetOf(target) {
  const affects = target?.affects;
  if (!affects) return undefined;
  const type = pick(TARGET_TYPE, affects.type, '');
  if (!type && !affects.count && !affects.special) return undefined;
  return {
    type,
    quantity: Number(affects.count) || 1,
    otherText: String(affects.special ?? ''),
    scaling: {},
    heard: false,
    seen: false,
  };
}

/** dnd5e `uses` -> a5e `uses`. a5e counts remaining, dnd5e counts spent. */
export function convertUses(uses) {
  if (!uses) return undefined;

  const max = String(uses.max ?? '').trim();
  const spent = Number(uses.spent) || 0;
  const maxNum = Number(max);
  const value = Number.isFinite(maxNum) && max !== '' ? Math.max(0, maxNum - spent) : 0;

  const recovery = (uses.recovery ?? [])[0];
  const per = pick(RECOVERY_PERIOD, recovery?.period, '');
  const isFormulaRecovery = recovery?.type === 'formula';

  const out = {
    value,
    max,
    per,
    recharge: {
      formula: String(recovery?.formula ?? ''),
      threshold: 0,
      type: isFormulaRecovery ? 'formula' : 'recoverAll',
    },
  };

  // dnd5e writes recharge as period "charges" with a formula like "1d6"; a5e wants
  // the threshold split out of the "Recharge N" wording, which Plutonium keeps in
  // `recovery.formula`. Best effort: a bare number formula is the threshold.
  if (per === 'recharge') {
    const threshold = Number(recovery?.formula);
    if (Number.isFinite(threshold)) {
      out.recharge.formula = '1d6';
      out.recharge.threshold = threshold;
    } else {
      out.recharge.threshold = 6;
    }
  }

  return out;
}

/**
 * Convert one dnd5e activity into one a5e action.
 * @returns {object|null} null for activity types a5e cannot represent at all.
 */
export function activityToAction(activity, opts = {}) {
  if (!activity) return null;

  const { isSpell = false, itemName = '', img = '' } = opts;
  const type = activity.type;
  // Cast/summon/enchant/order lean on dnd5e machinery with no a5e counterpart.
  // Dropping them silently would lose the text, so they become plain actions.
  const rolls = {};
  const prompts = {};

  switch (type) {
    case 'attack': {
      const ability = attackAbilityOf(activity.attack, opts);
      rolls[id()] = {
        ...rollBase(''),
        type: 'attack',
        attackType: attackTypeOf(activity.attack),
        ability,
        bonus: withMagic(attackBonusOf(activity.attack, ability, opts), opts.magicBonus),
        critThreshold: Number(activity.attack?.critical?.threshold) || 20,
        proficient: true,
      };
      addDamageRolls(rolls, activity.damage?.parts, {
        isSpell,
        critBonus: activity.damage?.critical?.bonus ?? '',
        impliedAbility: opts.isWeapon ? ability : null,
        magicBonus: opts.magicBonus,
      });
      break;
    }

    case 'save': {
      prompts[id()] = savePrompt(activity.save, activity.damage?.onSave);
      // Nothing crits on a saving throw.
      addDamageRolls(rolls, activity.damage?.parts, { isSpell, canCrit: false });
      break;
    }

    case 'damage': {
      addDamageRolls(rolls, activity.damage?.parts, {
        isSpell,
        canCrit: activity.damage?.critical?.allow !== false,
        critBonus: activity.damage?.critical?.bonus ?? '',
      });
      break;
    }

    case 'heal': {
      addHealingRoll(rolls, activity.healing, { isSpell });
      break;
    }

    case 'check': {
      const ability = activity.check?.ability;
      const skill = (activity.check?.associated ?? [])[0];
      prompts[id()] = skill
        ? { ...rollBase(''), type: 'skillCheck', skill, ability: ability ?? '' }
        : { ...rollBase(''), type: 'abilityCheck', ability: ability ?? 'str' };
      break;
    }

    case 'utility': {
      const formula = String(activity.roll?.formula ?? '').trim();
      if (formula) {
        rolls[id()] = {
          ...rollBase(activity.roll?.name ?? ''),
          type: 'generic',
          formula,
          scaling: {},
        };
      }
      break;
    }

    default:
      break;
  }

  const activationType = pick(ACTIVATION, activity.activation?.type, 'none');
  const area = areaOf(activity.target);
  const target = targetOf(activity.target);

  const action = {
    name: activity.name || itemName || 'Action',
    img: activity.img || img || '',
    description: String(activity.description?.chatFlavor ?? ''),
    descriptionOutputs: ['item', 'action'],
    default: false,
    activation: {
      type: activationType,
      cost: Number(activity.activation?.value) || (activationType === 'none' ? 0 : 1),
      reactionTrigger: String(activity.activation?.condition ?? ''),
    },
    duration: {
      unit: pick(DURATION_UNITS, activity.duration?.units, ''),
      value: String(activity.duration?.value ?? ''),
      concentration: !!activity.duration?.concentration,
    },
    ranges: rangeRecord(activity.range),
    rolls,
    prompts,
    consumers: {},
    effects: [],
    macro: '',
  };

  if (area) action.area = area;
  if (target) action.target = target;

  const consumer = isSpell ? spellConsumer(opts.spellLevel) : null;
  if (consumer) action.consumers[id()] = consumer;

  const uses = convertUses(activity.uses);
  if (uses && (uses.max || uses.per)) action.uses = uses;

  return action;
}

/**
 * Convert a whole `system.activities` record into a `system.actions` record.
 * The first action is flagged `default` so a5e's sheet has something to fire.
 */
export function activitiesToActions(activities, opts = {}) {
  const actions = {};
  const entries = Object.entries(activities ?? {});
  if (!entries.length) return actions;

  entries.forEach(([, activity]) => {
    const action = activityToAction(activity, opts);
    if (action) actions[id()] = action;
  });

  const first = Object.values(actions)[0];
  if (first) first.default = true;

  return actions;
}
