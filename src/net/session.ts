/**
 * AC connection session: login/connect handshake, packet sequencing, acks,
 * retransmission, fragment reassembly and outbound bundling. Mirrors the
 * behaviour of ACE.Server.Network.NetworkSession from the client side.
 */
import { BinReader } from "../dat/reader.ts";
import { BinWriter } from "./binary.ts";
import { Isaac } from "./crypto.ts";
import {
  buildPacket, Flags, type Fragment, type InboundPacket, MAX_FRAGMENT_DATA, MAX_PACKET_PAYLOAD, packetChecksumKey, parsePacket,
} from "./packet.ts";

export interface Transport {
  send(portOffset: 0 | 1, data: Uint8Array): void;
  close(): void;
}

export type SessionState = "idle" | "login" | "connect" | "connected" | "closed";

export interface GameMessage {
  opcode: number;
  reader: BinReader;
  data: Uint8Array;
}

export interface SessionEvents {
  onState?(state: SessionState, detail?: string): void;
  onMessage?(msg: GameMessage): void;
  onLog?(line: string): void;
}

interface CachedPacket {
  bytes: Uint8Array;
  flags: number;
  optional: Uint8Array;
  fragments: Fragment[];
  xor: number;
}

export class NetSession {
  state: SessionState = "idle";
  clientId = 0;
  readonly serverId = 0xb;
  private sendSeq = 1; // next outbound sequence = ++sendSeq (first data packet after connect is 2)
  private fragmentSeq = 0;
  private lastReceived = 0;
  private nextFragmentSeq: number | null = null;
  private outOfOrder = new Map<number, InboundPacket>();
  private pendingFragments = new Map<number, GameMessage>();
  private partial = new Map<number, Fragment[]>();
  private cache = new Map<number, CachedPacket>();
  private outIsaac: Isaac | null = null;
  private inIsaac: Isaac | null = null;
  private inKeys: number[] = [];
  private cookie = 0n;
  private queue: { data: Uint8Array; group: number }[] = [];
  private ackPending = false;
  private lastAck = 0;
  private lastEcho = 0;
  private lastNak = 0;
  private timer: number | undefined;
  private startTime = performance.now();
  serverTimeOffset = 0;
  debug = false;

  constructor(private transport: Transport, private events: SessionEvents = {}) {}

  private log(s: string) {
    this.events.onLog?.(s);
  }

  private setState(s: SessionState, detail?: string) {
    this.state = s;
    this.events.onState?.(s, detail);
  }

  get clientTime(): number {
    return (performance.now() - this.startTime) / 1000;
  }

  /** Begin the handshake. Password is only ever written into the login packet. */
  login(account: string, password: string) {
    const w = new BinWriter();
    w.string16L("1802");
    const start = w.pos;
    w.u32(0); // remaining length placeholder
    w.u32(2); // NetAuthType.AccountPassword
    w.u32(0); // auth flags
    w.u32(Math.floor(Date.now() / 1000) >>> 0);
    w.string16L(account);
    w.string16L("");
    w.string32L(password);
    const bytes = w.toBytes();
    new DataView(bytes.buffer).setUint32(start, bytes.length - start - 4, true);
    const pkt = buildPacket({ sequence: 0, flags: Flags.LoginRequest, id: 0, time: 0, iteration: 0 }, bytes, [], 0);
    this.transport.send(0, pkt);
    this.setState("login");
    this.timer = setInterval(() => this.tick(), 50) as unknown as number;
  }

  close() {
    if (this.timer !== undefined) clearInterval(this.timer);
    if (this.state === "connected") {
      try {
        this.sendRaw(Flags.Disconnect, new Uint8Array(0), [], false);
      } catch { /* ignore */ }
    }
    this.transport.close();
    this.setState("closed");
  }

