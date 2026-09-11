/**
 * AC UDP packet codec: 20-byte header, optional header fields selected by
 * flags, and blob fragments (16-byte header + data). Ported from ACE.
 */
import { BinReader } from "../dat/reader.ts";
import { BinWriter } from "./binary.ts";
import { hash32 } from "./crypto.ts";

export const HEADER_SIZE = 20;
export const FRAGMENT_HEADER_SIZE = 16;
export const MAX_FRAGMENT_DATA = 448;
export const MAX_PACKET_PAYLOAD = 464;

export enum Flags {
  None = 0,
  Retransmission = 0x1,
  EncryptedChecksum = 0x2,
  BlobFragments = 0x4,
  ServerSwitch = 0x100,
  LogonServerAddr = 0x200,
  Referral = 0x800,
  RequestRetransmit = 0x1000,
  RejectRetransmit = 0x2000,
  AckSequence = 0x4000,
  Disconnect = 0x8000,
  LoginRequest = 0x10000,
  WorldLoginRequest = 0x20000,
  ConnectRequest = 0x40000,
  ConnectResponse = 0x80000,
  NetError = 0x100000,
  NetErrorDisconnect = 0x200000,
  CICMDCommand = 0x400000,
  TimeSync = 0x1000000,
  EchoRequest = 0x2000000,
  EchoResponse = 0x4000000,
  Flow = 0x8000000,
}

export interface PacketHeader {
  sequence: number;
  flags: number;
  checksum: number;
  id: number;
  time: number;
  size: number;
  iteration: number;
}

export interface Fragment {
  sequence: number;
  id: number;
  count: number;
  size: number;
  index: number;
  queue: number;
  data: Uint8Array;
}

export interface InboundPacket {
  header: PacketHeader;
  /** optional-header fields */
  ackSequence?: number;
  retransmitRequest?: number[];
  rejectRetransmit?: number[];
  timeSync?: number;
  echoResponse?: { clientTime: number; delta: number };
  flow?: { bytes: number; interval: number };
  /** ConnectRequest payload */
  connect?: { serverTime: number; cookie: bigint; clientId: number; serverSeed: Uint8Array; clientSeed: Uint8Array };
  referral?: { cookie: bigint; port: number; host: Uint8Array };
  netError?: { a: number; b: number };
  fragments: Fragment[];
  /** whole datagram, for checksum verification */
  raw: Uint8Array;
}

export function parsePacket(raw: Uint8Array): InboundPacket | null {
  if (raw.length < HEADER_SIZE) return null;
  const r = new BinReader(raw);
  const header: PacketHeader = {
    sequence: r.u32(), flags: r.u32(), checksum: r.u32(), id: r.u16(), time: r.u16(), size: r.u16(), iteration: r.u16(),
  };
  if (header.size > raw.length - HEADER_SIZE) return null;
  const end = HEADER_SIZE + header.size;
  const p: InboundPacket = { header, fragments: [], raw };
  const f = header.flags;
  if (f & Flags.ServerSwitch) r.skip(8);
  if (f & Flags.Referral) {
    const cookie = r.view.getBigUint64(r.pos, true); r.skip(8);
    r.u16(); // family
    const port = (r.u8() << 8) | r.u8();
    const host = r.bytes(4);
    r.skip(8); // zero
    r.skip(8); // server id + zeros
    p.referral = { cookie, port, host };
  }
  if (f & Flags.RequestRetransmit) {
    const n = r.u32();
    p.retransmitRequest = [];
    for (let i = 0; i < n; i++) p.retransmitRequest.push(r.u32());
  }
  if (f & Flags.RejectRetransmit) {
    const n = r.u32();
    p.rejectRetransmit = [];
    for (let i = 0; i < n; i++) p.rejectRetransmit.push(r.u32());
  }
  if (f & Flags.AckSequence) p.ackSequence = r.u32();
  if (f & Flags.ConnectRequest) {
    const serverTime = r.f64();
    const cookie = r.view.getBigUint64(r.pos, true); r.skip(8);
    const clientId = r.u32();
    const serverSeed = r.bytes(4).slice();
    const clientSeed = r.bytes(4).slice();
    r.u32(); // padding
    p.connect = { serverTime, cookie, clientId, serverSeed, clientSeed };
  }
  if (f & Flags.NetError || f & Flags.NetErrorDisconnect) p.netError = { a: r.u32(), b: r.u32() };
  if (f & Flags.CICMDCommand) r.skip(8);
  if (f & Flags.TimeSync) p.timeSync = r.f64();
  if (f & Flags.EchoResponse) p.echoResponse = { clientTime: r.f32(), delta: r.f32() };
  if (f & Flags.Flow) p.flow = { bytes: r.u32(), interval: r.u16() };
  if (f & Flags.BlobFragments) {
    while (r.pos + FRAGMENT_HEADER_SIZE <= end) {
      const frag: Fragment = {
        sequence: r.u32(), id: r.u32(), count: r.u16(), size: r.u16(), index: r.u16(), queue: r.u16(), data: new Uint8Array(0),
      };
      const dataLen = frag.size - FRAGMENT_HEADER_SIZE;
      if (dataLen < 0 || r.pos + dataLen > end) break;
      frag.data = raw.subarray(r.pos, r.pos + dataLen);
      r.skip(dataLen);
      p.fragments.push(frag);
    }
  }
  return p;
}

