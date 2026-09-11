// Replay captures.log through NetWorld with real models and report what each entity plays.
import { BinReader } from "../dat/reader.ts";
import { DatDatabase, DenoFileSource } from "../dat/mod.ts";
import { parseMotionMessage, parseUpdatePosition, parseCreateObject, Opcode } from "../net/messages.ts";
import { Assets } from "../render/assets.ts";
import { ObjectRenderer } from "../render/objects.ts";
import { NetWorld } from "../render/networld.ts";
import type { WorldObject } from "../net/client.ts";
import { MotionCommandNames } from "../dat/motionenums.ts";

const portal = await DatDatabase.open(await DenoFileSource.open("/Users/r/Downloads/ac-updates/client_portal.dat"));
const cell = await DatDatabase.open(await DenoFileSource.open("/Users/r/Downloads/ac-updates/client_cell_1.dat"));
const assets = new Assets(portal, cell);
const nw = new NetWorld(assets, new ObjectRenderer(assets), null);
const objs = new Map<number, WorldObject>();
const only = Deno.args[0] ?? "rudytesttesta";
let last = 0;
for (const line of (await Deno.readTextFile("captures.log")).split("\n")) {
  if (!line.trim()) continue;
  const [ts, opHex, , hex] = line.split(" ");
  const data = Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));
  const op = parseInt(opHex, 16);
  const t = +ts;
  if (last) { let dt = (t - last) / 1000; while (dt > 0) { nw.update(Math.min(dt, 1 / 60)); dt -= 1 / 60; } }
  last = t;
  const r = new BinReader(data); r.u32();
  if (op === Opcode.ObjectCreate || op === Opcode.UpdateObject) {
    const co = parseCreateObject(r);
    if (co.weenie.name !== only) continue;
    const obj = {
      guid: co.guid, name: co.weenie.name, wcid: co.weenie.wcid, setup: co.physics.setup ?? 0, mtable: co.physics.mtable ?? 0, petable: co.physics.petable ?? 0,
      physicsState: co.physics.state, defaultScript: 0, defaultScriptIntensity: 1, scale: co.physics.scale ?? 1, position: co.physics.position ?? null,
      parent: co.physics.parent?.id ?? co.weenie.wielder ?? co.weenie.container ?? null, container: null, wielder: null, wieldedLocation: 0, stackSize: 1, value: 0, icon: 0,
      objectFlags: 0, itemType: 0, movement: co.physics.movement, raw: co,
    } as unknown as WorldObject;
    objs.set(co.guid, obj);
    const e = await nw.create(obj);
    console.log(`create ${obj.name} setup=${obj.setup.toString(16)} mtable=${obj.mtable.toString(16)} entity=${!!e} model=${!!e?.model} motion=${e?.model?.currentMotion.toString(16)} stance=${e?.model?.stance.toString(16)}`);
  } else if (op === Opcode.Motion) {
    const m = parseMotionMessage(r);
    const obj = objs.get(m.guid); if (!obj) continue;
    await nw.applyMotion(nw.entities.get(m.guid)!, m.movement);
    const e = nw.entities.get(m.guid)!;
    const st = m.movement.state;
    console.log(`motion fwd=${st ? MotionCommandNames[(0x44000000 | st.forward) >>> 0] ?? st.forward : "?"} -> model motion=${e.model?.currentMotion.toString(16)} ${MotionCommandNames[e.model?.currentMotion ?? 0] ?? ""} speed=${e.model?.motionSpeed} nodes=${e.model?.sequence.nodes.map((n) => n.framerate.toFixed(0)).join(",")} localVel=${e.localVel.toArray().map((v) => v.toFixed(2))} omega=${e.omega.toFixed(2)}`);
  } else if (op === Opcode.UpdatePosition) {
    const u = parseUpdatePosition(r);
    const obj = objs.get(u.guid); if (!obj) continue;
    nw.onPosition(obj, u);
  }
}
