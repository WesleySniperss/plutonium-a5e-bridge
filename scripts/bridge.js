import { noteCreatedDocuments } from './grant-linker.js';
import { assignSpellBooks } from './spellbook.js';
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

// a5e's `FeatureItemA5e._preCreate` hands every feature to
// `ActorGrantsManager.createInitialGrants`, which opens with
// `this.actor.levels.classes` — and `levels` is prepared only on *character*
// actors. So every creature trait imported onto an NPC throws a TypeError. It is
// an unhandled rejection rather than a failed import (a5e does not await the
// call), but it is one per trait, and it buries the errors that do matter.
//
// a5e's own grant code passes `noGrant` to suppress exactly this routine, so we
// use the same escape hatch. Nothing is lost: grants key off class levels, which
// an NPC does not have. Characters keep the normal behaviour — that is what
// hands out archetype features.
function withGrantGuard(doc, opts) {
  if (doc?.documentName !== 'Actor' || doc.type === 'character') return opts;

  return {
    ...opts,
    optionsCreateEmbeddedDocuments: {
      ...(opts?.optionsCreateEmbeddedDocuments ?? {}),
      noGrant: true,
    },
  };
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

    const created = await origCreateEmbedded(doc, translated, withGrantGuard(doc, opts));
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
