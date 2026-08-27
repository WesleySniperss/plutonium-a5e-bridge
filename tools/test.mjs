// Conversion tests. Run with `node tools/test.mjs`.
//
// The whole point of this module is schema fidelity, which is exactly the sort of
// thing that rots silently: a5e renames a field, or Plutonium changes what it
// emits, and imports keep "succeeding" while producing documents that no longer
// roll. The fixtures below are shaped the way dnd5e 5.x hands documents to
// `Item.create`; the expected values are a5e field names and vocabulary, checked
// against the system's own data models and content packs.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeSchema, installFoundryStub } from './foundry-stub.mjs';

installFoundryStub();

const { translateDocument, pruneUpdate } = await import('../scripts/translate/index.js');
const { actorRollContext } = await import('../scripts/translate/actor.js');
const { abilityFromText, convertUses, translateFormula, withMagic } = await import('../scripts/translate/actions.js');
const origins = await import('../scripts/translate/origins.js');
const { buildFeatureGrants, parseClassFeatureHash, parseSubclassFeatureHash } = origins;
const { assignSpellBooks, attachSpellBook, spellBookIdOf } = await import('../scripts/spellbook.js');
const { KINDS, belongsTo, ownerMetaFor } = await import('../scripts/grant-linker.js');
const { choiceCountsFromTable, parseClassTable, resourcesFromClassTable } = await import('../scripts/class-table.js');

let passed = 0;
const failures = [];
const running = [];

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      running.push(result.then(() => { passed++; }, (e) => failures.push({ name, e })));
      return;
    }
    passed++;
  } catch (e) {
    failures.push({ name, e });
  }
}

const first = (record) => Object.values(record ?? {})[0];
const rollsOfType = (action, type) => Object.values(action?.rolls ?? {}).filter((r) => r.type === type);

// --- fixtures ---------------------------------------------------------------

const goblin = {
  name: 'Goblin',
  type: 'npc',
  system: {
    abilities: {
      str: { value: 8, proficient: 0 },
      dex: { value: 14, proficient: 1 },
      con: { value: 10, proficient: 0 },
      int: { value: 10, proficient: 0 },
      wis: { value: 8, proficient: 0 },
      cha: { value: 8, proficient: 0 },
    },
    attributes: {
      ac: { flat: 15, calc: 'natural', formula: '' },
      hp: { value: 7, max: 7, temp: 0, formula: '2d6' },
      movement: { walk: 30, climb: 0, units: 'ft', hover: false },
      senses: { darkvision: 60, units: 'ft' },
      init: { ability: '', bonus: '' },
    },
    details: {
      cr: 0.25,
      type: { value: 'humanoid', subtype: 'goblinoid', swarm: '' },
      alignment: 'Neutral Evil',
      biography: { value: '<p>GM notes.</p>', public: '<p>Everyone can read this.</p>' },
      source: { book: 'Monster Manual', custom: '' },
    },
    skills: { ste: { value: 2, ability: 'dex' }, prc: { value: 1 }, ath: { value: 0 } },
    traits: {
      size: 'sm',
      languages: { value: ['common', 'goblin'], custom: '' },
      ci: { value: ['charmed'], custom: '' },
      di: { value: [], custom: '' },
      dr: { value: ['fire'], custom: 'bludgeoning from nonmagical attacks' },
      dv: { value: [], custom: '' },
    },
    resources: {
      legact: { value: 0, max: 0 },
      legres: { value: 3, max: 3 },
      lair: { value: 0, max: 0 },
    },
    currency: { cp: 0, sp: 12, ep: 0, gp: 5, pp: 0 },
  },
};

// "Scimitar. Melee Weapon Attack: +4 to hit, reach 5 ft. Hit: 5 (1d6 + 2) slashing."
const scimitar = {
  name: 'Scimitar',
  type: 'feat',
  system: {
    description: { value: '<p>Melee Weapon Attack…</p>' },
    type: { value: 'monster' },
    activities: {
      abc: {
        _id: 'abc',
        type: 'attack',
        activation: { type: 'action', value: 1, condition: '' },
        range: { units: 'ft', value: 5, special: '' },
        target: { affects: { type: 'creature', count: '1', special: '' } },
        attack: {
          ability: '',
          bonus: '4',
          flat: true,
          type: { value: 'melee', classification: 'weapon' },
          critical: { threshold: null },
        },
        damage: {
          parts: [{
            number: 1,
            denomination: 6,
            bonus: '2',
            types: ['slashing'],
            custom: { enabled: false, formula: '' },
            scaling: { mode: '', number: 1 },
          }],
        },
      },
    },
  },
};

// "Fire Breath (Recharge 5-6). Each creature in a 15-foot cone makes a DC 13 Dex
//  save, taking 24 (7d6) fire damage, or half as much on a success."
const fireBreath = {
  name: 'Fire Breath',
  type: 'feat',
  system: {
    description: { value: '<p>Recharge 5–6.</p>' },
    type: { value: 'monster' },
    uses: { max: '1', spent: 0, recovery: [{ period: 'charges', type: 'recoverAll', formula: '5' }] },
    activities: {
      def: {
        _id: 'def',
        type: 'save',
        activation: { type: 'action', value: 1, condition: '' },
        range: { units: 'self', value: null },
        target: { template: { type: 'cone', size: '15', units: 'ft', count: '1' } },
        save: { ability: ['dex'], dc: { calculation: '', formula: '13' } },
        damage: {
          onSave: 'half',
          parts: [{
            number: 7,
            denomination: 6,
            bonus: '',
            types: ['fire'],
            custom: { enabled: false, formula: '' },
            scaling: { mode: '', number: 1 },
          }],
        },
      },
    },
  },
};

const longsword = {
  name: 'Longsword',
  type: 'weapon',
  system: {
    description: { value: '<p>A sword.</p>' },
    type: { value: 'martialM', baseItem: 'longsword' },
    properties: ['ver', 'sil'],
    quantity: 1,
    weight: { value: 3 },
    price: { value: 15, denomination: 'gp' },
    rarity: '',
    equipped: true,
    proficient: null,
    damage: {
      base: { number: 1, denomination: 8, types: ['slashing'] },
      versatile: { number: 1, denomination: 10, types: ['slashing'] },
    },
    activities: {
      ghi: {
        _id: 'ghi',
        type: 'attack',
        activation: { type: 'action', value: 1 },
        range: { units: 'ft', value: 5 },
        attack: {
          ability: 'str',
          bonus: '',
          flat: false,
          type: { value: 'melee', classification: 'weapon' },
          critical: { threshold: null },
        },
        damage: {
          parts: [{
            number: 1,
            denomination: 8,
            bonus: '',
            types: ['slashing'],
            custom: { enabled: false, formula: '' },
            scaling: { mode: '', number: 1 },
          }],
        },
      },
    },
  },
};

const chainMail = {
  name: 'Chain Mail',
  type: 'equipment',
  system: {
    description: { value: '<p>Heavy armour.</p>' },
    type: { value: 'heavy', baseItem: 'chainmail' },
    properties: ['stealthDisadvantage'],
    armor: { value: 16, dex: null },
    strength: 13,
    price: { value: 75, denomination: 'gp' },
    weight: { value: 55 },
    rarity: '',
  },
};

const halfPlate = {
  name: 'Half Plate',
  type: 'equipment',
  system: {
    description: { value: '' },
    type: { value: 'medium' },
    properties: ['stealthDisadvantage'],
    armor: { value: 15, dex: 2 },
    strength: 0,
  },
};

const shield = {
  name: 'Shield',
  type: 'equipment',
  system: {
    description: { value: '' },
    type: { value: 'shield' },
    properties: [],
    armor: { value: 2, dex: null },
    strength: 0,
  },
};

const fireball = {
  name: 'Fireball',
  type: 'spell',
  system: {
    description: { value: '<p>A bright streak…</p>' },
    level: 3,
    school: 'evo',
    properties: ['vocal', 'somatic', 'material'],
    materials: { value: 'a tiny ball of bat guano and sulfur', consumed: false },
    preparation: { mode: 'prepared', prepared: 1 },
    sourceClass: 'wizard',
    activities: {
      jkl: {
        _id: 'jkl',
        type: 'save',
        activation: { type: 'action', value: 1 },
        range: { units: 'ft', value: 150 },
        target: { template: { type: 'sphere', size: '20', units: 'ft', count: '1' } },
        save: { ability: ['dex'], dc: { calculation: 'spellcasting', formula: '' } },
        duration: { units: 'inst', value: '' },
        damage: {
          onSave: 'half',
          parts: [{
            number: 8,
            denomination: 6,
            bonus: '',
            types: ['fire'],
            custom: { enabled: false, formula: '' },
            scaling: { mode: 'whole', number: 1 },
          }],
        },
      },
    },
  },
};

const champion = {
  name: 'Champion',
  type: 'subclass',
  system: {
    description: { value: '<p>The archetypal Champion…</p>' },
    identifier: 'champion',
    classIdentifier: 'barbarian',
    spellcasting: { progression: 'none', ability: '' },
    advancement: [],
    source: { book: "Player's Handbook" },
  },
  flags: { plutonium: { page: 'subclass', hash: 'champion_phb', source: 'phb' } },
};

const improvedCritical = {
  name: 'Improved Critical',
  type: 'feat',
  system: {
    description: { value: '<p>Your weapon attacks score a critical hit on a 19 or 20.</p>' },
    type: { value: 'subclass' },
    requirements: 'Fighter 3 (Champion)',
    activities: {},
  },
  flags: {
    plutonium: {
      page: 'subclassFeature',
      hash: 'improved%20critical_fighter_phb_champion_phb_3_phb',
      source: 'phb',
    },
  },
};