  /** Datagram received from the relay. */
  receive(portOffset: number, raw: Uint8Array) {
    const p = parsePacket(raw);
    if (!p) { this.log(`unparseable packet (${raw.length} bytes) from port+${portOffset}`); return; }
    const h = p.header;
    if (this.debug) {
      this.log(`<< seq=${h.sequence} flags=0x${h.flags.toString(16)} id=${h.id} size=${h.size} frags=[${p.fragments.map((f) => `${f.sequence}:${f.index}/${f.count} op=${f.data.length >= 4 ? (f.data[0] | (f.data[1] << 8) | (f.data[2] << 16) | (f.data[3] << 24)).toString(16) : "?"}`).join(" ")}] port+${portOffset}`);
    }
    if (h.flags & Flags.EncryptedChecksum) this.consumeInboundKey(p);

    if (h.flags & Flags.RequestRetransmit && !(h.flags & Flags.EncryptedChecksum)) {
      for (const seq of p.retransmitRequest ?? []) this.retransmit(seq);
      return;
    }
    if (h.flags & (Flags.Disconnect | Flags.NetErrorDisconnect)) {
      this.log(`server disconnected (${p.netError ? `${p.netError.a}/${p.netError.b}` : "flags " + h.flags.toString(16)})`);
      this.close();
      return;
    }
    if (h.flags & Flags.ConnectRequest && p.connect) {
      this.handleConnectRequest(p);
      return;
    }
    if (h.flags & Flags.NetError && p.netError) this.log(`net error ${p.netError.a} ${p.netError.b}`);
    if (h.flags & Flags.RejectRetransmit && p.rejectRetransmit) {
      // the server no longer has these; skip past them
      for (const seq of [...p.rejectRetransmit].sort((a, b) => a - b)) if (seq === this.lastReceived + 1) this.lastReceived = seq;
      this.drainOutOfOrder();
      return;
    }

    // ordering
    if (h.sequence !== 0) {
      if (h.sequence <= this.lastReceived && !(h.flags === Flags.AckSequence && h.sequence === this.lastReceived)) return;
      if (h.sequence > this.lastReceived + 1) {
        this.outOfOrder.set(h.sequence, p);
        if (h.sequence >= this.lastReceived + 2 && performance.now() - this.lastNak > 1000) this.requestRetransmit(h.sequence);
        return;
      }
    }
    this.handleOrdered(p);
    this.drainOutOfOrder();
  }

  private drainOutOfOrder() {
    while (this.outOfOrder.size) {
      const next = this.outOfOrder.get(this.lastReceived + 1);
      if (!next) break;
      this.outOfOrder.delete(this.lastReceived + 1);
      this.handleOrdered(next);
    }
  }

  private consumeInboundKey(p: InboundPacket) {
    if (!this.inIsaac) return;
    const { key } = packetChecksumKey(p);
    // tolerate loss/reorder: search ahead a bounded number of keys
    const idx = this.inKeys.indexOf(key);
    if (idx >= 0) {
      this.inKeys.splice(idx, 1);
      return;
    }
    for (let i = 0; i < 256; i++) {
      const k = this.inIsaac.next();
      if (k === key) return;
      this.inKeys.push(k);
    }
    this.log(`warning: inbound checksum key not found for seq ${p.header.sequence}`);
  }

  private handleConnectRequest(p: InboundPacket) {
    const c = p.connect!;
    this.cookie = c.cookie;
    this.clientId = c.clientId;
    this.inIsaac = new Isaac(c.serverSeed);
    this.outIsaac = new Isaac(c.clientSeed);
    // ACE restarts its packet sequence at 1 for the first encrypted packet, so the
    // first packet after ConnectRequest is sequence 2 regardless of the request's own sequence.
    this.lastReceived = 1;
    // ConnectResponse goes to the server's second port
    const w = new BinWriter(8);
    w.u64(this.cookie);
    const pkt = buildPacket({ sequence: 1, flags: Flags.ConnectResponse, id: this.clientId, time: this.ticks(), iteration: 0 }, w.toBytes(), [], 0);
    this.transport.send(1, pkt);
    this.setState("connected");
    this.log(`connected as client ${this.clientId}`);
  }

