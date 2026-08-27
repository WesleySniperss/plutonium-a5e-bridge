// Straight enum-to-enum translations between the dnd5e 5.3 schema Plutonium emits
// and the a5e 1.2 schema we store. Anything a5e has no equivalent for maps to the
// closest catch-all rather than being dropped, so imported content still opens.

// --- documents -------------------------------------------------------------

// dnd5e Item type -> a5e Item type.
export const ITEM_TYPE = {
  weapon: 'object',
  equipment: 'object',
  consumable: 'object',
  tool: 'object',
  loot: 'object',
  container: 'object',
  spell: 'spell',
  feat: 'feature',
  class: 'class',
  subclass: 'archetype',
  background: 'background',
  race: 'heritage',
  facility: 'feature',
};

// dnd5e Actor type -> a5e Actor type. a5e has no vehicle or group actor.
export const ACTOR_TYPE = {
  character: 'character',
  npc: 'npc',
  vehicle: 'npc',
  group: 'npc',
};

// --- shared vocabulary -----------------------------------------------------

// Sizes are identical slugs in both systems; listed so unknown values fall back.
export const SIZE = {
  tiny: 'tiny',
  sm: 'sm',
  med: 'med',
  lg: 'lg',
  huge: 'huge',
  grg: 'grg',
};

export const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

// dnd5e and a5e share every skill key dnd5e defines; a5e adds cul/eng/sci.
export const SKILLS = [
  'acr', 'ani', 'arc', 'ath', 'dec', 'his', 'ins', 'itm', 'inv',
  'med', 'nat', 'prc', 'prf', 'per', 'rel', 'slt', 'ste', 'sur',
];

export const DAMAGE_TYPES = new Set([
  'acid', 'bludgeoning', 'cold', 'fire', 'force', 'lightning', 'necrotic',
  'piercing', 'poison', 'psychic', 'radiant', 'slashing', 'thunder',
]);

export const CONDITIONS = new Set([
  'blinded', 'charmed', 'deafened', 'frightened', 'grappled', 'incapacitated',
  'invisible', 'paralyzed', 'petrified', 'poisoned', 'prone', 'restrained',
  'stunned', 'unconscious',
]);

// --- activations, durations, ranges ----------------------------------------

// dnd5e activation.type -> a5e abilityActivationTypes.
export const ACTIVATION = {
  action: 'action',
  bonus: 'bonusAction',
  reaction: 'reaction',
  legendary: 'legendaryAction',
  lair: 'lairAction',
  mythic: 'legendaryAction',
  crew: 'special',
  special: 'special',
  minute: 'minute',
  hour: 'hour',
  day: 'day',
  encounter: 'special',
  turnStart: 'special',
  turnEnd: 'special',
  longRest: 'special',
  shortRest: 'special',
  '': 'none',
  none: 'none',
};

// dnd5e duration.units -> a5e timePeriods.
export const DURATION_UNITS = {
  inst: 'instantaneous',
  turn: 'turn',
  round: 'round',
  minute: 'minute',
  hour: 'hour',
  day: 'day',
  week: 'week',
  month: 'month',
  year: 'year',
  perm: 'permanent',
  spec: 'special',
  '': '',
};

// dnd5e range.units -> a5e distanceUnits.
export const DISTANCE_UNITS = {
  ft: 'feet',
  mi: 'miles',
  m: 'meters',
  km: 'kilometers',
};

// a5e treats these distances as named ranges rather than numbers.
export const NAMED_FEET_RANGES = {
  5: 'fiveFeet',
  30: 'short',
  60: 'medium',
  120: 'long',
};

// dnd5e measured-template type -> a5e area shape.
export const AREA_SHAPE = {
  circle: 'circle',
  cone: 'cone',
  cube: 'cube',
  cylinder: 'cylinder',
  line: 'line',
  radius: 'emanation',
  sphere: 'sphere',
  square: 'square',
  rect: 'square',
  wall: 'wall',
};

// dnd5e target.affects.type -> a5e targetTypes.
export const TARGET_TYPE = {
  self: 'self',
  ally: 'creature',
  creature: 'creature',
  enemy: 'creature',
  object: 'object',
  creatureOrObject: 'creatureObject',
  space: 'other',
  any: 'other',
  willing: 'creature',
};

// dnd5e uses.recovery period -> a5e uses.per (resourceRecoveryOptions).
export const RECOVERY_PERIOD = {
  lr: 'longRest',
  sr: 'shortRest',
  day: 'day',
  dawn: 'day',
  dusk: 'day',
  charges: 'recharge',
  round: 'round',
  turnStart: 'turn',
  turnEnd: 'turn',
  encounter: 'round',
  week: 'week',
  month: 'month',
  year: 'year',
};

// --- items -----------------------------------------------------------------

// dnd5e item type (plus armour subtype) -> a5e objectType.
export const OBJECT_TYPE = {
  weapon: 'weapon',
  tool: 'tool',
  consumable: 'consumable',
  container: 'container',
  loot: 'miscellaneous',
  equipment: 'miscellaneous',
  facility: 'miscellaneous',
};

