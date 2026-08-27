import { FLAG_SCOPE } from './translate/origins.js';
import { adoptExistingFeatures, rebuildArchetypeGrants, rebuildClassGrants } from './grant-linker.js';
import { repairUseConsumers } from './repair.js';
import { ID, error, log } from './util/log.js';

// Content imported by an earlier version of this bridge is missing things the
// current one writes at import time: the tag that says a feature belongs to a
// class, the consumer that spends charges, the grants that hand features out on
// level-up. All of it can be recovered from what is already on the documents —
// so it is, once, rather than being left as homework.

const CURRENT = 2;

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

// An earlier bridge turned `@scale.rogue.sneak-attack` into `@sneakattack`,
// which a5e does not resolve: it gathers class resources onto the actor as
// `classResources`, and nothing sits at the top level under the slug alone. The
// formula evaluated to zero without ever complaining.
//
// Rewriting every bare `@word` would be guesswork, so only the slugs that are
// actually class resources in this world are touched.
function classResourceSlugs() {
  const slugs = new Set();

  const consider = (item) => {
    if (item?.type !== 'class' && item?.type !== 'archetype') return;
    for (const resource of item.system?.resources ?? []) {
      const slug = String(resource?.slug ?? '').trim();
      if (slug) slugs.add(slug);
    }
  };

  for (const item of game.items) consider(item);
  for (const actor of game.actors) for (const item of actor.items) consider(item);
  return slugs;
}

function repointFormulas(value, slugs) {
  if (typeof value === 'string') {
    return value.replace(/@([a-z][a-z0-9]*)\b/gi, (whole, slug) => (
      slugs.has(slug.toLowerCase()) ? `@classResources.${slug}` : whole
    ));
  }
  if (Array.isArray(value)) return value.map((v) => repointFormulas(v, slugs));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, repointFormulas(v, slugs)]),
    );
  }
  return value;
}

async function repairResourceReferences() {
  const slugs = classResourceSlugs();
  if (!slugs.size) return 0;

  let fixed = 0;

  const consider = async (item) => {
    const actions = item.system?.actions;
    if (!actions || !Object.keys(actions).length) return;

    const repointed = repointFormulas(actions, slugs);
    if (JSON.stringify(repointed) === JSON.stringify(actions)) return;

    await item.update({ 'system.actions': repointed }, { diff: false, recursive: false });
    fixed += 1;
  };

  for (const item of game.items) await consider(item);
  for (const actor of game.actors) for (const item of actor.items) await consider(item);

  return fixed;
}

async function repairImportedContent() {
  const { tagged } = await adoptExistingFeatures();
  const { consumers } = await repairUseConsumers();
  const references = await repairResourceReferences();

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

  return { tagged, consumers, wired, references };
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
    const { tagged, consumers, wired, references } = await repairImportedContent();
    await game.settings.set(ID, 'migration', CURRENT);

    if (tagged || consumers || wired || references) {
      const parts = [];
      if (tagged) parts.push(`tagged ${tagged} feature(s)`);
      if (consumers) parts.push(`restored ${consumers} charge consumer(s)`);
      if (wired) parts.push(`wired ${wired} class/archetype grant set(s)`);
      if (references) parts.push(`repointed ${references} scaling formula set(s)`);
      ui.notifications.info(`Plutonium ⇄ A5E: repaired earlier imports — ${parts.join(', ')}.`);
      log(`Migration complete: ${parts.join(', ')}.`);
    } else {
      log('Migration found nothing to repair.');
    }
  } catch (e) {
    error('Could not repair earlier imports. Run api.diagnose() for the details.', e);
  }
}
