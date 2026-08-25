# Plutonium ⇄ A5E Bridge

Lets [Plutonium](https://www.patreon.com/Giddy5e) import 5etools content into the
**Level Up: Advanced 5th Edition** system instead of dnd5e.

Plutonium is written against dnd5e end to end: it reads `CONFIG.DND5E` while it
works, and everything it produces is a dnd5e document. This module sits between
Plutonium and Foundry and does three things:

1. **Config shim** — stands up a `CONFIG.DND5E` (plus the one `dnd5e` global
   Plutonium libWraps, and `game.system.config`, which it reads unguarded) so
   Plutonium's pipeline runs to completion under a5e.
2. **Patch targets** — `Patcher_ActorSheet.init()` registers three libWrapper
   patches against `game.system.applications.actor.CharacterActorSheet` without
   checking the system first. a5e has no such class, libWrapper refuses to patch
   a target it cannot resolve, and the throw takes the rest of Plutonium's
   `handleReady()` with it — importers, templates and API included — leaving it
   loaded but inert. libWrapper cannot be intercepted (it freezes itself and
   installs a non-configurable global), so instead of stopping the patch the
   bridge gives it something to patch: a stub class a5e never instantiates. The
   wrappers register and then sit idle. Everything else Plutonium patches is
   either core Foundry or already behind its own `game.system.id` check.
3. **Translation** — wraps the four methods every Plutonium import funnels
   through (`UtilDocuments.pCreateDocument`, `pCreateEmbeddedDocuments`,
   `pUpdateDocument`, `pUpdateEmbeddedDocuments`, reached through Plutonium's own
   public API) and rewrites each document from the dnd5e schema into the a5e one
   before it is created.

Plutonium's own files are never modified, with one unavoidable exception — see
Install, step 1.

## Install

1. **Let Foundry show Plutonium under a5e.** Foundry hides a module whose
   `relationships.systems` does not list the active system, and it decides that
   before any module code runs, so this cannot be fixed from inside a module.

   ```sh
   node tools/patch-plutonium-manifest.mjs
   ```

   Adds `{"id": "a5e", "type": "system"}` to Plutonium's `module.json`, keeping a
   `module.json.pre-a5e.bak` next to it. It is idempotent, and
   `--revert` puts the original back. **Re-run it after every Plutonium update.**

2. Restart Foundry, then enable **Plutonium**, **libWrapper** and
   **Plutonium ⇄ A5E Bridge** in Manage Modules.

3. Import as usual from Plutonium's sidebar buttons.

## What converts, and how well

| 5etools content | a5e result | State |
| --- | --- | --- |
| Creatures / NPCs | `npc` actor | Works. Abilities, AC, HP, hit dice, speeds, senses, skills, saves, traits, immunities, languages, CR, legendary/lair resources. |
| Creature actions & traits | `feature` items with actions | Works. Attacks get an a5e attack roll + damage roll; save effects get a saving-throw prompt; recharge is mapped to a5e uses. |
| Items, weapons, armour, gear | `object` items | Works. Object type, AC formula and dex cap, price, weight, rarity, attunement, weapon/material properties, versatile die, actions. A magic bonus is folded into the attack, the damage or the AC formula, since a5e has no field for it. |
| Spells | `spell` items | Works. Level, school, components, materials, ritual/concentration, upcast scaling, save prompt, and a spell-slot consumer so casting actually spends a slot. On an actor they are filed under a spell book — a5e refuses to create one otherwise. |
| Feats and optional features | `feature` items | Works as text plus any rollable action. No a5e grants. |
| Tokens | unchanged | Works. Prototype tokens are core Foundry data, and Plutonium takes bars, vision and disposition from its own config, defaulting to your world's default token — so nothing dnd5e-shaped rides along. |
| Maps, scenes, journals, adventures, books, roll tables, decks of cards | unchanged | Works. The bridge only rewrites Actors and Items; everything else is core Foundry data and is passed through exactly as Plutonium built it. |
| **Subclasses** | `archetype` + levelled feature grants | **Works, including automatic features on level-up.** See below. |
| **Classes** | `class` + levelled feature grants | **Features work, including on level-up.** Proficiencies, ASIs and spell slots do not — see below. |
| Backgrounds, races | `background` / `heritage` | **Text only.** See below. |

## Classes and subclasses

The two systems model a class or subclass the same way — a set of features handed out at
fixed class levels — they just encode it differently:

| | dnd5e | a5e |
| --- | --- | --- |
| where | `system.advancement[]`, type `ItemGrant` | `system.grants{}`, grantType `feature` |
| when | `level` | `level` + `levelType: "class"` |
| what | item UUIDs | item UUIDs |
| applied by | the Advancement engine | `ActorGrantsManager`, on every class-level change |

So the bridge converts one into the other. Because the features do not exist yet
while the class or subclass itself is being created, this happens in two steps:

1. **Translate.** A subclass becomes an `archetype`, a class becomes a `class`,
   and each of their features becomes an a5e `feature` tagged with the level read
   out of Plutonium's own 5etools hash.
2. **Link,** once Plutonium reports the import finished. The features are copied
   into the module's compendiums (grants need stable UUIDs, and it means the same
   class imported twice does not pile up duplicates), and the class or archetype
   gets one feature grant per level, exactly as a5e's own content is built.

