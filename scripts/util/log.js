export const ID = 'plutonium-a5e';
export const NAME = 'Plutonium ⇄ A5E';

const TAG = [`%c${NAME}`, 'color: #b57edc; font-weight: bold;', '|'];

export function log(...args) {
  console.log(...TAG, ...args);
}

export function warn(...args) {
  console.warn(...TAG, ...args);
}

export function error(...args) {
  console.error(...TAG, ...args);
}

// Verbose per-document tracing, off unless the "debug" setting is on. Reading the
// setting throws before `init`, so it is guarded rather than cached.
export function debug(...args) {
  let on = false;
  try { on = game.settings.get(ID, 'debug'); } catch { /* settings not ready */ }
  if (on) console.debug(...TAG, ...args);
}
