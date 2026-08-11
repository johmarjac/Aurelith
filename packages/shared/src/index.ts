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
export * from './content/database.ts';
export * from './content/progression.ts';

export * from './assets/manifest.ts';

export const ENGINE_NAME = 'Aurelith';
