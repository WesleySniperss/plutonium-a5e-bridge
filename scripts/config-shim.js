import { debug, log, warn } from './util/log.js';

// Plutonium is written against dnd5e and reads `CONFIG.DND5E` in ~25 distinct
// places. Under a5e that global does not exist, so every one of those reads is a
// TypeError that aborts whichever import is running.
//
// We therefore stand up a `CONFIG.DND5E` that is real where Plutonium actually
// looks, and a logging null-object everywhere else. The values below were taken
// from dnd5e 5.3.3 (`systems/dnd5e/dnd5e.mjs`), the version Plutonium declares
// support for; labels are plain English because nothing localises them here.

const KNOWN = {
  // Read when converting spell preparation. `.value` is what gets stored.
  spellPreparationStates: {
    unprepared: { label: 'Unprepared', value: 0 },
    prepared: { label: 'Prepared', value: 1 },
    always: { label: 'Always Prepared', value: 2 },
  },

  // Fallback artwork per item type. Plutonium reads `defaultArtwork.Item[type]`,
  // most often for `feat`. Core Foundry icons, so they exist under any system.
  defaultArtwork: {
    Item: {
      background: 'icons/svg/item-bag.svg',
      class: 'icons/svg/upgrade.svg',
      consumable: 'icons/svg/tankard.svg',
      container: 'icons/svg/chest.svg',
      equipment: 'icons/svg/shield.svg',
      facility: 'icons/svg/village.svg',
      feat: 'icons/svg/book.svg',
      loot: 'icons/svg/item-bag.svg',
      race: 'icons/svg/eye.svg',
      spell: 'icons/svg/explosion.svg',
      subclass: 'icons/svg/paralysis.svg',
      tool: 'icons/svg/hammer.svg',
      weapon: 'icons/svg/sword.svg',
    },
    ActiveEffect: {},
    Actor: {},
  },

  // `Object.keys(CONFIG.DND5E.senses)` drives sense parsing. Same four as a5e.
  senses: {
    blindsight: 'Blindsight',
    darkvision: 'Darkvision',
    tremorsense: 'Tremorsense',
    truesight: 'Truesight',
  },

  // Used for coin conversion; only `.conversion` is read.
  currencies: {
    pp: { label: 'Platinum', abbreviation: 'pp', conversion: 0.1 },
    gp: { label: 'Gold', abbreviation: 'gp', conversion: 1 },
    ep: { label: 'Electrum', abbreviation: 'ep', conversion: 2 },
    sp: { label: 'Silver', abbreviation: 'sp', conversion: 10 },
    cp: { label: 'Copper', abbreviation: 'cp', conversion: 100 },
  },
  defaultCurrency: 'gp',

  attunementTypes: {
    required: 'Requires Attunement',
    optional: 'Attunement Optional',
  },

  hitDieTypes: ['d4', 'd6', 'd8', 'd10', 'd12'],

  // XP needed for each character level, index 0 = level 1. Read unguarded (via
  // `game.system.config`, see below) whenever a class or subclass is imported
  // onto a character. A5E keeps 5e's thresholds, so these are correct here too.
  CHARACTER_EXP_LEVELS: [
    0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000,
    85000, 100000, 120000, 140000, 165000, 195000, 225000, 265000, 305000, 355000,
  ],

  // Membership tests only. Slugs are shared with a5e's `creatureTypes`.
  creatureTypes: {
    aberration: { label: 'Aberration' },
    beast: { label: 'Beast' },
    celestial: { label: 'Celestial' },
    construct: { label: 'Construct' },
    dragon: { label: 'Dragon' },
    elemental: { label: 'Elemental' },
    fey: { label: 'Fey' },
    fiend: { label: 'Fiend' },
    giant: { label: 'Giant' },
    humanoid: { label: 'Humanoid' },
    monstrosity: { label: 'Monstrosity' },
    ooze: { label: 'Ooze' },
    plant: { label: 'Plant' },
    undead: { label: 'Undead' },
  },

  // Plutonium turns these keys into a regex that spots damage types in statblock
  // text, so they have to be the real list or damage typing is lost on import.
  // Same thirteen as a5e, and dnd5e 5.3 keys them identically.
  damageTypes: {
    acid: { label: 'Acid' },
    bludgeoning: { label: 'Bludgeoning', isPhysical: true },
    cold: { label: 'Cold' },
    fire: { label: 'Fire' },
    force: { label: 'Force' },
    lightning: { label: 'Lightning' },
    necrotic: { label: 'Necrotic' },
    piercing: { label: 'Piercing', isPhysical: true },
    poison: { label: 'Poison' },
    psychic: { label: 'Psychic' },
    radiant: { label: 'Radiant' },
    slashing: { label: 'Slashing', isPhysical: true },
    thunder: { label: 'Thunder' },
  },

  healingTypes: {
    healing: { label: 'Healing' },
    temphp: { label: 'Temporary Hit Points' },
  },

  // Truthiness tests when deciding whether a 5etools condition maps to a real one.
  conditionTypes: {
    blinded: 'Blinded',
    charmed: 'Charmed',
    deafened: 'Deafened',
    exhaustion: 'Exhaustion',
    frightened: 'Frightened',
    grappled: 'Grappled',
    incapacitated: 'Incapacitated',
    invisible: 'Invisible',
    paralyzed: 'Paralyzed',
    petrified: 'Petrified',
    poisoned: 'Poisoned',
    prone: 'Prone',
    restrained: 'Restrained',
    stunned: 'Stunned',
    unconscious: 'Unconscious',
  },

  // Only `languages.standard.children[x]` / `languages.exotic.children[x]` are
  // read, to decide which bucket a language belongs in.
  languages: {
    standard: {
      label: 'Standard',
      children: {
        common: 'Common',
        dwarvish: 'Dwarvish',
        elvish: 'Elvish',
        giant: 'Giant',
        gnomish: 'Gnomish',
        goblin: 'Goblin',
        halfling: 'Halfling',
        orc: 'Orc',
      },
    },
    exotic: {
      label: 'Exotic',
      children: {
        aarakocra: 'Aarakocra',
        abyssal: 'Abyssal',
        celestial: 'Celestial',
        deep: 'Deep Speech',
        draconic: 'Draconic',
        druidic: 'Druidic',
        gith: 'Gith',
        gnoll: 'Gnoll',
        infernal: 'Infernal',
        primordial: 'Primordial',
        sylvan: 'Sylvan',
        thievesCant: 'Thieves Cant',
        undercommon: 'Undercommon',
      },
    },
  },

  // Base-item lookups. Left empty on purpose: they only feed `system.type.baseItem`,
  // which a5e has no equivalent for and the translator discards anyway.
  tools: {},
  weaponIds: {},
  armorIds: {},
  shieldIds: {},
  weaponMasteries: {},

  // 2024-only content Plutonium probes with `?.` before use.
  facilities: {},
  habitats: {},
  treasure: {},

  // Written to (not just read) when the Tashas tattoo compatibility shim runs.
  validProperties: {},

  consumableTypes: {
    poison: {
      label: 'Poison',
      subtypes: { contact: 'Contact', ingested: 'Ingested', inhaled: 'Inhaled', injury: 'Injury' },
    },
  },

  // `activityTypes.cast.documentClass.metadata.img` is used as a fallback icon.
  activityTypes: {
    cast: { documentClass: { metadata: { img: 'icons/svg/book.svg' } } },
  },

  // Reference-link enrichers. Empty means "no rules link", which renders as plain text.
  rules: {},
  enrichmentLookup: { skills: {} },
};

