import {
  FLAG_SCOPE,
  buildFeatureGrants,
  parseClassFeatureHash,
  parseSubclassFeatureHash,
} from './translate/origins.js';
import { classSlug } from './translate/maps.js';
import { ID, debug, error, log, warn } from './util/log.js';

// A class and an archetype hand out features exactly the same way in a5e: a
// `system.grants` entry per level, applied by `ActorGrantsManager` whenever the
// class level changes. So both are wired up here, by the same machinery.
//
// Neither can be wired at translation time, because the features do not exist
// yet — Plutonium creates the owner and its features as separate documents. We
// watch what an import produces and join the two once it finishes.
//
// The features are copied into a module-owned compendium first. Grants need
// stable UUIDs that survive the source item being moved or deleted, and
// a5e-mancer only offers classes and archetypes it can find in a compendium.

export const KINDS = {
  archetype: {
    itemType: 'archetype',
    ownerFlag: 'archetype',
    featureFlag: 'subclassFeature',
    // Whether a feature has to name this specific subclass, or only the class.
    matchIdentifier: true,
    grantLabel: 'Archetype Features',
    noun: 'Archetype',
    rebuildFn: 'rebuildArchetypeGrants',
    featurePack: ['plutonium-a5e-archetype-features', 'Plutonium ⇄ A5E: Archetype Features'],
    ownerPack: ['plutonium-a5e-archetypes', 'Plutonium ⇄ A5E: Archetypes'],
  },
  class: {
    itemType: 'class',
    ownerFlag: 'class',
    featureFlag: 'classFeature',
    matchIdentifier: false,
    grantLabel: 'Class Features',
    noun: 'Class',
    rebuildFn: 'rebuildClassGrants',
    featurePack: ['plutonium-a5e-class-features', 'Plutonium ⇄ A5E: Class Features'],
    ownerPack: ['plutonium-a5e-classes', 'Plutonium ⇄ A5E: Classes'],
  },
};

const pending = { owners: [], features: [] };

function flagsOf(doc) {
  return doc?.flags?.[FLAG_SCOPE] ?? doc?.getFlag?.(FLAG_SCOPE) ?? null;
}

