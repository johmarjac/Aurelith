/**
 * Öffentliche Oberfläche der geteilten Schicht.
 *
 * Client und Server importieren ausschließlich von hier. Das ist die „schmale,
 * benannte Brücke" aus dem Blueprint: was hier nicht steht, ist intern und darf
 * sich ohne Absprache ändern.
 *
 * Die Simulation steht bewusst nicht in dieser Liste — sie liegt im C++-Kern
 * unter `packages/core` und wird über `@aurelith/core` angesprochen.
 */

export * from './math.ts';

export * from './net/bytes.ts';
export * from './net/cipher.ts';
export * from './net/frame.ts';
export * from './net/opcodes.ts';
export * from './net/messages.ts';

export * from './sim/types.ts';

export * from './content/mapFormat.ts';
export * from './content/terrainFields.ts';
export * from './content/terrainWorld.ts';
export * from './content/database.ts';
export * from './content/equipment.ts';
export * from './content/armorSets.ts';
export * from './content/attributes.ts';
export * from './content/classes.ts';
export * from './content/progression.ts';
export * from './content/quests.ts';
export * from './content/tuning.ts';
export * from './content/contentFormat.ts';
export * from './content/upgrades.ts';
export * from './content/daycycle.ts';

export * from './assets/manifest.ts';

// Nur das Format. `build/ermitteln.node.ts` steht bewusst nicht hier: es ruft
// `git` auf und gehört damit nicht in ein Browserbündel.
export * from './build/stamp.ts';

export * from './account/access.ts';

export const ENGINE_NAME = 'Aurelith';
