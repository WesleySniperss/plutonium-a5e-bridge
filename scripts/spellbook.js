import { debug } from './util/log.js';

// a5e files every spell under a spell book: `SpellItemA5e._preCreate` refuses —
// returns `false`, cancelling the creation — to put a spell on an actor unless
// `system.spellBook` names one. Plutonium has no idea a5e wants that, so the
// spell is silently dropped, and Plutonium then fails the *whole* creature
// import on "Number of returned items did not match number of input items".
//
// Actors do start with a book (the `spellBooks` record field has a random-id
// initial), so this is usually just a matter of finding its id.

const TEMPLATE = {
  name: 'Spells',
  img: 'icons/svg/book.svg',
  ability: 'default',
  disableSpellConsumers: false,
  showSpellPoints: false,
  showSpellSlots: true,
};

function newSpellBook() {
  const _id = foundry.utils.randomID();
  return { _id, book: { ...TEMPLATE, _id } };
}

/** The id of an actor's first spell book, or null if it has none. */
export function spellBookIdOf(actor) {
  return Object.keys(actor?.system?.spellBooks ?? {})[0] ?? null;
}

/**
 * Give an actor payload that has not been created yet a spell book, so spells
 * being created alongside it have something to point at.
 * @returns {string} the book's id
 */
export function attachSpellBook(actorData) {
  const existing = spellBookIdOf(actorData);
  if (existing) return existing;

  const { _id, book } = newSpellBook();
  (actorData.system ??= {}).spellBooks = { [_id]: book };
  return _id;
}

/**
 * Point every spell in `items` at a spell book on `actor`, creating one first if
 * the actor somehow has none.
 * @param {Document} actor  the actor the items are about to be created on
 * @param {object[]} items  translated item payloads, mutated in place
 */
export async function assignSpellBooks(actor, items) {
  if (actor?.documentName !== 'Actor') return;

  const spells = items.filter((item) => item?.type === 'spell' && !item?.system?.spellBook);
  if (!spells.length) return;

  let id = spellBookIdOf(actor);
  if (!id) {
    const { _id, book } = newSpellBook();
    await actor.update({ [`system.spellBooks.${_id}`]: book });
    id = _id;
    debug(`Created a spell book on "${actor.name}" — it had none.`);
  }

  spells.forEach((spell) => { spell.system.spellBook = id; });
  debug(`Filed ${spells.length} spell(s) under spell book "${id}" on "${actor.name}".`);
}