// dnd5e equipment `system.type.value` -> a5e objectType / armorCategory.
export const EQUIPMENT_SUBTYPE = {
  light: { objectType: 'armor', armorCategory: 'light' },
  medium: { objectType: 'armor', armorCategory: 'medium' },
  heavy: { objectType: 'armor', armorCategory: 'heavy' },
  shield: { objectType: 'shield', shieldCategory: 'heavy' },
  clothing: { objectType: 'clothing' },
  trinket: { objectType: 'miscellaneous' },
  vehicle: { objectType: 'miscellaneous' },
  ring: { objectType: 'jewelry' },
  rod: { objectType: 'miscellaneous' },
  wand: { objectType: 'miscellaneous' },
  ammunition: { objectType: 'ammunition' },
};

export const RARITY = {
  '': 'mundane',
  common: 'common',
  uncommon: 'uncommon',
  rare: 'rare',
  veryRare: 'veryRare',
  legendary: 'legendary',
  artifact: 'artifact',
  varies: 'mundane',
  unknown: 'mundane',
};

// dnd5e item property flags -> a5e weaponProperties.
export const WEAPON_PROPERTY = {
  amm: 'ammunition',
  fin: 'finesse',
  hvy: 'heavy',
  lgt: 'dualWielding',
  lod: 'loading',
  rch: 'reach',
  rel: 'reload',
  ret: 'rebounding',
  thr: 'thrown',
  two: 'twoHanded',
  ver: 'versatile',
  spc: 'exotic',
};

// dnd5e item property flags -> a5e materialProperties. a5e has no adamantine, so
// `ada` deliberately has no entry and survives only in the description text.
export const MATERIAL_PROPERTY = {
  sil: 'silvered',
};

// --- spells ----------------------------------------------------------------

export const SPELL_SCHOOL = {
  abj: 'abjuration',
  con: 'conjuration',
  div: 'divination',
  enc: 'enchantment',
  evo: 'evocation',
  ill: 'illusion',
  nec: 'necromancy',
  trs: 'transmutation',
};

// --- features --------------------------------------------------------------

// dnd5e feat `system.type.value` -> a5e featureType.
export const FEATURE_TYPE = {
  background: 'background',
  class: 'class',
  monster: 'other',
  race: 'heritage',
  feat: 'feat',
  supernaturalGift: 'boon',
  enchantment: 'other',
  subclass: 'class',
  '': 'other',
};

// --- proficiencies ----------------------------------------------------------
//
// What a class hands a character. The two systems abbreviate differently:
// dnd5e keeps `lgt`/`med`/`hvy`/`shl` and `sim`/`mar`; a5e spells them out, and
// keys its own `CONFIG.A5E.armor` and weapon categories that way.

export const ARMOR_PROFICIENCY = {
  lgt: 'light',
  med: 'medium',
  hvy: 'heavy',
  shl: 'shield',
};

export const WEAPON_PROFICIENCY = {
  sim: 'simple',
  mar: 'martial',
};

// dnd5e keys a tool by a short id; a5e keys `CONFIG.A5E.tools` by a camel-cased
// full name, grouped into artisansTools / gamingSets / instruments /
// miscellaneous / vehicles. Only the key matters for proficiency — a5e stores a
// flat array of them under `system.proficiencies.tools`.
export const TOOL_PROFICIENCY = {
  // miscellaneous
  disg: 'disguiseKit',
  forg: 'forgeryKit',
  herb: 'herbalismKit',
  navg: 'navigatorsTools',
  pois: 'poisonersKit',
  thief: 'thievesTools',

  // artisans
  alchemist: 'alchemistsSupplies',
  brewer: 'brewersSupplies',
  calligrapher: 'calligraphersSupplies',
  carpenter: 'carpentersTools',
  cartographer: 'cartographersTools',
  cobbler: 'cobblersTools',
  cook: 'cooksUtensils',
  glassblower: 'glassblowersTools',
  jeweler: 'jewelersTools',
  leatherworker: 'leatherworkersTools',
  mason: 'masonsTools',
  painter: 'paintersSupplies',
  potter: 'pottersTools',
  smith: 'smithsTools',
  tinker: 'tinkersTools',
  weaver: 'weaversTools',
  woodcarver: 'woodcarversTools',

  // instruments — spelled the same in both
  bagpipes: 'bagpipes',
  drum: 'drum',
  dulcimer: 'dulcimer',
  flute: 'flute',
  horn: 'horn',
  lute: 'lute',
  lyre: 'lyre',
  panflute: 'panflute',
  shawm: 'shawm',
  viol: 'viol',

  // vehicles
  land: 'landVehicles',
  water: 'waterVehicles',
  air: 'airVehicles',
  space: 'spaceVehicles',
};

/**
 * Translate a list of proficiency ids, leaving anything unrecognised alone —
 * homebrew and a5e-native ids pass through rather than being thrown away.
 */
export function mapProficiencies(values, map) {
  return [values ?? []].flat().map((id) => map[id] ?? id);
}

// --- classes ---------------------------------------------------------------

// An a5e archetype finds its class by slug, and a5e renamed several of the 5e
// classes. Everything not listed here keeps its own name.
export const CLASS_SLUG = {
  barbarian: 'berserker',
  monk: 'adept',
  paladin: 'herald',
};

/** dnd5e class identifier -> the slug an a5e class item reports. */
export function classSlug(identifier) {
  const slug = String(identifier ?? '').trim().toLowerCase().replace(/\s+/g, '-');
  return CLASS_SLUG[slug] ?? slug;
}

/** Pick a mapped value, falling back to `dflt` when the key is unknown. */
export function pick(map, key, dflt) {
  if (key == null) return dflt;
  const val = map[key];
  return val === undefined ? dflt : val;
}
