/**
 * Little-endian binary reader over a Uint8Array, mirroring the helpers in
 * ACE.DatLoader (BinaryReaderExtensions) so record parsers can be ported 1:1.
 */
export class BinReader {
  readonly view: DataView;
  pos = 0;

  constructor(readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  get length(): number {
    return this.buf.byteLength;
  }

  get remaining(): number {
    return this.buf.byteLength - this.pos;
  }

  u8(): number {
    return this.view.getUint8(this.pos++);
  }
  i8(): number {
    return this.view.getInt8(this.pos++);
  }
  u16(): number {
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  i16(): number {
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }
  u32(): number {
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  i32(): number {
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }
  f32(): number {
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }
  f64(): number {
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }
  bytes(n: number): Uint8Array {
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  skip(n: number): void {
    this.pos += n;
  }
  peekU32(): number {
    return this.view.getUint32(this.pos, true);
  }

  /** Align to the next DWORD boundary (relative to buffer start). */
  align(): void {
    const d = this.pos % 4;
    if (d !== 0) this.pos += 4 - d;
  }

  /**
   * 1/2/4-byte packed uint. MSB clear: 1 byte. MSB set, 0x40 clear: 2 bytes (big-endian-ish).
   * Both set: 4 bytes.
   */
  compressedU32(): number {
    const b0 = this.u8();
    if ((b0 & 0x80) === 0) return b0;
    const b1 = this.u8();
    if ((b0 & 0x40) === 0) return ((b0 & 0x7f) << 8) | b1;
    const s = this.u16();
    return ((((b0 & 0x3f) << 8) | b1) << 16 | s) >>> 0;
  }

  /** u16 with optional u16 extension, added to a known type base (e.g. 0x01000000). */
  dataIdOfKnownType(knownType: number): number {
    const v = this.u16();
    if ((v & 0x8000) !== 0) {
      const lower = this.u16();
      const higher = (v & 0x3fff) << 16;
      return (knownType + ((higher | lower) >>> 0)) >>> 0;
    }
    return (knownType + v) >>> 0;
  }

  /** Length-prefixed string; length is u16 by default or u8. Windows-1252 bytes. */
  pstring(sizeOfLength: 1 | 2 = 2): string {
    const len = sizeOfLength === 1 ? this.u8() : this.u16();
    return decode1252(this.bytes(len));
  }

  /** .NET BinaryReader.ReadString: 7-bit encoded length + UTF-8 bytes. */
  csString(): string {
    let len = 0, shift = 0, b: number;
    do {
      b = this.u8();
      len |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    return new TextDecoder().decode(this.bytes(len));
  }

  /** u16 length + nibble-swapped bytes. */
  obfuscatedString(): string {
    const len = this.u16();
    const raw = this.bytes(len);
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = ((raw[i] >> 4) | (raw[i] << 4)) & 0xff;
    return decode1252(out);
  }

  unicodeString(): string {
    const len = this.compressedU32();
    let s = "";
    for (let i = 0; i < len; i++) s += String.fromCharCode(this.u16());
    return s;
  }

  vec3(): Vec3 {
    return { x: this.f32(), y: this.f32(), z: this.f32() };
  }

  /** Origin + quaternion stored as (w, x, y, z). */
  frame(): Frame {
    const origin = this.vec3();
    const w = this.f32();
    const x = this.f32();
    const y = this.f32();
    const z = this.f32();
    return { origin, rotation: { x, y, z, w } };
  }

  /** u32 count followed by u32 values. */
  u32List(): number[] {
    const n = this.u32();
    const out = new Array<number>(n);
    for (let i = 0; i < n; i++) out[i] = this.u32();
    return out;
  }

  /** compressed count followed by u32 values ("SmartArray"). */
  u32SmartArray(): number[] {
    const n = this.compressedU32();
    const out = new Array<number>(n);
    for (let i = 0; i < n; i++) out[i] = this.u32();
    return out;
  }

  /** u32 count followed by parsed items. */
  list<T>(parse: (r: BinReader) => T): T[] {
    const n = this.u32();
    const out = new Array<T>(n);
    for (let i = 0; i < n; i++) out[i] = parse(this);
    return out;
  }

  fixedList<T>(n: number, parse: (r: BinReader) => T): T[] {
    const out = new Array<T>(n);
    for (let i = 0; i < n; i++) out[i] = parse(this);
    return out;
  }

  /** compressed count, then parsed items ("SmartArray"). */
  smartList<T>(parse: (r: BinReader) => T): T[] {
    const n = this.compressedU32();
    const out = new Array<T>(n);
    for (let i = 0; i < n; i++) out[i] = parse(this);
    return out;
  }

  /** compressed count, then (u32 key, item) pairs. */
  smartMapU32<T>(parse: (r: BinReader) => T): Map<number, T> {
    const n = this.compressedU32();
    const out = new Map<number, T>();
    for (let i = 0; i < n; i++) {
      const key = this.u32();
      out.set(key, parse(this));
    }
    return out;
  }

  /** a byte of bucket size, a byte of count, then (u32 key, item) pairs; used by the UI records. */
  byteMapU32<T>(parse: (r: BinReader) => T): Map<number, T> {
    this.u8(); // bucket size
    const n = this.u8();
    const out = new Map<number, T>();
    for (let i = 0; i < n; i++) {
      const key = this.u32();
      out.set(key, parse(this));
    }
    return out;
  }

  /** compressed count, then (u16 key, item) pairs. */
  smartMapU16<T>(parse: (r: BinReader) => T): Map<number, T> {
    const n = this.compressedU32();
    const out = new Map<number, T>();
    for (let i = 0; i < n; i++) {
      const key = this.u16();
      out.set(key, parse(this));
    }
    return out;
  }

  /** u32 count, then (u32 key, item) pairs. */
  mapU32<T>(parse: (r: BinReader) => T): Map<number, T> {
    const n = this.u32();
    const out = new Map<number, T>();
    for (let i = 0; i < n; i++) {
      const key = this.u32();
      out.set(key, parse(this));
    }
    return out;
  }

  /** u32 count, then (i32 key, item) pairs. */
  mapI32<T>(parse: (r: BinReader) => T): Map<number, T> {
    const n = this.u32();
    const out = new Map<number, T>();
    for (let i = 0; i < n; i++) {
      const key = this.i32();
      out.set(key, parse(this));
    }
    return out;
  }

  /** u16 count, u16 bucket size, then (u32 key, item) pairs ("PackedHashTable"). */
  packedHashTable<T>(parse: (r: BinReader) => T): Map<number, T> {
    const n = this.u16();
    this.u16(); // bucket size
    const out = new Map<number, T>();
    for (let i = 0; i < n; i++) {
      const key = this.u32();
      out.set(key, parse(this));
    }
    return out;
  }
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}
export interface Frame {
  origin: Vec3;
  rotation: Quat;
}

const decoder1252 = new TextDecoder("windows-1252");
function decode1252(b: Uint8Array): string {
  return decoder1252.decode(b);
}

export function hex(id: number, width = 8): string {
  return id.toString(16).toUpperCase().padStart(width, "0");
}
