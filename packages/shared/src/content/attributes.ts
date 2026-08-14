/**
 * Die Eigenschaften einer Figur — und wie sie zustande kommen.
 *
 * Hier steht **die** Liste. Wer ein Attribut hinzufügt, trägt es in
 * `ATTRIBUTES` ein und lässt es beim Zusammenrechnen mitlaufen; im
 * Charakterfenster erscheint es dann von selbst. Genau das ist der Zweck: eine
 * Anzeige, die abgeschriebene Zeilen hat, zeigt irgendwann sechs von acht
 * Werten, und die zwei fehlenden sind die, an denen das Gleichgewicht kippt.
 *
 * Mitgeliefert wird nicht nur die Summe, sondern die **Herkunft**: welcher
 * Grundwert, welches Stück, welcher Satz. Zum Ausbalancieren ist die Zahl
 * allein wertlos — die Frage ist immer, woher sie kommt.
 */

/** Wie ein Wert zu lesen ist. */
export type AttributeForm = 'zahl' | 'prozent' | 'faktor' | 'sekunden' | 'tempo';

export interface AttributeDef {
  /** Schlüssel im Protokoll. Wird nie umbenannt. */
  id: string;
  /** Was im Fenster steht. */
  name: string;
  form: AttributeForm;
  /**
   * Ist weniger besser?
   *
   * Für die Schlagpause gilt das. Ohne diese Angabe läse sich „+0,2 s" wie ein
   * Gewinn, und beim Ausbalancieren wäre das genau die falsche Richtung.
   */
  wenigerIstBesser?: boolean;
  /** Kurze Erklärung, für den Hinweistext an der Zeile. */
  hinweis?: string;
}

export const ATTRIBUTES: readonly AttributeDef[] = [
  { id: 'maxHp', name: 'Leben', form: 'zahl' },
  { id: 'maxMp', name: 'Mana', form: 'zahl' },
  {
    id: 'hpRegen',
    name: 'Lebensregeneration',
    form: 'zahl',
    hinweis: 'Leben je Sekunde ausserhalb des Kampfes. Ohne ein Stück, das sie mitbringt, gibt es keine.',
  },
  {
    id: 'mpRegen',
    name: 'Manaregeneration',
    form: 'zahl',
    hinweis: 'Mana je Sekunde ausserhalb des Kampfes.',
  },
  { id: 'attackDamage', name: 'Angriff', form: 'zahl' },
  { id: 'defense', name: 'Verteidigung', form: 'zahl' },
  {
    id: 'critChance',
    name: 'Kritische Chance',
    form: 'prozent',
    hinweis: 'Wie oft ein Schlag kritisch trifft.',
  },
  {
    id: 'critMultiplier',
    name: 'Kritischer Schaden',
    form: 'faktor',
    hinweis: 'Womit der Schaden bei einem kritischen Treffer malgenommen wird.',
  },
  { id: 'moveSpeed', name: 'Tempo', form: 'tempo', hinweis: 'Weltenheiten je Sekunde.' },
  {
    id: 'attackRange',
    name: 'Reichweite',
    form: 'zahl',
    hinweis: 'Wie weit ein Schlag trägt. Kommt von der Waffe in der Hand.',
  },
  {
    id: 'attackCooldown',
    name: 'Schlagpause',
    form: 'sekunden',
    wenigerIstBesser: true,
    hinweis: 'Wie lange es zwischen zwei Schlägen dauert. Weniger ist besser.',
  },
];

export function attributeDef(id: string): AttributeDef | undefined {
  return ATTRIBUTES.find((a) => a.id === id);
}

/**
 * Ein Beitrag zu einem Attribut.
 *
 * Zwei Arten, weil es zwei gibt: ein flacher Zuschlag und ein Anteil. Wer nur
 * flache Zuschläge kennt, kann „zehn Prozent mehr Leben" nicht ausdrücken,
 * ohne die Grundwerte zu kennen — und wer nur Anteile kennt, nicht „+12
 * Angriff".
 */
export interface AttributeSource {
  /** Woher — ein Gegenstandsname, „Grundwert", ein Satzname. */
  quelle: string;
  /** Flacher Zuschlag, kann negativ sein. */
  flach: number;
  /** Anteil, 0.1 heisst zehn Prozent mehr. Kann negativ sein. */
  prozent: number;
}

export interface AttributeValue {
  id: string;
  /** Was die Stufe allein hergibt. */
  basis: number;
  /** Alles, was dazukommt — in der Reihenfolge, in der es angewandt wurde. */
  quellen: AttributeSource[];
  /** Was am Ende gilt. Genau dieser Wert geht auch in die Simulation. */
  gesamt: number;
}

