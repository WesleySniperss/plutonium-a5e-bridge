import { classSlug } from './maps.js';

// dnd5e subclasses and a5e archetypes really do work the same way: a set of
// features handed out at fixed class levels. What differs is only the encoding.
//
//   dnd5e   system.advancement[] of type "ItemGrant", each with a level and a
//           list of item UUIDs, resolved by dnd5e's Advancement engine.
//   a5e     system.grants{} of grantType "feature", each with a level, a
//           levelType of "class", and a list of item UUIDs, resolved by
//           ActorGrantsManager whenever the class level changes.
//
// So the conversion is real, not a fudge. The only genuinely hard part is that
// the feature UUIDs have to point at documents that exist — which is what
// `grant-linker.js` deals with after the import finishes.

export const FLAG_SCOPE = 'plutonium-a5e';

/** Plutonium records what a document was on 5etools; that is our matching key. */
function plutoniumFlags(data) {
  return data?.flags?.plutonium ?? null;
}

// `UrlUtil.encodeArrayForHash` joins URI-encoded parts with "_", and the two
// feature hash builders have a fixed field order:
//
//   classFeature     name, className, classSource, level, source
//   subclassFeature  name, className, classSource, subclassShortName,
//                    subclassSource, level, source
//
// Everything after the name is a fixed-length tail, so parsing from the end
// keeps a name containing an underscore from shifting all the others along —
// `encodeURIComponent` leaves "_" alone, so that really happens.
const SUBCLASS_FEATURE_HASH_TAIL = [
  'className', 'classSource', 'subclassShortName', 'subclassSource', 'level', 'source',
];

const CLASS_FEATURE_HASH_TAIL = ['className', 'classSource', 'level', 'source'];

