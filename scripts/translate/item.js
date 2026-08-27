import {
  activitiesToActions,
  addUsesConsumer,
  convertUses,
  defaultAction,
  withMagic,
} from './actions.js';
import {
  EQUIPMENT_SUBTYPE,
  FEATURE_TYPE,
  ITEM_TYPE,
  MATERIAL_PROPERTY,
  OBJECT_TYPE,
  RARITY,
  SPELL_SCHOOL,
  WEAPON_PROPERTY,
  classSlug,
  pick,
} from './maps.js';
import {
  FLAG_SCOPE,
  classFeatureMeta,
  classMeta,
  isClassFeatureItem,
  isOptionalFeatureItem,
  optionalFeatureMeta,
  isSubclassFeatureItem,
  resourcesFromAdvancement,
  spellcastingOf,
  subclassFeatureMeta,
  translateSubclass,
} from './origins.js';
import { resourcesFromClassTable } from '../class-table.js';
import { debug } from '../util/log.js';

// dnd5e keeps item properties as a Set; it arrives as an array or a Set depending
// on where in Plutonium it was built.
function props(system) {
  const p = system?.properties;
  if (!p) return new Set();
  return new Set(Array.isArray(p) ? p : [...p]);
}

function descriptionOf(system) {
  return String(system?.description?.value ?? '');
}

// dnd5e 5.x source is an object; a5e wants one string.
function sourceOf(system) {
  const src = system?.source;
  if (!src) return '';
  if (typeof src === 'string') return src;
  return String(src.custom || src.book || '');
}

function priceOf(system) {
  const price = system?.price;
  return {
    value: Number(price?.value) || 0,
    denomination: price?.denomination || 'gp',
    special: '',
  };
}

function weightOf(system) {
  const weight = system?.weight;
  if (typeof weight === 'number') return weight;
  return Number(weight?.value) || 0;
}

// --- objects ---------------------------------------------------------------

function objectTypeOf(data) {
  const { type, system } = data;
  if (type === 'equipment') {
    const sub = EQUIPMENT_SUBTYPE[system?.type?.value];
    if (sub) return sub;
    return { objectType: 'miscellaneous' };
  }
  return { objectType: pick(OBJECT_TYPE, type, 'miscellaneous') };
}

// dnd5e stores armour as a flat AC plus a dex cap. a5e splits the same thing in
// two: the formula carries a plain `@dex.mod`, and the cap lives in `maxDex`,
// because `ItemA5e.prepareArmorData()` rewrites the one into
// `min(@dex.mod, <maxDex>)` at prepare time. Writing the `min()` ourselves as
// well would nest it twice, so we store it the way a5e's own armour is stored —
// checked against the system's `adventuringGear` pack:
//
//   plate       "18"              mode 2, maxDex 0, minStr 15
//   half plate  "15 + @dex.mod"   mode 2, maxDex 2, minStr 13
//   leather     "12 + @dex.mod"   mode 2, maxDex 0
//   shield      "2"               mode 1, maxDex 0
//
// Heavy armour has no `@dex.mod` term at all: 5e ignores Dexterity in heavy
// armour, including a negative modifier, which a cap of 0 would not reproduce.
function armorOf(data, kind) {
  const system = data.system ?? {};
  const base = Number(system.armor?.value);
  if (!Number.isFinite(base) || !base) return null;

  const isShield = kind.objectType === 'shield';
  const usesDex = !isShield && kind.armorCategory !== 'heavy';

  const declared = Number(system.armor?.dex);
  const maxDex = declared > 0 ? declared : (kind.armorCategory === 'medium' ? 2 : 0);

  // a5e has no magic-bonus field; its own +2 plate is stored as "18 + 2".
  const withBonus = withMagic(base, system.armor?.magicalBonus);

  return {
    // Shields add to AC; body armour replaces the base formula.
    mode: isShield ? 1 : 2,
    baseFormula: usesDex ? `${withBonus} + @dex.mod` : withBonus,
    formula: '',
    maxDex: usesDex ? maxDex : 0,
    minStr: Number(system.strength) || 0,
    grantsDisadvantage: props(system).has('stealthDisadvantage'),
    requiresNoShield: false,
    requiresUnarmored: false,
  };
}

