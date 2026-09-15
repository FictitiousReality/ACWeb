/** Decode captures.log (raw game messages posted by play.html?debug=1) into readable movement summaries. */
import { BinReader } from "../dat/reader.ts";
import { parseMotionMessage, parseUpdatePosition, parseCreateObject, Opcode } from "../net/messages.ts";
import { commandFromKey, MotionCommandNames } from "../dat/motionenums.ts";

const file = Deno.args[0] ?? "captures.log";
const text = await Deno.readTextFile(file);
const names = new Map<number, string>();
const cmd = (k: number) => k ? (MotionCommandNames[commandFromKey(k)] ?? k.toString(16)) : "-";
let t0 = 0;
for (const line of text.split("\n")) {
  if (!line.trim()) continue;
  const [ts, opHex, err, hex] = line.split(" ");
  const data = Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));
  const op = parseInt(opHex, 16);
  if (!t0) t0 = +ts;
  const rel = ((+ts - t0) / 1000).toFixed(2).padStart(7);
  const r = new BinReader(data); r.u32();
  try {
    if (op === Opcode.ObjectCreate || op === Opcode.UpdateObject) {
      const co = parseCreateObject(r);
      names.set(co.guid, co.weenie.name);
      const mv = co.physics.movement;
      console.log(`${rel} create ${co.weenie.name} setup=${(co.physics.setup ?? 0).toString(16)} mtable=${(co.physics.mtable ?? 0).toString(16)} state=${co.physics.state.toString(16)}${mv?.state ? ` fwd=${cmd(mv.state.forward)}x${mv.state.forwardSpeed}` : ""}`);
    } else if (op === Opcode.Motion) {
      const m = parseMotionMessage(r);
      const md = m.movement, st = md.state;
      console.log(`${rel} motion ${names.get(m.guid) ?? m.guid.toString(16)} auto=${md.autonomous} type=${md.type} flags=${md.motionFlags} stance=${md.stance.toString(16)}${st ? ` fwd=${cmd(st.forward)}x${st.forwardSpeed.toFixed(2)} side=${cmd(st.sidestep)}x${st.sidestepSpeed.toFixed(2)} turn=${cmd(st.turn)}x${st.turnSpeed.toFixed(2)} cmds=[${st.commands.map((c) => cmd(c.command)).join(",")}]` : ""}${md.moveTo ? ` moveTo run=${md.moveTo.runRate} heading=${md.moveTo.heading}` : ""} ${err !== "-" ? err : ""} used=${r.pos}/${data.length}`);
    } else if (op === Opcode.UpdatePosition) {
      const u = parseUpdatePosition(r);
      console.log(`${rel} pos ${names.get(u.guid) ?? u.guid.toString(16)} cell=${u.position.cell.toString(16)} ${u.position.x.toFixed(1)},${u.position.y.toFixed(1)},${u.position.z.toFixed(1)} flags=${u.flags.toString(16)}${u.velocity ? ` vel=${u.velocity.map((v) => v.toFixed(2))}` : ""}`);
    } else if (op === Opcode.GameEvent) {
      r.u32(); r.u32(); // recipient, sequence
      const type = r.u32();
      const first = r.pos + 4 <= data.length ? r.u32() : 0;
      console.log(`${rel} event 0x${type.toString(16).padStart(4, "0")}${type === 0x01c7 ? ` use done code=0x${first.toString(16)}` : ""} (${data.length} bytes)`);
    } else console.log(`${rel} op=${opHex} ${err} ${data.length} bytes`);
  } catch (e) {
    console.log(`${rel} op=${opHex} PARSE FAILED: ${(e as Error).message} ${err} hex=${hex.slice(0, 160)}`);
  }
}
