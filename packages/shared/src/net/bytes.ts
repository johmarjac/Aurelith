/**
 * Byte-Ebene des Protokolls. Alles Little-Endian, alles längenpräfixiert.
 *
 * Positionen und Winkel werden quantisiert, nicht als f32 übertragen: eine
 * Snapshot-Zeile kostet damit 13 statt 28 Byte, und die Genauigkeit von
 * 1/16 Weltnenheit liegt weit unter dem, was auf dem Bildschirm sichtbar wäre.
 */

/** Positionen als i16 in 1/16-Schritten → Reichweite ±2047,9. */
export const POS_SCALE = 16;
/** Winkel als u16 über den vollen Kreis. */
export const ANGLE_SCALE = 65536 / (Math.PI * 2);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class ByteWriter {
  private buf: Uint8Array;
  private view: DataView;
  private off = 0;

  constructor(initialCapacity = 256) {
    this.buf = new Uint8Array(initialCapacity);
    this.view = new DataView(this.buf.buffer);
  }

  private ensure(extra: number): void {
    const needed = this.off + extra;
    if (needed <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < needed) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.off));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): this {
    this.ensure(1);
    this.view.setUint8(this.off, v & 0xff);
    this.off += 1;
    return this;
  }

  i8(v: number): this {
    this.ensure(1);
    this.view.setInt8(this.off, v | 0);
    this.off += 1;
    return this;
  }

  u16(v: number): this {
    this.ensure(2);
    this.view.setUint16(this.off, v & 0xffff, true);
    this.off += 2;
    return this;
  }

  i16(v: number): this {
    this.ensure(2);
    this.view.setInt16(this.off, v | 0, true);
    this.off += 2;
    return this;
  }

  u32(v: number): this {
    this.ensure(4);
    this.view.setUint32(this.off, v >>> 0, true);
    this.off += 4;
    return this;
  }

  i32(v: number): this {
    this.ensure(4);
    this.view.setInt32(this.off, v | 0, true);
    this.off += 4;
    return this;
  }

  f32(v: number): this {
    this.ensure(4);
    this.view.setFloat32(this.off, v, true);
    this.off += 4;
    return this;
  }

  f64(v: number): this {
    this.ensure(8);
    this.view.setFloat64(this.off, v, true);
    this.off += 8;
    return this;
  }

  bool(v: boolean): this {
    return this.u8(v ? 1 : 0);
  }

  /** Quantisierte Weltkoordinate. */
  pos(v: number): this {
    return this.i16(Math.round(v * POS_SCALE));
  }

  /** Quantisierter Winkel im Bogenmaß. */
  angle(v: number): this {
    return this.u16(Math.round(v * ANGLE_SCALE) & 0xffff);
  }

  /**
   * Die Neigung in der Luft: ein Byte, ein Grad.
   *
   * Gröber als `angle` und mit Absicht. Ein Winkel, der links und rechts
   * unterscheidet, muss genau sein — eine Figur, die um zwei Grad daneben
   * schaut, zielt sichtbar vorbei. Die Nase dagegen wird nur gezeichnet, und
   * ein Grad ist feiner, als ein Auge es an einer schrägen Figur ablesen kann.
   * Der Preis wäre sonst ein zweites Byte je Wesen und Schnappschuss.
   */
  neigung(v: number): this {
    const grad = Math.round((v * 180) / Math.PI);
    return this.i8(Math.max(-90, Math.min(90, grad)));
  }

  /** UTF-8, u16-längenpräfixiert. */
  str(s: string): this {
    const bytes = textEncoder.encode(s);
    if (bytes.length > 0xffff) throw new RangeError('Zeichenkette überschreitet 65535 Byte');
    this.u16(bytes.length);
    this.ensure(bytes.length);
    this.buf.set(bytes, this.off);
    this.off += bytes.length;
    return this;
  }

  bytes(b: Uint8Array): this {
    this.ensure(b.length);
    this.buf.set(b, this.off);
    this.off += b.length;
    return this;
  }

  get length(): number {
    return this.off;
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.off);
  }
}

export class ByteReader {
  private view: DataView;
  private off = 0;

  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  private need(n: number): void {
    if (this.off + n > this.buf.byteLength) {
      throw new RangeError(`Paket zu kurz: ${n} Byte ab ${this.off} von ${this.buf.byteLength}`);
    }
  }

  u8(): number {
    this.need(1);
    const v = this.view.getUint8(this.off);
    this.off += 1;
    return v;
  }

  i8(): number {
    this.need(1);
    const v = this.view.getInt8(this.off);
    this.off += 1;
    return v;
  }

  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.off, true);
    this.off += 2;
    return v;
  }

  i16(): number {
    this.need(2);
    const v = this.view.getInt16(this.off, true);
    this.off += 2;
    return v;
  }

  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.off, true);
    this.off += 4;
    return v;
  }

  i32(): number {
    this.need(4);
    const v = this.view.getInt32(this.off, true);
    this.off += 4;
    return v;
  }

  f32(): number {
    this.need(4);
    const v = this.view.getFloat32(this.off, true);
    this.off += 4;
    return v;
  }

  f64(): number {
    this.need(8);
    const v = this.view.getFloat64(this.off, true);
    this.off += 8;
    return v;
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  pos(): number {
    return this.i16() / POS_SCALE;
  }

  angle(): number {
    return this.u16() / ANGLE_SCALE;
  }

  neigung(): number {
    return (this.i8() * Math.PI) / 180;
  }

  str(): string {
    const len = this.u16();
    this.need(len);
    const s = textDecoder.decode(this.buf.subarray(this.off, this.off + len));
    this.off += len;
    return s;
  }

  bytes(len: number): Uint8Array {
    this.need(len);
    const b = this.buf.subarray(this.off, this.off + len);
    this.off += len;
    return b;
  }

  get remaining(): number {
    return this.buf.byteLength - this.off;
  }

  get offset(): number {
    return this.off;
  }
}