function versatileDieOf(system) {
  const part = system?.damage?.versatile;
  if (!part) return '';
  const denom = Number(part.denomination);
  return denom ? `d${denom}` : '';
}

function toObject(data, ctx) {
  const system = data.system ?? {};
  const flags = props(system);
  const kind = objectTypeOf(data);

  const out = {
    description: descriptionOf(system),
    secretDescription: '',
    source: sourceOf(system),
    favorite: false,
    macro: '',

    ...kind,

    quantity: Number(system.quantity) || 1,
    weight: weightOf(system),
    price: priceOf(system),
    rarity: pick(RARITY, system.rarity, 'mundane'),
    bulky: false,
    plotItem: false,
    // dnd5e uses null for "work it out from the owner"; a5e wants a straight
    // boolean, and assuming proficiency is right far more often than not.
    proficient: system.proficient == null ? true : !!system.proficient,

    requiresAttunement: !!system.attunement,
    attuned: !!system.attuned,
    attunementHint: system.attunement === 'optional' ? 'Attunement optional' : '',

    equippedState: system.equipped ? 2 : 1,
    unidentified: system.identified === false,
    unidentifiedDescription: String(system.unidentified?.description ?? ''),
    unidentifiedName: String(system.unidentified?.name ?? ''),

    weaponProperties: [...flags].map((p) => WEAPON_PROPERTY[p]).filter(Boolean),
    materialProperties: [...flags].map((p) => MATERIAL_PROPERTY[p]).filter(Boolean),
    armorProperties: [],
    ammunitionProperties: [],
    versatile: versatileDieOf(system),

    actions: activitiesToActions(system.activities, {
      itemName: data.name,
      img: data.img,
      description: descriptionOf(system),
      ...ctx,
      isWeapon: kind.objectType === 'weapon',
      magicBonus: Number(system.magicalBonus) || 0,
      // Lives on the item in dnd5e, not the activity, so the action builder
      // cannot reach it on its own.
      versatileDamage: kind.objectType === 'weapon' ? (system.damage?.versatile ?? null) : null,
    }),
  };

  if (kind.objectType !== 'weapon') out.weaponProperties = [];

  const ac = armorOf(data, kind);
  if (ac) out.ac = ac;

  const uses = convertUses(system.uses);
  if (uses) {
    out.uses = uses;
    // Without a consumer a5e shows the charges and never spends them.
    addUsesConsumer(defaultAction(out.actions), 'itemUses');
  }

  if (kind.objectType === 'container') {
    out.capacity = {
      type: 'weight',
      value: Number(system.capacity?.value) || 0,
      weightlessContents: false,
    };
  }

  return out;
}

// --- spells ----------------------------------------------------------------

// Both systems encode preparation as 0 unprepared / 1 prepared / 2 always.
//
// dnd5e 5.x splits it in two: `system.method` says *how* the spell is available,
// and `system.prepared` is the toggle. Earlier dnd5e nested both under
// `system.preparation`, so that shape is read as a fallback — Plutonium's import
// customizer writes the 5.x one, and reading only the old shape left every
// imported spell unprepared.
const ALWAYS_AVAILABLE = new Set(['always', 'atwill', 'innate', 'pact']);

function preparedStateOf(system) {
  const legacy = system?.preparation ?? {};
  const method = system?.method || legacy.mode || '';
  if (ALWAYS_AVAILABLE.has(method)) return 2;

  const prepared = Number(system?.prepared ?? legacy.prepared);
  return Number.isFinite(prepared) ? Math.min(2, Math.max(0, prepared)) : 0;
}