  private handleOrdered(p: InboundPacket) {
    const h = p.header;
    if (h.flags & Flags.AckSequence && p.ackSequence !== undefined) {
      for (const seq of [...this.cache.keys()]) if (seq < p.ackSequence) this.cache.delete(seq);
    }
    if (h.flags & Flags.TimeSync && p.timeSync !== undefined) {
      this.serverTimeOffset = p.timeSync - this.clientTime;
    }
    if (h.flags & Flags.EchoResponse) { /* rtt available in p.echoResponse */ }
    if (h.flags & Flags.Referral && p.referral) this.log(`referral to ${[...p.referral.host].join(".")}:${p.referral.port} (ignored)`);
    for (const f of p.fragments) this.processFragment(f);
    if (h.sequence !== 0 && h.flags !== Flags.AckSequence) {
      this.lastReceived = h.sequence;
      this.ackPending = true;
    }
  }

  private processFragment(f: Fragment) {
    let msg: GameMessage | null = null;
    if (f.count !== 1) {
      let parts = this.partial.get(f.sequence);
      if (!parts) this.partial.set(f.sequence, parts = []);
      if (!parts.some((x) => x.index === f.index)) parts.push({ ...f, data: f.data.slice() });
      if (parts.length === f.count) {
        parts.sort((a, b) => a.index - b.index);
        const total = parts.reduce((n, x) => n + x.data.length, 0);
        const data = new Uint8Array(total);
        let o = 0;
        for (const x of parts) { data.set(x.data, o); o += x.data.length; }
        this.partial.delete(f.sequence);
        msg = this.makeMessage(data);
      }
    } else if (f.data.length >= 4) {
      msg = this.makeMessage(f.data.slice());
    }
    if (!msg) return;
    if (this.nextFragmentSeq === null) this.nextFragmentSeq = f.sequence;
    if (f.sequence === this.nextFragmentSeq) {
      this.dispatch(msg);
      this.nextFragmentSeq++;
      while (this.pendingFragments.has(this.nextFragmentSeq)) {
        const m = this.pendingFragments.get(this.nextFragmentSeq)!;
        this.pendingFragments.delete(this.nextFragmentSeq);
        this.dispatch(m);
        this.nextFragmentSeq++;
      }
    } else if (f.sequence > this.nextFragmentSeq) {
      this.pendingFragments.set(f.sequence, msg);
    }
  }

  private makeMessage(data: Uint8Array): GameMessage {
    const reader = new BinReader(data);
    return { opcode: reader.u32(), reader, data };
  }

  private dispatch(msg: GameMessage) {
    try {
      this.events.onMessage?.(msg);
    } catch (e) {
      this.log(`handler error for opcode ${msg.opcode.toString(16)}: ${(e as Error).message}`);
      console.error(e);
    }
  }

  private requestRetransmit(received: number) {
    const need: number[] = [];
    for (let s = this.lastReceived + 1; s < received && need.length < 100; s++) if (!this.outOfOrder.has(s)) need.push(s);
    if (!need.length) return;
    const w = new BinWriter();
    w.u32(need.length);
    for (const s of need) w.u32(s);
    this.sendRaw(Flags.RequestRetransmit, w.toBytes(), [], false, this.sendSeq);
    this.lastNak = performance.now();
  }

  private retransmit(seq: number) {
    const c = this.cache.get(seq);
    if (!c) {
      const w = new BinWriter();
      w.u32(1).u32(seq);
      this.sendRaw(Flags.RejectRetransmit, w.toBytes(), [], false, this.sendSeq);
      return;
    }
    const pkt = buildPacket(
      { sequence: seq, flags: c.flags | Flags.Retransmission, id: this.clientId, time: this.ticks(), iteration: 0 },
      c.optional, c.fragments, c.xor,
    );
    this.transport.send(0, pkt);
  }

  private ticks(): number {
    return Math.floor(this.clientTime) & 0xffff;
  }

  /** Queue a game message (opcode already included in `data`). */
  send(data: Uint8Array, group: number) {
    this.queue.push({ data, group });
    this.flush();
  }

  private tick() {
    if (this.state !== "connected") return;
    const now = performance.now();
    if (this.ackPending && now - this.lastAck > 2000) this.flush(true);
    if (now - this.lastEcho > 10000) {
      this.lastEcho = now;
      const w = new BinWriter(4);
      w.f32(this.clientTime);
      this.sendRaw(Flags.EchoRequest | Flags.EncryptedChecksum, w.toBytes(), [], true);
    }
  }

