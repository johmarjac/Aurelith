/**
 * Die JavaScript-Hälfte des Layout-Vertrags aus `types.hpp`.
 *
 * Diese Zahlen sind Kopien der Byte-Versätze im C++-Kern. Kopien driften — und
 * gegen genau das gibt es `verifyLayout`: der Kern liefert seine eigenen
 * Versätze über `describeLayout()`, und beim Start wird verglichen. Ein
 * verschobenes Feld fällt damit beim ersten Aufruf auf, statt sich später als
 * unerklärlich verrutschte Position zu zeigen.
 */

export const ENTITY_VIEW = {
  stride: 60,
  id: 0,
  targetId: 4,
  x: 8,
  y: 12,
  z: 16,
  yaw: 20,
  vx: 24,
  vz: 28,
  hp: 32,
  maxHp: 36,
  radius: 40,
  height: 44,
  defIndex: 48,
  level: 52,
  type: 54,
  state: 55,
  pitch: 56,
} as const;

export const EVENT_VIEW = {
  stride: 32,
  type: 0,
  flags: 1,
  a: 4,
  b: 8,
  value: 12,
  value2: 16,
  x: 20,
  y: 24,
  z: 28,
} as const;

export class LayoutMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LayoutMismatchError';
  }
}

/**
 * Vergleicht die erwarteten Versätze mit denen, die der Kern meldet.
 * Wirft bei der ersten Abweichung — hier weiterzumachen hieße, ab jetzt
 * falsche Zahlen zu lesen.
 */
export function verifyLayout(reported: {
  entity: Record<string, number>;
  event: Record<string, number>;
}): void {
  const check = (name: string, expected: Record<string, number>, actual: Record<string, number>) => {
    for (const [field, offset] of Object.entries(expected)) {
      const got = actual[field];
      if (got !== offset) {
        throw new LayoutMismatchError(
          `${name}.${field}: Kern meldet Versatz ${got}, TypeScript erwartet ${offset}. ` +
            'types.hpp und layout.ts sind auseinandergelaufen.',
        );
      }
    }
  };
  check('EntityView', ENTITY_VIEW, reported.entity);
  check('EventView', EVENT_VIEW, reported.event);
}
