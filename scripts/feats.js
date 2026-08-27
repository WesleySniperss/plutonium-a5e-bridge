import { FLAG_SCOPE } from './translate/origins.js';
import { getOrCreatePack, publish } from './grant-linker.js';
import { NAME, debug, log } from './util/log.js';

// An imported feat is already the right shape: a5e's own feats are `feature`
// documents with `system.featureType === "feat"`, checked against the system's
// `feats` pack, and that is exactly what the translation produces.
//
// What stops them being offered is where they live. Anything that picks a feat
// reads compendiums, not the world — a5e-mancer's picker walks
// `PackFilter.itemPacks()` and never looks at `game.items` — while a Plutonium
// import drops its feats straight into the sidebar. So they are published.

const FEAT_PACK = ['plutonium-a5e-feats', 'Plutonium ⇄ A5E: Feats'];

function isFeat(doc) {
  return doc?.documentName === 'Item'
    && doc.type === 'feature'
    && doc.system?.featureType === 'feat';
}

/** Every feat this bridge has imported into the world. */
export function importedFeats() {
  return game.items.filter((item) => isFeat(item) && item.flags?.[FLAG_SCOPE]);
}

/**
 * Copy imported feats into a compendium, where anything that offers a feat
 * looks. Safe to run again: `publish` matches on the library key and updates in
 * place rather than making a second copy.
 *
 * @returns {Promise<number>} how many were published
 */
export async function publishFeats(feats = null) {
  const list = feats ?? importedFeats();
  if (!list.length) return 0;

  const pack = await getOrCreatePack(FEAT_PACK);

  let published = 0;
  for (const feat of list) {
    const key = feat.flags?.[FLAG_SCOPE]?.hash || feat.name;
    try {
      await publish(pack, feat, key);
      published += 1;
    } catch (e) {
      debug(`Could not publish feat "${feat.name}": ${e.message}`);
    }
  }

  if (published) log(`Published ${published} feat(s) to "${FEAT_PACK[1]}".`);
  return published;
}

/** Publish the feats an import just brought in, and say so once. */
export async function publishImportedFeats(created) {
  if (!game.user?.isGM) return 0;

  const fresh = [created].flat()
    .map((entry) => (entry?.documentName ? entry : entry?.document))
    .filter((doc) => isFeat(doc) && !doc.parent);

  if (!fresh.length) return 0;

  const published = await publishFeats(fresh);
  if (published) {
    ui.notifications.info(
      `${NAME}: ${published} feat(s) published to a compendium, where a feat picker can find them.`,
    );
  }
  return published;
}
