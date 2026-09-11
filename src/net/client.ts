/**
 * High-level game client: login -> character list -> enter world, then a
 * live view of world objects driven by server messages.
 */
import { BinReader } from "../dat/reader.ts";
import { readString16L } from "./binary.ts";
import { humanize, WeenieErrorNames, WeenieErrorWithStringNames } from "./weenieerrors.ts";
import { NetSession, RelayTransport, type GameMessage, type SessionState } from "./session.ts";
import {
  buildAutonomousPosition, buildCharacterEnterWorld, buildCharacterEnterWorldRequest, buildDDDResponse, buildLoginComplete,
  buildMoveToState, buildTalk, buildCharacterCreate, parseCharacterCreateResponse, CharacterCreateResult, Group, Opcode,
  buildUse, buildUseWithTarget, buildGive, buildDrop, buildPutInContainer, buildIdentify, buildTell, buildEmote, buildSoulEmote, parseCharacterList, parseCreateObject, parseMotionMessage, parseMovementData,
  parseObjDesc, parseServerName, parseUpdatePosition, type CharacterList, type CreateObject, type MovementData,
  type ObjectSequences, type Position, type PositionUpdate, type RawMotion, type CharacterCreateInfo,
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
  container: number | null;
  wielder: number | null;
  wieldedLocation: number;
  stackSize: number;
  value: number;
  icon: number;
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
  onCharacterCreated?(result: string, guid?: number, name?: string): void;
  onEnterWorld?(playerGuid: number): void;
  onObjectCreate?(obj: WorldObject): void;
  onObjectUpdate?(obj: WorldObject): void;
  onObjectPosition?(obj: WorldObject, update: PositionUpdate): void;
  onObjectMotion?(obj: WorldObject, movement: MovementData): void;
  onObjectDelete?(guid: number): void;
  onPlayerTeleport?(): void;
  /** the server is commanding our own character to move/turn (e.g. facing an NPC on use) */
  onPlayerMotion?(movement: MovementData): void;
  /** inventory/equipment of the player changed (item added, removed, wielded, stack changed) */
  onInventory?(): void;
  /** an item left the 3D world (picked up by someone) */
  onObjectPickedUp?(guid: number): void;
  onError?(text: string): void;
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

  private loginCompleteTimer: number | undefined;
  /**
   * Send LoginComplete after things settle. Called on first enter-world and after
   * every PlayerTeleport; debounced so a burst of create/teleport messages results
   * in a single LoginComplete once the burst stops.
   */
  private scheduleLoginComplete() {
    if (this.loginCompleteTimer !== undefined) clearTimeout(this.loginCompleteTimer);
    this.loginCompleteTimer = setTimeout(() => {
      this.loginCompleteTimer = undefined;
      this.send(buildLoginComplete(), Group.Weenie);
      this.log("sent LoginComplete");
    }, 700) as unknown as number;
  }

  enterWorld(characterId: number) {
    this.enterWorldSent = false;
    this.pendingCharacter = characterId;
    this.send(buildCharacterEnterWorldRequest(), Group.UI);
  }
  private pendingCharacter = 0;

  createCharacter(info: CharacterCreateInfo) {
    this.send(buildCharacterCreate(this.account, info), Group.UI);
  }

  say(text: string) {
    this.send(buildTalk(text), Group.Weenie);
  }
  tell(target: string, text: string) {
    this.send(buildTell(text, target), Group.Weenie);
  }
  emote(text: string) {
    this.send(buildEmote(text), Group.Weenie);
  }
  soulEmote(text: string) {
    this.send(buildSoulEmote(text), Group.Weenie);
  }
  use(guid: number) {
    this.send(buildUse(guid), Group.Weenie);
  }
  useWith(source: number, target: number) {
    this.send(buildUseWithTarget(source, target), Group.Weenie);
  }
  give(target: number, item: number, amount = 1) {
    this.send(buildGive(target, item, amount), Group.Weenie);
  }
  drop(item: number) {
    this.send(buildDrop(item), Group.Weenie);
  }
  putInContainer(item: number, container: number, placement = 0) {
    this.send(buildPutInContainer(item, container, placement), Group.Weenie);
  }
  identify(guid: number) {
    this.send(buildIdentify(guid), Group.Weenie);
  }

  /** Items in the player's packs (including sub-packs) and equipped items. */
  inventory(): WorldObject[] {
    const packs = new Set<number>([this.playerGuid]);
    for (const o of this.objects.values()) if (o.container === this.playerGuid && o.itemType & 0x200) packs.add(o.guid);
    return [...this.objects.values()].filter((o) => (o.container !== null && packs.has(o.container)) || o.wielder === this.playerGuid);
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
      case Opcode.CharacterCreateResponse: {
        const res = parseCharacterCreateResponse(r);
        const name = CharacterCreateResult[res.result] ?? `code ${res.result}`;
        this.log(`character create: ${name}${res.name ? ` (${res.name})` : ""}`);
        if (res.result === 1 && res.guid !== undefined && this.characters) {
          this.characters.characters.unshift({ id: res.guid, name: res.name ?? "", deleteTime: 0 });
          this.events.onCharacterList?.(this.characters);
        }
        this.events.onCharacterCreated?.(name, res.guid, res.name);
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
          container: co.weenie.container ?? null, wielder: co.weenie.wielder ?? null, wieldedLocation: co.weenie.wieldedLocation ?? 0,
          stackSize: co.weenie.stackSize ?? 1, value: co.weenie.value ?? 0, icon: co.weenie.icon,
          objectFlags: co.weenie.objectFlags, itemType: co.weenie.itemType, movement: co.physics.movement, raw: co,
        };
        const existed = this.objects.has(co.guid);
        this.objects.set(co.guid, obj);
        if (co.guid === this.playerGuid) {
          const s = co.physics.sequences;
          this.playerSequences = { instance: s[8], serverControl: s[5], teleport: s[4], forcePosition: s[6] };
          if (!this.loginCompleteSent) {
            this.loginCompleteSent = true;
            this.events.onEnterWorld?.(this.playerGuid);
          }
          this.scheduleLoginComplete();
        }
        if (existed) this.events.onObjectUpdate?.(obj);
        else this.events.onObjectCreate?.(obj);
        if (obj.container === this.playerGuid || obj.wielder === this.playerGuid || this.isInMyPack(obj)) this.events.onInventory?.();
        break;
      }
      case Opcode.ObjectDelete: {
        const guid = r.u32();
        const wasMine = this.isMine(this.objects.get(guid));
        this.objects.delete(guid);
        this.events.onObjectDelete?.(guid);
        if (wasMine) this.events.onInventory?.();
        break;
      }
      case Opcode.InventoryRemoveObject: {
        const guid = r.u32();
        const o = this.objects.get(guid);
        if (o) { o.container = null; o.wielder = null; }
        this.events.onInventory?.();
        break;
      }
      case Opcode.SetStackSize: {
        r.u8();
        const guid = r.u32();
        const stack = r.u32();
        const value = r.u32();
        const o = this.objects.get(guid);
        if (o) { o.stackSize = stack; o.value = value; }
        this.events.onInventory?.();
        break;
      }
      case Opcode.PickupEvent: {
        const guid = r.u32();
        this.events.onObjectPickedUp?.(guid);
        break;
      }
      case Opcode.EmoteText:
      case Opcode.SoulEmote: {
        r.u32();
        const sender = readString16L(r);
        const text = readString16L(r);
        this.events.onChat?.(m.opcode === Opcode.SoulEmote ? `${sender} ${text}` : `${sender} ${text}`, "emote", undefined);
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
          if (mm.guid === this.playerGuid) this.events.onPlayerMotion?.(mm.movement);
        }
        break;
      }
      case Opcode.PlayerTeleport: {
        this.playerSequences.teleport = r.u16();
        // A teleport puts us back in the "teleporting" state server-side; we must
        // finish loading and send LoginComplete again to clear it. Without this the
        // server rejects our movement and answers actions with "You're too busy".
        this.scheduleLoginComplete();
        this.events.onPlayerTeleport?.();
        break;
      }
      case Opcode.SetState: {
        const guid = r.u32();
        const state = r.u32();
        const obj = this.objects.get(guid);
        if (obj) obj.raw.physics.state = state;
        this.playerSequences.instance = r.u16();
        if (guid === this.playerGuid) this.events.onLog?.(`physics state 0x${state.toString(16)}`);
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

  private isMine(o: WorldObject | undefined): boolean {
    return !!o && (o.container === this.playerGuid || o.wielder === this.playerGuid || this.isInMyPack(o));
  }
  private isInMyPack(o: WorldObject): boolean {
    if (o.container === null) return false;
    const pack = this.objects.get(o.container);
    return !!pack && pack.container === this.playerGuid;
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
        r.u32(); r.u32();
        const kind = r.u32();
        this.events.onChat?.(text, `tell:${kind}`, sender);
        break;
      }
      case 0x0022: { // InventoryPutObjInContainer
        const item = r.u32();
        const container = r.u32();
        const o = this.objects.get(item);
        if (o) { o.container = container; o.wielder = null; o.position = null; }
        this.events.onObjectPickedUp?.(item);
        this.events.onInventory?.();
        break;
      }
      case 0x0023: { // WieldObject
        const item = r.u32();
        const location = r.i32();
        const o = this.objects.get(item);
        if (o) { o.wielder = this.playerGuid; o.wieldedLocation = location; o.container = null; }
        this.events.onInventory?.();
        break;
      }
      case 0x0196: { // ViewContents
        const container = r.u32();
        const n = r.u32();
        for (let i = 0; i < n; i++) {
          const guid = r.u32(); r.u32();
          const o = this.objects.get(guid);
          if (o) o.container = container;
        }
        this.events.onInventory?.();
        break;
      }
      case 0x028a: { // WeenieError
        const code = r.u32();
        this.events.onError?.(humanize(WeenieErrorNames[code] ?? `error ${code}`));
        break;
      }
      case 0x028b: { // WeenieErrorWithString
        const code = r.u32();
        const text = readString16L(r);
        const name = WeenieErrorWithStringNames[code] ?? "";
        this.events.onError?.(name && !name.endsWith("_") ? `${text} ${humanize(name)}` : text);
        break;
      }
      case 0x01c7: // UseDone
        break;
      case 0x0013: // PlayerDescription: large; we don't need it yet
        break;
      default:
        break;
    }
  }
}

export { parseMovementData };
export type { CharacterList, Position, PositionUpdate, MovementData };