// --- actors -----------------------------------------------------------------

test('npc: identity, abilities and skills', () => {
  const out = translateDocument('Actor', goblin);
  assert.equal(out.type, 'npc');
  assert.equal(out.system.abilities.dex.value, 14);
  assert.equal(out.system.abilities.dex.save.proficient, true);
  assert.equal(out.system.abilities.str.save.proficient, false);
  // dnd5e expertise (2) and proficiency (1) collapse onto a5e's 0-2 scale.
  assert.equal(out.system.skills.ste.proficient, 2);
  assert.equal(out.system.skills.prc.proficient, 1);
  assert.equal(out.system.skills.ath.proficient, 0);
  assert.equal(out.system.skills.ste.ability, 'dex');
  assert.equal(out.flags['plutonium-a5e'].sourceType, 'npc');
});

test('npc: ac, hp and hit dice', () => {
  const out = translateDocument('Actor', goblin);
  assert.equal(out.system.attributes.ac.baseFormula, '15');
  assert.equal(out.system.attributes.hp.baseMax, 7);
  // The hit dice live in the dnd5e HP formula, "2d6".
  assert.equal(out.system.attributes.hitDice.d6.total, 2);
  assert.equal(out.system.attributes.hitDice.d6.current, 2);
  assert.equal(out.system.attributes.hitDice.d8.total, 0);
});

test('npc: movement, senses and traits', () => {
  const out = translateDocument('Actor', goblin);
  assert.equal(out.system.attributes.movement.walk.distance, 30);
  assert.equal(out.system.attributes.movement.walk.unit, 'feet');
  assert.equal(out.system.attributes.senses.darkvision.distance, 60);
  assert.equal(out.system.traits.size, 'sm');
  assert.deepEqual(out.system.traits.alignment, ['evil', 'neutral']);
  assert.deepEqual(out.system.traits.conditionImmunities, ['charmed']);
  assert.deepEqual(out.system.traits.damageResistances, ['fire', 'bludgeoning from nonmagical attacks']);
  assert.deepEqual(out.system.proficiencies.languages, ['common', 'goblin']);
  assert.deepEqual(out.system.details.creatureTypes, ['humanoid']);
  assert.equal(out.system.details.cr, 0.25);
});

test('npc: the public biography stays player-visible', () => {
  const out = translateDocument('Actor', goblin);
  assert.equal(out.system.details.bio, '<p>GM notes.</p>');
  assert.equal(out.system.details.notes, '<p>Everyone can read this.</p>');
  assert.equal(out.system.details.privateNotes, '');
});

test('npc: legendary resistances become a labelled resource', () => {
  const out = translateDocument('Actor', goblin);
  assert.equal(out.system.resources.secondary.label, 'Legendary Resistances');
  assert.equal(out.system.resources.secondary.max, '3');
  assert.equal(out.system.resources.primary, undefined, 'an empty dnd5e resource must not create an a5e one');
});

test('npc: items inlined on the actor are translated with it', () => {
  const out = translateDocument('Actor', { ...goblin, items: [scimitar] });
  assert.equal(out.items[0].type, 'feature');
  assert.equal(out.items[0].system.featureType, 'naturalWeapon');
});

test('roll context: proficiency comes from CR when the actor has none', () => {
  const ctx = actorRollContext(translateDocument('Actor', goblin));
  assert.equal(ctx.profBonus, 2);
  assert.equal(ctx.abilityMod('dex'), 2);
  assert.equal(ctx.abilityMod('str'), -1);
});

// --- creature actions -------------------------------------------------------

test('statblock attack: the ability that reproduces the printed bonus wins', () => {
  const actor = translateDocument('Actor', goblin);
  const parent = { documentName: 'Actor', system: actor.system };
  const out = translateDocument('Item', scimitar, parent);
  const [attack] = rollsOfType(first(out.system.actions), 'attack');

  assert.equal(attack.attackType, 'meleeWeaponAttack');
  // str is -1 and dex +2; with proficiency +2 only dex reaches the printed +4.
  assert.equal(attack.ability, 'dex');
  assert.equal(attack.bonus, '', 'nothing should be left over once the ability is right');
  assert.equal(attack.critThreshold, 20);
});

test('statblock attack: damage keeps its printed flat bonus', () => {
  const out = translateDocument('Item', scimitar);
  const [damage] = rollsOfType(first(out.system.actions), 'damage');
  assert.equal(damage.formula, '1d6 + 2');
  assert.equal(damage.damageType, 'slashing');
  assert.equal(damage.canCrit, true);
});

test('save trait: prompt, half damage, no crit, and a cone area', () => {
  const out = translateDocument('Item', fireBreath);
  const action = first(out.system.actions);
  const prompt = first(action.prompts);

  assert.equal(prompt.type, 'savingThrow');
  assert.equal(prompt.ability, 'dex');
  assert.equal(prompt.saveDC.type, 'custom');
  assert.equal(prompt.saveDC.bonus, '13');
  assert.equal(prompt.onSave, 'Half damage');

  const [damage] = rollsOfType(action, 'damage');
  assert.equal(damage.formula, '7d6');
  assert.equal(damage.canCrit, false, 'a saving throw never crits');

  assert.equal(action.area.shape, 'cone');
  assert.equal(action.area.length, 15);
});

test('save trait: "Recharge 5" becomes a5e recharge uses', () => {
  const out = translateDocument('Item', fireBreath);
  assert.equal(out.system.uses.per, 'recharge');
  assert.equal(out.system.uses.recharge.threshold, 5);
  assert.equal(out.system.uses.recharge.formula, '1d6');
  assert.equal(out.system.uses.value, 1);
});

// --- which saving throw -----------------------------------------------------

test('save: the ability is read from the text when the field is empty', () => {
  // Homebrew often leaves `save.ability` empty because nothing generated it. The
  // old fallback quietly asked for Constitution, so the description said
  // Charisma and the roll asked for Con.
  const feature = translateDocument('Item', {
    name: 'Interdiction',
    type: 'feat',
    system: {
      description: { value: '<p>The target must succeed on a Charisma saving throw or be marked.</p>' },
      type: { value: 'class' },
      activities: {
        a: {
          _id: 'a',
          type: 'save',
          activation: { type: 'action', value: 1 },
          save: { ability: [], dc: { calculation: '', formula: '13' } },
          damage: { parts: [] },
        },
      },
    },
  });

  assert.equal(first(first(feature.system.actions).prompts).ability, 'cha');
});

test('save: an ability the data does name is trusted over the text', () => {
  assert.equal(abilityFromText('a Charisma saving throw'), 'cha');
  assert.equal(translateDocument('Item', fireBreath).system.actions
    && first(first(translateDocument('Item', fireBreath).system.actions).prompts).ability, 'dex');
});

test('save: the ability nearest the words "saving throw" wins', () => {
  // Features mention several abilities; only one is the one being rolled.
  assert.equal(
    abilityFromText('Add your Charisma modifier. The target makes a Wisdom saving throw.'),
    'wis',
  );
});

test('save: nothing to read still yields a usable prompt', () => {
  assert.equal(abilityFromText(''), null);
  assert.equal(abilityFromText('<p>No abilities here.</p>'), null);
});

// --- roll-data names --------------------------------------------------------
//
// Both systems keep the same numbers, under different names. A formula carried
// across verbatim resolves to nothing, and the feature sits there with dead
// numbers — which is what "the uses never go up" looks like.

test('formulas: ability references lose dnd5e\'s abilities. prefix', () => {
  assert.equal(translateFormula('@abilities.cha.mod'), '@cha.mod');
  assert.equal(translateFormula('1d8 + @abilities.str.mod'), '1d8 + @str.mod');
  assert.equal(translateFormula('@abilities.dex.value'), '@dex.value');
});

test('formulas: proficiency is already spelled the same', () => {
  // 223 uses of @prof in a5e's own content, so this must survive untouched.
  assert.equal(translateFormula('@prof'), '@prof');
  assert.equal(translateFormula('@prof + @abilities.wis.mod'), '@prof + @wis.mod');
});

test('formulas: a scale value points at the class resource slug', () => {
  // dnd5e reaches it through the class. a5e gathers every class's resources onto
  // the actor as `classResources`, and nothing sits at the top level under the
  // slug alone — `@sneakattack` evaluates to zero without complaint. a5e's own
  // packs write `@classResources.<slug>`, which is the reference to produce.
  assert.equal(translateFormula('@scale.rogue.sneak-attack'), '@classResources.sneak-attack');
  assert.equal(
    translateFormula('@scale.illriggerrevised.blood_price + 2'),
    '@classResources.blood-price + 2',
  );
});

test('formulas: anything else is left alone', () => {
  assert.equal(translateFormula('2d6 + 3'), '2d6 + 3');
  assert.equal(translateFormula('@dex.mod'), '@dex.mod', 'already in a5e terms');
  assert.equal(translateFormula(''), '');
  assert.equal(translateFormula(undefined), '');
});

test('formulas: a feature\'s uses are translated too', () => {
  const feature = translateDocument('Item', {
    name: 'Interdiction',
    type: 'feat',
    system: {
      description: { value: '' },
      type: { value: 'class' },
      uses: { max: '@abilities.cha.mod', spent: 0, recovery: [{ period: 'lr', type: 'recoverAll' }] },
      activities: {},
    },
  });
  assert.equal(feature.system.uses.max, '@cha.mod');
});

