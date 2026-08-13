/**
 * Passwörter. Gespeichert wird nie das Passwort, sondern nur, was zu ihm passt.
 *
 * `scrypt` aus dem Node-Kern, kein Paket von aussen: eine Abhängigkeit weniger
 * an der Stelle, an der eine kompromittierte Abhängigkeit am meisten anrichten
 * könnte. Die Parameter sind die Empfehlung von Node selbst (N=16384, r=8,
 * p=1) — das kostet auf einem gewöhnlichen Server rund hundert Millisekunden
 * je Anmeldung und ist genau das, was es soll: teuer für den, der Millionen
 * durchprobiert, unmerklich für den, der sich einmal anmeldet.
 *
 * Format der Zeile: `scrypt$<salt-hex>$<hash-hex>`. Das Verfahren steht mit
 * drin, damit ein späterer Wechsel die alten Zeilen nicht ungültig macht.
 */

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/**
 * Passt dieses Passwort zu dieser Zeile?
 *
 * Verglichen wird in fester Zeit. Ein gewöhnlicher Vergleich bricht beim
 * ersten falschen Byte ab, und aus dem Zeitunterschied lässt sich ein Hash
 * Byte für Byte erraten.
 *
 * Eine leere oder unbekannte Zeile passt zu nichts — auch nicht zum leeren
 * Passwort. Bestandskonten aus der Zeit ohne Passwort kommen damit nicht
 * hinein, und das ist die richtige Antwort.
 */
export async function verifyPassword(password: string, gespeichert: string): Promise<boolean> {
  const teile = gespeichert.split('$');
  if (teile.length !== 3 || teile[0] !== 'scrypt') return false;

  const salt = Buffer.from(teile[1]!, 'hex');
  const erwartet = Buffer.from(teile[2]!, 'hex');
  if (salt.length === 0 || erwartet.length !== KEY_LENGTH) return false;

  const hash = await scryptAsync(password, salt, KEY_LENGTH);
  return timingSafeEqual(hash, erwartet);
}
