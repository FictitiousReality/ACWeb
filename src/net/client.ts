/**
 * High-level game client: login -> character list -> enter world, then a
 * live view of world objects driven by server messages.
 */
import { BinReader } from "../dat/reader.ts";
import { readString16L } from "./binary.ts";
import { NetSession, RelayTransport, type GameMessage, type SessionState } from "./session.ts";
import {
  buildAutonomousPosition, buildCharacterEnterWorld, buildCharacterEnterWorldRequest, buildDDDResponse, buildLoginComplete,
  buildMoveToState, buildTalk, Group, Opcode, parseCharacterList, parseCreateObject, parseMotionMessage, parseMovementData,
  parseObjDesc, parseServerName, parseUpdatePosition, type CharacterList, type CreateObject, type MovementData,
  type ObjectSequences, type Position, type PositionUpdate, type RawMotion,
} from "./messages.ts";

export interface WorldObject {
  guid: number;
  name: string;
  wcid: number;
  setup: number;
  mtable: number;
  scale: number;
  position: Position | null;
  parent: number | null;
  objectFlags: number;
  itemType: number;
  movement?: MovementData;
  raw: CreateObject;
}

export interface ClientEvents {
  onState?(state: string, detail?: string): void;
  onLog?(line: string): void;
  onChat?(text: string, kind: string, sender?: string): void;
  onCharacterList?(list: CharacterList): void;
  onEnterWorld?(playerGuid: number): void;
  onObjectCreate?(obj: WorldObject): void;
  onObjectUpdate?(obj: WorldObject): void;
  onObjectPosition?(obj: WorldObject, update: PositionUpdate): void;
  onObjectMotion?(obj: WorldObject, movement: MovementData): void;
  onObjectDelete?(guid: number): void;
  onPlayerTeleport?(): void;
}

export interface DatIterations { portal: number; cell: number; language: number }

export class GameClient {
  session: NetSession | null = null;
  private transport: RelayTransport | null = null;
  account = "";
  characters: CharacterList | null = null;
  serverName = "";
  playerGuid = 0;
  readonly objects = new Map<number, WorldObject>();
  playerSequences: ObjectSequences = { instance: 1, serverControl: 0, teleport: 0, forcePosition: 0 };
  private enterWorldSent = false;
  private loginCompleteSent = false;

  constructor(private relayUrl: string, private iterations: DatIterations, private events: ClientEvents = {}) {}

  private log(s: string) {
    this.events.onLog?.(s);
  }

  connect(host: string, port: number, account: string, password: string) {
    this.account = account;
    this.transport = new RelayTransport(this.relayUrl, host, port);
    const session = new NetSession(this.transport, {
      onState: (s: SessionState, d?: string) => this.events.onState?.(s, d),
      onLog: (l) => this.log(l),
      onMessage: (m) => this.handle(m),
    });
    this.session = session;
    this.transport.onReceive = (offset, data) => session.receive(offset, data);
    this.transport.onClose = (reason) => {
      this.log(`relay closed: ${reason}`);
      this.events.onState?.("closed", reason);
    };
    this.transport.onOpen = () => {
      this.log(`relay open; sending login for ${account}`);
      session.login(account, password);
    };
  }

  disconnect() {
    this.session?.close();
    this.session = null;
  }

  private send(data: Uint8Array, group: number) {
    this.session?.send(data, group);
  }

  enterWorld(characterId: number) {
    this.enterWorldSent = false;
    this.pendingCharacter = characterId;
    this.send(buildCharacterEnterWorldRequest(), Group.UI);
  }
  private pendingCharacter = 0;

  say(text: string) {
    this.send(buildTalk(text), Group.Weenie);
  }

  sendMoveToState(motion: RawMotion, pos: Position, contact = true) {
    this.send(buildMoveToState(motion, pos, this.playerSequences, contact), Group.Weenie);
  }

  sendAutonomousPosition(pos: Position, contact = true) {
    this.send(buildAutonomousPosition(pos, this.playerSequences, contact), Group.SecureWeenie);
  }