// --- spending charges -------------------------------------------------------
//
// a5e never spends anything just because an item has uses. Its
// `ResourceConsumptionManager` walks the action's `consumers` and decrements
// only what it finds there, so without one the charges sit at full forever.

test('recharge trait: the action is given something to spend', () => {
  const action = first(translateDocument('Item', fireBreath).system.actions);
  const consumers = Object.values(action.consumers);

  assert.equal(consumers.length, 1);
  assert.equal(consumers[0].type, 'itemUses', "the uses are the item's, so the consumer draws on those");
  assert.equal(consumers[0].quantity, 1);
  assert.equal(consumers[0].default, true, 'a consumer that is not selected spends nothing');
});

test('per-action uses get their own consumer', () => {
  const feature = translateDocument('Item', {
    name: 'Second Wind',
    type: 'feat',
    system: {
      description: { value: '' },
      type: { value: 'class' },
      activities: {
        a: {
          _id: 'a',
          type: 'utility',
          activation: { type: 'bonus', value: 1 },
          uses: { max: '1', spent: 0, recovery: [{ period: 'sr', type: 'recoverAll' }] },
          roll: { formula: '1d10', name: 'Healing' },
        },
      },
    },
  });

  const action = first(feature.system.actions);
  assert.equal(action.uses.max, '1');
  assert.equal(Object.values(action.consumers)[0].type, 'actionUses');
});

test('a spell keeps its slot consumer and does not gain a second', () => {
  const action = first(translateDocument('Item', fireball).system.actions);
  const types = Object.values(action.consumers).map((c) => c.type);
  assert.deepEqual(types, ['spell']);
});

test('an item without uses gets no consumer', () => {
  const action = first(translateDocument('Item', longsword).system.actions);
  assert.deepEqual(Object.values(action.consumers), []);
});

// --- objects ----------------------------------------------------------------

test('weapon: type, properties and versatile die', () => {
  const out = translateDocument('Item', longsword);
  assert.equal(out.type, 'object');
  assert.equal(out.system.objectType, 'weapon');
  assert.deepEqual(out.system.weaponProperties, ['versatile']);
  assert.deepEqual(out.system.materialProperties, ['silvered']);
  assert.equal(out.system.versatile, 'd10');
  assert.equal(out.system.equippedState, 2, 'a5e: 0 not carried, 1 carried, 2 equipped');
  assert.equal(out.system.proficient, true, 'dnd5e null means "work it out"; a5e needs a boolean');
  assert.equal(out.system.price.value, 15);
  assert.equal(out.system.weight, 3);
  assert.equal(out.system.ac, undefined, 'a weapon has no armour block');
});

test('weapon: a5e needs the ability modifier written into the damage formula', () => {
  const out = translateDocument('Item', longsword);
  const [damage] = rollsOfType(first(out.system.actions), 'damage');
  assert.equal(damage.formula, '1d8 + @str.mod');
});

test('heavy armour: no dexterity term at all', () => {
  const out = translateDocument('Item', chainMail);
  assert.equal(out.system.objectType, 'armor');
  assert.equal(out.system.armorCategory, 'heavy');
  assert.equal(out.system.ac.mode, 2, 'body armour replaces the base formula');
  // a5e stores plate as "18" — heavy armour ignores Dexterity, negative included.
  assert.equal(out.system.ac.baseFormula, '16');
  assert.equal(out.system.ac.maxDex, 0);
  assert.equal(out.system.ac.minStr, 13);
  assert.equal(out.system.ac.grantsDisadvantage, true);
});

test('medium armour: the cap goes in maxDex, not into the formula', () => {
  const out = translateDocument('Item', halfPlate);
  assert.equal(out.system.armorCategory, 'medium');
  // a5e's own half plate is "15 + @dex.mod" with maxDex 2; `prepareArmorData()`
  // turns that into min(@dex.mod, 2) at prepare time.
  assert.equal(out.system.ac.baseFormula, '15 + @dex.mod');
  assert.equal(out.system.ac.maxDex, 2);
});

test('shield: adds to AC rather than replacing it', () => {
  const out = translateDocument('Item', shield);
  assert.equal(out.system.objectType, 'shield');
  assert.equal(out.system.ac.mode, 1, 'a5e mode 1 is "add"');
  assert.equal(out.system.ac.baseFormula, '2');
  assert.equal(out.system.ac.maxDex, 0);
});

// --- spells -----------------------------------------------------------------

test('spell: level, school, components and materials', () => {
  const out = translateDocument('Item', fireball);
  assert.equal(out.type, 'spell');
  assert.equal(out.system.level, 3);
  assert.equal(out.system.schools.primary, 'evocation');
  assert.deepEqual(out.system.components, { vocalized: true, seen: true, material: true });
  assert.equal(out.system.materials, 'a tiny ball of bat guano and sulfur');
  assert.equal(out.system.concentration, false);
  assert.equal(out.system.prepared, 1);
  assert.deepEqual(out.system.classes, ['wizard']);
});

test('spell: casting it spends a slot, and upcasting scales', () => {
  const out = translateDocument('Item', fireball);
  const action = first(out.system.actions);
  const consumer = first(action.consumers);

  assert.equal(consumer.type, 'spell');
  assert.equal(consumer.spellLevel, 3);
  assert.equal(consumer.points, 5, 'a5e spell points for a 3rd-level slot');

  const [damage] = rollsOfType(action, 'damage');
  assert.equal(damage.scaling.mode, 'spellLevel');
  assert.equal(damage.scaling.formula, '1d6');

  assert.equal(first(action.prompts).saveDC.type, 'spellcasting');
  assert.equal(action.area.shape, 'sphere');
  assert.equal(action.area.radius, 20);
});

test('spell: dnd5e 5.x keeps preparation in method + prepared', () => {
  // This is the shape Plutonium's import customizer actually writes. Reading
  // only the older `preparation` block left every imported spell unprepared.
  const modern = (system) => translateDocument('Item', {
    ...fireball,
    system: { ...fireball.system, preparation: undefined, ...system },
  }).system.prepared;

  assert.equal(modern({ method: 'prepared', prepared: 1 }), 1);
  assert.equal(modern({ method: 'prepared', prepared: 0 }), 0);
  assert.equal(modern({ method: 'innate', prepared: 0 }), 2, 'innate spells are always available');
  assert.equal(modern({ method: 'atwill', prepared: 0 }), 2);
  assert.equal(modern({ method: 'pact', prepared: 0 }), 2, 'a warlock always has its pact spells');
  assert.equal(modern({ method: '', prepared: 0 }), 0);
});

test('spell: the older preparation block is still understood', () => {
  assert.equal(translateDocument('Item', fireball).system.prepared, 1);
});

// --- magic items ------------------------------------------------------------
//
// a5e has no magic-bonus field: its own +2 plate is stored as the formula
// "18 + 2". dnd5e keeps the bonus apart in `system.magicalBonus`, so it has to
// be folded in or an imported +1 sword hits and hurts for nothing extra.

test('magic weapon: the bonus reaches both the attack and the damage', () => {
  const plusOne = translateDocument('Item', {
    ...longsword,
    name: 'Longsword +1',
    system: { ...longsword.system, magicalBonus: 1 },
  });
  const action = first(plusOne.system.actions);

  assert.equal(rollsOfType(action, 'attack')[0].bonus, '1');
  assert.equal(rollsOfType(action, 'damage')[0].formula, '1d8 + @str.mod + 1');
});

test('magic weapon: a plain one is untouched', () => {
  const action = first(translateDocument('Item', longsword).system.actions);
  assert.equal(rollsOfType(action, 'attack')[0].bonus, '');
  assert.equal(rollsOfType(action, 'damage')[0].formula, '1d8 + @str.mod');
});

test('magic armour: the bonus goes into the AC formula, a5e style', () => {
  const plusTwo = translateDocument('Item', {
    ...chainMail,
    name: 'Plate +2',
    system: { ...chainMail.system, armor: { value: 18, dex: null, magicalBonus: 2 } },
  });
  assert.equal(plusTwo.system.ac.baseFormula, '18 + 2');
});

test('magic armour: a dex-capped one keeps its modifier term', () => {
  const plusOne = translateDocument('Item', {
    ...halfPlate,
    system: { ...halfPlate.system, armor: { value: 15, dex: 2, magicalBonus: 1 } },
  });
  assert.equal(plusOne.system.ac.baseFormula, '15 + 1 + @dex.mod');
  assert.equal(plusOne.system.ac.maxDex, 2);
});

test('magic shield: still adds rather than replaces', () => {
  const plusOne = translateDocument('Item', {
    ...shield,
    system: { ...shield.system, armor: { value: 2, dex: null, magicalBonus: 1 } },
  });
  assert.equal(plusOne.system.ac.baseFormula, '2 + 1');
  assert.equal(plusOne.system.ac.mode, 1);
});

test('magic bonus: folding handles nothing, a blank base, and a penalty', () => {
  assert.equal(withMagic('1d8', 0), '1d8');
  assert.equal(withMagic('', 2), '2', 'a bare bonus needs no leading plus');
  assert.equal(withMagic('1d8', -1), '1d8 - 1', 'cursed items exist');
});

// --- subclasses -------------------------------------------------------------

test('subclass: becomes an archetype pointing at the a5e class slug', () => {
  const out = translateDocument('Item', champion);
  assert.equal(out.type, 'archetype');
  // a5e calls the barbarian a berserker, and an archetype finds its class by slug.
  assert.equal(out.system.class, 'berserker');
  assert.deepEqual(out.system.grants, {}, 'grants are wired up once the features exist');
  assert.equal(out.flags['plutonium-a5e'].archetype.identifier, 'champion');
  assert.equal(out.flags['plutonium-a5e'].grantsLinked, false);
});

