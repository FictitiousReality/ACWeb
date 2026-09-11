/** Growable little-endian writer plus AC string/packed-dword helpers. */
import { BinReader } from "../dat/reader.ts";

export class BinWriter {
  private buf: Uint8Array;
  private view: DataView;
  pos = 0;

  constructor(capacity = 64) {
    this.buf = new Uint8Array(capacity);
    this.view = new DataView(this.buf.buffer);
  }

  private ensure(n: number) {
    if (this.pos + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.pos + n) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.pos));
    this.buf = nb;
    this.view = new DataView(nb.buffer);
  }

  u8(v: number) { this.ensure(1); this.view.setUint8(this.pos, v); this.pos += 1; return this; }
  u16(v: number) { this.ensure(2); this.view.setUint16(this.pos, v, true); this.pos += 2; return this; }
  u16be(v: number) { this.ensure(2); this.view.setUint16(this.pos, v, false); this.pos += 2; return this; }
  i32(v: number) { this.ensure(4); this.view.setInt32(this.pos, v, true); this.pos += 4; return this; }
  u32(v: number) { this.ensure(4); this.view.setUint32(this.pos, v >>> 0, true); this.pos += 4; return this; }
  u64(v: bigint) { this.ensure(8); this.view.setBigUint64(this.pos, v, true); this.pos += 8; return this; }
  f32(v: number) { this.ensure(4); this.view.setFloat32(this.pos, v, true); this.pos += 4; return this; }
  f64(v: number) { this.ensure(8); this.view.setFloat64(this.pos, v, true); this.pos += 8; return this; }
  bytes(b: Uint8Array) { this.ensure(b.length); this.buf.set(b, this.pos); this.pos += b.length; return this; }
  zeros(n: number) { this.ensure(n); this.buf.fill(0, this.pos, this.pos + n); this.pos += n; return this; }

  /** Pad to a 4-byte boundary (relative to buffer start). */
  align() {
    const d = this.pos % 4;
    if (d) this.zeros(4 - d);
    return this;
  }

  /** u16 length + Windows-1252 bytes, padded so length+bytes is a multiple of 4. */
  string16L(s: string) {
    const b = encode1252(s);
    this.u16(b.length).bytes(b);
    const total = 2 + b.length;
    const pad = (4 - (total % 4)) % 4;
    return this.zeros(pad);
  }

  /** u32 length + bytes, padded to multiple of 4. */
  string32L(s: string) {
    const b = encode1252(s);
    this.u32(b.length).bytes(b);
    const total = 4 + b.length;
    return this.zeros((4 - (total % 4)) % 4);
  }

  packedDword(v: number) {
    if (v <= 32767) return this.u16(v);
    const packed = ((v << 16) | ((v >>> 16) | 0x8000)) >>> 0;
    return this.u32(packed);
  }

  packedDwordOfKnownType(v: number, type: number) {
    if ((v & type) > 0) v -= type;
    return this.packedDword(v);
  }

  toBytes(): Uint8Array<ArrayBuffer> {
    return this.buf.slice(0, this.pos) as Uint8Array<ArrayBuffer>;
  }
}

export function encode1252(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[i] = c < 256 ? c : 0x3f;
  }
  return out;
}

const decoder = new TextDecoder("windows-1252");

/** Reader helpers matching ACE's BinaryReader extensions. */
export function readString16L(r: BinReader): string {
  const len = r.u16();
  const s = decoder.decode(r.bytes(len));
  const pad = (4 - ((2 + len) % 4)) % 4;
  r.skip(pad);
  return s;
}

export function readString32L(r: BinReader): string {
  const len = r.u32();
  const s = decoder.decode(r.bytes(len));
  r.skip((4 - ((4 + len) % 4)) % 4);
  return s;
}

export function readPackedDword(r: BinReader): number {
  const v = r.u16();
  if ((v & 0x8000) === 0) return v;
  const lower = r.u16();
  return (((v & 0x7fff) << 16) | lower) >>> 0;
}

export function readPackedDwordOfKnownType(r: BinReader, type: number): number {
  const v = readPackedDword(r);
  return (v & type) === 0 ? (v + type) >>> 0 : v;
}

export function alignReader(r: BinReader) {
  const d = r.pos % 4;
  if (d) r.skip(4 - d);
}

export { BinReader };