function decodePart(part) {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

function parseHash(hash, tail) {
  if (!hash) return null;
  const parts = String(hash).split('_');
  if (parts.length < tail.length + 1) return null;

  const values = parts.slice(-tail.length);
  const out = { name: decodePart(parts.slice(0, -tail.length).join('_')) };
  tail.forEach((field, i) => { out[field] = decodePart(values[i]); });

  out.level = Number(out.level) || 1;
  return out;
}

export function parseSubclassFeatureHash(hash) {
  return parseHash(hash, SUBCLASS_FEATURE_HASH_TAIL);
}

export function parseClassFeatureHash(hash) {
  return parseHash(hash, CLASS_FEATURE_HASH_TAIL);
}

// Fallback for when the hash is missing: Plutonium writes the level into the
// dnd5e requirements string, e.g. "Fighter 3 (Champion)".
function parseRequirements(requirements) {
  const match = String(requirements ?? '').match(/^(.+?)\s+(\d+)(?:\s*\((.+)\))?\s*$/);
  if (!match) return null;
  return {
    className: match[1].trim(),
    level: Number(match[2]) || 1,
    subclassShortName: (match[3] ?? '').trim(),
  };
}

/** Is this dnd5e `feat` item one of a subclass's levelled features? */
export function isSubclassFeatureItem(data) {
  if (data?.type !== 'feat') return false;
  return plutoniumFlags(data)?.page === 'subclassFeature';
}

/** Is this dnd5e `feat` item one of a class's own levelled features? */
export function isClassFeatureItem(data) {
  if (data?.type !== 'feat') return false;
  return plutoniumFlags(data)?.page === 'classFeature';
}

/**
 * Everything needed to file a class feature under the right class and level.
 * @returns {{level: number, className: string, classSource: string}|null}
 */
export function classFeatureMeta(data) {
  const flags = plutoniumFlags(data);
  const fromHash = parseClassFeatureHash(flags?.hash);
  if (fromHash) return fromHash;

  const fromReq = parseRequirements(data?.system?.requirements);
  if (!fromReq) return null;
  return {
    name: String(data?.name ?? ''),
    className: fromReq.className,
    classSource: '',
    level: fromReq.level,
    source: flags?.source ?? '',
  };
}

/**
 * Everything needed to file a feature under the right archetype and level.
 * @returns {{level: number, className: string, classSource: string,
 *            subclassShortName: string, subclassSource: string}|null}
 */
export function subclassFeatureMeta(data) {
  const flags = plutoniumFlags(data);
  const fromHash = parseSubclassFeatureHash(flags?.hash);
  if (fromHash) return fromHash;

  const fromReq = parseRequirements(data?.system?.requirements);
  if (!fromReq) return null;
  return {
    className: fromReq.className,
    classSource: '',
    subclassShortName: fromReq.subclassShortName,
    subclassSource: flags?.source ?? '',
    level: fromReq.level,
    source: flags?.source ?? '',
  };
}

/**
 * dnd5e subclass -> a5e archetype.
 *
 * The grants are left empty here on purpose: at creation time the features do
 * not exist yet, so there is nothing to point at. The linker fills them in once
 * the import has produced them.
 */
export function translateSubclass(data, { description, source }) {
  const system = data.system ?? {};
  const flags = plutoniumFlags(data);

  return {
    system: {
      description,
      secretDescription: '',
      source,
      favorite: false,
      macro: '',

      slug: '',
      class: classSlug(system.classIdentifier),
      grants: {},
      resources: [],
      spellcasting: spellcastingOf(system),
    },
    flags: {
      [FLAG_SCOPE]: {
        sourceType: 'subclass',
        converted: true,
        // What the linker matches features against, and what a manual rebuild
        // uses to find this archetype's data again.
        archetype: {
          classIdentifier: String(system.classIdentifier ?? ''),
          classSlug: classSlug(system.classIdentifier),
          identifier: String(system.identifier ?? ''),
          hash: flags?.hash ?? '',
          source: flags?.source ?? '',
        },
        grantsLinked: false,
      },
    },
  };
}

/**
 * What the linker needs to recognise an imported class again, in the same shape
 * as an archetype's, so one matcher serves both. A class is its own "class", so
 * `identifier` and `classIdentifier` are the same thing here.
 */
export function classMeta(data) {
  const identifier = String(data?.system?.identifier || data?.name || '');
  return {
    classIdentifier: identifier,
    classSlug: classSlug(identifier),
    identifier,
    hash: plutoniumFlags(data)?.hash ?? '',
    source: plutoniumFlags(data)?.source ?? '',
  };
}

// dnd5e subclass spellcasting -> a5e caster progression, where one exists.
const CASTER_PROGRESSION = {
  full: 'full',
  half: 'half',
  third: 'third',
  artificer: 'half',
  pact: 'pact',
};

function spellcastingOf(system) {
  const progression = system?.spellcasting?.progression;
  const casterType = CASTER_PROGRESSION[progression] ?? 'none';
  const ability = system?.spellcasting?.ability || 'none';

  return {
    ability: { base: ability, options: [], value: ability },
    casterType,
    maxPreparedFormula: '0',
  };
}

/**
 * Group levelled features into a5e feature grants — one grant per level, the way
 * a5e's own archetypes are built.
 *
 * @param {Array<{level: number, uuid: string, name: string, img: string}>} features
 * @param {string} label  what the grant is called on the sheet
 * @returns {object} a `system.grants` record
 */
export function buildFeatureGrants(features, label = 'Archetype Features') {
  const byLevel = new Map();

  features.forEach(({ level, uuid, name, img }) => {
    if (!uuid) return;
    const lvl = Math.max(1, Number(level) || 1);
    if (!byLevel.has(lvl)) byLevel.set(lvl, []);
    byLevel.get(lvl).push({ uuid, name, img, limitedReselection: true, selectionLimit: 1 });
  });

  const grants = {};
  [...byLevel.keys()].sort((a, b) => a - b).forEach((level) => {
    const _id = foundry.utils.randomID();
    grants[_id] = {
      _id,
      grantType: 'feature',
      level,
      levelType: 'class',
      optional: false,
      label: `${ordinal(level)} Level ${label}`,
      img: '',
      features: {
        base: byLevel.get(level),
        options: [],
        total: 0,
      },
    };
  });

  return grants;
}

function ordinal(n) {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}
