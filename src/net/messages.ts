/**
 * Game message codecs for the subset of the AC protocol the client needs to
 * log in, enter the world, see objects, move, and chat. Formats mirror ACE.
 */
import { BinReader } from "../dat/reader.ts";
import { alignReader, BinWriter, readPackedDword, readPackedDwordOfKnownType, readString16L } from "./binary.ts";

export const Opcode = {
  HearSpeech: 0x02bb,
  HearRangedSpeech: 0x02bc,
  ObjDescEvent: 0xf625,
  CharacterCreateResponse: 0xf643,
  CharacterLogOff: 0xf653,
  CharacterEnterWorld: 0xf657,
  CharacterList: 0xf658,
  CharacterError: 0xf659,
  ObjectCreate: 0xf745,
  PlayerCreate: 0xf746,
  ObjectDelete: 0xf747,
  UpdatePosition: 0xf748,
  ParentEvent: 0xf749,
  PickupEvent: 0xf74a,
  SetState: 0xf74b,
  Motion: 0xf74c,
  VectorUpdate: 0xf74e,
  Sound: 0xf750,
  PlayerTeleport: 0xf751,
  AutonomousPosition: 0xf753,
  PlayScriptId: 0xf754,
  PlayEffect: 0xf755,
  GameEvent: 0xf7b0,
  GameAction: 0xf7b1,
  AccountBanned: 0xf7c1,
  CharacterEnterWorldRequest: 0xf7c8,
  AccountBoot: 0xf7dc,
  UpdateObject: 0xf7db,
  CharacterEnterWorldServerReady: 0xf7df,
  ServerMessage: 0xf7e0,
  ServerName: 0xf7e1,
  DDD_Interrogation: 0xf7e5,
  DDD_InterrogationResponse: 0xf7e6,
  DDD_BeginDDD: 0xf7e7,
  DDD_EndDDD: 0xf7ea,
} as const;

export const Group = { Invalid: 0, Event: 1, Control: 2, Weenie: 3, Login: 4, Database: 5, SecureWeenie: 7, UI: 9, Smartbox: 10 } as const;

export const GameActionType = {
  Talk: 0x15,
  LoginComplete: 0xa1,
  PingRequest: 0x1e9,
  Jump: 0xf61b,
  MoveToState: 0xf61c,
  AutonomousPosition: 0xf753,
} as const;

export interface Position {
  cell: number;
  x: number;
  y: number;
  z: number;
  qw: number;
  qx: number;
  qy: number;
  qz: number;
}

export function readPosition(r: BinReader): Position {
  return { cell: r.u32(), x: r.f32(), y: r.f32(), z: r.f32(), qw: r.f32(), qx: r.f32(), qy: r.f32(), qz: r.f32() };
}
export function writePosition(w: BinWriter, p: Position) {
  w.u32(p.cell).f32(p.x).f32(p.y).f32(p.z).f32(p.qw).f32(p.qx).f32(p.qy).f32(p.qz);
}

// ---------- inbound ----------

export interface CharacterEntry { id: number; name: string; deleteTime: number }
export interface CharacterList { characters: CharacterEntry[]; slots: number; account: string }
export function parseCharacterList(r: BinReader): CharacterList {
  r.u32();
  const n = r.u32();
  const characters: CharacterEntry[] = [];
  for (let i = 0; i < n; i++) characters.push({ id: r.u32(), name: readString16L(r), deleteTime: r.u32() });
  r.u32();
  const slots = r.u32();
  const account = readString16L(r);
  return { characters, slots, account };
}

export function parseServerName(r: BinReader): { connections: number; max: number; name: string } {
  return { connections: r.i32(), max: r.i32(), name: readString16L(r) };
}

