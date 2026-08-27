// Everything a class does per level lives in its table, and for homebrew that is
// the *only* place it lives. Plutonium builds dnd5e `ScaleValue` advancements
// from `srdData` alone:
//
//   advancement: UtilAdvancements.getAdvancementsObject([
//     ...Object.values(srdData?.system?.advancement || {})
//       .filter(it => it.type === "ScaleValue"),
//
// so a class it cannot match against the dnd5e SRD arrives with no progression
// at all — which is why an imported homebrew feature never grew and its uses
// never went up.
//
// But the table itself is always there. Plutonium renders it into the class
// description and says so plainly:
//
//   // Always import the note and the table
//   if (!Config.get("importClass", "isImportDescription")) return `…${ptTable}…`;
//
// with a shape it generates itself, so it can be read back: a header row keyed
// by `ve-cls-tbl__col-level`, one row per level, and an em dash for zero.

const TABLE = /<table[^>]*class="[^"]*ve-cls-tbl[^"]*"[^>]*>([\s\S]*?)<\/table>/i;
const ROW = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
const CELL = /<t([hd])([^>]*)>([\s\S]*?)<\/t\1>/gi;

const LEVEL_COL = 've-cls-tbl__col-level';
const GROUP_COL = 've-cls-tbl__col-group';

// Spell slots are a5e's own business: it derives them from the class's
// `casterType`, so importing them as resources would put a second, unrelated
// set of numbers on the sheet.
const SLOT_GROUP = /spell\s*slots/i;


function stripTags(html) {
  return String(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function cellsOf(rowHtml) {
  const out = [];
  CELL.lastIndex = 0;
  let match = CELL.exec(rowHtml);
  while (match) {
    out.push({
      tag: match[1],
      attrs: match[2] ?? '',
      text: stripTags(match[3]),
      colspan: Number((match[2] ?? '').match(/colspan="(\d+)"/i)?.[1] ?? 1),
    });
    match = CELL.exec(rowHtml);
  }
  return out;
}

function levelOf(text) {
  // "1st", "20th" — Plutonium writes `Parser.getOrdinalForm(ixLvl + 1)`.
  const match = String(text).match(/^(\d+)\s*(st|nd|rd|th)?$/i);
  if (!match) return null;

  const level = Number(match[1]);
  if (!Number.isInteger(level) || level < 1 || level > 20) return null;
  return level;
}

/**
 * Read the class table Plutonium renders into a class description.
 *
 * @param {string} html  the class item's description
 * @returns {{label: string, group: string, values: Record<number, string>}[]}
 *   one entry per column beyond Level / Proficiency Bonus / Features, each with
 *   what it holds at every level the table gives.
 */
export function parseClassTable(html) {
  const table = TABLE.exec(String(html ?? ''))?.[1];
  if (!table) return [];

  const rows = [];
  ROW.lastIndex = 0;
  let match = ROW.exec(table);
  while (match) {
    rows.push(cellsOf(match[1]));
    match = ROW.exec(table);
  }

  // The header row is the one whose first cell is the level heading.
  const headerIndex = rows.findIndex((cells) => cells[0]?.tag === 'h' && cells[0].attrs.includes(LEVEL_COL));
  if (headerIndex < 0) return [];

  const headers = rows[headerIndex].slice(3).map((c) => c.text);
  if (!headers.length) return [];

  // The row above carries the group titles, each spanning its own columns.
  const groups = [];
  for (const cell of rows[headerIndex - 1] ?? []) {
    const title = cell.attrs.includes(GROUP_COL) ? cell.text : '';
    for (let i = 0; i < cell.colspan; i += 1) groups.push(title);
  }
  // That row opens with a colspan=3 spacer for Level / Prof / Features.
  const groupFor = (i) => groups[i + 3] ?? '';

  const columns = headers.map((label, i) => ({ label, group: groupFor(i), values: {} }));

  for (const cells of rows.slice(headerIndex + 1)) {
    if (cells[0]?.tag !== 'd') continue;

    const level = levelOf(cells[0].text);
    if (level == null) continue;

    cells.slice(3).forEach((cell, i) => {
      if (!columns[i]) return;
      // An em dash is how the renderer writes a zero.
      const text = cell.text === '—' ? '0' : cell.text;
      if (text) columns[i].values[level] = text;
    });
  }

  return columns.filter((col) => col.label && Object.keys(col.values).length);
}

function slugOf(label) {
  return String(label).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// A column is worth turning into a resource when every rung is a number or a
// dice expression — "5", "1d8", "2d6". A column of feature names is not.
const NUMERIC = /^\d+$/;
const DICE = /^\d*d\d+(\s*[+-]\s*\d+)?$/i;

function scalable(values) {
  const entries = Object.values(values);
  if (!entries.length) return false;
  return entries.every((v) => NUMERIC.test(v) || DICE.test(v));
}

/**
 * Turn the numeric columns of a class table into a5e class resources, so a
 * feature's damage and uses grow with level the way the book says.
 *
 * a5e resolves `system.resources[].reference[level]` into roll data at the
 * current class level, which is the same job dnd5e's ScaleValue does — this
 * just gets there without needing an SRD match.
 *
 * @param {string} html  the class item's description
 * @returns {object[]} entries for `system.resources`
 */
export function resourcesFromClassTable(html) {
  return parseClassTable(html)
    .filter((col) => !SLOT_GROUP.test(col.group) && scalable(col.values))
    .map((col) => {
      const slug = slugOf(col.label);
      if (!slug) return null;

      return {
        name: col.label,
        slug,
        consumable: false,
        displayOnCore: true,
        recovery: 'longRest',
        reference: { ...col.values },
      };
    })
    .filter(Boolean);
}

/**
 * How many new picks a column grants at each level.
 *
 * A class table states the running total — "Interdict Boons: 1 at 2nd, 2 at
 * 7th" — while an a5e grant hands out however many it is worth on its own. The
 * difference between one rung and the last is what has to be granted.
 *
 * @param {string} html         the class item's description
 * @param {string} columnLabel  which column, matched loosely
 * @returns {Record<number, number>} level -> how many to pick that level
 */
export function choiceCountsFromTable(html, columnLabel) {
  const wanted = String(columnLabel).toLowerCase().trim();
  const column = parseClassTable(html)
    .find((col) => col.label.toLowerCase().includes(wanted)
      || col.group.toLowerCase().includes(wanted));
  if (!column) return {};

  const out = {};
  let previous = 0;

  for (const level of Object.keys(column.values).map(Number).sort((a, b) => a - b)) {
    const total = Number(column.values[level]);
    if (!Number.isFinite(total)) continue;

    const gained = total - previous;
    if (gained > 0) out[level] = gained;
    previous = Math.max(previous, total);
  }

  return out;
}

/** What columns a class offers, so a choice can be pointed at one. */
export function listClassTableColumns(html) {
  return parseClassTable(html).map((col) => ({
    label: col.label,
    group: col.group || '—',
    kind: scalable(col.values) ? 'numeric' : 'text',
    sample: Object.entries(col.values).slice(0, 3).map(([l, v]) => `${l}:${v}`).join(' '),
  }));
}
