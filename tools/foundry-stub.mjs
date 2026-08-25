// The smallest slice of Foundry the translation layer touches, so the converters
// can be exercised outside a browser. Everything here mirrors Foundry's own
// behaviour closely enough for the assertions in `test.mjs` to mean something.

function randomID(length = 16) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < length; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function flattenObject(obj, depth = Infinity, prefix = '') {
  const out = {};
  for (const [key, value] of Object.entries(obj ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value) && Object.keys(value).length && depth > 0) {
      Object.assign(out, flattenObject(value, depth - 1, path));
    } else {
      out[path] = value;
    }
  }
  return out;
}

function expandObject(flat) {
  const out = {};
  for (const [path, value] of Object.entries(flat ?? {})) {
    const parts = path.split('.');
    let node = out;
    parts.forEach((part, i) => {
      if (i === parts.length - 1) node[part] = value;
      else node = (node[part] ??= {});
    });
  }
  return out;
}

function setProperty(obj, path, value) {
  const parts = path.split('.');
  let node = obj;
  parts.forEach((part, i) => {
    if (i === parts.length - 1) node[part] = value;
    else node = (node[part] ??= {});
  });
  return true;
}

/** Foundry adds this to `String.prototype`; `toOrigin` builds class slugs with it. */
function slugify({ replacement = '-', strict = false } = {}) {
  let slug = this.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, replacement)
    .replace(new RegExp(`^${replacement}|${replacement}$`, 'g'), '');
  if (strict) slug = slug.replace(new RegExp(`[^a-z0-9${replacement}]`, 'g'), '');
  return slug;
}

// Enough of the data-field hierarchy for `pruneUpdate` to tell a field that holds
// arbitrary keys from one that does not. a5e's `RecordField` extends
// `ObjectField`, which is why that is the distinction the real code draws.
class ObjectField {}
class SchemaField {
  constructor(fields = {}) { this.fields = fields; }
}
class NumberField {}

export function installFoundryStub() {
  globalThis.foundry = {
    utils: { randomID, flattenObject, expandObject, setProperty },
    data: { fields: { ObjectField, SchemaField, NumberField } },
  };
  if (!String.prototype.slugify) {
    Object.defineProperty(String.prototype, 'slugify', { value: slugify, writable: true });
  }
  // `debug()` reads a setting inside a try/catch; give it something that says "off".
  globalThis.game = { settings: { get: () => false } };
}

/**
 * A stand-in for a document's `system.schema`, so `pruneUpdate` can be tested.
 * @param {string[]|Record<string, 'leaf'|'object'|'schema'>} spec
 *   Dotted `system.*` paths the fake schema knows about. An array means every
 *   one is a leaf; an object names each field's kind, which is what decides
 *   whether keys nested under it are allowed.
 */
export function fakeSchema(spec) {
  const known = new Map(Array.isArray(spec) ? spec.map((p) => [p, 'leaf']) : Object.entries(spec));

  return {
    getField(path) {
      const kind = known.get(path);
      if (!kind) return null;
      if (kind === 'object') return new ObjectField();
      if (kind === 'schema') return new SchemaField({});
      return new NumberField();
    },
  };
}
