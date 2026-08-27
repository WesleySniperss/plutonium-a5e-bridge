import { ABILITIES, ACTOR_TYPE, DISTANCE_UNITS, SIZE, SKILLS, pick } from './maps.js';
import { debug } from '../util/log.js';

const MOVEMENT_KEYS = ['walk', 'burrow', 'climb', 'fly', 'swim'];
const SENSE_KEYS = ['blindsight', 'darkvision', 'tremorsense', 'truesight'];

export function abilityMod(score) {
  return Math.floor(((Number(score) || 10) - 10) / 2);
}

/** Monster proficiency bonus from CR, per the standard table. */
export function profBonusFromCr(cr) {
  const n = Number(cr) || 0;
  return Math.max(2, Math.floor((n - 1) / 4) + 2);
}

function abilitiesOf(system) {
  const out = {};
  ABILITIES.forEach((abl) => {
    const src = system?.abilities?.[abl] ?? {};
    out[abl] = {
      value: Number(src.value) || 10,
      check: { expertiseDice: 0, bonus: '' },
      save: {
        proficient: !!src.proficient,
        expertiseDice: 0,
        bonus: '',
        ...(abl === 'con' ? { concentrationBonus: '' } : {}),
      },
    };
  });
  return out;
}

function skillsOf(system) {
  const out = {};
  SKILLS.forEach((skl) => {
    const src = system?.skills?.[skl] ?? {};
    const value = Number(src.value) || 0;
    out[skl] = {
      // dnd5e uses 0 / 0.5 / 1 / 2; a5e has no half-proficiency, so it rounds down.
      proficient: value >= 2 ? 2 : value >= 1 ? 1 : 0,
      ability: src.ability || undefined,
      expertiseDice: 0,
      specialties: [],
      minRoll: 1,
      bonuses: { check: '', passive: 0 },
    };
    if (!out[skl].ability) delete out[skl].ability;
  });
  return out;
}

function movementOf(system) {
  const mv = system?.attributes?.movement ?? {};
  const unit = mv.units === 'mi' ? 'miles' : pick(DISTANCE_UNITS, mv.units, 'feet');
  const out = { traits: { hover: !!mv.hover } };
  MOVEMENT_KEYS.forEach((key) => {
    out[key] = { distance: Number(mv[key]) || 0, unit };
  });
  return out;
}

function sensesOf(system) {
  const sn = system?.attributes?.senses ?? {};
  const unit = pick(DISTANCE_UNITS, sn.units, 'feet');
  const out = {};
  SENSE_KEYS.forEach((key) => {
    out[key] = { distance: Number(sn[key]) || 0, unit };
    if (key === 'blindsight') out[key].otherwiseBlind = false;
  });
  return out;
}

// dnd5e stores AC as a calculation plus a flat override; a5e stores one formula.
function acFormulaOf(system) {
  const ac = system?.attributes?.ac ?? {};
  const flat = Number(ac.flat);
  if (Number.isFinite(flat) && flat > 0) return String(flat);
  if (ac.formula) return String(ac.formula);
  return '10 + @dex.mod';
}

// NPC hit dice live in the HP formula, e.g. "7d8 + 14".
function hitDiceOf(system) {
  const out = {};
  ['d4', 'd6', 'd8', 'd10', 'd12', 'd20'].forEach((d) => { out[d] = { current: 0, total: 0 }; });

  const formula = String(system?.attributes?.hp?.formula ?? '');
  const match = formula.match(/(\d+)\s*d\s*(\d+)/i);
  if (!match) return out;

  const key = `d${match[2]}`;
  if (!out[key]) return out;
  const count = Number(match[1]) || 0;
  out[key] = { current: count, total: count };
  return out;
}

function alignmentOf(system) {
  const raw = String(system?.details?.alignment ?? '').toLowerCase();
  if (!raw) return [];
  const words = ['lawful', 'chaotic', 'good', 'evil', 'neutral'];
  return words.filter((w) => raw.includes(w));
}

function creatureTypesOf(system) {
  const type = system?.details?.type ?? {};
  const value = type.value || type.custom;
  return value ? [String(value)] : [];
}

// dnd5e trait blocks are `{ value: [], custom: "", bypasses: [] }`.
function traitList(block) {
  if (!block) return [];
  const values = block.value ? [...block.value] : [];
  const custom = String(block.custom ?? '').split(';').map((s) => s.trim()).filter(Boolean);
  return [...values, ...custom];
}

function resourcesOf(system) {
  const res = system?.resources ?? {};
  const out = {};
  const slots = [
    ['primary', res.legact, 'Legendary Actions'],
    ['secondary', res.legres, 'Legendary Resistances'],
    ['tertiary', res.lair, 'Lair Actions'],
  ];

  slots.forEach(([key, src, label]) => {
    const max = Number(src?.max) || 0;
    if (!max) return;
    out[key] = {
      label,
      value: Number(src?.value) || max,
      max: String(max),
      per: 'round',
      hideMax: false,
      recharge: { formula: '1d6', threshold: 6 },
    };
  });

  return out;
}

/**
 * Translate one dnd5e-shaped Actor document into an a5e-shaped one.
 * Embedded items are left alone here — Plutonium creates them separately through
 * `pCreateEmbeddedDocuments`, and the bridge translates them there.
 */
