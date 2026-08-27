import { ID } from './util/log.js';

export function registerSettings() {
  game.settings.register(ID, 'enabled', {
    name: 'Convert Plutonium imports to a5e',
    hint: 'Turn off to let Plutonium write raw dnd5e data. Only useful for debugging — the documents it produces will not work under a5e.',
    scope: 'world',
    config: true,
    type: Boolean,
    default: true,
  });

  // The key is kept as-is so existing worlds do not lose the choice; it now
  // covers imported classes as well.
  game.settings.register(ID, 'publishArchetypes', {
    name: 'Publish imported classes and archetypes to a compendium',
    hint: 'Copies each imported class or archetype, and its features, into module-owned compendiums. a5e-mancer only offers what it can find in a compendium, so leave this on if you level up with it.',
    scope: 'world',
    config: true,
    type: Boolean,
    default: true,
  });

  game.settings.register(ID, 'commonManeuvers', {
    name: 'Give imported creatures the common manoeuvres',
    hint: 'Disarm, Grab On, Grapple, Knockdown, Overrun and Shove — what anyone can attempt in a5e. A statblock never lists them, so an import cannot learn of them; the system puts them on all 324 of its own converted monsters.',
    scope: 'world',
    config: true,
    type: Boolean,
    default: true,
  });

  game.settings.register(ID, 'actorHandover', {
    name: 'Let a5e own class and subclass features on characters',
    hint: 'When a class or subclass is imported straight onto a character, remove the loose feature items Plutonium adds and let a5e grant them instead. This is what makes later level-ups add the next feature by themselves. Turn it off to keep Plutonium’s items and get no automation.',
    scope: 'world',
    config: true,
    type: Boolean,
    default: true,
  });

  // Which imported classes a5e-mancer should offer combat maneuvers to, and on
  // whose progression. Edited through api.setClassManeuvers(), not by hand.
  game.settings.register(ID, 'classManeuvers', {
    scope: 'world',
    config: false,
    type: Object,
    default: {},
  });

  // Not shown: how far this world has been brought forward. See migrate.js.
  game.settings.register(ID, 'migration', {
    scope: 'world',
    config: false,
    type: Number,
    default: 0,
  });

  game.settings.register(ID, 'debug', {
    name: 'Verbose conversion logging',
    hint: 'Log every converted document and every dnd5e config path Plutonium asks for that this bridge does not model. Use it when something imports wrong.',
    scope: 'client',
    config: true,
    type: Boolean,
    default: false,
  });
}
