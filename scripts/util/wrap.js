import { ID } from './log.js';

// Methods other modules may also be wrapping go through libWrapper.
//
// libWrapper is how Foundry modules share one method: Plutonium wraps
// `CONFIG.Actor.documentClass.prototype.getRollData` through it, and a5e 1.4
// sets `CONFIG.Actor.documentClass` to `ActorA5E` itself — the very prototype
// the roll-data shim adds to. Assigning over a method libWrapper manages is
// what its warning describes:
//
//   "… and Plutonium modify the same FoundryVTT functionality and are more
//    likely to conflict."
//   Detected non-libWrapper wrapping of '…getRollData' by module plutonium-a5e.
//
// Registered with libWrapper instead, both wrappers run in turn and nothing is
// reported. Plutonium will not start without libWrapper, so it is here whenever
// this module has work to do; the plain assignment is only for a world without it.

/**
 * The prototypes that carry an actor method, each with the libWrapper path
 * that reaches it. a5e has registered per-type classes in some versions and
 * one class in others.
 * @param {string} method
 * @returns {{ target: string, owner: object }[]}
 */
export function actorMethodTargets(method) {
  const out = [];
  const seen = new Set();

  for (const [type, cls] of Object.entries(CONFIG.A5E?.Actor?.documentClasses ?? {})) {
    const owner = cls?.prototype;
    if (!/^\w+$/.test(type) || typeof owner?.[method] !== 'function' || seen.has(owner)) continue;
    seen.add(owner);
    out.push({ target: `CONFIG.A5E.Actor.documentClasses.${type}.prototype.${method}`, owner });
  }

  if (!out.length) {
    const owner = CONFIG.Actor?.documentClass?.prototype;
    if (typeof owner?.[method] === 'function') {
      out.push({ target: `CONFIG.Actor.documentClass.prototype.${method}`, owner });
    }
  }
  return out;
}

/**
 * Wrap `owner[name]`, reached from the global scope as `target`.
 * @param {string} target   libWrapper path, e.g. "CONFIG.Actor.documentClass.prototype.getRollData"
 * @param {object} owner    the object `target` resolves to, for the fallback
 * @param {string} name     the method's name on it
 * @param {Function} wrapper  `function (wrapped, ...args)`, called with the instance as `this`;
 *                            it must call `wrapped(...args)` exactly once
 * @returns {"libWrapper"|"direct"}
 */
export function wrapMethod(target, owner, name, wrapper) {
  const lw = globalThis.libWrapper;
  if (typeof lw?.register === 'function') {
    lw.register(ID, target, wrapper, 'WRAPPER');
    return 'libWrapper';
  }

  const orig = owner[name];
  owner[name] = function wrappedMethod(...args) {
    return wrapper.call(this, (...a) => orig.apply(this, a), ...args);
  };
  return 'direct';
}