  private flush(ackOnly = false) {
    if (this.state !== "connected") return;
    if (!this.queue.length) {
      if (ackOnly && this.ackPending) {
        const w = new BinWriter(4);
        w.u32(this.lastReceived);
        this.sendRaw(Flags.AckSequence, w.toBytes(), [], false, this.sendSeq);
        this.ackPending = false;
        this.lastAck = performance.now();
      }
      return;
    }
    // split messages into fragments
    const frags: Fragment[] = [];
    for (const m of this.queue) {
      const seq = ++this.fragmentSeq;
      const count = Math.max(1, Math.ceil(m.data.length / MAX_FRAGMENT_DATA));
      for (let i = 0; i < count; i++) {
        const data = m.data.subarray(i * MAX_FRAGMENT_DATA, Math.min(m.data.length, (i + 1) * MAX_FRAGMENT_DATA));
        frags.push({ sequence: seq, id: 0x80000000, count, size: 16 + data.length, index: i, queue: m.group, data });
      }
    }
    this.queue = [];
    // pack fragments into packets
    let i = 0;
    let first = true;
    while (i < frags.length) {
      const inPacket: Fragment[] = [];
      let space = MAX_PACKET_PAYLOAD;
      let optional = new Uint8Array(0);
      let flags = Flags.EncryptedChecksum | Flags.BlobFragments;
      if (first && this.ackPending) {
        const w = new BinWriter(4);
        w.u32(this.lastReceived);
        optional = w.toBytes();
        flags |= Flags.AckSequence;
        space -= 4;
        this.ackPending = false;
        this.lastAck = performance.now();
      }
      first = false;
      while (i < frags.length && frags[i].size <= space) {
        inPacket.push(frags[i]);
        space -= frags[i].size;
        i++;
      }
      if (!inPacket.length) { i++; continue; }
      this.sendRaw(flags, optional, inPacket, true);
    }
  }

  private sendRaw(flags: number, optional: Uint8Array, fragments: Fragment[], cacheIt: boolean, fixedSeq?: number) {
    const seq = fixedSeq ?? ++this.sendSeq;
    const xor = flags & Flags.EncryptedChecksum && this.outIsaac ? this.outIsaac.next() : 0;
    const pkt = buildPacket({ sequence: seq, flags, id: this.clientId, time: this.ticks(), iteration: 0 }, optional, fragments, xor);
    if (this.debug) this.log(`>> seq=${seq} flags=0x${flags.toString(16)} frags=${fragments.length} xor=${xor.toString(16)}`);
    if (cacheIt && fixedSeq === undefined) {
      this.cache.set(seq, { bytes: pkt, flags, optional, fragments, xor });
      if (this.cache.size > 512) this.cache.delete(Math.min(...this.cache.keys()));
    }
    this.transport.send(0, pkt);
  }
}

/** WebSocket transport to the Deno relay (src/tools/proxy.ts). */
export class RelayTransport implements Transport {
  private ws: WebSocket;
  private pending: Uint8Array[] = [];
  onReceive: ((portOffset: number, data: Uint8Array) => void) | null = null;
  onOpen: (() => void) | null = null;
  onClose: ((reason: string) => void) | null = null;

  constructor(relayUrl: string, host: string, port: number) {
    const u = new URL(relayUrl);
    u.searchParams.set("host", host);
    u.searchParams.set("port", String(port));
    this.ws = new WebSocket(u.toString());
    this.ws.binaryType = "arraybuffer";
    this.ws.onopen = () => {
      for (const p of this.pending) this.ws.send(p);
      this.pending = [];
      this.onOpen?.();
    };
    this.ws.onmessage = (ev) => {
      const b = new Uint8Array(ev.data as ArrayBuffer);
      this.onReceive?.(b[0], b.subarray(1));
    };
    this.ws.onclose = (ev) => this.onClose?.(ev.reason || `code ${ev.code}`);
    this.ws.onerror = () => this.onClose?.("websocket error");
  }

  send(portOffset: 0 | 1, data: Uint8Array) {
    const framed = new Uint8Array(data.length + 1);
    framed[0] = portOffset;
    framed.set(data, 1);
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(framed);
    else this.pending.push(framed);
  }

  close() {
    this.ws.close();
  }
}