export interface ObjDesc {
  paletteId: number;
  subPalettes: { id: number; offset: number; length: number }[];
  textureChanges: { part: number; oldTex: number; newTex: number }[];
  animPartChanges: { index: number; animId: number }[];
}
export function parseObjDesc(r: BinReader): ObjDesc {
  const start = r.pos;
  r.u8(); // 0x11
  const nPal = r.u8(), nTex = r.u8(), nParts = r.u8();
  const d: ObjDesc = { paletteId: 0, subPalettes: [], textureChanges: [], animPartChanges: [] };
  if (nPal > 0) d.paletteId = readPackedDwordOfKnownType(r, 0x4000000);
  for (let i = 0; i < nPal; i++) d.subPalettes.push({ id: readPackedDwordOfKnownType(r, 0x4000000), offset: r.u8(), length: r.u8() });
  for (let i = 0; i < nTex; i++) d.textureChanges.push({ part: r.u8(), oldTex: readPackedDwordOfKnownType(r, 0x5000000), newTex: readPackedDwordOfKnownType(r, 0x5000000) });
  for (let i = 0; i < nParts; i++) d.animPartChanges.push({ index: r.u8(), animId: readPackedDwordOfKnownType(r, 0x1000000) });
  void start;
  alignReader(r);
  return d;
}

export interface InterpretedMotion {
  stance: number;
  forward: number;
  sidestep: number;
  turn: number;
  forwardSpeed: number;
  sidestepSpeed: number;
  turnSpeed: number;
  commands: { command: number; sequence: number; speed: number }[];
}
export interface MovementData {
  movementSeq?: number;
  serverControlSeq?: number;
  autonomous: boolean;
  type: number;
  motionFlags: number;
  stance: number;
  state?: InterpretedMotion;
  stickyObject?: number;
  moveTo?: { target?: number; cell: number; x: number; y: number; z: number; runRate: number; heading: number };
}

export function parseMovementData(r: BinReader, header: boolean): MovementData {
  const md: MovementData = { autonomous: false, type: 0, motionFlags: 0, stance: 0 };
  if (header) {
    md.movementSeq = r.u16();
    md.serverControlSeq = r.u16();
    md.autonomous = r.u8() !== 0;
    alignReader(r);
  }
  md.type = r.u8();
  md.motionFlags = r.u8();
  md.stance = (r.u16() | 0x80000000) >>> 0;
  switch (md.type) {
    case 0: { // Invalid: interpreted motion state
      const packed = r.u32();
      const flags = packed & 0x7f, n = packed >>> 7;
      const st: InterpretedMotion = { stance: md.stance, forward: 0, sidestep: 0, turn: 0, forwardSpeed: 1, sidestepSpeed: 1, turnSpeed: 1, commands: [] };
      if (flags & 0x1) st.stance = (r.u16() | 0x80000000) >>> 0;
      if (flags & 0x2) st.forward = r.u16();
      if (flags & 0x8) st.sidestep = r.u16();
      if (flags & 0x20) st.turn = r.u16();
      if (flags & 0x4) st.forwardSpeed = r.f32();
      if (flags & 0x10) st.sidestepSpeed = r.f32();
      if (flags & 0x40) st.turnSpeed = r.f32();
      for (let i = 0; i < n; i++) st.commands.push({ command: r.u16(), sequence: r.u16(), speed: r.f32() });
      alignReader(r);
      md.state = st;
      if (md.motionFlags & 0x1) md.stickyObject = r.u32();
      break;
    }
    case 6: { // MoveToObject
      const target = r.u32();
      const cell = r.u32(), x = r.f32(), y = r.f32(), z = r.f32();
      r.u32(); r.f32(); r.f32(); r.f32(); r.f32(); r.f32(); const heading = r.f32();
      const runRate = r.f32();
      md.moveTo = { target, cell, x, y, z, runRate, heading };
      break;
    }
    case 7: { // MoveToPosition
      const cell = r.u32(), x = r.f32(), y = r.f32(), z = r.f32();
      r.u32(); r.f32(); r.f32(); r.f32(); r.f32(); r.f32(); const heading = r.f32();
      const runRate = r.f32();
      md.moveTo = { cell, x, y, z, runRate, heading };
      break;
    }
    case 8: { // TurnToObject
      const target = r.u32(); const heading = r.f32(); r.u32(); r.f32(); r.f32();
      md.moveTo = { target, cell: 0, x: 0, y: 0, z: 0, runRate: 0, heading };
      break;
    }
    case 9: { // TurnToHeading
      r.u32(); r.f32(); const heading = r.f32();
      md.moveTo = { cell: 0, x: 0, y: 0, z: 0, runRate: 0, heading };
      break;
    }
  }
  return md;
}

