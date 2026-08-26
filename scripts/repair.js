import { error, log } from './util/log.js';

// a5e spends charges only through an action's `consumers` — see
// `ResourceConsumptionManager.consumeResources`, which decrements `itemUses` and
// `actionUses` and nothing else. Content imported before the bridge wrote those
// shows its charges and never spends them.
//
// Everything needed to fix it is already on the documents, so this walks what is
// there rather than asking for a re-import.

function usesConsumer(type) {
  return { type, quantity: 1, default: true, label: '' };
}

function hasUses(uses) {
  return !!String(uses?.max ?? '').trim();
}

function lacksConsumer(action, type) {
  return !Object.values(action?.consumers ?? {}).some((c) => c?.type === type);
}

/**
 * Give imported items back the ability to spend their own charges.
 *
 * @returns {Promise<{items: number, consumers: number}>}
 */
export async function repairUseConsumers() {
  const documents = [...game.items];
  for (const actor of game.actors) documents.push(...actor.items);

  let items = 0;
  let consumers = 0;

  for (const item of documents) {
    const actions = Object.entries(item.system?.actions ?? {});
    if (!actions.length) continue;

    const update = {};

    // The item's own uses hang off whichever action the sheet fires first.
    if (hasUses(item.system?.uses)) {
      const [defaultId, defaultAction] = actions.find(([, a]) => a?.default) ?? actions[0];
      if (lacksConsumer(defaultAction, 'itemUses')) {
        update[`system.actions.${defaultId}.consumers.${foundry.utils.randomID()}`] = usesConsumer('itemUses');
      }
    }

    for (const [actionId, action] of actions) {
      if (!hasUses(action?.uses)) continue;
      if (!lacksConsumer(action, 'actionUses')) continue;
      update[`system.actions.${actionId}.consumers.${foundry.utils.randomID()}`] = usesConsumer('actionUses');
    }

    const added = Object.keys(update).length;
    if (!added) continue;

    try {
      await item.update(update);
      items += 1;
      consumers += added;
    } catch (e) {
      error(`Could not repair the uses on "${item.name}".`, e);
    }
  }

  log(`Repaired ${consumers} consumer(s) across ${items} item(s).`);
  return { items, consumers };
}
