/** Local player: keyboard movement on the terrain, animation, and movement reporting to the server. */
import * as THREE from "three";
import type { AnimatedModel } from "./animated.ts";
import type { GameClient } from "../net/client.ts";
import type { Position, RawMotion } from "../net/messages.ts";
import type { WorldStreamer } from "./streamer.ts";
import { BLOCK_LENGTH, CELL_LENGTH } from "../world/terrain.ts";
import { MotionStance } from "../dat/motionenums.ts";

export const Cmd = {
  Ready: 0x41000003, WalkForward: 0x45000005, WalkBackwards: 0x45000006, RunForward: 0x44000007,
  TurnRight: 0x6500000d, TurnLeft: 0x6500000e, SideStepRight: 0x6500000f, SideStepLeft: 0x65000010,
} as const;

export class PlayerController {
  readonly root = new THREE.Group();
  model: AnimatedModel | null = null;
  /** world-space position (Z-up) */
  readonly pos = new THREE.Vector3();
  /** rotation about +Z; facing = (-sin, cos) */
  yaw = 0;
  run = true;
  private keys = new Set<string>();
  private lastMotion = "";
  private lastReport = 0;
  private speeds = { run: 4, walk: 1.5, back: 1, side: 1.5, turn: 1.5 };
  private currentCommand = Cmd.Ready as number;
  contact = true;

  constructor(private client: GameClient, private streamer: WorldStreamer) {
    addEventListener("keydown", (e) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      this.keys.add(e.code);
      if (e.code === "ShiftLeft" || e.code === "ShiftRight") this.run = false;
    });
    addEventListener("keyup", (e) => {
      this.keys.delete(e.code);
      if (e.code === "ShiftLeft" || e.code === "ShiftRight") this.run = true;
    });
    addEventListener("blur", () => this.keys.clear());
  }

  async setModel(m: AnimatedModel) {
    this.model = m;
    this.root.add(m.root);
    const run = await m.cycleVelocity(Cmd.RunForward);
    const walk = await m.cycleVelocity(Cmd.WalkForward);
    const side = await m.cycleVelocity(Cmd.SideStepRight);
    if (run[1] > 0) this.speeds.run = run[1];
    if (walk[1] > 0) this.speeds.walk = walk[1];
    if (Math.abs(side[0]) > 0) this.speeds.side = Math.abs(side[0]);
  }

  setFromPosition(p: Position) {
    const lbx = p.cell >>> 24, lby = (p.cell >>> 16) & 0xff;
    this.pos.set(lbx * BLOCK_LENGTH + p.x, lby * BLOCK_LENGTH + p.y, p.z);
    this.yaw = 2 * Math.atan2(p.qz, p.qw);
    this.root.position.copy(this.pos);
    this.root.rotation.set(0, 0, this.yaw);
  }

  /** Current position in AC terms: landblock cell + local coords + heading quaternion. */
  position(): Position {
    const lbx = Math.floor(this.pos.x / BLOCK_LENGTH), lby = Math.floor(this.pos.y / BLOCK_LENGTH);
    const lx = this.pos.x - lbx * BLOCK_LENGTH, ly = this.pos.y - lby * BLOCK_LENGTH;
    let cell = ((lbx << 8) | lby) << 16;
    const inCell = this.streamer.envcells.findCell(this.pos);
    if (inCell) cell = inCell.id;
    else cell |= (Math.floor(lx / CELL_LENGTH) * 8 + Math.floor(ly / CELL_LENGTH) + 1);
    const half = this.yaw / 2;
    return { cell: cell >>> 0, x: lx, y: ly, z: this.pos.z, qw: Math.cos(half), qx: 0, qy: 0, qz: Math.sin(half) };
  }

  update(dt: number) {
    const k = this.keys;
    const fwd = k.has("KeyW") || k.has("ArrowUp");
    const back = k.has("KeyS") || k.has("ArrowDown");
    const left = k.has("KeyA") || k.has("ArrowLeft");
    const right = k.has("KeyD") || k.has("ArrowRight");
    const sl = k.has("KeyQ"), sr = k.has("KeyE");

    if (left && !right) this.yaw += this.speeds.turn * dt;
    if (right && !left) this.yaw -= this.speeds.turn * dt;
    const fx = -Math.sin(this.yaw), fy = Math.cos(this.yaw);
    let vx = 0, vy = 0;
    let cmd: number = Cmd.Ready;
    if (fwd && !back) {
      const s = this.run ? this.speeds.run : this.speeds.walk;
      vx += fx * s; vy += fy * s;
      cmd = this.run ? Cmd.RunForward : Cmd.WalkForward;
    } else if (back && !fwd) {
      vx -= fx * this.speeds.back; vy -= fy * this.speeds.back;
      cmd = Cmd.WalkBackwards;
    }
    if (sr && !sl) { vx += fy * this.speeds.side; vy -= fx * this.speeds.side; if (cmd === Cmd.Ready) cmd = Cmd.SideStepRight; }
    if (sl && !sr) { vx -= fy * this.speeds.side; vy += fx * this.speeds.side; if (cmd === Cmd.Ready) cmd = Cmd.SideStepLeft; }
    if (cmd === Cmd.Ready && left !== right) cmd = left ? Cmd.TurnLeft : Cmd.TurnRight;

    if (vx !== 0 || vy !== 0) {
      const nx = this.pos.x + vx * dt, ny = this.pos.y + vy * dt;
      const floor = this.streamer.floorAt(nx, ny, this.pos.z);
      // move if we found a floor within step range (or nothing is loaded yet and we're outdoors on terrain)
      if (floor !== null && floor - this.pos.z < 1.5) {
        this.pos.x = nx; this.pos.y = ny; this.pos.z = floor;
      } else if (floor === null && this.streamer.envcells.findCell(this.pos) === null) {
        const h = this.streamer.heightAt(nx, ny);
        if (h !== null) { this.pos.x = nx; this.pos.y = ny; this.pos.z = h; }
      }
    } else {
      const floor = this.streamer.floorAt(this.pos.x, this.pos.y, this.pos.z);
      if (floor !== null && Math.abs(floor - this.pos.z) < 3) this.pos.z = floor;
    }
    this.root.position.copy(this.pos);
    this.root.rotation.set(0, 0, this.yaw);

    if (this.model) {
      if (cmd !== this.currentCommand) {
        this.currentCommand = cmd;
        this.model.playMotion(cmd);
      }
      this.model.update(dt);
    }

    // network: MoveToState on state change, AutonomousPosition once a second while moving
    const motionKey = `${cmd}:${this.run}:${fwd}:${back}:${left}:${right}:${sl}:${sr}`;
    const now = performance.now();
    if (motionKey !== this.lastMotion) {
      this.lastMotion = motionKey;
      const m: RawMotion = { holdKey: this.run ? 2 : 1, stance: MotionStance.NonCombat };
      if (fwd && !back) m.forward = Cmd.WalkForward;
      else if (back && !fwd) m.forward = Cmd.WalkBackwards;
      if (sr && !sl) m.sidestep = Cmd.SideStepRight;
      else if (sl && !sr) m.sidestep = Cmd.SideStepLeft;
      if (left !== right) { m.turn = left ? Cmd.TurnLeft : Cmd.TurnRight; m.turnSpeed = 1; }
      this.client.sendMoveToState(m, this.position(), this.contact);
      this.lastReport = now;
    } else if (cmd !== Cmd.Ready && now - this.lastReport > 1000) {
      this.client.sendAutonomousPosition(this.position(), this.contact);
      this.lastReport = now;
    }
  }
}