export interface PhysicsDesc {
  flags: number;
  state: number;
  movement?: MovementData;
  placement?: number;
  position?: Position;
  mtable?: number;
  stable?: number;
  petable?: number;
  setup?: number;
  parent?: { id: number; location: number };
  children: { id: number; location: number }[];
  scale?: number;
  translucency?: number;
  velocity?: [number, number, number];
  sequences: number[];
}
export function parsePhysicsDesc(r: BinReader): PhysicsDesc {
  const flags = r.u32();
  const state = r.u32();
  const d: PhysicsDesc = { flags, state, children: [], sequences: [] };
  if (flags & 0x10000) {
    const len = r.u32();
    if (len > 0) {
      const end = r.pos + len;
      d.movement = parseMovementData(r, false);
      r.pos = end;
      r.u32(); // autonomous
    }
  } else if (flags & 0x20000) d.placement = r.u32();
  if (flags & 0x8000) d.position = readPosition(r);
  if (flags & 0x2) d.mtable = r.u32();
  if (flags & 0x800) d.stable = r.u32();
  if (flags & 0x1000) d.petable = r.u32();
  if (flags & 0x1) d.setup = r.u32();
  if (flags & 0x20) d.parent = { id: r.u32(), location: r.u32() };
  if (flags & 0x40) {
    const n = r.u32();
    for (let i = 0; i < n; i++) d.children.push({ id: r.u32(), location: r.u32() });
  }
  if (flags & 0x80) d.scale = r.f32();
  if (flags & 0x100) r.f32(); // friction
  if (flags & 0x200) r.f32(); // elasticity
  if (flags & 0x40000) d.translucency = r.f32();
  if (flags & 0x4) d.velocity = [r.f32(), r.f32(), r.f32()];
  if (flags & 0x8) { r.f32(); r.f32(); r.f32(); }
  if (flags & 0x10) { r.f32(); r.f32(); r.f32(); }
  if (flags & 0x2000) r.u32();
  if (flags & 0x4000) r.f32();
  for (let i = 0; i < 9; i++) d.sequences.push(r.u16());
  alignReader(r);
  return d;
}