  private handle(m: GameMessage) {
    const r = m.reader;
    switch (m.opcode) {
      case Opcode.CharacterList: {
        this.characters = parseCharacterList(r);
        this.log(`character list: ${this.characters.characters.map((c) => c.name).join(", ") || "(none)"}`);
        this.events.onCharacterList?.(this.characters);
        break;
      }
      case Opcode.ServerName: {
        const s = parseServerName(r);
        this.serverName = s.name;
        this.log(`server: ${s.name} (${s.connections}/${s.max})`);
        break;
      }
      case Opcode.CharacterError: {
        const code = r.u32();
        this.log(`character error ${code}`);
        this.events.onState?.("error", `character error ${code}`);
        break;
      }
      case Opcode.DDD_Interrogation: {
        this.send(buildDDDResponse(this.iterations.portal, this.iterations.cell, this.iterations.language), Group.Database);
        break;
      }
      case Opcode.DDD_BeginDDD: {
        this.log("server wants to patch our dats (BeginDDD) - not supported");
        break;
      }
      case Opcode.DDD_EndDDD: {
        this.log("dats accepted");
        this.events.onState?.("ready");
        break;
      }
      case Opcode.CharacterEnterWorldServerReady: {
        if (this.pendingCharacter && !this.enterWorldSent) {
          this.enterWorldSent = true;
          this.send(buildCharacterEnterWorld(this.pendingCharacter, this.account), Group.UI);
          this.log("entering world...");
        }
        break;
      }
      case Opcode.PlayerCreate: {
        this.playerGuid = r.u32();
        this.log(`player guid ${this.playerGuid.toString(16)}`);
        break;
      }
      case Opcode.ObjectCreate:
      case Opcode.UpdateObject: {
        const co = parseCreateObject(r);
        const obj: WorldObject = {
          guid: co.guid, name: co.weenie.name, wcid: co.weenie.wcid, setup: co.physics.setup ?? 0, mtable: co.physics.mtable ?? 0,
          scale: co.physics.scale ?? 1, position: co.physics.position ?? null, parent: co.physics.parent?.id ?? co.weenie.wielder ?? co.weenie.container ?? null,
          objectFlags: co.weenie.objectFlags, itemType: co.weenie.itemType, movement: co.physics.movement, raw: co,
        };
        const existed = this.objects.has(co.guid);
        this.objects.set(co.guid, obj);
        if (co.guid === this.playerGuid) {
          const s = co.physics.sequences;
          this.playerSequences = { instance: s[8], serverControl: s[5], teleport: s[4], forcePosition: s[6] };
          if (!this.loginCompleteSent) {
            this.loginCompleteSent = true;
            setTimeout(() => this.send(buildLoginComplete(), Group.Weenie), 500);
            this.events.onEnterWorld?.(this.playerGuid);
          }
        }
        if (existed) this.events.onObjectUpdate?.(obj);
        else this.events.onObjectCreate?.(obj);
        break;
      }
      case Opcode.ObjectDelete: {
        const guid = r.u32();
        this.objects.delete(guid);
        this.events.onObjectDelete?.(guid);
        break;
      }
      case Opcode.UpdatePosition: {
        const u = parseUpdatePosition(r);
        const obj = this.objects.get(u.guid);
        if (obj) {
          obj.position = u.position;
          if (u.guid === this.playerGuid) {
            this.playerSequences.teleport = u.teleportSeq;
            this.playerSequences.forcePosition = u.forcePositionSeq;
          }
          this.events.onObjectPosition?.(obj, u);
        }
        break;
      }
      case Opcode.Motion: {
        const mm = parseMotionMessage(r);
        const obj = this.objects.get(mm.guid);
        if (obj) {
          obj.movement = mm.movement;
          if (mm.guid === this.playerGuid && mm.movement.serverControlSeq !== undefined && !mm.movement.autonomous) {
            this.playerSequences.serverControl = mm.movement.serverControlSeq;
          }
          this.events.onObjectMotion?.(obj, mm.movement);
        }
        break;
      }
      case Opcode.PlayerTeleport: {
        this.playerSequences.teleport = r.u16();
        this.events.onPlayerTeleport?.();
        break;
      }
      case Opcode.ObjDescEvent: {
        const guid = r.u32();
        const od = parseObjDesc(r);
        const obj = this.objects.get(guid);
        if (obj) obj.raw.objDesc = od;
        break;
      }
      case Opcode.ServerMessage: {
        const text = readString16L(r);
        const kind = r.i32();
        this.events.onChat?.(text, `system:${kind}`);
        break;
      }
      case Opcode.HearSpeech: {
        const text = readString16L(r);
        const sender = readString16L(r);
        r.u32();
        const kind = r.u32();
        this.events.onChat?.(text, `speech:${kind}`, sender);
        break;
      }
      case Opcode.HearRangedSpeech: {
        const text = readString16L(r);
        const sender = readString16L(r);
        r.u32(); r.f32();
        const kind = r.u32();
        this.events.onChat?.(text, `speech:${kind}`, sender);
        break;
      }
      case Opcode.AccountBoot: {
        const reason = r.remaining >= 2 ? readString16L(r) : "";
        this.log(`booted: ${reason}`);
        this.events.onState?.("error", `booted ${reason}`);
        break;
      }
      case Opcode.GameEvent: {
        r.u32(); r.u32();
        const type = r.u32();
        this.handleGameEvent(type, r);
        break;
      }
      default:
        break;
    }
  }

  private handleGameEvent(type: number, r: BinReader) {
    switch (type) {
      case 0x0004: // PopupString
      case 0x02eb: { // CommunicationTransientString
        const text = readString16L(r);
        this.events.onChat?.(text, "popup");
        break;
      }
      case 0x02bd: { // Tell
        const text = readString16L(r);
        const sender = readString16L(r);
        this.events.onChat?.(text, "tell", sender);
        break;
      }
      case 0x0013: // PlayerDescription: large; we don't need it yet
        break;
      default:
        break;
    }
  }
}

export { parseMovementData };
export type { CharacterList, Position, PositionUpdate, MovementData };