/**
 * Die eine Rechnung: erst alles Flache, dann die Anteile darauf.
 *
 * `gesamt = (basis + Σflach) × (1 + Σprozent)`
 *
 * Die Reihenfolge ist eine Festlegung und keine Selbstverständlichkeit —
 * Anteile auf die Summe statt auf den Grundwert. Anders herum wäre ein
 * Prozentzuschlag umso schwächer, je besser die Ausrüstung ist, und das ist
 * das Gegenteil dessen, was jeder erwartet.
 */
export function summiere(basis: number, quellen: readonly AttributeSource[]): number {
  let flach = 0;
  let anteil = 0;
  for (const q of quellen) {
    flach += q.flach;
    anteil += q.prozent;
  }
  return (basis + flach) * (1 + anteil);
}

/**
 * Sammelt Beiträge und rechnet zusammen.
 *
 * Der Sammler ist bewusst simpel: `füge(id, quelle, flach, prozent)`. Wer ein
 * Attribut hinzufügt, ruft dieselbe Funktion — es gibt keinen zweiten Weg, an
 * dem man ihn vergessen könnte.
 */
export class AttributeSheet {
  private readonly basen = new Map<string, number>();
  private readonly quellen = new Map<string, AttributeSource[]>();

  /** Setzt den Grundwert eines Attributs — das, was die Stufe hergibt. */
  basis(id: string, wert: number): void {
    this.basen.set(id, wert);
    if (!this.quellen.has(id)) this.quellen.set(id, []);
  }

  /** Trägt einen Beitrag ein. Null-Beiträge werden weggelassen. */
  fuege(id: string, quelle: string, flach: number, prozent = 0): void {
    if (flach === 0 && prozent === 0) return;
    const liste = this.quellen.get(id) ?? [];
    liste.push({ quelle, flach, prozent });
    this.quellen.set(id, liste);
    if (!this.basen.has(id)) this.basen.set(id, 0);
  }

  /** Was am Ende gilt — für die Simulation. */
  wert(id: string): number {
    return summiere(this.basen.get(id) ?? 0, this.quellen.get(id) ?? []);
  }

  /**
   * Alles, in der Reihenfolge der Tabelle.
   *
   * Attribute ohne Eintrag bleiben draussen: eine Zeile „Mana 0", die es im
   * Spiel gar nicht gibt, ist keine Auskunft, sondern Füllmaterial.
   */
  alle(): AttributeValue[] {
    const raus: AttributeValue[] = [];
    for (const def of ATTRIBUTES) {
      if (!this.basen.has(def.id)) continue;
      const basis = this.basen.get(def.id) ?? 0;
      const quellen = this.quellen.get(def.id) ?? [];
      raus.push({ id: def.id, basis, quellen, gesamt: summiere(basis, quellen) });
    }
    // Was nicht in der Tabelle steht, kommt trotzdem mit — sonst verschluckt
    // die Anzeige genau das Attribut, das jemand gerade neu eingeführt hat.
    for (const [id, basis] of this.basen) {
      if (attributeDef(id)) continue;
      const quellen = this.quellen.get(id) ?? [];
      raus.push({ id, basis, quellen, gesamt: summiere(basis, quellen) });
    }
    return raus;
  }
}

/** Ein Wert, wie er im Fenster steht. */
export function formatAttribute(id: string, wert: number): string {
  const def = attributeDef(id);
  switch (def?.form) {
    case 'prozent':
      return `${(wert * 100).toFixed(1)} %`;
    case 'faktor':
      return `×${wert.toFixed(2)}`;
    case 'sekunden':
      return `${wert.toFixed(2)} s`;
    case 'tempo':
      return `${wert.toFixed(1)}`;
    default:
      // Ganze Zahlen ohne Komma, alles andere mit einer Stelle: „Leben 214,0"
      // liest sich falsch, „Reichweite 2" wäre gelogen.
      return Number.isInteger(wert) ? String(wert) : wert.toFixed(1);
  }
}

/** Ein Beitrag, wie er im Hinweistext steht — mit Vorzeichen. */
export function formatBeitrag(id: string, quelle: AttributeSource): string {
  const teile: string[] = [];
  if (quelle.flach !== 0) {
    const zahl = attributeDef(id)?.form === 'prozent'
      ? `${(quelle.flach * 100).toFixed(1)} %`
      : formatAttribute(id, Math.abs(quelle.flach));
    teile.push(`${quelle.flach > 0 ? '+' : '−'}${zahl}`);
  }
  if (quelle.prozent !== 0) {
    teile.push(`${quelle.prozent > 0 ? '+' : '−'}${Math.abs(quelle.prozent * 100).toFixed(0)} %`);
  }
  return `${quelle.quelle} ${teile.join(' ')}`.trim();
}