export interface WeenieDesc {
  flags: number;
  name: string;
  wcid: number;
  icon: number;
  itemType: number;
  objectFlags: number;
  flags2: number;
  container?: number;
  wielder?: number;
}
export function parseWeenieDesc(r: BinReader): WeenieDesc {
  const flags = r.u32();
  const name = readString16L(r);
  const wcid = readPackedDword(r);
  const icon = readPackedDwordOfKnownType(r, 0x6000000);
  const itemType = r.u32();
  const objectFlags = r.u32();
  alignReader(r);
  const d: WeenieDesc = { flags, name, wcid, icon, itemType, objectFlags, flags2: 0 };
  if (objectFlags & 0x4000000) d.flags2 = r.u32();
  if (flags & 0x1) readString16L(r);
  if (flags & 0x2) r.u8();
  if (flags & 0x4) r.u8();
  if (flags & 0x100) r.u16();
  if (flags & 0x8) r.u32();
  if (flags & 0x10) r.u32();
  if (flags & 0x20) r.f32();
  if (flags & 0x80000) r.u32();
  if (flags & 0x80) r.u32();
  if (flags & 0x200) r.u8();
  if (flags & 0x400) r.u16();
  if (flags & 0x800) r.u16();
  if (flags & 0x1000) r.u16();
  if (flags & 0x2000) r.u16();
  if (flags & 0x4000) d.container = r.u32();
  if (flags & 0x8000) d.wielder = r.u32();
  if (flags & 0x10000) r.u32();
  if (flags & 0x20000) r.u32();
  if (flags & 0x40000) r.u32();
  if (flags & 0x100000) r.u8();
  if (flags & 0x800000) r.u8();
  if (flags & 0x8000000) r.u32();
  if (flags & 0x1000000) r.u32();
  if (flags & 0x200000) r.u16();
  if (flags & 0x400000) r.u16();
  if (flags & 0x2000000) r.u32();
  if (flags & 0x4000000) {
    // RestrictionDB: version, open, monarch, packable hash table (count u16, buckets u16, then guid+u32 pairs)
    r.u32(); r.u32(); r.u32();
    const n = r.u16(); r.u16();
    for (let i = 0; i < n; i++) { r.u32(); r.u32(); }
  }
  if (flags & 0x20000000) r.u32();
  if (flags & 0x40) r.u32();
  if (flags & 0x10000000) r.u32();
  if (flags & 0x40000000) readPackedDwordOfKnownType(r, 0x6000000);
  if (d.flags2 & 0x1) readPackedDwordOfKnownType(r, 0x6000000);
  if (flags & 0x80000000) r.u32();
  if (d.flags2 & 0x2) r.u32();
  if (d.flags2 & 0x4) r.f64();
  if (d.flags2 & 0x8) r.u32();
  alignReader(r);
  return d;
}

export interface CreateObject {
  guid: number;
  objDesc: ObjDesc;
  physics: PhysicsDesc;
  weenie: WeenieDesc;
}
export function parseCreateObject(r: BinReader): CreateObject {
  const guid = r.u32();
  const objDesc = parseObjDesc(r);
  const physics = parsePhysicsDesc(r);
  const weenie = parseWeenieDesc(r);
  return { guid, objDesc, physics, weenie };
}

export interface PositionUpdate {
  guid: number;
  flags: number;
  position: Position;
  velocity?: [number, number, number];
  placement?: number;
  instanceSeq: number;
  positionSeq: number;
  teleportSeq: number;
  forcePositionSeq: number;
}
export function parseUpdatePosition(r: BinReader): PositionUpdate {
  const guid = r.u32();
  const flags = r.u32();
  const cell = r.u32(), x = r.f32(), y = r.f32(), z = r.f32();
  const qw = flags & 0x8 ? 0 : r.f32();
  const qx = flags & 0x10 ? 0 : r.f32();
  const qy = flags & 0x20 ? 0 : r.f32();
  const qz = flags & 0x40 ? 0 : r.f32();
  const u: PositionUpdate = { guid, flags, position: { cell, x, y, z, qw, qx, qy, qz }, instanceSeq: 0, positionSeq: 0, teleportSeq: 0, forcePositionSeq: 0 };
  if (flags & 0x1) u.velocity = [r.f32(), r.f32(), r.f32()];
  if (flags & 0x2) u.placement = r.u32();
  u.instanceSeq = r.u16();
  u.positionSeq = r.u16();
  u.teleportSeq = r.u16();
  u.forcePositionSeq = r.u16();
  return u;
}

export function parseMotionMessage(r: BinReader): { guid: number; instanceSeq: number; movement: MovementData } {
  const guid = r.u32();
  const instanceSeq = r.u16();
  const movement = parseMovementData(r, true);
  return { guid, instanceSeq, movement };
}

// ---------- outbound ----------

function message(opcode: number): BinWriter {
  const w = new BinWriter();
  w.u32(opcode);
  return w;
}

