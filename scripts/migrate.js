import { FLAG_SCOPE } from './translate/origins.js';
import { adoptExistingFeatures, rebuildArchetypeGrants, rebuildClassGrants } from './grant-linker.js';
import { repairUseConsumers } from './repair.js';
import { ID, error, log } from './util/log.js';

// Content imported by an earlier version of this bridge is missing things the
// current one writes at import time: the tag that says a feature belongs to a
// class, the consumer that spends charges, the grants that hand features out on
// level-up. All of it can be recovered from what is already on the documents —
// so it is, once, rather than being left as homework.

const CURRENT = 1;

/** Every class and archetype this bridge imported, wherever it ended up. */
function importedOrigins() {
  const seen = new Set();
  const out = [];

  const consider = (item) => {
    if (!item || seen.has(item.uuid)) return;
    if (item.type !== 'class' && item.type !== 'archetype') return;
    const flags = item.flags?.[FLAG_SCOPE];
    if (!flags?.class && !flags?.archetype) return;
    seen.add(item.uuid);
    out.push(item);
  };

  for (const item of game.items) consider(item);
  for (const actor of game.actors) for (const item of actor.items) consider(item);
  return out;
}

function hasFeatureGrants(item) {
  return Object.values(item.system?.grants ?? {}).some((g) => g?.grantType === 'feature');
}

async function repairImportedContent() {
  const { tagged } = await adoptExistingFeatures();
  const { consumers } = await repairUseConsumers();

  let wired = 0;
  for (const owner of importedOrigins()) {
    if (hasFeatureGrants(owner)) continue;
    try {
      if (owner.type === 'class') await rebuildClassGrants(owner.uuid);
      else await rebuildArchetypeGrants(owner.uuid);
      wired += 1;
    } catch (e) {
      // Nothing to build from is a normal outcome here, not a failure worth
      // shouting about — the import simply never brought that owner's features.
      log(`Left "${owner.name}" alone: ${e.message}`);
    }
  }

  return { tagged, consumers, wired };
}

/**
 * Bring a world imported by an older bridge up to what the current one produces.
 * Runs once, for the GM, and is safe to run again — every step checks before it
 * writes.
 */
export async function runMigrations() {
  if (!game.user.isGM) return;

  let done = 0;
  try {
    done = Number(game.settings.get(ID, 'migration')) || 0;
  } catch {
    return;
  }
  if (done >= CURRENT) return;

  try {
    const { tagged, consumers, wired } = await repairImportedContent();
    await game.settings.set(ID, 'migration', CURRENT);

    if (tagged || consumers || wired) {
      const parts = [];
      if (tagged) parts.push(`tagged ${tagged} feature(s)`);
      if (consumers) parts.push(`restored ${consumers} charge consumer(s)`);
      if (wired) parts.push(`wired ${wired} class/archetype grant set(s)`);
      ui.notifications.info(`Plutonium ⇄ A5E: repaired earlier imports — ${parts.join(', ')}.`);
      log(`Migration complete: ${parts.join(', ')}.`);
    } else {
      log('Migration found nothing to repair.');
    }
  } catch (e) {
    error('Could not repair earlier imports. Run api.diagnose() for the details.', e);
  }
}
