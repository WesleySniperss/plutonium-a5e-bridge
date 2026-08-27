import { noteCreatedDocuments } from './grant-linker.js';
import { publishImportedFeats } from './feats.js';
import { assignSpellBooks } from './spellbook.js';
import { addCommonManeuversTo } from './maneuvers.js';
import { repairQuantityConsumers } from './translate/actions.js';
import { pruneUpdate, translateDocument } from './translate/index.js';
import { ID, debug, log, warn } from './util/log.js';

// Every document Plutonium imports funnels through four static methods on its
// internal `UtilDocuments` class, which it exposes on its public API under
// `salphar` (the hook its sibling module uses). Wrapping those four is enough to
// catch creatures, items, spells, features, journals and adventures alike — and
// it means we never have to touch Plutonium's own files.

let patched = false;

function getUtilDocuments() {
  const api = game.modules.get('plutonium')?.api ?? globalThis.plutonium;
  return api?.salphar?.UtilDocuments ?? null;
}

// a5e runs its grant routine from `_preCreate`, and there are two reasons that
// is wrong for an import.
//
// On an NPC it throws: `createInitialGrants` opens with
// `this.actor.levels.classes`, and `levels` is prepared only on *character*
// actors, so every creature trait produces an unhandled TypeError.
//
// On a character it is simply too early. A class or archetype arrives with empty
// grants — they cannot be built until the features exist, which is after the
// import finishes — and a5e opens its "Apply Grants" dialog for any class
// regardless of whether there is anything to choose. The result is a modal with
// nothing in it, applying nothing.
//
// a5e's own grant code passes `noGrant` to suppress that routine, so we use the
// same escape hatch and apply the grants ourselves once they exist.
function withGrantGuard(doc, opts, items) {
  if (doc?.documentName !== 'Actor') return opts;

  const tooEarly = items.some((item) => item?.type === 'class' || item?.type === 'archetype');
  if (doc.type === 'character' && !tooEarly) return opts;

  return {
    ...opts,
    optionsCreateEmbeddedDocuments: {
      ...(opts?.optionsCreateEmbeddedDocuments ?? {}),
      noGrant: true,
    },
  };
}

// Plutonium hands back a wrapper per created item, and finds the one it wants by
// object identity against the data it passed in:
//
//   static getImportedEmbed (importedEmbeds, itemData) {
//     const importedEmbed = importedEmbeds.find(it => it.raw === itemData);
//     if (!importedEmbed) { ui.notifications.warn("Failed to link embedded entity...
//
// We hand the creator a *translated* copy, so that identity no longer holds and
// the lookup fails — which is not cosmetic: the class importer assigns
//
//   dataBuilderOpts.classItem = DataConverter.getImportedEmbed(...)?.document;
//
// and everything downstream of a missing `classItem` silently does nothing.
//
// Plutonium builds the wrappers by index off the array it was given, and asserts
// the two lengths match, so index is a sound way back to the original.
function restoreRawIdentity(created, originals) {
  if (!Array.isArray(created) || created.length !== originals.length) return;

  created.forEach((wrapper, i) => {
    if (!wrapper || wrapper.raw === originals[i]) return;
    try {
      wrapper.raw = originals[i];
    } catch {
      // A frozen or accessor-only wrapper: leave it be rather than throw mid-import.
      debug("Could not restore raw identity on an imported embed.");
    }
  });
}


// A `quantity` consumer names the item it spends by id, and a5e looks that id up
// on the actor — an id that is only settled once the document exists, and that
// changes again whenever the item is copied. An empty or stale one makes the
// consumer do nothing at all rather than fail, so it is corrected here, after
// creation, for whichever path the import took.
async function pointQuantityConsumersAtTheirItems(created) {
  for (const entry of [created].flat()) {
    const doc = entry?.documentName ? entry : entry?.document;
    if (doc?.documentName !== 'Item') continue;

    try {
      const update = repairQuantityConsumers(doc);
      if (update) await doc.update(update);
    } catch (e) {
      debug(`Could not point a quantity consumer at "${doc.name}": ${e.message}`);
    }
  }
}