function slug(str) {
  return String(str ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// The same class reaches us spelled several ways: a dnd5e `classIdentifier`
// ("illriggerrevised"), a 5etools `className` out of a feature's hash
// ("Illrigger Revised"), and a5e's own class slugs, which also run words
// together ("artificerrevised"). Dropping every separator makes those compare
// equal, which is what stopped homebrew subclasses finding their features.
function tight(str) {
  return String(str ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** The kind config for a document this bridge imported, or null. */
function kindOf(doc) {
  const flags = flagsOf(doc);
  if (!flags) return null;

  for (const kind of Object.values(KINDS)) {
    if (doc.type === kind.itemType && flags[kind.ownerFlag]) return kind;
  }
  return null;
}

/**
 * What the matcher needs to know about a class or archetype.
 *
 * An imported one carries it in its flags. One that a5e ships itself, or that
 * was built by hand, carries none — so the same shape is derived from what a5e
 * stores. That is what lets imported features be attached to a native a5e class.
 */
export function ownerMetaFor(owner, kind) {
  const flagged = flagsOf(owner)?.[kind.ownerFlag];
  if (flagged) return flagged;

  const ownSlug = owner.system?.slug || slug(owner.name);

  if (kind === KINDS.class) {
    return { classIdentifier: ownSlug, classSlug: ownSlug, identifier: ownSlug, derived: true };
  }

  // An archetype names its class directly, and is itself identified by its name.
  const cls = owner.system?.class || '';
  return { classIdentifier: cls, classSlug: cls, identifier: ownSlug, derived: true };
}

/** Called by the bridge for everything Plutonium creates during an import. */
export function noteCreatedDocuments(docs) {
  for (const entry of [docs].flat()) {
    // `pCreateEmbeddedDocuments` hands back Plutonium's own wrapper rather than
    // the document, so unwrap before asking anything about it.
    const doc = entry?.documentName ? entry : entry?.document;
    if (!doc || doc.documentName !== 'Item') continue;

    const flags = flagsOf(doc);
    if (!flags) continue;

    if (kindOf(doc)) pending.owners.push(doc);
    else if (doc.type === 'feature' && (flags.subclassFeature || flags.classFeature)) {
      pending.features.push(doc);
    }
  }
}

function clearPending() {
  pending.owners = [];
  pending.features = [];
}

// --- the module's compendiums ----------------------------------------------

async function getOrCreatePack([name, label]) {
  const collection = `world.${name}`;
  const existing = game.packs.get(collection);
  if (existing) return existing;

  const CompendiumCollection = foundry.documents?.collections?.CompendiumCollection
    ?? globalThis.CompendiumCollection;

  return CompendiumCollection.createCompendium({
    label,
    type: 'Item',
    packageType: 'world',
    name,
  });
}

/**
 * Put a copy of `item` in `pack`, reusing an existing copy when we have already
 * published this exact 5etools entry — re-importing a class should not leave a
 * trail of duplicates for its grants to fight over.
 */
async function publish(pack, item, libraryKey) {
  const index = await pack.getIndex({ fields: ['name', 'type', `flags.${FLAG_SCOPE}.libraryKey`] });

  const match = index.find((entry) => {
    if (libraryKey) return entry.flags?.[FLAG_SCOPE]?.libraryKey === libraryKey;
    return entry.name === item.name && entry.type === item.type;
  });

  const data = item.toObject();
  delete data._id;
  foundry.utils.setProperty(data, `flags.${FLAG_SCOPE}.libraryKey`, libraryKey ?? '');

  if (match) {
    const existing = await pack.getDocument(match._id);
    await existing.update(data, { diff: false, recursive: false });
    return existing.uuid;
  }

  const created = await Item.implementation.create(data, { pack: pack.collection });
  return created.uuid;
}

// --- matching ---------------------------------------------------------------

/**
 * Is this feature's class the owner's class, however either side spells it?
 *
 * Three vocabularies meet here: a dnd5e identifier ("illriggerrevised"), a
 * 5etools class name out of the feature's hash ("Illrigger Revised"), and an a5e
 * class slug, which for the renamed classes is a different word entirely
 * ("berserker" for a barbarian). Every spelling of each side is compared, so an
 * imported barbarian feature also lines up with a5e's own Berserker.
 */
function sameClassAs(meta, ownerMeta) {
  const wanted = new Set([
    tight(ownerMeta?.classIdentifier),
    tight(ownerMeta?.classSlug),
    tight(classSlug(ownerMeta?.classIdentifier)),
  ].filter(Boolean));
  if (!wanted.size) return true;

  const className = meta?.className;
  return [tight(className), tight(classSlug(className))].some((have) => have && wanted.has(have));
}

/**
 * Does a feature's recorded parentage point at this class or archetype?
 * Exported for the tests — this is where homebrew subclasses go wrong.
 */
export function belongsTo(meta, ownerMeta, kind = KINDS.archetype) {
  if (!meta) return false;
  if (!sameClassAs(meta, ownerMeta)) return false;
  // A class feature only has to name the class; there is nothing finer to check.
  if (!kind.matchIdentifier) return true;

  const wantSub = tight(ownerMeta.identifier);
  const short = tight(meta.subclassShortName);
  if (!wantSub || !short) return true;
  return short === wantSub || wantSub.includes(short) || short.includes(wantSub);
}

/**
 * Which of this batch's features belong to this owner. With a single archetype
 * in the batch the class alone settles it; with several — a whole class imported
 * at once — the subclass name has to break the tie.
 */
function featuresFor(owner, kind, features, ownerCount) {
  const meta = ownerMetaFor(owner, kind);
  const mine = features.filter((feature) => {
    const fm = flagsOf(feature)?.[kind.featureFlag];
    return fm && sameClassAs(fm, meta);
  });

  if (ownerCount <= 1) return mine;
  return mine.filter((feature) => belongsTo(flagsOf(feature)?.[kind.featureFlag], meta, kind));
}

// Plutonium keeps the features its advancements point at in a compendium of its
// own — `Advancement-Backing Items`, under its internal id. Once they are there,
// re-importing a class creates nothing new: it reuses them. So an import can
// legitimately produce zero documents while every feature the class needs sits
// in that pack, which is why looking only at the world found nothing.
const PLUTONIUM_BACKING_PACK = 'world.srd5e-advancement-backing-item';

async function backingFeaturesFor(owner, kind) {
  const pack = game.packs.get(PLUTONIUM_BACKING_PACK);
  if (!pack) return [];

  const meta = ownerMetaFor(owner, kind);
  const index = await pack.getIndex({ fields: ['type', `flags.${FLAG_SCOPE}`] });

  const ids = index
    .filter((entry) => entry.type === 'feature'
      && belongsTo(entry.flags?.[FLAG_SCOPE]?.[kind.featureFlag], meta, kind))
    .map((entry) => entry._id);

  return (await Promise.all(ids.map((id) => pack.getDocument(id)))).filter(Boolean);
}

/** Every feature item in the world (or on the owner's actor) that belongs to it. */
function worldFeaturesFor(owner, kind) {
  const meta = ownerMetaFor(owner, kind);
  if (!meta) return [];

  const seen = new Set();
  const candidates = [];

  for (const item of [...game.items, ...(owner.parent?.items ?? [])]) {
    if (item.type !== 'feature' || seen.has(item.id)) continue;
    const fm = flagsOf(item)?.[kind.featureFlag];
    if (!fm || !belongsTo(fm, meta, kind)) continue;
    seen.add(item.id);
    candidates.push(item);
  }

  return candidates;
}

/** Every feature the library holds for this owner, newest levels included. */
async function libraryFeaturesFor(owner, kind, featurePack) {
  const ownerMeta = ownerMetaFor(owner, kind);
  const index = await featurePack.getIndex({ fields: ['name', 'type', 'img', `flags.${FLAG_SCOPE}`] });

  const byLevel = new Map();

  for (const entry of index) {
    if (entry.type !== 'feature') continue;
    const meta = entry.flags?.[FLAG_SCOPE]?.[kind.featureFlag];
    if (!belongsTo(meta, ownerMeta, kind)) continue;

    // Guard against a stale duplicate of the same feature at the same level.
    const key = `${meta.level}::${slug(entry.name)}`;
    if (byLevel.has(key)) continue;

    byLevel.set(key, {
      level: meta.level,
      uuid: `Compendium.${featurePack.collection}.Item.${entry._id}`,
      name: entry.name,
      img: entry.img ?? '',
    });
  }

  return [...byLevel.values()].sort((a, b) => a.level - b.level);
}

// --- linking ----------------------------------------------------------------

function setting(key, dflt) {
  try {
    return game.settings.get(ID, key);
  } catch {
    return dflt;
  }
}

async function linkOne(owner, kind, features) {
  const featurePack = await getOrCreatePack(kind.featurePack);

  for (const feature of features) {
    const meta = flagsOf(feature)?.[kind.featureFlag] ?? {};
    const key = feature.flags?.plutonium?.hash ?? `${slug(feature.name)}-${meta.level}`;
    await publish(featurePack, feature, key);
  }

  // Build the grants from everything the library holds for this owner, not just
  // what this import produced. Importing onto a character brings only the
  // features up to that character's level — so a level 3 import would otherwise
  // throw away the later levels a previous, fuller import had found. It is also
  // why an import that brought no features of its own is still worth running:
  // the library may already know this class from an earlier one.
  // Publish before worrying about grants. a5e-mancer only offers classes and
  // archetypes it can find in a compendium, so one that arrived without its
  // features still has to get there — otherwise it cannot even be picked, and
  // the grants could never be filled in afterwards.
  await publishOwner(owner, kind);

  const entries = await libraryFeaturesFor(owner, kind, featurePack);
  log(`"${owner.name}": library holds ${entries.length} feature(s) for it.`);

  if (!entries.length) {
    warn(
      `${kind.noun} "${owner.name}" imported with no features found, and none in the library `
      + `either — grants left empty. Import it from the sidebar to stock the library, then `
      + `rebuild with api.${kind.rebuildFn}().`,
    );
    return false;
  }

  const grants = buildFeatureGrants(entries, kind.grantLabel);

  // `system.grants` is an object field, so an update merges into it key by key.
  // That is what allows imported features to be added to a class a5e ships
  // itself without touching the proficiency, ability-score and exertion grants
  // it already has. Only the ones this bridge wrote last time are removed, which
  // is why their ids are remembered.
  const previous = flagsOf(owner)?.grantIds ?? [];
  const stale = previous.filter((id) => owner.system?.grants?.[id]);
  if (stale.length) {
    await owner.update(Object.fromEntries(stale.map((id) => [`system.grants.-=${id}`, null])));
  }

  await owner.update({
    'system.grants': grants,
    [`flags.${FLAG_SCOPE}.grantIds`]: Object.keys(grants),
    [`flags.${FLAG_SCOPE}.grantsLinked`]: true,
  });

  log(`Linked "${owner.name}": ${entries.length} feature(s) across ${Object.keys(grants).length} level(s).`);

  if (kind === KINDS.class) await setArchetypeLevel(owner);

  await publishOwner(owner, kind);
  return true;
}

/** Copy a class or archetype into the module's compendium, so the builder sees it. */
async function publishOwner(owner, kind) {
  if (!setting('publishArchetypes', true) || owner.pack) return;

  const ownerPack = await getOrCreatePack(kind.ownerPack);
  const key = flagsOf(owner)?.[kind.ownerFlag]?.hash ?? slug(owner.name);
  const uuid = await publish(ownerPack, owner, key);
  debug(`Published ${kind.noun.toLowerCase()} to the library: ${uuid}`);
}

/**
 * Tell the class which level picks an archetype.
 *
 * a5e keeps that on the class as `system.archetypeLevel`, and it is what decides
 * when the builder offers the choice. dnd5e has no equivalent field — it just
 * knows a subclass's features start at some level — and Plutonium emits no
 * Subclass advancement, so the number has to be inferred: the earliest level any
 * of this class's subclass features appears at.
 *
 * Left alone when nothing is known, so a5e's own default of 3 stands.
 */
async function setArchetypeLevel(owner) {
  const meta = ownerMetaFor(owner, KINDS.class);

  const levels = [];
  const pack = game.packs.get(`world.${KINDS.archetype.featurePack[0]}`);

  if (pack) {
    const index = await pack.getIndex({ fields: [`flags.${FLAG_SCOPE}`] });
    for (const entry of index) {
      const fm = entry.flags?.[FLAG_SCOPE]?.subclassFeature;
      if (fm && sameClassAs(fm, meta)) levels.push(Number(fm.level) || 0);
    }
  }

  for (const item of game.items) {
    const fm = flagsOf(item)?.subclassFeature;
    if (fm && sameClassAs(fm, meta)) levels.push(Number(fm.level) || 0);
  }

  const earliest = Math.min(...levels.filter((n) => n >= 1 && n <= 20));
  if (!Number.isFinite(earliest)) return;
  if (owner.system?.archetypeLevel === earliest) return;

  await owner.update({ 'system.archetypeLevel': earliest });
  log(`"${owner.name}" picks its archetype at level ${earliest}.`);
}

/**
 * When the class or archetype landed on a character, Plutonium has already put
 * its features on the sheet as loose items. Those are exactly what the grants
 * now hand out, so leaving both gives every feature twice. Remove Plutonium's
 * copies and let a5e's grant engine own them — that is also what makes the
 * *next* level add the next feature by itself.
 */
async function handoverToActor(owner, features) {
  const actor = owner.parent;
  if (!actor || actor.documentName !== 'Actor') return;
  if (!setting('actorHandover', true)) return;

  const ids = features.filter((f) => f.parent?.id === actor.id).map((f) => f.id);
  if (ids.length) {
    await actor.deleteEmbeddedDocuments('Item', ids);
    debug(`Removed ${ids.length} duplicate feature item(s) from "${actor.name}".`);
  }

  // a5e opens its "Apply Grants" dialog whenever the item it is applying is a
  // class — unconditionally, not just when something needs choosing:
  //
  //   let a = n.cls && n.item.type === "class", s = i || !!t.length || a || o;
  //   if (s) { ...GenericConfigDialog(`${actor.name} - Apply Grants (...)`)... }
  //
  // During an import that is a modal in the middle of a batch, for grants that
  // ask nothing. The class's features arrive on the next level change anyway —
  // through a5e's own routine, or a5e-mancer's — so it is left to that.
  if (kindOf(owner) === KINDS.class) {
    log(`"${owner.name}" is wired up; its features will be applied on the next level change.`);
    return;
  }

  try {
    await actor.grants?.createInitialGrants?.(actor.items.get(owner.id) ?? owner);
    log(`a5e applied "${owner.name}" grants to "${actor.name}".`);
  } catch (e) {
    error(`a5e could not apply the grants from "${owner.name}" to "${actor.name}".`, e);
  }
}

let queued = null;

/** Debounced: one import can fire `importComplete` several times. */
export function scheduleLink() {
  if (queued) clearTimeout(queued);
  queued = setTimeout(() => {
    queued = null;
    linkPending().catch((e) => error('Grant linking failed.', e));
  }, 250);
}

export async function linkPending() {
  if (!pending.owners.length || !game.user.isGM) {
    clearPending();
    return;
  }

  const owners = [...pending.owners];
  const features = [...pending.features];
  clearPending();

  // Logged plainly rather than behind the debug setting: when level-up hands out
  // nothing, this line is the difference between "the import brought no
  // features" and "it brought them and they did not match".
  log(
    `Linking ${owners.length} owner(s) with ${features.length} feature(s) from this import: `
    + owners.map((o) => `${o.name} [${o.type}]`).join(', '),
  );

  // Two archetypes of the same class in one batch have to be told apart by name;
  // a lone one does not. Counted per kind, so a class does not make its own
  // subclasses look ambiguous.
  const countOfKind = (kind) => owners.filter((o) => kindOf(o) === kind).length;

  for (const owner of owners) {
    const kind = kindOf(owner);
    if (!kind) continue;

    try {
      let mine = featuresFor(owner, kind, features, countOfKind(kind));

      // Plutonium does not always create an owner and its features in the same
      // batch — importing subclasses on their own brings no features at all, and
      // `importComplete` can land between the two halves. Rather than give up,
      // fall back to features this world already holds.
      let from = 'this import';

      if (!mine.length) {
        mine = worldFeaturesFor(owner, kind);
        from = 'the world';
      }
      if (!mine.length) {
        mine = await backingFeaturesFor(owner, kind);
        from = "Plutonium's backing compendium";
      }

      log(`"${owner.name}": ${mine.length} matching feature(s) to publish, from ${from}.`);

      const linked = await linkOne(owner, kind, mine);
      if (linked) await handoverToActor(owner, mine);
    } catch (e) {
      // This is where a failure actually strands a class with no grants, so it
      // is reported to the GM rather than only logged.
      error(`Failed to link "${owner?.name}" — it will have no feature grants.`, e);
      if (game.user.isGM) {
        ui.notifications.error(
          `Plutonium ⇄ A5E: could not wire up "${owner?.name}" — ${e.message}. See the console.`,
        );
      }
    }
  }
}

/**
 * Rebuild one class's or archetype's grants from features already in the world
 * or in the module's library. Use it when an import was interrupted, or after
 * editing the features by hand.
 *
 * @param {string} uuid
 */
async function rebuild(uuid, kind) {
  const owner = await fromUuid(uuid);
  if (!owner) throw new Error(`"${uuid}" is not an item.`);

  // Deliberately checked by *type*, not by our flags: the target may be a class
  // a5e ships itself, or one built by hand, that you want imported features
  // attached to. `ownerMetaFor` derives what the matcher needs either way.
  if (owner.type !== kind.itemType) {
    const other = Object.values(KINDS).find((k) => k.itemType === owner.type);
    throw new Error(other
      ? `"${owner.name}" is a ${other.noun.toLowerCase()}; use api.${other.rebuildFn}().`
      : `"${owner.name}" is a "${owner.type}" item, not a ${kind.noun.toLowerCase()}.`);
  }

  const loose = worldFeaturesFor(owner, kind);
  const candidates = loose.length ? loose : await backingFeaturesFor(owner, kind);

  // No loose copies is not a failure on its own — `linkOne` still rebuilds from
  // the module's own library, which is where earlier imports were filed.
  if (!(await linkOne(owner, kind, candidates))) {
    throw new Error(`Found no imported features for "${owner.name}", in the world or the library.`);
  }

  return candidates.length;
}

/**
 * Tag features an earlier version of this bridge imported without a tag.
 *
 * Class-feature tagging arrived after subclass-feature tagging, so a world
 * imported in between ends up with its subclass features recognised and its
 * class features invisible — the class then has nothing to build grants from,
 * and levelling up does nothing.
 *
 * Nothing needs re-importing: Plutonium's own flags are still on every document,
 * and its hash carries the class and the level. This reads them back and writes
 * the tag the linker looks for.
 *
 * @returns {Promise<{tagged: number, skipped: number}>}
 */
export async function adoptExistingFeatures() {
  const PARSE = {
    classFeature: parseClassFeatureHash,
    subclassFeature: parseSubclassFeatureHash,
  };

  const documents = [...game.items];
  for (const actor of game.actors) documents.push(...actor.items);

  let tagged = 0;
  let skipped = 0;

  for (const doc of documents) {
    if (doc.type !== 'feature') continue;

    const page = doc.flags?.plutonium?.page;
    const parse = PARSE[page];
    if (!parse) continue;
    // Already recognised — either by this bridge or by an earlier pass.
    if (flagsOf(doc)?.[page]) continue;

    const meta = parse(doc.flags?.plutonium?.hash);
    if (!meta?.className) { skipped++; continue; }

    try {
      await doc.update({ [`flags.${FLAG_SCOPE}.${page}`]: meta });
      tagged++;
    } catch (e) {
      error(`Could not tag "${doc.name}".`, e);
      skipped++;
    }
  }

  log(`Adopted ${tagged} previously untagged feature(s); ${skipped} could not be read.`);
  if (tagged) log('Now rebuild the grants: api.rebuildClassGrants(uuid) / api.rebuildArchetypeGrants(uuid).');

  return { tagged, skipped };
}

export function rebuildArchetypeGrants(uuid) {
  return rebuild(uuid, KINDS.archetype);
}

export function rebuildClassGrants(uuid) {
  return rebuild(uuid, KINDS.class);
}