const seenUnknown = new Set();

function noteUnknown(path) {
  if (seenUnknown.has(path)) return;
  seenUnknown.add(path);
  debug(`Plutonium read unmapped config "${path}" — returning a null object.`);
}

// A never-throwing stand-in for config Plutonium reads that we have not mapped.
// It is callable and iterable so `.map()`, spread and `Object.keys()` all degrade
// to empty rather than blowing up mid-import.
function nullObject(path) {
  // The target must be an arrow function, not a normal one. A normal function
  // has a non-configurable `prototype`, and a Proxy's `ownKeys` is required to
  // report every non-configurable own property of its target — so returning an
  // empty key list made `Object.keys()` throw
  // ("trap result did not include 'prototype'"). Arrow functions have no
  // `prototype`, and their `length`/`name` are configurable, so [] is legal.
  const target = () => {};

  return new Proxy(target, {
    get(_t, prop) {
      if (prop === Symbol.toPrimitive) return () => '';
      if (prop === Symbol.iterator) return function* iter() {};
      if (prop === Symbol.toStringTag) return 'Object';
      if (prop === 'toString' || prop === 'valueOf') return () => '';
      // Never look like a Promise, or `await` on us hangs.
      if (prop === 'then') return undefined;
      if (prop === 'length' || prop === 'size') return 0;
      if (prop === 'constructor') return Object;

      const child = `${path}.${String(prop)}`;
      noteUnknown(child);
      return nullObject(child);
    },
    has() { return true; },
    ownKeys() { return []; },
    apply() { return nullObject(`${path}()`); },
    set() { return true; },
  });
}