/** DDD interrogation response: report our dat iterations (portal, cell, language). */
export function buildDDDResponse(portalIter: number, cellIter: number, languageIter: number): Uint8Array {
  const w = message(Opcode.DDD_InterrogationResponse);
  w.u32(1); // language
  const lists: [number, number, number][] = [[0, 1, portalIter], [1, 2, cellIter], [1, 3, languageIter]];
  w.i32(lists.length);
  for (const [type, id, iter] of lists) {
    w.i32(type).i32(id);
    w.i32(iter); // CMostlyConsecutiveIntSet: total iterations, then a run [1, -N]
    w.i32(1).i32(-iter);
  }
  w.i32(0); // iterations without keys
  w.u32(0); // flags
  return w.toBytes();
}

export function buildCharacterEnterWorldRequest(): Uint8Array {
  return message(Opcode.CharacterEnterWorldRequest).toBytes();
}

export function buildCharacterEnterWorld(guid: number, account: string): Uint8Array {
  const w = message(Opcode.CharacterEnterWorld);
  w.u32(guid).string16L(account);
  return w.toBytes();
}

export function buildDDDEnd(): Uint8Array {
  return message(Opcode.DDD_EndDDD).toBytes();
}

let actionSequence = 0;
function gameAction(type: number): BinWriter {
  const w = message(Opcode.GameAction);
  w.u32(++actionSequence).u32(type);
  return w;
}

export function buildLoginComplete(): Uint8Array {
  return gameAction(GameActionType.LoginComplete).toBytes();
}

export function buildTalk(text: string): Uint8Array {
  const w = gameAction(GameActionType.Talk);
  w.string16L(text);
  return w.toBytes();
}

export function buildPing(): Uint8Array {
  return gameAction(GameActionType.PingRequest).toBytes();
}

export interface RawMotion {
  holdKey: number; // 1 none, 2 run
  stance: number;
  forward?: number; // MotionCommand
  sidestep?: number;
  turn?: number;
  turnSpeed?: number;
}
export interface ObjectSequences {
  instance: number;
  serverControl: number;
  teleport: number;
  forcePosition: number;
}

export function buildMoveToState(m: RawMotion, pos: Position, seq: ObjectSequences, contact = true): Uint8Array {
  const w = gameAction(GameActionType.MoveToState);
  let flags = 0x1 | 0x2;
  if (m.forward !== undefined) flags |= 0x4 | 0x8;
  if (m.sidestep !== undefined) flags |= 0x20 | 0x40;
  if (m.turn !== undefined) flags |= 0x100 | 0x200 | (m.turnSpeed !== undefined ? 0x400 : 0);
  w.u32(flags);
  w.u32(m.holdKey);
  w.u32(m.stance);
  if (m.forward !== undefined) { w.u32(m.forward); w.u32(m.holdKey); }
  if (m.sidestep !== undefined) { w.u32(m.sidestep); w.u32(m.holdKey); }
  if (m.turn !== undefined) { w.u32(m.turn); w.u32(m.holdKey); if (m.turnSpeed !== undefined) w.f32(m.turnSpeed); }
  writePosition(w, pos);
  w.u16(seq.instance).u16(seq.serverControl).u16(seq.teleport).u16(seq.forcePosition);
  w.u8(contact ? 1 : 0);
  w.align();
  return w.toBytes();
}

export function buildAutonomousPosition(pos: Position, seq: ObjectSequences, contact = true): Uint8Array {
  const w = gameAction(GameActionType.AutonomousPosition);
  writePosition(w, pos);
  w.u16(seq.instance).u16(seq.serverControl).u16(seq.teleport).u16(seq.forcePosition);
  w.u8(contact ? 1 : 0);
  w.align();
  return w.toBytes();
}

export function buildJump(extent: number, velocity: [number, number, number], seq: ObjectSequences): Uint8Array {
  const w = gameAction(GameActionType.Jump);
  w.f32(extent).f32(velocity[0]).f32(velocity[1]).f32(velocity[2]);
  w.u16(seq.instance).u16(seq.serverControl).u16(seq.teleport).u16(seq.forcePosition);
  w.u32(0).u32(0);
  return w.toBytes();
}