test('subclass feature: the level comes out of the 5etools hash', () => {
  const out = translateDocument('Item', improvedCritical);
  const meta = out.flags['plutonium-a5e'].subclassFeature;
  assert.equal(out.type, 'feature');
  assert.equal(out.system.featureType, 'class');
  assert.equal(meta.level, 3);
  assert.equal(meta.className, 'fighter');
  assert.equal(meta.subclassShortName, 'champion');
});

test('subclass feature: a name containing "_" does not shift the other fields', () => {
  // `encodeURIComponent` leaves "_" alone, so parsing from the front would break.
  const meta = parseSubclassFeatureHash('a_b_fighter_phb_champion_phb_7_phb');
  assert.equal(meta.name, 'a_b');
  assert.equal(meta.level, 7);
  assert.equal(meta.subclassShortName, 'champion');
});

test('subclass feature: the requirements string is the fallback', () => {
  const noHash = { ...improvedCritical, flags: { plutonium: { page: 'subclassFeature' } } };
  const meta = translateDocument('Item', noHash).flags['plutonium-a5e'].subclassFeature;
  assert.equal(meta.level, 3);
  assert.equal(meta.className, 'Fighter');
  assert.equal(meta.subclassShortName, 'Champion');
});

test('grants: one per level, shaped the way a5e builds its own', () => {
  const grants = buildFeatureGrants([
    { level: 3, uuid: 'Compendium.world.x.Item.aaa', name: 'Improved Critical', img: '' },
    { level: 3, uuid: 'Compendium.world.x.Item.bbb', name: 'Remarkable Athlete', img: '' },
    { level: 7, uuid: 'Compendium.world.x.Item.ccc', name: 'Additional Fighting Style', img: '' },
  ]);

  const byLevel = Object.values(grants);
  assert.equal(byLevel.length, 2);

  const third = byLevel.find((g) => g.level === 3);
  assert.equal(third.grantType, 'feature');
  assert.equal(third.levelType, 'class', 'archetype features track class level, not character level');
  assert.equal(third.optional, false);
  assert.equal(third.label, '3rd Level Archetype Features');
  assert.equal(third.features.base.length, 2);
  assert.equal(third.features.base[0].uuid, 'Compendium.world.x.Item.aaa');
  assert.equal(third.features.total, 0, 'a plain grant hands everything out; it does not ask');
  assert.equal(byLevel.find((g) => g.level === 7).label, '7th Level Archetype Features');
});

// --- classes and their levelled features ------------------------------------

const fighter = {
  name: 'Fighter',
  type: 'class',
  system: {
    description: { value: '<p>A master of martial combat.</p>' },
    identifier: 'fighter',
    hd: { denomination: 'd10' },
    advancement: [],
  },
  flags: { plutonium: { page: 'class', hash: 'fighter_phb', source: 'phb' } },
};

const actionSurge = {
  name: 'Action Surge',
  type: 'feat',
  system: {
    description: { value: '<p>You can push yourself beyond your normal limits.</p>' },
    type: { value: 'class' },
    requirements: 'Fighter 2',
    activities: {},
  },
  flags: {
    plutonium: { page: 'classFeature', hash: 'action%20surge_fighter_phb_2_phb', source: 'phb' },
  },
};

test('class: the text and hit die import, the rest is left to a5e', () => {
  const out = translateDocument('Item', fighter);
  assert.equal(out.type, 'class');
  assert.equal(out.system.hp.hitDiceSize, 10);
  assert.deepEqual(out.system.grants, {}, 'the linker fills these once the features exist');
});

test('class: the level survives the rename to classLevels', () => {
  const atThird = translateDocument('Item', { ...fighter, system: { ...fighter.system, levels: 3 } });
  assert.equal(atThird.system.classLevels, 3, 'a5e decides which grants are reached from this');
  assert.equal(translateDocument('Item', fighter).system.classLevels, 1, 'a bare class starts at 1');
});

test('updates: a later level change is renamed too', () => {
  const doc = { name: 'Fighter', system: { schema: fakeSchema({ classLevels: 'leaf' }) } };
  assert.equal(pruneUpdate(doc, { 'system.levels': 5 }).system.classLevels, 5);
});

test('class: the slug comes from the identifier, so archetypes can find it', () => {
  // a5e matches an archetype to its class by slug, and renames several classes.
  // Both sides run through the same map, so both land on "berserker".
  const barbarian = translateDocument('Item', {
    ...fighter,
    name: 'Barbarian',
    system: { ...fighter.system, identifier: 'barbarian' },
  });
  const archetype = translateDocument('Item', champion);

  assert.equal(barbarian.system.slug, 'berserker');
  assert.equal(archetype.system.class, 'berserker');
  assert.equal(barbarian.system.slug, archetype.system.class);
});

test('class: a homebrew identifier beats the display name', () => {
  const illrigger = translateDocument('Item', {
    ...fighter,
    name: 'Illrigger',
    system: { ...fighter.system, identifier: 'illriggerrevised' },
  });
  assert.equal(illrigger.system.slug, 'illriggerrevised');
});

test('class: the linker is told what this class is', () => {
  const meta = translateDocument('Item', fighter).flags['plutonium-a5e'].class;
  assert.equal(meta.classIdentifier, 'fighter');
  assert.equal(meta.classSlug, 'fighter');
  assert.equal(meta.hash, 'fighter_phb');
});

test('class: spellcasting drives a5e slots', () => {
  const wizard = translateDocument('Item', {
    ...fighter,
    name: 'Wizard',
    system: { ...fighter.system, identifier: 'wizard', spellcasting: { progression: 'full', ability: 'int' } },
  });
  assert.equal(wizard.system.spellcasting.casterType, 'fullCaster');
  assert.equal(wizard.system.spellcasting.ability.value, 'int');
  assert.equal(translateDocument('Item', fighter).system.spellcasting.casterType, 'none');
});

test('spellcasting: the caster type must be a key a5e actually knows', () => {
  // a5e looks the type up in CONFIG.A5E.casterProgression. A value that is not
  // one of its keys is stored without complaint and then yields no spell slots
  // at all, which is what "the caster gets nothing on level-up" looks like.
  const VALID = new Set([
    'none', 'fullCaster', 'halfCaster', 'tertiaryCaster', 'quaternaryCaster',
    'halfCasterWithFirstLevel', 'artificerA5e', 'elementalist', 'herald',
    'psion', 'warlockA5e', 'warlock5e', 'wielder',
  ]);

  const casterOf = (progression) => translateDocument('Item', {
    ...fighter,
    system: { ...fighter.system, spellcasting: { progression, ability: 'int' } },
  }).system.spellcasting.casterType;

  for (const progression of ['full', 'half', 'third', 'artificer', 'pact', 'none', '', undefined]) {
    assert.ok(VALID.has(casterOf(progression)), `"${progression}" produced an unknown caster type`);
  }

  assert.equal(casterOf('full'), 'fullCaster');
  assert.equal(casterOf('half'), 'halfCaster');
  assert.equal(casterOf('third'), 'tertiaryCaster');
  assert.equal(casterOf('artificer'), 'artificerA5e');
  assert.equal(casterOf('pact'), 'warlock5e');
  assert.equal(casterOf(undefined), 'none');
});

test('spellcasting: an archetype gets the same treatment', () => {
  const arch = translateDocument('Item', {
    ...champion,
    system: { ...champion.system, spellcasting: { progression: 'third', ability: 'int' } },
  });
  assert.equal(arch.system.spellcasting.casterType, 'tertiaryCaster');
});

test('class: a scale value becomes an a5e class resource', () => {
  // dnd5e: "at rogue level N, sneak attack is Xd6". a5e: the same table, in
  // `resources[].reference`, resolved for the current class level at prepare time.
  const rogue = translateDocument('Item', {
    ...fighter,
    name: 'Rogue',
    system: {
      ...fighter.system,
      identifier: 'rogue',
      advancement: {
        a: {
          _id: 'a',
          type: 'ScaleValue',
          title: 'Sneak Attack',
          configuration: {
            type: 'dice',
            identifier: 'sneak-attack',
            scale: { 1: { number: 1, faces: 6 }, 3: { number: 2, faces: 6 }, 5: { number: 3, faces: 6 } },
          },
        },
      },
    },
  });

  const [resource] = rogue.system.resources;
  assert.equal(resource.name, 'Sneak Attack');
  // a5e hyphenates: ClassResourceManager falls back to name.slugify({strict:true}),
  // and its own packs are written that way — @classResources.sneak-attack. Running
  // the words together resolves against our own class but not against a native one,
  // which is exactly the case when imported features are attached to a5e's Rogue.
  assert.equal(resource.slug, 'sneak-attack');
  assert.equal(resource.reference[1], '1d6');
  assert.equal(resource.reference[3], '2d6');
  assert.equal(resource.reference[5], '3d6');
});

test('class: a numeric scale value survives too', () => {
  const monk = translateDocument('Item', {
    ...fighter,
    system: {
      ...fighter.system,
      advancement: {
        b: {
          _id: 'b',
          type: 'ScaleValue',
          title: 'Ki Points',
          configuration: { type: 'number', identifier: 'ki-points', scale: { 2: { value: 2 }, 3: { value: 3 } } },
        },
      },
    },
  });
  const [resource] = monk.system.resources;
  assert.equal(resource.reference[2], '2');
  assert.equal(resource.reference[3], '3');
  assert.equal(resource.recovery, 'longRest');
});