// A spellcasting monster keeps its slots in dnd5e as `system.spells.spell1.max`
// and so on; a5e keeps the same numbers in `spellResources.slots`, keyed 1-9
// with a current and a max. Without them an imported archmage has every spell
// prepared and no way to cast one, because the slot consumer has nothing to
// spend. a5e's own conversion of the same monsters fills this in — its Archmage
// carries 4/3/3/3/3/1/1/1/1.
//
// Warlock-style pact slots are folded into the level they are cast at, which is
// the closest a5e has for a monster with no pact progression of its own.
function spellSlotsOf(system) {
  const spells = system?.spells;
  if (!spells) return null;

  const slots = {};
  let any = false;

  for (let level = 1; level <= 9; level += 1) {
    const entry = spells[`spell${level}`] ?? {};
    const max = Number(entry.max) || 0;
    const current = Number.isFinite(Number(entry.value)) ? Number(entry.value) : max;
    slots[level] = { current: Math.max(0, current), max };
    if (max) any = true;
  }

  const pact = spells.pact ?? {};
  const pactLevel = Number(pact.level) || 0;
  const pactMax = Number(pact.max) || 0;
  if (pactLevel >= 1 && pactLevel <= 9 && pactMax) {
    slots[pactLevel] = {
      current: slots[pactLevel].current + (Number(pact.value) || pactMax),
      max: slots[pactLevel].max + pactMax,
    };
    any = true;
  }

  return any ? slots : null;
}

export function translateActor(data) {
  const a5eType = ACTOR_TYPE[data.type];
  if (!a5eType) {
    debug(`No a5e actor type for dnd5e "${data.type}" — passing through untouched.`);
    return data;
  }

  const system = data.system ?? {};
  const hp = system.attributes?.hp ?? {};
  const cr = Number(system.details?.cr) || 0;

  const out = {
    ...data,
    type: a5eType,
    system: {
      source: String(system.details?.source?.book ?? system.details?.source?.custom ?? ''),

      abilities: abilitiesOf(system),
      skills: skillsOf(system),

      attributes: {
        ac: { baseFormula: acFormulaOf(system), value: 0 },
        hp: {
          value: Number(hp.value) || Number(hp.max) || 1,
          baseMax: Number(hp.max) || Number(hp.value) || 1,
          temp: Number(hp.temp) || 0,
          bonus: 0,
        },
        hitDice: hitDiceOf(system),
        initiative: {
          ability: system.attributes?.init?.ability || 'dex',
          bonus: String(system.attributes?.init?.bonus ?? ''),
          expertiseDice: 0,
        },
        movement: movementOf(system),
        senses: sensesOf(system),
        spellcasting: system.attributes?.spellcasting || '',
        casterLevel: Number(system.details?.spellLevel) || 0,
        death: { success: 0, failure: 0 },
      },

      details: {
        cr,
        bio: String(system.details?.biography?.value ?? ''),
        creatureTypes: creatureTypesOf(system),
        isSwarm: !!system.details?.type?.swarm,
        isShapechanger: false,
        isSquad: false,
        elite: false,
        // dnd5e's "public" biography is the one players can read, so it belongs
        // in a5e's player-visible notes — not in the GM-only private ones.
        notes: String(system.details?.biography?.public ?? ''),
        privateNotes: '',
        terrain: [],
      },

      traits: {
        size: pick(SIZE, system.traits?.size, 'med'),
        alignment: alignmentOf(system),
        conditionImmunities: traitList(system.traits?.ci),
        damageImmunities: traitList(system.traits?.di),
        damageResistances: traitList(system.traits?.dr),
        damageVulnerabilities: traitList(system.traits?.dv),
      },

      proficiencies: {
        armor: [],
        languages: traitList(system.traits?.languages),
        tools: [],
        weapons: [],
        traditions: [],
      },

      currency: {
        cp: Number(system.currency?.cp) || 0,
        sp: Number(system.currency?.sp) || 0,
        ep: Number(system.currency?.ep) || 0,
        gp: Number(system.currency?.gp) || 0,
        pp: Number(system.currency?.pp) || 0,
        cr: 0,
      },

      resources: resourcesOf(system),
    },
  };

  // Only written when the creature actually has slots: the field is a full 1-9
  // record, and stamping an empty one on every goblin would put a spell-slot
  // tracker on the sheet of something that has never cast anything.
  const slots = spellSlotsOf(system);
  if (slots) out.system.spellResources = { slots };

  out.flags = {
    ...(data.flags ?? {}),
    'plutonium-a5e': { sourceType: data.type, converted: true },
  };

  return out;
}

/**
 * Ability modifiers and proficiency bonus for an actor, used to keep converted
 * attack bonuses matching the original statblock.
 */
export function actorRollContext(actor) {
  if (!actor) return null;

  const abilities = {};
  ABILITIES.forEach((abl) => {
    const value = actor.system?.abilities?.[abl]?.value;
    abilities[abl] = abilityMod(value);
  });

  const prof = Number(actor.system?.attributes?.prof)
    || profBonusFromCr(actor.system?.details?.cr);

  return {
    abilityMod: (abl) => abilities[abl] ?? 0,
    profBonus: prof,
    spellcastingAbility: actor.system?.attributes?.spellcasting || 'int',
  };
}