After that they are ordinary a5e documents. Put them on a character — drag them,
or pick them during level-up in **a5e-mancer**, which lists classes and
archetypes from compendiums — and a5e hands out each feature as the class level
reaches it.

### Both sides have to agree on the class slug

a5e ties an archetype to its class by string: `archetype.system.class` has to
equal the class item's slug. So both are derived the same way, from the dnd5e
identifier rather than the display name — which matters twice over:

- a5e renamed several classes (barbarian → berserker, monk → adept, paladin →
  herald), so an imported Barbarian subclass says `berserker` and attaches to
  a5e's own Berserker.
- Homebrew rarely matches its own name. The Illrigger Revised class is *named*
  "Illrigger" but identifies as `illriggerrevised`; taking the name would have
  left its subclasses unable to find it.

### Which way to import

Plutonium's own advice is to import classes and subclasses straight onto the
character sheet, because in dnd5e that is what wires up the Advancement links,
proficiencies and spell slots that drag-and-drop does not. That advice still
holds for everything *except* the levelled features, for one concrete reason:

**the Charactermancer imports only the features up to the level you pick.** Bring
Champion onto a 3rd-level fighter and the import contains the 3rd-level feature
and nothing else — there is no 7th, 10th, 15th or 18th-level feature anywhere for
a grant to point at.

The same is true of a class: bring a class onto a 3rd-level character and its
5th, 6th and 7th-level features are simply not in the import.

So for automation on later levels, import the class or subclass **once from the
sidebar** as well. A directory import is not level-limited, so it fills the
library with the whole progression. The two are complementary, not alternatives:

- Sidebar import — stocks the feature library and the class/archetype compendium.
- Sheet import — sets the character up the way Plutonium intends.

Grants are always rebuilt from **everything the library holds**, never just the
last import, so doing both in either order converges on the complete set.
Importing at a higher level later tops the library up.

**Nothing is needed in a5e-mancer for classes.** Its level-up already applies the
class item's own grants and checks each one's `level` against the new class
level, so the moment an imported class *has* grants, they arrive on schedule.
Archetypes did need a change — `levelUpWithoutDialog` suppresses a5e's own grant
routine and only walks the class, so `GrantAbsorber.applyArchetypeGrants` runs
alongside it. Both are safe at every level: granted features keep their
compendium id, so ones the character already has are recognised, not duplicated.

Two caveats:

- If an import lands **straight onto a character**, Plutonium also adds the
  features as loose items — the same ones the grants now hand out. The bridge
  removes those and lets a5e grant them instead, which is what makes later
  level-ups work. Turn off *Let a5e own class and subclass features on
  characters* to keep Plutonium's items and get no automation.
- Grants that would open a picker are left alone rather than silently defaulted.
  Imported content produces plain grants, so this only affects hand-edited ones.

### Attaching imported features to a class a5e already has

You do not have to use the imported class. If you would rather keep a5e's own
Berserker and only borrow the features, point the bridge at it:

```js
game.modules.get('plutonium-a5e').api.rebuildClassGrants('Item.abc123');
```

The target is checked by *type*, not by whether this bridge imported it, so any
`class` item works — a5e's own, a homebrew one, one you built by hand.
`rebuildArchetypeGrants` behaves the same way for archetypes.

**It does not overwrite what the class already had.** a5e's own classes carry a
pile of grants — proficiencies, ability-score increases, expertise dice — and
those are left alone. Only the feature grants this bridge wrote last time are
replaced; their ids are remembered on the item, so a rebuild is repeatable.

**The class names do not have to match**, which matters because a5e renamed
several: an imported *Barbarian* feature is recognised as belonging to a5e's
*Berserker*, monk features to the *Adept*, paladin features to the *Herald*.
Identifiers, display names and slugs are all compared, with separators ignored.