test('class: no advancement means no resources, not a crash', () => {
  assert.deepEqual(translateDocument('Item', fighter).system.resources, []);
});

test('class feature: level and class come out of the 5etools hash', () => {
  const out = translateDocument('Item', actionSurge);
  const meta = out.flags['plutonium-a5e'].classFeature;

  assert.equal(out.type, 'feature');
  assert.equal(out.system.featureType, 'class');
  assert.equal(meta.level, 2);
  assert.equal(meta.className, 'fighter');
  assert.equal(meta.name, 'action surge');
  assert.equal(out.flags['plutonium-a5e'].subclassFeature, undefined, 'it is not a subclass feature');
});

test('class feature: a class hash has four trailing fields, not six', () => {
  const meta = parseClassFeatureHash('extra%20attack_fighter_phb_5_phb');
  assert.equal(meta.name, 'extra attack');
  assert.equal(meta.className, 'fighter');
  assert.equal(meta.level, 5);
  // Read as a subclass hash the same string would put the level in the wrong slot.
  assert.notEqual(parseSubclassFeatureHash('extra%20attack_fighter_phb_5_phb')?.level, 5);
});

test('class feature: the requirements string is the fallback', () => {
  const noHash = { ...actionSurge, flags: { plutonium: { page: 'classFeature' } } };
  const meta = translateDocument('Item', noHash).flags['plutonium-a5e'].classFeature;
  assert.equal(meta.level, 2);
  assert.equal(meta.className, 'Fighter');
});

test('class feature: matching needs the class only, not a subclass name', () => {
  const ownerMeta = { classIdentifier: 'fighter', classSlug: 'fighter', identifier: 'fighter' };
  const featureMeta = { className: 'Fighter', level: 2 };

  assert.equal(belongsTo(featureMeta, ownerMeta, KINDS.class), true);
  assert.equal(belongsTo({ className: 'Rogue' }, ownerMeta, KINDS.class), false);
});

test('grants: a class labels its grants as class features', () => {
  const grants = buildFeatureGrants(
    [{ level: 2, uuid: 'Compendium.world.x.Item.aaa', name: 'Action Surge', img: '' }],
    KINDS.class.grantLabel,
  );
  const [grant] = Object.values(grants);
  assert.equal(grant.label, '2nd Level Class Features');
  assert.equal(grant.levelType, 'class');
});

test('journals and other system-agnostic documents pass straight through', () => {
  const journal = { name: 'Chapter 1', pages: [] };
  assert.equal(translateDocument('JournalEntry', journal), journal);
});

test('an unknown dnd5e item type is passed through rather than mangled', () => {
  const odd = { name: 'Odd', type: 'somethingNew', system: {} };
  assert.equal(translateDocument('Item', odd), odd);
});

test('a conversion that throws imports untranslated instead of failing', () => {
  const booby = { name: 'Boom', type: 'weapon', get system() { throw new Error('boom'); } };
  // The failure is logged on purpose; swallow it so the run stays readable.
  const realError = console.error;
  console.error = () => {};
  try {
    assert.equal(translateDocument('Item', booby), booby);
  } finally {
    console.error = realError;
  }
});

// --- follow-up updates ------------------------------------------------------

test('updates: dnd5e-only keys are dropped, everything else survives', () => {
  const doc = {
    name: 'Goblin',
    system: { schema: fakeSchema(['attributes.hp.value', 'details.cr']) },
  };
  const pruned = pruneUpdate(doc, {
    name: 'Goblin Boss',
    'system.attributes.hp.value': 11,
    'system.details.cr': 1,
    'system.advancement': [{ type: 'ItemGrant' }],
    'system.attributes.ac.calc': 'natural',
  });

  assert.equal(pruned.name, 'Goblin Boss');
  assert.equal(pruned.system.attributes.hp.value, 11);
  assert.equal(pruned.system.details.cr, 1);
  assert.equal(pruned.system.advancement, undefined);
  assert.equal(pruned.system.attributes.ac, undefined);
});

test('updates: nothing is nested under a leaf field', () => {
  // dnd5e experience is an object; a5e's `details.xp` is a number. Keeping the
  // object's keys made Foundry reject the entire update with "xp: must be a
  // number", which is what a class dropped onto a sheet used to hit.
  const doc = { name: 'Hero', system: { schema: fakeSchema({ 'details.xp': 'leaf' }) } };
  const pruned = pruneUpdate(doc, {
    'system.details.xp.pct': 0,
    'system.details.xp.max': 900,
  });

  assert.deepEqual(pruned, {}, 'every key under the number has to go');
});

test('updates: experience is carried across rather than dropped', () => {
  const doc = { name: 'Hero', system: { schema: fakeSchema({ 'details.xp': 'leaf' }) } };
  const pruned = pruneUpdate(doc, { 'system.details.xp.value': 900, 'system.details.xp.pct': 0 });

  assert.equal(pruned.system.details.xp, 900, 'dnd5e\'s xp.value is a5e\'s xp');
});

test('updates: keys under a record field are still allowed', () => {
  const doc = { name: 'Hero', system: { schema: fakeSchema({ grants: 'object' }) } };
  const pruned = pruneUpdate(doc, { 'system.grants.abc123.level': 3 });

  assert.equal(pruned.system.grants.abc123.level, 3);
});

test('updates: what a class hands a character is carried across', () => {
  // Importing a class onto a character asks about skills, saves, armour and
  // weapons — all written in dnd5e's vocabulary, all silently lost before.
  const doc = {
    name: 'Hero',
    system: {
      schema: fakeSchema({
        'proficiencies.armor': 'leaf',
        'proficiencies.weapons': 'leaf',
        'proficiencies.languages': 'leaf',
        'skills.ath.proficient': 'leaf',
        'abilities.str.save.proficient': 'leaf',
        'attributes.hp.baseMax': 'leaf',
      }),
    },
  };

  const pruned = pruneUpdate(doc, {
    'system.traits.armorProf.value': ['lgt', 'med', 'shl'],
    'system.traits.weaponProf.value': ['sim', 'mar'],
    'system.traits.languages.value': ['common', 'infernal'],
    'system.skills.ath.value': 1,
    'system.abilities.str.proficient': 1,
    'system.attributes.hp.max': 44,
  });

  assert.deepEqual(pruned.system.proficiencies.armor, ['light', 'medium', 'shield']);
  assert.deepEqual(pruned.system.proficiencies.weapons, ['simple', 'martial']);
  assert.deepEqual(pruned.system.proficiencies.languages, ['common', 'infernal']);
  assert.equal(pruned.system.skills.ath.proficient, 1);
  assert.equal(pruned.system.abilities.str.save.proficient, true);
  assert.equal(pruned.system.attributes.hp.baseMax, 44);
});

test('updates: half proficiency rounds down, a5e has no such grade', () => {
  const doc = { name: 'Hero', system: { schema: fakeSchema({ 'skills.prc.proficient': 'leaf' }) } };
  assert.equal(pruneUpdate(doc, { 'system.skills.prc.value': 0.5 }).system.skills.prc.proficient, 0);
  assert.equal(pruneUpdate(doc, { 'system.skills.prc.value': 2 }).system.skills.prc.proficient, 2);
});

test('updates: an unrecognised proficiency id is kept, not thrown away', () => {
  const doc = { name: 'Hero', system: { schema: fakeSchema({ 'proficiencies.weapons': 'leaf' }) } };
  const pruned = pruneUpdate(doc, { 'system.traits.weaponProf.value': ['sim', 'homebrewBlaster'] });
  assert.deepEqual(pruned.system.proficiencies.weapons, ['simple', 'homebrewBlaster']);
});

test('updates: a document with no schema is left alone', () => {
  const update = { 'system.anything': 1 };
  assert.deepEqual(pruneUpdate({}, update), update);
});

test('uses: limited uses per long rest', () => {
  const uses = convertUses({ max: '3', spent: 1, recovery: [{ period: 'lr', type: 'recoverAll' }] });
  assert.equal(uses.value, 2, 'dnd5e counts what is spent, a5e counts what is left');
  assert.equal(uses.max, '3');
  assert.equal(uses.per, 'longRest');
});

// --- spell books ------------------------------------------------------------
//
// `SpellItemA5e._preCreate` cancels the creation of a spell on an actor that
// names no spell book, and Plutonium turns one cancelled item into a failed
// import for the entire creature. So every spell has to arrive with one.

test('spell: a bare spell still has the field, empty', () => {
  assert.equal(translateDocument('Item', fireball).system.spellBook, '');
});

test('spell: one inlined on a new actor is filed under a book created for it', () => {
  const out = translateDocument('Actor', { ...goblin, items: [fireball] });
  const bookIds = Object.keys(out.system.spellBooks);

  assert.equal(bookIds.length, 1, 'the actor payload gains exactly one spell book');
  assert.equal(out.items[0].system.spellBook, bookIds[0]);
  assert.equal(out.system.spellBooks[bookIds[0]].name, 'Spells');
});

test('spell: an actor with no spells is not given a spell book it does not need', () => {
  const out = translateDocument('Actor', { ...goblin, items: [scimitar] });
  assert.equal(out.system.spellBooks, undefined);
});

test('spell books: an existing actor lends its first book to the spells', async () => {
  const actor = {
    documentName: 'Actor',
    name: 'Aberrant Zealot',
    system: { spellBooks: { abcdefghijklmnop: {} } },
  };
  const items = [{ type: 'spell', system: {} }, { type: 'feature', system: {} }];

  await assignSpellBooks(actor, items);
  assert.equal(items[0].system.spellBook, 'abcdefghijklmnop');
  assert.equal(items[1].system.spellBook, undefined, 'only spells are filed');
});