function toSpell(data, ctx) {
  const system = data.system ?? {};
  const flags = props(system);

  return {
    description: descriptionOf(system),
    secretDescription: '',
    source: sourceOf(system),
    favorite: false,
    macro: '',

    level: Number(system.level) || 0,
    schools: {
      primary: pick(SPELL_SCHOOL, system.school, ''),
      secondary: [],
    },
    // a5e will not create a spell on an actor unless it names a spell book; the
    // bridge fills this in from the actor the spell is being imported onto.
    spellBook: String(ctx?.spellBookId ?? ''),
    components: {
      vocalized: flags.has('vocal'),
      seen: flags.has('somatic'),
      material: flags.has('material'),
    },
    materials: String(system.materials?.value ?? ''),
    materialsConsumed: !!system.materials?.consumed,
    concentration: flags.has('concentration'),
    ritual: flags.has('ritual'),
    rare: false,
    prerequisite: '',
    classes: system.sourceClass ? [system.sourceClass] : [],
    disciplines: [],
    // dnd5e and a5e use the same 0/1/2 encoding for preparation.
    prepared: preparedStateOf(system),

    actions: activitiesToActions(system.activities, {
      itemName: data.name,
      img: data.img,
      description: descriptionOf(system),
      isSpell: true,
      spellLevel: Number(system.level) || 0,
      ...ctx,
    }),
  };
}

// Two statements of the same progression: keep the advancement, which is data
// Plutonium built from a real SRD match, and fill in only what it lacks.
function mergeResources(fromAdvancement, fromTable) {
  const seen = new Set(fromAdvancement.map((r) => r.slug));
  return [...fromAdvancement, ...fromTable.filter((r) => !seen.has(r.slug))];
}

// --- features --------------------------------------------------------------

// Creature traits and actions arrive as dnd5e `feat` items. a5e distinguishes a
// natural weapon from a plain trait by `featureType`, and the sheet groups them
// by it, so it is worth getting right.
function featureTypeOf(data) {
  const system = data.system ?? {};
  const activities = Object.values(system.activities ?? {});

  if (activities.some((a) => a.type === 'attack')) return 'naturalWeapon';

  const activationTypes = new Set(activities.map((a) => a.activation?.type));
  if (activationTypes.has('legendary')) return 'legendaryAction';

  return pick(FEATURE_TYPE, system.type?.value, 'other');
}

function toFeature(data, ctx) {
  const system = data.system ?? {};

  const out = {
    description: descriptionOf(system),
    secretDescription: '',
    source: sourceOf(system),
    favorite: false,
    macro: '',

    featureType: featureTypeOf(data),
    featClasses: [],
    classes: '',
    class: '',
    prerequisite: String(system.prerequisites?.level ?? system.requirements ?? ''),
    concentration: false,
    requiresBloodied: false,
    hidden: false,
    grants: {},

    actions: activitiesToActions(system.activities, {
      itemName: data.name,
      img: data.img,
      description: descriptionOf(system),
      ...ctx,
    }),
  };

  const uses = convertUses(system.uses);
  if (uses) {
    out.uses = uses;
    // Without a consumer a5e shows the charges and never spends them.
    addUsesConsumer(defaultAction(out.actions), 'itemUses');
  }

  return out;
}

// --- origin items ----------------------------------------------------------