// dnd5e's `CastActivityData.schema` is the one dnd5e path Plutonium libWraps
// without checking the system first. Give libWrapper a real getter to wrap, and
// shape the result so Plutonium's wrapper takes its "dnd5e < 5.2.5" early return.
function buildDnd5eGlobal() {
  return {
    dataModels: {
      activity: {
        CastActivityData: {
          get schema() {
            return { fields: { spell: { fields: { uuid: { options: {} } } } } };
          },
        },
      },
      item: {},
      ItemDataModel: { mixin: (...bases) => bases[0] ?? class {} },
    },
    documents: { activity: {} },
    applications: { actor: {} },
    tooltips: {},
  };
}

let installed = false;

/** Config paths Plutonium asked for that this shim does not model. */
export function getUnmappedConfigPaths() {
  return [...seenUnknown];
}

export function installDnd5eShim() {
  if (installed) return;

  if (globalThis.CONFIG?.DND5E) {
    log('CONFIG.DND5E already exists — leaving it alone.');
    installed = true;
    return;
  }

  CONFIG.DND5E = new Proxy(KNOWN, {
    get(t, prop, receiver) {
      if (prop in t) return Reflect.get(t, prop, receiver);
      if (typeof prop === 'symbol') return undefined;
      const child = `CONFIG.DND5E.${String(prop)}`;
      noteUnknown(child);
      return nullObject(child);
    },
  });

  globalThis.dnd5e ??= buildDnd5eGlobal();

  installed = true;
  log('Installed dnd5e config shim.');
}

/** `game` does not exist at module-import time, so this half runs on `init`. */
export function installDnd5eGameShim() {
  if (!game.dnd5e) {
    game.dnd5e = globalThis.dnd5e ?? buildDnd5eGlobal();
    debug('Installed game.dnd5e shim.');
  }

  // dnd5e ends its startup with `Object.assign(game.system, globalThis.dnd5e)`,
  // which is why `game.system.config` is `CONFIG.DND5E` there. Plutonium reads
  // `game.system.config.CHARACTER_EXP_LEVELS` without checking the system first,
  // when it sets XP during a class or subclass import onto a character — the very
  // path its own docs recommend — so under a5e that read has to resolve as well.
  // Defined non-enumerably: nothing walking the active system's own keys should
  // find a dnd5e config hanging off it.
  if (game.system.id === 'a5e' && !game.system.config) {
    try {
      Object.defineProperty(game.system, 'config', {
        value: CONFIG.DND5E,
        writable: true,
        configurable: true,
        enumerable: false,
      });
      debug('Installed game.system.config shim.');
    } catch (e) {
      warn('Could not shim game.system.config — importing a class onto a character may fail.', e);
    }
  }

  if (game.system.id !== 'a5e') {
    warn(`Active system is "${game.system.id}", not "a5e" — the bridge will stay idle.`);
  }
}