/** Build a datagram. `isaacXor` is applied when the EncryptedChecksum flag is set. */
export function buildPacket(
  header: Omit<PacketHeader, "checksum" | "size">, optional: Uint8Array, fragments: Fragment[], isaacXor: number,
): Uint8Array {
  const w = new BinWriter(HEADER_SIZE + optional.length + fragments.reduce((n, f) => n + FRAGMENT_HEADER_SIZE + f.data.length, 0));
  w.zeros(HEADER_SIZE);
  let payloadChecksum = 0;
  if (optional.length) {
    w.bytes(optional);
    payloadChecksum = (payloadChecksum + hash32(optional)) >>> 0;
  }
  for (const f of fragments) {
    const start = w.pos;
    w.u32(f.sequence).u32(f.id).u16(f.count).u16(FRAGMENT_HEADER_SIZE + f.data.length).u16(f.index).u16(f.queue);
    const fh = w.toBytes().subarray(start, start + FRAGMENT_HEADER_SIZE);
    payloadChecksum = (payloadChecksum + hash32(fh) + hash32(f.data)) >>> 0;
    w.bytes(f.data);
  }
  const out = w.toBytes();
  const view = new DataView(out.buffer);
  const size = out.length - HEADER_SIZE;
  view.setUint32(0, header.sequence >>> 0, true);
  view.setUint32(4, header.flags >>> 0, true);
  view.setUint32(8, 0xbadd70dd, true);
  view.setUint16(12, header.id, true);
  view.setUint16(14, header.time & 0xffff, true);
  view.setUint16(16, size, true);
  view.setUint16(18, header.iteration, true);
  const headerChecksum = hash32(out, 0, HEADER_SIZE);
  const xor = header.flags & Flags.EncryptedChecksum ? isaacXor : 0;
  view.setUint32(8, (headerChecksum + ((payloadChecksum ^ xor) >>> 0)) >>> 0, true);
  return out;
}

/** Verify a received packet's checksum. Returns the ISAAC key it used (0 for plain). */
export function packetChecksumKey(p: InboundPacket): { ok: boolean; key: number } {
  const raw = p.raw;
  const hdr = raw.slice(0, HEADER_SIZE);
  new DataView(hdr.buffer).setUint32(8, 0xbadd70dd, true);
  const headerChecksum = hash32(hdr);
  // optional headers = bytes between header end and first fragment
  const firstFrag = p.fragments.length ? indexOfFragmentStart(p) : HEADER_SIZE + p.header.size;
  let payload = hash32(raw, HEADER_SIZE, firstFrag - HEADER_SIZE);
  if (firstFrag - HEADER_SIZE === 0) payload = 0;
  for (const f of p.fragments) {
    const fhStart = f.data.byteOffset - raw.byteOffset - FRAGMENT_HEADER_SIZE;
    payload = (payload + hash32(raw, fhStart, FRAGMENT_HEADER_SIZE) + hash32(f.data)) >>> 0;
  }
  if (p.header.flags & Flags.EncryptedChecksum) {
    const key = (((p.header.checksum - headerChecksum) >>> 0) ^ payload) >>> 0;
    return { ok: true, key };
  }
  return { ok: ((headerChecksum + payload) >>> 0) === p.header.checksum, key: 0 };
}

function indexOfFragmentStart(p: InboundPacket): number {
  const f = p.fragments[0];
  return f.data.byteOffset - p.raw.byteOffset - FRAGMENT_HEADER_SIZE;
}