function enabled() {
  if (game.system.id !== 'a5e') return false;
  try {
    return game.settings.get(ID, 'enabled');
  } catch {
    return true;
  }
}

export function installPlutoniumBridge() {
  if (patched) return true;

  const UtilDocuments = getUtilDocuments();
  if (!UtilDocuments) {
    warn('Plutonium is not active (or too old to expose its API) — bridge not installed.');
    return false;
  }

  const origCreate = UtilDocuments.pCreateDocument.bind(UtilDocuments);
  const origCreateEmbedded = UtilDocuments.pCreateEmbeddedDocuments.bind(UtilDocuments);
  const origUpdate = UtilDocuments.pUpdateDocument.bind(UtilDocuments);
  const origUpdateEmbedded = UtilDocuments.pUpdateEmbeddedDocuments?.bind(UtilDocuments);

  UtilDocuments.pCreateDocument = async function pCreateDocument(Clazz, docData, opts) {
    if (!enabled()) return origCreate(Clazz, docData, opts);

    const name = Clazz?.metadata?.name;
    const translated = translateDocument(name, docData);
    if (translated !== docData) debug(`Translated ${name} "${docData?.name}" -> type "${translated?.type}".`);

    const created = await origCreate(Clazz, translated, opts);
    noteCreatedDocuments(created);

    // A statblock never lists the manoeuvres anyone can attempt, so they have to
    // be added rather than converted. Failing must not take the import down.
    addCommonManeuversTo(created).catch((e) => debug(`Manoeuvres failed: ${e.message}`));

    // A feat is only offered from a compendium; an import leaves it in the
    // sidebar. Failing to publish must not take the import down with it.
    publishImportedFeats(created).catch((e) => debug(`Feat publishing failed: ${e.message}`));
    return created;
  };

  UtilDocuments.pCreateEmbeddedDocuments = async function pCreateEmbeddedDocuments(doc, embedArray, opts) {
    if (!enabled() || !Array.isArray(embedArray)) {
      return origCreateEmbedded(doc, embedArray, opts);
    }

    const name = opts?.ClsEmbed?.metadata?.name;
    if (name !== 'Item') return origCreateEmbedded(doc, embedArray, opts);

    const translated = embedArray.map((embed) => translateDocument('Item', embed, doc));
    debug(`Translated ${translated.length} embedded item(s) for "${doc?.name}".`);

    await assignSpellBooks(doc, translated);

    const created = await origCreateEmbedded(doc, translated, withGrantGuard(doc, opts, translated));
    restoreRawIdentity(created, embedArray);
    await pointQuantityConsumersAtTheirItems(created);
    noteCreatedDocuments(created);
    return created;
  };

  UtilDocuments.pUpdateDocument = async function pUpdateDocument(doc, docUpdate, opts) {
    if (!enabled()) return origUpdate(doc, docUpdate, opts);
    return origUpdate(doc, pruneUpdate(doc, docUpdate), opts);
  };

  if (origUpdateEmbedded) {
    UtilDocuments.pUpdateEmbeddedDocuments = async function pUpdateEmbeddedDocuments(doc, updates, opts) {
      if (!enabled() || !Array.isArray(updates)) return origUpdateEmbedded(doc, updates, opts);

      const collection = opts?.ClsEmbed?.metadata?.collection;
      const pruned = updates.map((update) => {
        const target = collection ? doc?.[collection]?.get(update?._id) : null;
        return target ? pruneUpdate(target, update) : update;
      });
      return origUpdateEmbedded(doc, pruned, opts);
    };
  }

  patched = true;
  log('Bridge installed — Plutonium imports will be converted to a5e.');
  return true;
}
