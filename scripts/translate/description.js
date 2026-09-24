import { translateFormula } from './actions.js';

// Plutonium writes dnd5e's own enrichers into descriptions, and a5e does not
// know them, so they reach the page as literal text — "&Reference[condition=
// Prone]" in the middle of a spell. The exact shapes, from Plutonium:
//
//   `&Reference[condition=${name}]{display}`
//   `&Reference[rule=${name}]{display}`,  `&Reference[skill=${key}]{display}`
//   `[[/damage ${formula} type=${type}]]{display}`
//   `[[/save ability=${abil} dc=${dc}]]`
//
// a5e registers exactly one custom enricher, for `check`, `save`, `condition`
// and `ref`, each taking `key=value` arguments:
//
//   pattern: /\[\[\/(?<enricherType>check|save|condition|ref)(?<argString> [^\]]+)?]]/gi
//
// so `[[/save ability=dex dc=15]]` already works and is left alone; the rest are
// rewritten into something a5e renders, or into the plain words they stood for.

// a5e's own condition keys. Every 5e condition is among them except exhaustion,
// which a5e replaced with fatigue and strife — `[[/condition id=exhaustion]]`
// would render as "Invalid condition", so that one stays as text.
const A5E_CONDITIONS = new Set([
  'blinded', 'bloodied', 'charmed', 'concentration', 'confused', 'corruption',
  'dazzled', 'deafened', 'dead', 'doomed', 'encumbered', 'enervated', 'fatigue',
  'fixated', 'frightened', 'grappled', 'hungover', 'incapacitated', 'inebriated',
  'invisible', 'paralyzed', 'petrified', 'poisoned', 'prone', 'rattled',
  'restrained', 'slowed', 'strife', 'stunned', 'unconscious',
]);

// `&Reference[kind=value]` optionally followed by `{display}`.
const REFERENCE = /&Reference\[([a-z]+)=([^\]]+)\](?:\{([^}]*)\})?/gi;

// `[[/damage formula key=value …]]` optionally followed by `{display}`.
const DAMAGE = /\[\[\/damage\s+([^\]]*?)\]\](?:\{([^}]*)\})?/gi;

// a5e's argument parser takes `key="value"` but no quote inside the value.
function quoteSafe(text) {
  return String(text ?? '').replace(/["']/g, '').trim();
}

function reference(_, kind, value, display) {
  const shown = display || value;

  if (kind.toLowerCase() === 'condition') {
    const id = String(value).trim().toLowerCase();
    if (A5E_CONDITIONS.has(id)) {
      // a5e labels the link with the condition's own name unless told otherwise.
      return display
        ? `[[/condition id=${id} label="${quoteSafe(display)}"]]`
        : `[[/condition id=${id}]]`;
    }
  }

  // A rule or a skill reference was a tooltip in dnd5e, not a roll. Turning it
  // into a clickable check would change what it does, so it becomes its words.
  return shown;
}

function damage(_, body, display) {
  const parts = String(body).trim().split(/\s+/);
  const formulaParts = [];
  let type = '';

  for (const part of parts) {
    const kv = part.match(/^([a-z]+)=(.*)$/i);
    if (!kv) formulaParts.push(part);
    else if (kv[1].toLowerCase() === 'type') type = kv[2];
  }

  const formula = translateFormula(formulaParts.join(' '));
  if (!formula) return display || '';

  // Foundry's own inline roll, which every system renders and rolls.
  const flavour = type ? ` # ${type}` : '';
  return `[[/r ${formula}${flavour}]]${display ? `{${display}}` : ''}`;
}

/** Rewrite dnd5e-only enrichers in an HTML description into ones a5e renders. */
export function translateDescription(html) {
  const text = String(html ?? '');
  if (!text.includes('&Reference[') && !text.includes('[[/damage')) return text;

  return text
    .replace(REFERENCE, reference)
    .replace(DAMAGE, damage);
}