test('spell books: an actor with none gets one created before the spells land', async () => {
  const updates = [];
  const actor = {
    documentName: 'Actor',
    name: 'Bookless',
    system: { spellBooks: {} },
    update: async (data) => updates.push(data),
  };
  const items = [{ type: 'spell', system: {} }];

  await assignSpellBooks(actor, items);

  assert.equal(updates.length, 1);
  const [path] = Object.keys(updates[0]);
  assert.match(path, /^system\.spellBooks\.[A-Za-z0-9]{16}$/);
  assert.equal(items[0].system.spellBook, path.split('.').pop());
});

test('spell books: a book already named on the spell is left alone', async () => {
  const actor = { documentName: 'Actor', name: 'X', system: { spellBooks: { aaa: {} } } };
  const items = [{ type: 'spell', system: { spellBook: 'chosen' } }];

  await assignSpellBooks(actor, items);
  assert.equal(items[0].system.spellBook, 'chosen');
});

test('spell books: attach and lookup agree', () => {
  const payload = { system: {} };
  const id = attachSpellBook(payload);
  assert.equal(spellBookIdOf(payload), id);
  assert.equal(attachSpellBook(payload), id, 'a second call must not add a second book');
});

// --- archetype matching -----------------------------------------------------

test('archetype: a class spelled differently on each side still matches', () => {
  // dnd5e hands us "illriggerrevised"; the 5etools hash says "Illrigger Revised".
  const archetype = { classIdentifier: 'illriggerrevised', classSlug: 'illriggerrevised', identifier: 'painkiller' };
  const feature = { className: 'Illrigger Revised', subclassShortName: 'Painkiller', level: 3 };
  assert.equal(belongsTo(feature, archetype), true);
});

test('archetype: a feature from another class is still rejected', () => {
  const archetype = { classIdentifier: 'illriggerrevised', classSlug: 'illriggerrevised', identifier: 'painkiller' };
  const feature = { className: 'Fighter', subclassShortName: 'Champion', level: 3 };
  assert.equal(belongsTo(feature, archetype), false);
});

test('archetype: a sibling subclass of the same class is rejected', () => {
  const archetype = { classIdentifier: 'illrigger-revised', classSlug: 'illriggerrevised', identifier: 'painkiller' };
  const feature = { className: 'Illrigger Revised', subclassShortName: 'Hellspeaker', level: 3 };
  assert.equal(belongsTo(feature, archetype), false);
});

test('archetype: a5e-renamed classes match their dnd5e identifier', () => {
  const archetype = { classIdentifier: 'barbarian', classSlug: 'berserker', identifier: 'champion' };
  assert.equal(belongsTo({ className: 'Barbarian', subclassShortName: 'Champion' }, archetype), true);
  assert.equal(belongsTo({ className: 'Berserker', subclassShortName: 'Champion' }, archetype), true);
});

test('adoption: a hash read back off an old item still matches its class', () => {
  // Features imported before the bridge tagged them keep Plutonium's own flags,
  // so the class and level can be recovered from the hash. What matters is that
  // the recovered name lines up with the class — the hash is lowercased and
  // URI-encoded, the class identifier is not.
  const meta = parseClassFeatureHash('diabolic%20inspiration_illrigger_illrigger_5_illrigger');
  assert.equal(meta.className, 'illrigger');
  assert.equal(meta.level, 5);

  const owner = { classIdentifier: 'Illrigger', classSlug: 'illrigger', identifier: 'Illrigger' };
  assert.equal(belongsTo(meta, owner, KINDS.class), true);
});

// --- attaching to a5e's own classes -----------------------------------------
//
// A class or archetype that a5e ships, or that was built by hand, carries none
// of this bridge's flags. Imported features can still be attached to it, so the
// matcher has to work from what a5e itself stores.

test('native class: what the matcher needs is derived from the item', () => {
  const berserker = { type: 'class', name: 'Berserker', system: { slug: '' } };
  const meta = ownerMetaFor(berserker, KINDS.class);

  assert.equal(meta.classIdentifier, 'berserker', 'falls back to the name when slug is blank');
  assert.equal(meta.derived, true);
});

test('native class: an explicit slug wins over the name', () => {
  const homebrew = { type: 'class', name: 'Illrigger', system: { slug: 'illriggerrevised' } };
  assert.equal(ownerMetaFor(homebrew, KINDS.class).classIdentifier, 'illriggerrevised');
});

test('native archetype: its class comes from system.class', () => {
  const champion = { type: 'archetype', name: 'Champion', system: { class: 'fighter', slug: '' } };
  const meta = ownerMetaFor(champion, KINDS.archetype);

  assert.equal(meta.classIdentifier, 'fighter');
  assert.equal(meta.identifier, 'champion', 'the archetype identifies itself by name');
});

test('imported barbarian features attach to a5e\'s own Berserker', () => {
  // The whole point: a5e renamed the class, so the two never share a spelling.
  const berserker = ownerMetaFor({ type: 'class', name: 'Berserker', system: {} }, KINDS.class);
  assert.equal(belongsTo({ className: 'Barbarian', level: 3 }, berserker, KINDS.class), true);
});

test('and the other way round, for an imported class', () => {
  const imported = { classIdentifier: 'barbarian', classSlug: 'berserker', identifier: 'barbarian' };
  assert.equal(belongsTo({ className: 'Berserker', level: 3 }, imported, KINDS.class), true);
});

test('a renamed class does not swallow an unrelated one', () => {
  const berserker = ownerMetaFor({ type: 'class', name: 'Berserker', system: {} }, KINDS.class);
  assert.equal(belongsTo({ className: 'Rogue' }, berserker, KINDS.class), false);
  assert.equal(belongsTo({ className: 'Herald' }, berserker, KINDS.class), false);
});

test('an imported subclass attaches to a5e\'s own class too', () => {
  const adept = ownerMetaFor({ type: 'archetype', name: 'Way of Shadow', system: { class: 'adept' } }, KINDS.archetype);
  const feature = { className: 'Monk', subclassShortName: 'Shadow', level: 3 };

  // monk → adept, and "shadow" is contained in "wayofshadow".
  assert.equal(belongsTo(feature, adept, KINDS.archetype), true);
});

// --- the module graph -------------------------------------------------------
//
// Foundry loads `scripts/main.js` as one ES module: a single import that does not
// resolve takes the whole bridge down before any of it runs, and the only sign is
// one line in the browser console. Nothing above would catch that — those tests
// import the translation layer directly — so the graph is walked here.

const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');

function scriptFiles(dir = SCRIPTS, found = []) {
  for (const entry of readdirSync(dir)) {
    const path = resolve(dir, entry);
    if (statSync(path).isDirectory()) scriptFiles(path, found);
    else if (path.endsWith('.js')) found.push(path);
  }
  return found;
}

const AS = /\s+as\s+/;

function exportedNames(source) {
  const names = new Set();
  for (const m of source.matchAll(/^export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z0-9_$]+)/gm)) {
    names.add(m[1]);
  }
  for (const m of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(AS).pop().trim();
      if (name) names.add(name);
    }
  }
  if (/^export\s+default/m.test(source)) names.add('default');
  return names;
}

const files = scriptFiles();
const exportsByFile = new Map(files.map((f) => [f, exportedNames(readFileSync(f, 'utf8'))]));

const missingFiles = [];
const missingExports = [];

for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const pattern = /import\s+(?:[A-Za-z0-9_$]+\s*,\s*)?(?:\{([^}]*)\})?\s*from\s*['"](\.[^'"]+)['"]/g;

  for (const m of source.matchAll(pattern)) {
    const [, named, spec] = m;
    const target = resolve(dirname(file), spec);

    if (!existsSync(target)) {
      missingFiles.push(`${relative(SCRIPTS, file)} -> ${spec}`);
      continue;
    }
    for (const part of (named ?? '').split(',')) {
      const name = part.trim().split(AS)[0].trim();
      if (name && !exportsByFile.get(target).has(name)) {
        missingExports.push(`${relative(SCRIPTS, file)} imports "${name}" from ${spec}`);
      }
    }
  }
}

test('every relative import points at a file that exists', () => {
  assert.deepEqual(missingFiles, [], 'a dangling import stops the whole module loading');
});

test('every named import is actually exported', () => {
  assert.deepEqual(missingExports, []);
});

// --- report -----------------------------------------------------------------


test('spell: every field a5e declares is filled in', () => {
  // Read off `A5ESpellData`'s own schema in the system source. A spell that is
  // missing one of these is stored, and then quietly behaves as the default —
  // which is how the spell book and the preparation state went wrong before.
  const REQUIRED = [
    'classes', 'components', 'concentration', 'disciplines', 'level',
    'materials', 'materialsConsumed', 'prepared', 'prerequisite', 'rare',
    'ritual', 'schools', 'spellBook',
    // from A5EBaseItemData
    'description', 'secretDescription', 'source', 'favorite', 'macro',
    // from actions()
    'actions',
  ];

  const { system } = translateDocument('Item', fireball);
  const missing = REQUIRED.filter((key) => !(key in system));
  assert.deepEqual(missing, [], `spell is missing: ${missing.join(', ')}`);

  assert.deepEqual(Object.keys(system.components).sort(), ['material', 'seen', 'vocalized']);
  assert.deepEqual(Object.keys(system.schools).sort(), ['primary', 'secondary']);
});