### Will a5e-mancer show any of this?

Yes. Its `PackFilter` reads every Item compendium in the world, so the
module-owned `Plutonium ⇄ A5E: Classes` and `… Archetypes` packs are picked up
along with a5e's own — they are excluded only if a pack looks like one of the 5e
conversion compendiums, which these do not. Leave *Publish imported classes and
archetypes to a compendium* on and imported content appears in the builder next
to everything else.

### When the features are not in the same import

Importing subclasses on their own brings no features with them, and Plutonium
does not always finish a class and its features in one batch. So an archetype
that arrives with nothing to grant is not treated as a failure: the bridge looks
for its features among the world's items, and then in its own library, before it
gives up. Grants are always rebuilt from everything it can find, so the order the
pieces arrive in does not matter.

Matching a feature to its archetype is by class and subclass name, and those are
spelled differently on each side — dnd5e hands over an identifier like
`illriggerrevised` while the 5etools hash says `Illrigger Revised`. Separators are
ignored on both sides, which is what lets homebrew classes line up at all.

If an import was interrupted, or you have edited the features by hand, rebuild
one class's or archetype's wiring directly:

```js
const api = game.modules.get('plutonium-a5e').api;
api.rebuildArchetypeGrants('Item.abc123');
api.rebuildClassGrants('Item.def456');
```

### Deliberate gaps

**A class brings its features and its hit die — not the rest of its mechanics.**
"Here is a feature at level N" maps cleanly, and that is now converted for
classes as well as subclasses. The rest of what dnd5e keeps in Advancement does
not map: a5e spreads proficiencies, ability-score increases, expertise dice,
skill specialties and exertion across a wide set of typed grants, and drives
spell slots from a caster progression rather than a table. There is no honest
conversion for those, and inventing one would silently build wrong characters.
So an imported class hands out its features and leaves the rest blank, to be
filled in on the class item or during level-up in a5e-mancer.

**Backgrounds and heritages import their text, not their mechanics,** for the
same reason and with nothing levelled to salvage.

Related: **Plutonium's Charactermancer does not work here.** It builds dnd5e
advancement choices. Use a5e-mancer for character creation.

Other known losses:

- **Active Effects** pass through untranslated. dnd5e effect change keys
  (`system.attributes.ac.bonus`, …) do not exist in a5e, so most imported effects
  will be inert. They are visible on the item and easy to fix by hand.
- **Attack ability is inferred.** A statblock only prints a total. Where the
  creature is known, the bridge picks the ability that reproduces the printed
  number exactly (which is how a finesse attacker correctly lands on dex) and
  puts any remainder in the roll's bonus field. It always adds up; the ability
  shown may occasionally not be the one the designer intended.
- **Adamantine** has no a5e property and survives only in the description text.
- **A spell's method becomes a preparation state.** dnd5e distinguishes at-will,
  innate, pact and prepared casting; a5e has only unprepared / prepared / always
  prepared. Anything permanently available lands on "always prepared".
- Base-item identity (`system.type.baseItem`) is dropped — a5e has no equivalent.
- **Plutonium's Polymorpher does not work here.** It drives dnd5e's own
  `TransformDialog` and its `transformationSettings` setting, neither of which
  a5e has. Startup is unaffected — it only registers keybinds — so this fails
  only if the polymorpher is actually opened.

## Two things a5e insists on

Both of these are a5e rules that Plutonium has no way to know about, and both
used to break creature imports outright.

**Spells belong to a spell book.** `SpellItemA5e._preCreate` cancels the creation
of any spell on an actor whose `system.spellBook` is empty. Plutonium counts the
documents that came back, sees one missing, and fails the whole creature with
"Number of returned items did not match number of input items". So the bridge
files every imported spell under the actor's first spell book, creating one if
the actor somehow has none.

**Grants are a character thing.** `FeatureItemA5e._preCreate` hands every feature
to `ActorGrantsManager.createInitialGrants`, which starts by reading
`actor.levels.classes` — and `levels` is only prepared on *character* actors. On
an NPC that throws for every single creature trait. a5e's own grant code passes a
`noGrant` option to skip that routine, so the bridge passes it too whenever the
actor is not a character. Nothing is lost: grants key off class levels, which an
NPC does not have. Characters are untouched — their grants are what hands out
archetype features.

## Troubleshooting

**Start here.** One call answers most of it — whether Plutonium is installed,
whether its manifest names a5e, whether it is enabled, whether it finished
starting, and what to do about whichever of those is wrong:

```js
game.modules.get('plutonium-a5e').api.diagnose();
```

It also runs by itself when Plutonium is not usable, so the reason reaches you
as a notification rather than as silence.

**If Foundry will not start, or you would rather check from outside it**, the
same questions are answered from the filesystem alone — no Foundry, no browser,
no world needed. Run this from the Foundry data folder:

```sh
node modules/plutonium-a5e/tools/doctor.mjs        # report
node modules/plutonium-a5e/tools/doctor.mjs --fix  # and repair what it can
```

It reports on the bridge, libWrapper and Plutonium, says which of your a5e worlds
have them switched on, and `--fix` writes the manifest patch for you, keeping a
backup. Add `--data <path>` to check an install somewhere else.

**On a server you reach over SSH**, there is nothing to install first — run it
straight from the Foundry data folder:

```sh
cd /path/to/foundrydata   # the folder holding Config/ Data/ Logs/
curl -sL https://raw.githubusercontent.com/WesleySniperss/plutonium-a5e-bridge/main/tools/doctor.mjs | node - --fix
```

It finds the data folder from the working directory, so that is the only thing
you have to get right. Restart the Foundry service afterwards.

**"Plutonium is missing from the module list."** That is Foundry hiding it, not a
bug: it hides any module whose `relationships.systems` does not name the active
system, and it decides that before a single line of module code runs. This bridge
shows up because it names a5e; Plutonium out of the box names only dnd5e, dnd4e
and lancer. Install step 1 is what fixes it, and it has to be redone after every
Plutonium update, because an update replaces the manifest.

Turn on **Verbose conversion logging** in the module settings. It logs every
converted document, and every `CONFIG.DND5E` path Plutonium asked for that the
shim does not model — that list is exactly what to add to `KNOWN` in
`scripts/config-shim.js` if something imports oddly.

```js
// in the console, after an import
game.modules.get('plutonium-a5e').api.getUnmappedConfigPaths();
// stub patch targets created for Plutonium at startup
game.modules.get('plutonium-a5e').api.getInstalledStubs();
```

**"Unhandled dnd5e.rulesVersion" in the console.** Plutonium asks dnd5e whether
the world is on the 2014 or 2024 rules, gets nothing under a5e, and defaults to
2024. Set Plutonium's own **Config → Miscellaneous → Rules Version** to *Legacy
(2014)* or *Modern (2024)* instead of *Use game setting*: the warning stops, and
which edition it assumes stops being an accident.

If `game.modules.get('plutonium').api` is missing, Plutonium's own startup did
not finish — it assigns that at the very end of its `ready` handler. Look for an
error logged with the `Plutonium` tag; the bridge logs a warning for this case too.

Every converted document keeps `flags.plutonium-a5e.sourceType`, so you can always
tell what it started life as.

If a conversion throws, the bridge logs it and imports the untranslated document
rather than failing the whole import.

## Tests

The conversions run outside Foundry against a small stub of the handful of
globals they touch, so a mapping that drifts fails loudly instead of quietly
importing an item that no longer rolls:

```sh
node tools/test.mjs
```

The fixtures are shaped the way dnd5e 5.x hands documents to `Item.create`, and
the expected values were read out of a5e's own data models and content packs —
so a test failing after an a5e update is a real signal, not a stale assertion.

## Layout

```
scripts/
  main.js            entry point; installs the shim at import time
  config-shim.js     CONFIG.DND5E, the dnd5e global, game.system.config
  spellbook.js       files imported spells under an a5e spell book
  diagnose.js        works out why Plutonium is not usable, and says so
  patch-targets.js   the stub sheet class Plutonium's libWraps need to resolve
  bridge.js          the four wrapped Plutonium methods
  settings.js
  translate/
    index.js         dispatch + update pruning
    maps.js          every enum-to-enum table
    actions.js       dnd5e activities -> a5e actions (attacks, damage, saves)
    actor.js         npc / character
    item.js          object / spell / feature / origin items
    origins.js       class and subclass metadata, and grant building
  grant-linker.js    wires class and archetype grants to their features
tools/
  doctor.mjs         checks an install from outside Foundry, and repairs it
  patch-plutonium-manifest.mjs
  test.mjs           the conversion tests
  foundry-stub.mjs   the slice of Foundry they need
```

The a5e mappings were checked against the system's own `dnd5e-monsters`,
`dnd5e-items` and `spells` compendia, so converted content matches how the a5e
authors model the same thing.
