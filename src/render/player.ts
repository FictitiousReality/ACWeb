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
  /** cycle speeds at rate 1 (metres or radians per second), from the motion table */
  private speeds = { run: 4, walk: 2.6, side: 1.2, turn: 1.5 };
  /** the server's run rate for this character (from the echo of our own motion); walking is always 1 */
  runRate = 1;
  private currentCommand = -1;
  contact = true;
  /** walk through walls (/noclip) */
  noclip = false;
  /** ignore floors; R rises, F descends; reports go out airborne (/fly) */
  fly = false;
  private flySpeed = 4;

  /** Leave fly mode and drop onto the nearest floor below (or the terrain). */
  land() {
    this.fly = false;
    const floor = this.streamer.floorAt(this.pos.x, this.pos.y, this.pos.z, 1.2, 600) ?? this.streamer.heightAt(this.pos.x, this.pos.y);
    if (floor !== null) this.pos.z = floor;
  }
  /** collision radius against walls */
  radius = 0.35;

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
    const omega = m.cycleOmega(Cmd.TurnRight);
    if (omega) this.speeds.turn = Math.abs(omega);
  }

  setFromPosition(p: Position) {
    this.streamer.setPlayerCell(p.cell);
    this.lastCell = p.cell;
    const lbx = p.cell >>> 24, lby = (p.cell >>> 16) & 0xff;
    this.pos.set(lbx * BLOCK_LENGTH + p.x, lby * BLOCK_LENGTH + p.y, p.z);
    this.yaw = 2 * Math.atan2(p.qz, p.qw);
    this.root.position.copy(this.pos);
    this.root.rotation.set(0, 0, this.yaw);
  }

  private lastCell = 0;

  /**
   * Current position in AC terms: cell id + coordinates local to that cell's
   * landblock + heading quaternion. Indoors the cell comes from the cell BSP;
   * dungeon geometry can extend outside its landblock's 192x192 box, so local
   * coordinates are always taken relative to the cell's landblock, and while in
   * a dungeon we never report a cell from another landblock (the server rejects it).
   */
  position(): Position {
    let cell: number;
    const inCell = this.streamer.envcells.findCell(this.pos, this.streamer.playerBlock);
    if (inCell) cell = inCell.id;
    else if (this.streamer.inDungeon && this.lastCell) cell = this.lastCell;
    else {
      const lbx = Math.floor(this.pos.x / BLOCK_LENGTH), lby = Math.floor(this.pos.y / BLOCK_LENGTH);
      const lx = this.pos.x - lbx * BLOCK_LENGTH, ly = this.pos.y - lby * BLOCK_LENGTH;
      cell = ((((lbx << 8) | lby) << 16) | (Math.floor(lx / CELL_LENGTH) * 8 + Math.floor(ly / CELL_LENGTH) + 1)) >>> 0;
    }
    this.lastCell = cell;
    const lbx = cell >>> 24, lby = (cell >>> 16) & 0xff;
    const half = this.yaw / 2;
    return {
      cell: cell >>> 0, x: this.pos.x - lbx * BLOCK_LENGTH, y: this.pos.y - lby * BLOCK_LENGTH, z: this.pos.z,
      qw: Math.cos(half), qx: 0, qy: 0, qz: Math.sin(half),
    };
  }

  /**
   * Debug aid: jump one landblock (192 units) in the facing direction onto the terrain there
   * and report it. ACE accepts any position in the current or an adjacent block (its speed
   * check only rejects jumps farther than 50 units into a block more than one away), so
   * blocks must be taken one at a time. Returns false if that terrain isn't loaded yet.
   */
  blink(): boolean {
    const fx = -Math.sin(this.yaw), fy = Math.cos(this.yaw);
    const nx = this.pos.x + fx * BLOCK_LENGTH, ny = this.pos.y + fy * BLOCK_LENGTH;
    const h = this.streamer.heightAt(nx, ny);
    if (h === null) return false;
    this.pos.set(nx, ny, h);
    this.root.position.copy(this.pos);
    this.lastCell = 0;
    const p = this.position();
    this.streamer.setPlayerCell(p.cell);
    this.client.sendAutonomousPosition(p, true);
    this.lastMotion = ""; // re-send the movement state from the new spot
    return true;
  }

  /** Face an AC heading (degrees, 0 = north, clockwise) — used when the server turns us to an NPC. */
  faceHeading(headingDeg: number) {
    this.yaw = -headingDeg * Math.PI / 180;
    this.root.rotation.set(0, 0, this.yaw);
  }

  /**
   * Clip a velocity against walls: stop at the first wall in the way, then slide the
   * remaining motion along it (velocity projected onto the wall plane).
   */
  private slideAlongWalls(vx: number, vy: number, dt: number): [number, number] {
    const tryDir = (ax: number, ay: number): [number, number] => {
      const speed = Math.hypot(ax, ay);
      if (speed < 1e-6) return [0, 0];
      const step = speed * dt;
      const hit = this.streamer.wallAt(this.pos.x, this.pos.y, this.pos.z, ax, ay, step + this.radius);
      if (!hit) return [ax, ay];
      const allowed = Math.max(0, hit.distance - this.radius);
      const k = Math.min(1, allowed / step);
      // remaining motion slides along the wall
      const rem = 1 - k;
      const dot = ax * hit.nx + ay * hit.ny;
      let sx = (ax - dot * hit.nx) * rem, sy = (ay - dot * hit.ny) * rem;
      if (Math.hypot(sx, sy) > 1e-4) {
        const h2 = this.streamer.wallAt(this.pos.x, this.pos.y, this.pos.z, sx, sy, Math.hypot(sx, sy) * dt + this.radius);
        if (h2) {
          const a2 = Math.max(0, h2.distance - this.radius), s2 = Math.hypot(sx, sy) * dt;
          const k2 = Math.min(1, a2 / s2);
          sx *= k2; sy *= k2;
        }
      } else { sx = 0; sy = 0; }
      return [ax * k + sx, ay * k + sy];
    };
    return tryDir(vx, vy);
  }

  update(dt: number) {
    const k = this.keys;
    const fwd = k.has("KeyW") || k.has("ArrowUp");
    const back = k.has("KeyS") || k.has("ArrowDown");
    const left = k.has("KeyA") || k.has("ArrowLeft");
    const right = k.has("KeyD") || k.has("ArrowRight");
    const sl = k.has("KeyQ"), sr = k.has("KeyE");

    // the same interpretation the server applies to our raw keys (ACE MovementData):
    // run = RunForward at the run rate, backwards = WalkForward at -0.65 x rate,
    // sidestep = SideStepRight at rate * 3.12 / 1.25 * 0.5 (max 3), turn = 1.5x faster while running
    const rate = this.run ? this.runRate : 1;
    const turnSpeed = this.run ? 1.5 : 1;
    if (left && !right) this.yaw += this.speeds.turn * turnSpeed * dt;
    if (right && !left) this.yaw -= this.speeds.turn * turnSpeed * dt;
    const fx = -Math.sin(this.yaw), fy = Math.cos(this.yaw);
    let vx = 0, vy = 0;
    let cmd: number = Cmd.Ready, animCmd: number = Cmd.Ready, animSpeed = 1;
    if (fwd && !back) {
      const s = this.run ? this.speeds.run * this.runRate : this.speeds.walk;
      vx += fx * s; vy += fy * s;
      cmd = this.run ? Cmd.RunForward : Cmd.WalkForward;
      animCmd = cmd; animSpeed = this.run ? this.runRate : 1;
    } else if (back && !fwd) {
      const s = this.speeds.walk * 0.65 * rate;
      vx -= fx * s; vy -= fy * s;
      cmd = Cmd.WalkBackwards;
      animCmd = Cmd.WalkForward; animSpeed = -0.65 * rate;
    }
    const sideRate = Math.min(3, rate * 3.12 / 1.25 * 0.5);
    if (sr && !sl) { vx += fy * this.speeds.side * sideRate; vy -= fx * this.speeds.side * sideRate; if (cmd === Cmd.Ready) { cmd = Cmd.SideStepRight; animCmd = Cmd.SideStepRight; animSpeed = sideRate; } }
    if (sl && !sr) { vx -= fy * this.speeds.side * sideRate; vy += fx * this.speeds.side * sideRate; if (cmd === Cmd.Ready) { cmd = Cmd.SideStepLeft; animCmd = Cmd.SideStepRight; animSpeed = -sideRate; } }
    if (cmd === Cmd.Ready && left !== right) { cmd = left ? Cmd.TurnLeft : Cmd.TurnRight; animCmd = Cmd.TurnRight; animSpeed = left ? -turnSpeed : turnSpeed; }

    if ((vx !== 0 || vy !== 0) && !this.noclip) [vx, vy] = this.slideAlongWalls(vx, vy, dt);
    if (this.fly) {
      // free flight: no floor snapping, vertical keys, position reported as airborne
      const vz = (k.has("KeyR") ? 1 : 0) - (k.has("KeyF") ? 1 : 0);
      this.pos.x += vx * dt; this.pos.y += vy * dt; this.pos.z += vz * this.flySpeed * rate * dt;
    } else if (vx !== 0 || vy !== 0) {
      const nx = this.pos.x + vx * dt, ny = this.pos.y + vy * dt;
      const floor = this.streamer.floorAt(nx, ny, this.pos.z);
      // move if we found a floor within step range (or nothing is loaded yet and we're outdoors on terrain)
      if (floor !== null && floor - this.pos.z < 1.5) {
        this.pos.x = nx; this.pos.y = ny; this.pos.z = floor;
      } else if (floor === null && this.streamer.envcells.findCell(this.pos, this.streamer.playerBlock) === null) {
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
      const animKey = animCmd * 8 + animSpeed;
      if (animKey !== this.currentCommand) {
        this.currentCommand = animKey;
        this.model.playMotion(animCmd, this.model.stance, animSpeed);
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
      this.client.sendMoveToState(m, this.position(), this.contact && !this.fly);
      this.lastReport = now;
    } else if ((cmd !== Cmd.Ready || this.fly) && now - this.lastReport > 1000) {
      this.client.sendAutonomousPosition(this.position(), this.contact && !this.fly);
      this.lastReport = now;
    }
  }
}