test('spell: the school is a key a5e knows, never a dnd5e abbreviation', () => {
  // a5e looks the school up in `CONFIG.A5E.spellSchools.primary`, whose keys are
  // spelled out in full. Storing "evo" shows the raw string on the sheet.
  const KNOWN = new Set([
    'abjuration', 'conjuration', 'divination', 'enchantment',
    'evocation', 'illusion', 'necromancy', 'transmutation',
  ]);

  for (const [abbr, expected] of Object.entries({
    abj: 'abjuration', con: 'conjuration', div: 'divination', enc: 'enchantment',
    evo: 'evocation', ill: 'illusion', nec: 'necromancy', trs: 'transmutation',
  })) {
    const out = translateDocument('Item', {
      ...fireball, system: { ...fireball.system, school: abbr },
    });
    assert.equal(out.system.schools.primary, expected);
    assert.ok(KNOWN.has(out.system.schools.primary));
  }

  // An unknown school is left blank rather than passed through as junk.
  const odd = translateDocument('Item', {
    ...fireball, system: { ...fireball.system, school: 'xyz' },
  });
  assert.equal(odd.system.schools.primary, '');
});

test('spell: a cantrip is level 0 and spends nothing', () => {
  const cantrip = translateDocument('Item', {
    ...fireball,
    name: 'Fire Bolt',
    system: { ...fireball.system, level: 0 },
  });
  assert.equal(cantrip.system.level, 0);

  const action = first(cantrip.system.actions);
  const consumers = Object.values(action.consumers ?? {});
  assert.equal(consumers.filter((c) => c.type === 'spell').length, 0,
    'a cantrip must not consume a slot');
});


// --- bridge ------------------------------------------------------------------

test("bridge: Plutonium can still find the item it asked us to create", async () => {
  // Plutonium looks its own creation up by object identity:
  //
  //   getImportedEmbed (importedEmbeds, itemData) {
  //     const importedEmbed = importedEmbeds.find(it => it.raw === itemData);
  //
  // and the class importer assigns `classItem` from the result. We hand the
  // creator a translated copy, so without the fix that lookup misses, the user
  // sees "Failed to link embedded entity for active effects!", and every step
  // that needed `classItem` quietly does nothing.
  class ImportedEmbeddedDocument {
    constructor({ raw, document }) { this.raw = raw; this.document = document; }
  }

  const UtilDocuments = {
    ImportedEmbeddedDocument,
    async pCreateDocument(Clazz, docData) { return docData; },
    async pCreateEmbeddedDocuments(doc, embedArray) {
      // Exactly what Plutonium does: wrap by index off the array it was given.
      return embedArray.map((raw, i) => new ImportedEmbeddedDocument({
        raw, document: { id: `doc${i}`, name: raw.name },
      }));
    },
    async pUpdateDocument(doc, u) { return u; },
    async pUpdateEmbeddedDocuments(doc, u) { return u; },
  };

  const prevGame = globalThis.game;
  globalThis.game = {
    system: { id: "a5e" },
    settings: { get: (_m, key) => (key === "enabled" ? true : false) },
    modules: { get: () => ({ api: { salphar: { UtilDocuments } } }) },
  };

  try {
    const { installPlutoniumBridge } = await import("../scripts/bridge.js");
    assert.equal(installPlutoniumBridge(), true, "bridge should install");

    const actor = { documentName: "Actor", type: "character", name: "Serthalqin", system: { spellBooks: { aaa: {} } } };
    const classItemToCreate = {
      name: "Illrigger",
      type: "class",
      system: {
        description: { value: "<p>An Illrigger…</p>" },
        identifier: "illrigger",
        levels: 1,
        hitDice: "d10",
        spellcasting: { progression: "none", ability: "" },
        advancement: [],
      },
      flags: { plutonium: { page: "class", hash: "illrigger_illr", source: "IllR" } },
    };

    const embeds = await UtilDocuments.pCreateEmbeddedDocuments(
      actor, [classItemToCreate], { ClsEmbed: { metadata: { name: "Item" } } },
    );

    // The lookup Plutonium performs, verbatim.
    const found = embeds.find((it) => it.raw === classItemToCreate);
    assert.ok(found, "Plutonium must find the embed it asked us to create");
    assert.equal(found.document.name, "Illrigger");

    // The document really was created from the translated data, not the raw.
    assert.equal(embeds[0].document.name, classItemToCreate.name);
  } finally {
    globalThis.game = prevGame;
  }
});


// --- tool proficiencies ------------------------------------------------------

const toolActor = () => ({
  name: 'Serthalqin',
  system: {
    proficiencies: { tools: [] },
    schema: fakeSchema({ 'proficiencies.tools': 'leaf' }),
  },
});

test('updates: a rogue keeps its thieves tools', () => {
  // Plutonium writes each tool separately, in dnd5e ids; a5e keeps one list,
  // keyed the way CONFIG.A5E.tools is.
  const out = pruneUpdate(toolActor(), { system: { tools: { thief: { value: 1 } } } });
  assert.deepEqual(out.system.proficiencies.tools, ['thievesTools']);
});

test('updates: several tools in one update all survive', () => {
  // Each dnd5e key collapses onto the same a5e key, so without carrying the
  // running list forward only the last one would be left standing.
  const out = pruneUpdate(toolActor(), {
    system: { tools: { thief: { value: 1 }, herb: { value: 1 }, smith: { value: 2 } } },
  });
  assert.deepEqual(
    out.system.proficiencies.tools.sort(),
    ['herbalismKit', 'smithsTools', 'thievesTools'],
  );
});

test('updates: tools already held are not duplicated, and 0 adds nothing', () => {
  const actor = toolActor();
  actor.system.proficiencies.tools = ['thievesTools'];

  const out = pruneUpdate(actor, {
    system: { tools: { thief: { value: 1 }, lute: { value: 0 } } },
  });
  assert.deepEqual(out.system.proficiencies.tools, ['thievesTools']);
});

test('updates: an unknown tool id is kept rather than dropped', () => {
  const out = pruneUpdate(toolActor(), { system: { tools: { homebrewKit: { value: 1 } } } });
  assert.deepEqual(out.system.proficiencies.tools, ['homebrewKit']);
});

test('actor shim: the field Plutonium reads exists, and stays out of the data', async () => {
  // Plutonium does MiscUtil.get(actor, "_source", "system", "tools") and then
  // dereferences it. Undefined is what killed the Rogue import, with
  // "Cannot read properties of undefined" naming whichever tool it wanted.
  const prevConfig = globalThis.CONFIG;
  const prevGame = globalThis.game;

  class FakeActor {
    constructor() { this.type = 'character'; this._source = { system: { skills: {} } }; }
    prepareData() { this.prepared = true; }
  }
  globalThis.CONFIG = { Actor: { documentClass: FakeActor } };
  globalThis.game = { ...prevGame, actors: [] };

  try {
    const { installActorShim } = await import('../scripts/actor-shim.js');
    assert.equal(installActorShim(), true);

    const actor = new FakeActor();
    actor.prepareData();

    assert.ok(actor.prepared, 'the original prepareData still runs');
    assert.deepEqual(actor._source.system.tools, {}, 'Plutonium finds an empty answer');

    // Non-enumerable, so it is never cloned into an update or written to the db.
    assert.deepEqual(Object.keys(actor._source.system), ['skills']);
    assert.equal(JSON.parse(JSON.stringify(actor._source)).system.tools, undefined);
  } finally {
    globalThis.CONFIG = prevConfig;
    globalThis.game = prevGame;
  }
});


// --- class tables ------------------------------------------------------------

// Built exactly the way Plutonium builds it, from `getRenderedClassTableFromDereferenced`:
// a colspan=3 spacer then group titles, a header row keyed by the level class,
// one row per level, and an em dash where the value is zero.
const illriggerTable = `<div class="ve-mb-2 ve-flex-col"><p>Fluff.</p><table class="ve-cls-tbl shadow-big ve-w-100 ve-mb-3">
  <tbody>
  <tr><th class="ve-tbl-border" colspan="15"></th></tr>
  <tr>
    <th colspan="3"></th>
    <th class="ve-cls-tbl__col-group" colspan="2">Interdiction</th>
    <th class="ve-cls-tbl__col-group" colspan="1">Spell Slots per Spell Level</th>
  </tr>
  <tr>
    <th class="ve-cls-tbl__col-level">Level</th>
    <th class="ve-cls-tbl__col-prof-bonus">Proficiency Bonus</th>
    <th>Features</th>
    <th class="ve-cls-tbl__col-generic-center"><div class="cls__squash_header">Interdict Boons</div></th>
    <th class="ve-cls-tbl__col-generic-center"><div class="cls__squash_header">Baleful Damage</div></th>
    <th class="ve-cls-tbl__col-generic-center"><div class="cls__squash_header">1st</div></th>
  </tr>
  <tr>
    <td class="ve-cls-tbl__col-level">1st</td>
    <td class="ve-cls-tbl__col-prof-bonus">+2</td>
    <td>Baleful Interdict</td>
    <td class="ve-cls-tbl__col-generic-center">&mdash;</td>
    <td class="ve-cls-tbl__col-generic-center">1d8</td>
    <td class="ve-cls-tbl__col-generic-center">&mdash;</td>
  </tr>
  <tr>
    <td class="ve-cls-tbl__col-level">2nd</td>
    <td class="ve-cls-tbl__col-prof-bonus">+2</td>
    <td>Interdiction</td>
    <td class="ve-cls-tbl__col-generic-center">1</td>
    <td class="ve-cls-tbl__col-generic-center">1d8</td>
    <td class="ve-cls-tbl__col-generic-center">2</td>
  </tr>
  <tr>
    <td class="ve-cls-tbl__col-level">7th</td>
    <td class="ve-cls-tbl__col-prof-bonus">+3</td>
    <td>&mdash;</td>
    <td class="ve-cls-tbl__col-generic-center">2</td>
    <td class="ve-cls-tbl__col-generic-center">2d8</td>
    <td class="ve-cls-tbl__col-generic-center">4</td>
  </tr>
  <tr><th class="ve-tbl-border" colspan="15"></th></tr>
  </tbody>
</table></div>`.replace(/&mdash;/g, '\u2014');