// class / archetype / background / heritage all carry advancement data in dnd5e
// that a5e models completely differently (grants). We keep the text and the
// identity so the document imports and reads correctly, and leave the mechanics
// to be filled in by hand — inventing grants would produce wrong characters.
function toOrigin(data, a5eType) {
  const system = data.system ?? {};

  const base = {
    description: descriptionOf(system),
    secretDescription: '',
    source: sourceOf(system),
    favorite: false,
    macro: '',
    grants: {},
  };

  if (a5eType === 'class') {
    const die = Number(String(system.hd?.denomination ?? '').replace('d', ''));
    return {
      ...base,
      // a5e attaches an archetype to a class by comparing the archetype's
      // `system.class` with the class's slug, so both have to be derived the
      // same way — from the dnd5e identifier, not from the display name. A
      // homebrew "Illrigger" whose identifier is "illriggerrevised" would
      // otherwise never be found by its own subclasses.
      slug: classSlug(system.identifier || data.name),
      // dnd5e counts a class's levels in `system.levels`; a5e calls the same
      // number `classLevels`, and it is what decides which grants have been
      // reached, so importing a class onto a 3rd-level character has to carry it.
      classLevels: Math.max(1, Number(system.levels) || 1),
      hp: { hitDiceSize: Number.isFinite(die) && die ? die : 6 },
      // Drives spell slots. Same shape as a subclass's, so the same mapper does.
      spellcasting: spellcastingOf(system),
      // What makes a feature's damage and uses grow with level. Plutonium only
      // builds the dnd5e advancements these come from when it can match the
      // class against the SRD, so homebrew arrives with none — and the class
      // table, which is always imported, is then the only statement of the
      // progression there is. Advancements win where both describe a column.
      resources: mergeResources(
        resourcesFromAdvancement(system),
        resourcesFromClassTable(descriptionOf(system)),
      ),
    };
  }

  return base;
}

// ---------------------------------------------------------------------------

/**
 * Translate one dnd5e-shaped Item document into an a5e-shaped one.
 * @param {object} data  Expanded document data, as handed to `Item.create`.
 * @param {object} ctx   { actor } when the item is being created on an actor.
 * @returns {object} a new document object; the input is left untouched.
 */
export function translateItem(data, ctx = {}) {
  const a5eType = ITEM_TYPE[data.type];
  if (!a5eType) {
    debug(`No a5e item type for dnd5e "${data.type}" — passing through untouched.`);
    return data;
  }

  let system;
  let extraFlags = {};

  if (a5eType === 'archetype') {
    const converted = translateSubclass(data, {
      description: descriptionOf(data.system),
      source: sourceOf(data.system),
    });
    system = converted.system;
    extraFlags = converted.flags[FLAG_SCOPE];
  } else {
    switch (a5eType) {
      case 'object': system = toObject(data, ctx); break;
      case 'spell': system = toSpell(data, ctx); break;
      case 'feature': system = toFeature(data, ctx); break;
      default: system = toOrigin(data, a5eType); break;
    }
  }

  // A class's and a subclass's levelled features have to keep their level and
  // their parentage, or the linker cannot build grants out of them later.
  if (a5eType === 'feature' && isSubclassFeatureItem(data)) {
    const meta = subclassFeatureMeta(data);
    if (meta) {
      system.featureType = 'class';
      extraFlags = { ...extraFlags, subclassFeature: meta };
    }
  } else if (a5eType === 'feature' && isClassFeatureItem(data)) {
    const meta = classFeatureMeta(data);
    if (meta) {
      system.featureType = 'class';
      extraFlags = { ...extraFlags, classFeature: meta };
    }
  } else if (a5eType === 'feature' && isOptionalFeatureItem(data)) {
    // Tagged rather than granted: these are the options a feature offers, and
    // which of them a character takes is a choice, not an import.
    extraFlags = { ...extraFlags, optionalFeature: optionalFeatureMeta(data) };
  } else if (a5eType === 'class') {
    extraFlags = { ...extraFlags, class: classMeta(data), grantsLinked: false };
  }

  const out = {
    ...data,
    type: a5eType,
    system,
  };

  // Keep the original payload so a bad conversion can be diagnosed (and, later,
  // re-run) without re-importing from 5etools.
  out.flags = {
    ...(data.flags ?? {}),
    [FLAG_SCOPE]: {
      sourceType: data.type,
      converted: true,
      ...extraFlags,
    },
  };

  return out;
}
