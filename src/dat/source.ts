/**
 * Byte-range sources for a .dat file. The same reader code runs in Deno
 * (local file), in the browser against a user-picked File, or against an
 * HTTP server that supports Range requests.
 */
export interface DatSource {
  readonly size: number;
  /** Read `length` bytes at `offset`. May return fewer bytes only at EOF. */
  read(offset: number, length: number): Promise<Uint8Array>;
  close?(): Promise<void> | void;
}

/** Deno local file source. */
export class DenoFileSource implements DatSource {
  private constructor(private file: Deno.FsFile, readonly size: number) {}

  static async open(path: string): Promise<DenoFileSource> {
    const file = await Deno.open(path, { read: true });
    const stat = await file.stat();
    return new DenoFileSource(file, stat.size);
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    const end = Math.min(this.size, offset + length);
    const out = new Uint8Array(Math.max(0, end - offset));
    let done = 0;
    await this.file.seek(offset, Deno.SeekMode.Start);
    while (done < out.length) {
      const n = await this.file.read(out.subarray(done));
      if (n === null) break;
      done += n;
    }
    return done === out.length ? out : out.subarray(0, done);
  }

  close(): void {
    this.file.close();
  }
}

/** Browser Blob/File source. */
export class BlobSource implements DatSource {
  readonly size: number;
  constructor(private blob: Blob) {
    this.size = blob.size;
  }
  async read(offset: number, length: number): Promise<Uint8Array> {
    const end = Math.min(this.size, offset + length);
    const ab = await this.blob.slice(offset, end).arrayBuffer();
    return new Uint8Array(ab);
  }
}

/**
 * HTTP source using Range requests (server must support them). Requests are
 * limited to a small number in flight and retried on transient failure, since
 * a dungeon landblock can fan out into thousands of small reads at once.
 */
export class HttpRangeSource implements DatSource {
  static maxInFlight = 6;
  private static inFlight = 0;
  private static waiters: (() => void)[] = [];

  private constructor(readonly url: string, readonly size: number) {}

  private static async acquire(): Promise<void> {
    if (HttpRangeSource.inFlight < HttpRangeSource.maxInFlight) { HttpRangeSource.inFlight++; return; }
    await new Promise<void>((resolve) => HttpRangeSource.waiters.push(resolve));
    HttpRangeSource.inFlight++;
  }
  private static release() {
    HttpRangeSource.inFlight--;
    HttpRangeSource.waiters.shift()?.();
  }

  static async open(url: string): Promise<HttpRangeSource> {
    const head = await fetch(url, { method: "HEAD" });
    if (!head.ok) throw new Error(`HEAD ${url}: ${head.status}`);
    const len = Number(head.headers.get("content-length"));
    if (!Number.isFinite(len) || len <= 0) throw new Error(`No content-length for ${url}`);
    return new HttpRangeSource(url, len);
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    const end = Math.min(this.size, offset + length) - 1;
    await HttpRangeSource.acquire();
    try {
      let lastErr: unknown = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const res = await fetch(this.url, { headers: { Range: `bytes=${offset}-${end}` } });
          if (res.status === 206) return new Uint8Array(await res.arrayBuffer());
          lastErr = new Error(`Range request to ${this.url} returned ${res.status}`);
        } catch (e) {
          lastErr = e;
        }
        await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
      }
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    } finally {
      HttpRangeSource.release();
    }
  }
}

/**
 * Wraps a source with a simple block cache so that many small reads within
 * the same region (directory nodes, chained file sectors) hit memory.
 */
export class CachedSource implements DatSource {
  readonly size: number;
  private cache = new Map<number, Uint8Array>();
  private order: number[] = [];

  constructor(private inner: DatSource, private chunkSize = 256 * 1024, private maxChunks = 256) {
    this.size = inner.size;
  }

  private async chunk(idx: number): Promise<Uint8Array> {
    let c = this.cache.get(idx);
    if (c) return c;
    c = await this.inner.read(idx * this.chunkSize, this.chunkSize);
    this.cache.set(idx, c);
    this.order.push(idx);
    if (this.order.length > this.maxChunks) {
      const evict = this.order.shift()!;
      this.cache.delete(evict);
    }
    return c;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    const end = Math.min(this.size, offset + length);
    const out = new Uint8Array(Math.max(0, end - offset));
    let pos = offset;
    while (pos < end) {
      const idx = Math.floor(pos / this.chunkSize);
      const c = await this.chunk(idx);
      const within = pos - idx * this.chunkSize;
      const n = Math.min(c.length - within, end - pos);
      if (n <= 0) break;
      out.set(c.subarray(within, within + n), pos - offset);
      pos += n;
    }
    return out;
  }

  close(): void {
    this.inner.close?.();
  }
}