test('class table: columns, groups and per-level values are read back', () => {
  const columns = parseClassTable(illriggerTable);
  assert.deepEqual(columns.map((c) => c.label), ['Interdict Boons', 'Baleful Damage', '1st']);

  const boons = columns[0];
  assert.equal(boons.group, 'Interdiction');
  assert.deepEqual(boons.values, { 1: '0', 2: '1', 7: '2' }, 'an em dash means zero');

  assert.equal(columns[2].group, 'Spell Slots per Spell Level');
});

test('class table: a homebrew class scales off its own table', () => {
  // Plutonium builds ScaleValue advancements from `srdData` alone, so homebrew
  // arrives with none — this is the only statement of the progression there is.
  const resources = resourcesFromClassTable(illriggerTable);
  const damage = resources.find((r) => r.slug === 'baleful-damage');

  assert.ok(damage, 'the dice column becomes a resource');
  assert.equal(damage.reference[1], '1d8');
  assert.equal(damage.reference[7], '2d8');
});

test('class table: spell slots are left to a5e', () => {
  // a5e derives slots from the class's casterType; importing them as resources
  // would put a second, unrelated set of numbers on the sheet.
  const slugs = resourcesFromClassTable(illriggerTable).map((r) => r.slug);
  assert.ok(!slugs.includes('1st'));
});

test('class table: a column of feature names is not a resource', () => {
  const slugs = resourcesFromClassTable(illriggerTable).map((r) => r.slug);
  assert.deepEqual(slugs.sort(), ['baleful-damage', 'interdict-boons']);
});

test('class table: choices are counted as what each level adds', () => {
  // The table states the running total; an a5e grant hands out what it is worth
  // on its own, so the difference between rungs is what gets granted.
  const counts = choiceCountsFromTable(illriggerTable, 'Interdict Boons');
  assert.deepEqual(counts, { 2: 1, 7: 1 }, 'one at 2nd, one more at 7th');
});

test('class table: a class with no table yields nothing, quietly', () => {
  assert.deepEqual(parseClassTable('<p>Just prose.</p>'), []);
  assert.deepEqual(resourcesFromClassTable(undefined), []);
  assert.deepEqual(choiceCountsFromTable('', 'Interdict Boons'), {});
});

test('class: the table fills the gap where advancements are missing', () => {
  const homebrew = {
    name: 'Illrigger',
    type: 'class',
    system: {
      description: { value: illriggerTable },
      identifier: 'illrigger',
      levels: 1,
      hitDice: 'd10',
      spellcasting: { progression: 'none', ability: '' },
      advancement: [],
    },
  };

  const slugs = translateDocument('Item', homebrew).system.resources.map((r) => r.slug);
  assert.ok(slugs.includes('baleful-damage'), 'homebrew now scales');
});


test('class table: a level the table skips keeps the last value, not zero', () => {
  // a5e reads one rung and takes a miss as nothing:
  //   let i = n.reference?.[e] || "", … a ||= 0;
  // so a gap would read as zero rather than as "unchanged".
  const resources = resourcesFromClassTable(illriggerTable);
  const damage = resources.find((r) => r.slug === 'baleful-damage');

  assert.equal(damage.reference[7], '2d8');
  assert.equal(damage.reference[8], '2d8', 'carried past the last stated level');
  assert.equal(damage.reference[20], '2d8');
  assert.equal(damage.reference[1], '1d8');
});

test('class table: two columns that slug alike do not displace each other', () => {
  // a5e keys resources by slug, so the second would silently win in roll data.
  const table = illriggerTable.replace('Baleful Damage', 'Interdict-Boons');
  const slugs = resourcesFromClassTable(table).map((r) => r.slug);

  assert.equal(new Set(slugs).size, slugs.length, 'no duplicate slugs');
});


test('feat: an imported feat is shaped the way a5e ships its own', () => {
  // Checked against the system's own `feats` pack, whose 75 documents are
  // `feature` with `system.featureType: "feat"` — there is no item type "feat"
  // in a5e at all.
  const out = translateDocument('Item', {
    name: 'Great Weapon Master',
    type: 'feat',
    system: { description: { value: '<p>…</p>' }, type: { value: 'feat' }, activities: {} },
    flags: { plutonium: { page: 'feats.html', hash: 'great weapon master_phb' } },
  });

  assert.equal(out.type, 'feature');
  assert.equal(out.system.featureType, 'feat');
});


// --- ability score increases -------------------------------------------------

test('asi: an imported class gets what a5e ships on its own classes', async () => {
  // Read out of the system's own `a5e-classes` pack: every class but three
  // carries ten `ability` grants, two per level at 4/8/12/16/19, each worth one
  // point and choosable from all six abilities.
  const { ensureAsiGrants } = await import('../scripts/asi-grants.js');

  let written = null;
  const cls = {
    type: 'class',
    name: 'Illrigger',
    system: { grants: {} },
    async update(data) { written = data; },
  };

  assert.equal(await ensureAsiGrants(cls), true);

  const grants = Object.values(written['system.grants']);
  assert.equal(grants.length, 10, 'two points at each of five levels');

  const levels = [...new Set(grants.map((g) => g.level))].sort((a, b) => a - b);
  assert.deepEqual(levels, [4, 8, 12, 16, 19]);

  const one = grants[0];
  assert.equal(one.grantType, 'ability');
  assert.equal(one.levelType, 'class');
  assert.equal(one.optional, true, 'the point can go to a feat instead');
  assert.equal(one.bonus, '1');
  assert.equal(one.abilities.total, 1);
  assert.deepEqual(one.abilities.options, ['str', 'dex', 'con', 'int', 'wis', 'cha']);
  assert.deepEqual(one.context.types, ['base']);
});

test('asi: a class that already has them is left alone', async () => {
  // a5e's own classes carry these, and so does one this has already run on —
  // adding a second set would offer the points twice.
  const { ensureAsiGrants } = await import('../scripts/asi-grants.js');

  const native = {
    type: 'class',
    name: 'Marshal',
    system: { grants: { abc: { grantType: 'ability', level: 4 } } },
    async update() { throw new Error('must not write'); },
  };

  assert.equal(await ensureAsiGrants(native), false);
});

test('asi: only classes, never archetypes', async () => {
  const { ensureAsiGrants } = await import('../scripts/asi-grants.js');

  const archetype = {
    type: 'archetype',
    name: 'Architect of Ruin',
    system: { grants: {} },
    async update() { throw new Error('must not write'); },
  };

  assert.equal(await ensureAsiGrants(archetype), false);
});


test('weapon: a versatile weapon can be swung two-handed', () => {
  // dnd5e keeps two-handed damage on the item, apart from the activity's parts;
  // a5e has no such field and carries a second damage roll instead. Its own
  // longsword ships "1d8 + @str.mod" and "1d10 + @str.mod" side by side.
  const longsword = translateDocument('Item', {
    name: 'Longsword',
    type: 'weapon',
    system: {
      description: { value: '<p>…</p>' },
      properties: ['ver'],
      damage: { versatile: { number: 1, denomination: 10, types: ['slashing'] } },
      activities: {
        a: {
          _id: 'a',
          type: 'attack',
          attack: { type: { value: 'melee' }, ability: 'str' },
          damage: { parts: [{ number: 1, denomination: 8, types: ['slashing'], custom: { enabled: false } }] },
        },
      },
    },
  });

  const formulas = Object.values(first(longsword.system.actions).rolls)
    .filter((r) => r.type === 'damage')
    .map((r) => r.formula);

  assert.deepEqual(formulas, ['1d8 + @str.mod', '1d10 + @str.mod']);
  // The property still labels it, keyed by CONFIG.A5E.versatileOptions.
  assert.equal(longsword.system.versatile, 'd10');
  assert.ok(longsword.system.weaponProperties.includes('versatile'));
});

test('weapon: a non-versatile weapon gains no second roll', () => {
  const club = translateDocument('Item', {
    name: 'Club',
    type: 'weapon',
    system: {
      description: { value: '<p>…</p>' },
      properties: [],
      activities: {
        a: {
          _id: 'a',
          type: 'attack',
          attack: { type: { value: 'melee' }, ability: 'str' },
          damage: { parts: [{ number: 1, denomination: 4, types: ['bludgeoning'], custom: { enabled: false } }] },
        },
      },
    },
  });

  const damage = Object.values(first(club.system.actions).rolls).filter((r) => r.type === 'damage');
  assert.equal(damage.length, 1);
});

test('spell: an area effect can actually be placed on the canvas', () => {
  // a5e knows the shape either way, but without `placeTemplate` it never offers
  // to put it down — 314 of the 448 area actions the system ships set it.
  const area = first(translateDocument('Item', fireball).system.actions).area;
  assert.equal(area.shape, 'sphere');
  assert.equal(area.radius, 20);
  assert.equal(area.placeTemplate, true);
});


await Promise.all(running);

for (const { name, e } of failures) {
  console.error(`FAIL  ${name}`);
  console.error(`      ${String(e.message).split('\n')[0]}`);
}
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
