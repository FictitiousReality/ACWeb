import { BinReader, hex } from "./reader.ts";
import { CachedSource, type DatSource } from "./source.ts";
import { DatType } from "./types.ts";

const HEADER_OFFSET = 0x140;
const DIR_BRANCHES = 0x3e;
const DIR_ENTRIES = 0x3d;
const FILE_ENTRY_SIZE = 6 * 4;
const DIR_NODE_SIZE = DIR_BRANCHES * 4 + 4 + DIR_ENTRIES * FILE_ENTRY_SIZE; // 1716

export interface DatHeader {
  fileType: number;
  blockSize: number;
  fileSize: number;
  dataSet: DatType;
  dataSubset: number;
  freeHead: number;
  freeTail: number;
  freeCount: number;
  btree: number;
  newLRU: number;
  oldLRU: number;
  useLRU: boolean;
  masterMapId: number;
  enginePackVersion: number;
  gamePackVersion: number;
  versionMajor: Uint8Array;
  versionMinor: number;
}

export interface DatFileEntry {
  id: number;
  offset: number;
  size: number;
  date: number;
  iteration: number;
}

export type RecordParser<T> = (r: BinReader, id: number) => T;

/**
 * One .dat container: header, full file table, and chained-block file reads.
 * Parsed records are cached per parser so repeated lookups are free.
 */
export class DatDatabase {
  readonly files = new Map<number, DatFileEntry>();
  private caches = new WeakMap<RecordParser<unknown>, Map<number, unknown>>();
  private pending = new Map<number, Promise<Uint8Array>>();

  private constructor(readonly source: DatSource, readonly header: DatHeader) {}

  static async open(raw: DatSource): Promise<DatDatabase> {
    const source = raw instanceof CachedSource ? raw : new CachedSource(raw);
    const hb = await source.read(HEADER_OFFSET, 0x60);
    const r = new BinReader(hb);
    const header: DatHeader = {
      fileType: r.u32(),
      blockSize: r.u32(),
      fileSize: r.u32(),
      dataSet: r.u32() as DatType,
      dataSubset: r.u32(),
      freeHead: r.u32(),
      freeTail: r.u32(),
      freeCount: r.u32(),
      btree: r.u32(),
      newLRU: r.u32(),
      oldLRU: r.u32(),
      useLRU: r.u32() === 1,
      masterMapId: r.u32(),
      enginePackVersion: r.u32(),
      gamePackVersion: r.u32(),
      versionMajor: r.bytes(16),
      versionMinor: r.u32(),
    };
    if (header.fileType !== 0x5442) {
      throw new Error(`Not an AC dat file (magic ${hex(header.fileType)})`);
    }
    const db = new DatDatabase(source, header);
    await db.readDirectory(header.btree);
    return db;
  }

  get type(): DatType {
    return this.header.dataSet;
  }

  get blockSize(): number {
    return this.header.blockSize;
  }

  private async readDirectory(offset: number): Promise<void> {
    const buf = await this.readChain(offset, DIR_NODE_SIZE);
    const r = new BinReader(buf);
    const branches = new Array<number>(DIR_BRANCHES);
    for (let i = 0; i < DIR_BRANCHES; i++) branches[i] = r.u32();
    const count = r.u32();
    const entries: DatFileEntry[] = [];
    for (let i = 0; i < count; i++) {
      r.u32(); // bit flags
      entries.push({ id: r.u32(), offset: r.u32(), size: r.u32(), date: r.u32(), iteration: r.u32() });
    }
    if (branches[0] !== 0) {
      for (let i = 0; i <= count; i++) await this.readDirectory(branches[i]);
    }
    for (const e of entries) this.files.set(e.id, e);
  }

  /**
   * Follow the sector chain starting at `offset` and return `size` bytes.
   * Each sector's first dword is the address of the next sector (0 = last).
   */
  async readChain(offset: number, size: number): Promise<Uint8Array> {
    const bs = this.blockSize;
    const payload = bs - 4;
    const out = new Uint8Array(size);
    let written = 0;
    let cur = offset;
    // Read a window that covers several sectors; most chains are contiguous.
    const windowSize = Math.max(bs, Math.min(size + bs, 1 << 20));
    let win = await this.source.read(cur, windowSize);
    let winStart = cur;
    while (written < size) {
      if (cur < winStart || cur + bs > winStart + win.length) {
        win = await this.source.read(cur, windowSize);
        winStart = cur;
      }
      const local = cur - winStart;
      const next = win[local] | (win[local + 1] << 8) | (win[local + 2] << 16) | (win[local + 3] << 24);
      const n = Math.min(payload, size - written);
      out.set(win.subarray(local + 4, local + 4 + n), written);
      written += n;
      if (next === 0) break;
      cur = next >>> 0;
    }
    return out;
  }

  has(id: number): boolean {
    return this.files.has(id);
  }

  /** Raw bytes of a file, or null if not present. */
  async readFile(id: number): Promise<Uint8Array | null> {
    const entry = this.files.get(id);
    if (!entry) return null;
    let p = this.pending.get(id);
    if (!p) {
      p = this.readChain(entry.offset, entry.size).finally(() => this.pending.delete(id));
      this.pending.set(id, p);
    }
    return p;
  }

  /** Parse (and cache) a record with the given parser. Returns null if missing. */
  async get<T>(id: number, parser: RecordParser<T>): Promise<T | null> {
    let cache = this.caches.get(parser as RecordParser<unknown>);
    if (!cache) {
      cache = new Map();
      this.caches.set(parser as RecordParser<unknown>, cache);
    }
    if (cache.has(id)) return cache.get(id) as T;
    const buf = await this.readFile(id);
    if (!buf) return null;
    const value = parser(new BinReader(buf), id);
    cache.set(id, value);
    return value;
  }

  /** Iteration number (dat versioning). End of retail: cell 982, portal 2072, language 994. */
  async iteration(): Promise<number> {
    const buf = await this.readFile(0xffff0001);
    if (!buf) return 0;
    return new BinReader(buf).i32();
  }

  close(): void {
    this.source.close?.();
  }
}
