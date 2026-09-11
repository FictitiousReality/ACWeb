/** AC packet checksum (Hash32) and the ISAAC stream used to key encrypted checksums. */

export function hash32(data: Uint8Array, offset = 0, length = data.length - offset): number {
  let checksum = (length << 16) >>> 0;
  const view = new DataView(data.buffer, data.byteOffset + offset, length);
  let i = 0;
  for (; i + 4 <= length; i += 4) checksum = (checksum + view.getUint32(i, true)) >>> 0;
  let shift = 3;
  for (let j = (length >> 2) << 2; j < length; j++) {
    checksum = (checksum + ((data[offset + j] << (8 * shift--)) >>> 0)) >>> 0;
  }
  return checksum;
}

export class Isaac {
  private mm = new Uint32Array(256);
  private rsl = new Uint32Array(256);
  private a = 0;
  private b = 0;
  private c = 0;
  private offset = 255;

  constructor(seed: Uint8Array) {
    const x = new Uint32Array(8).fill(0x9e3779b9);
    for (let i = 0; i < 4; i++) this.shuffle(x);
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 256; j += 8) {
        for (let k = 0; k < 8; k++) x[k] = (x[k] + (i < 1 ? this.rsl[j + k] : this.mm[j + k])) >>> 0;
        this.shuffle(x);
        for (let k = 0; k < 8; k++) this.mm[j + k] = x[k];
      }
    }
    this.a = (seed[0] | (seed[1] << 8) | (seed[2] << 16) | (seed[3] << 24)) >>> 0;
    this.b = this.c = this.a;
    this.scramble();
  }

  next(): number {
    const v = this.rsl[this.offset];
    if (this.offset > 0) this.offset--;
    else {
      this.scramble();
      this.offset = 255;
    }
    return v;
  }

  private scramble() {
    this.c = (this.c + 1) >>> 0;
    this.b = (this.b + this.c) >>> 0;
    const mm = this.mm, rsl = this.rsl;
    let a = this.a, b = this.b;
    for (let i = 0; i < 256; i++) {
      const x = mm[i];
      switch (i & 3) {
        case 0: a = (a ^ (a << 13)) >>> 0; break;
        case 1: a = (a ^ (a >>> 6)) >>> 0; break;
        case 2: a = (a ^ (a << 2)) >>> 0; break;
        case 3: a = (a ^ (a >>> 16)) >>> 0; break;
      }
      a = (a + mm[(i + 128) & 0xff]) >>> 0;
      const y = (mm[(x >>> 2) & 0xff] + a + b) >>> 0;
      mm[i] = y;
      b = (mm[(y >>> 10) & 0xff] + x) >>> 0;
      rsl[i] = b;
    }
    this.a = a;
    this.b = b;
  }

  private shuffle(x: Uint32Array) {
    x[0] ^= x[1] << 11; x[3] = (x[3] + x[0]) >>> 0; x[1] = (x[1] + x[2]) >>> 0;
    x[1] ^= x[2] >>> 2; x[4] = (x[4] + x[1]) >>> 0; x[2] = (x[2] + x[3]) >>> 0;
    x[2] ^= x[3] << 8; x[5] = (x[5] + x[2]) >>> 0; x[3] = (x[3] + x[4]) >>> 0;
    x[3] ^= x[4] >>> 16; x[6] = (x[6] + x[3]) >>> 0; x[4] = (x[4] + x[5]) >>> 0;
    x[4] ^= x[5] << 10; x[7] = (x[7] + x[4]) >>> 0; x[5] = (x[5] + x[6]) >>> 0;
    x[5] ^= x[6] >>> 4; x[0] = (x[0] + x[5]) >>> 0; x[6] = (x[6] + x[7]) >>> 0;
    x[6] ^= x[7] << 8; x[1] = (x[1] + x[6]) >>> 0; x[7] = (x[7] + x[0]) >>> 0;
    x[7] ^= x[0] >>> 9; x[2] = (x[2] + x[7]) >>> 0; x[0] = (x[0] + x[1]) >>> 0;
  }
}
