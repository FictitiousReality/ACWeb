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
  /** jump state: in the air with this world velocity until we meet a floor */
  airborne = false;
  private airVel = new THREE.Vector3();
  /** Jump skill used for the jump height (pinned; the client doesn't read skills yet) */
  jumpSkill = 750;
  private wantJump = false;
  private jumpPower = 1;
  /** seconds of holding Space for a full-power jump */
  static readonly JUMP_CHARGE_SECONDS = 1.0;
  /** charge fraction while Space is held (null when not charging), for the jump bar */
  jumpCharge: number | null = null;

  /** Space pressed: start charging (ignored while airborne or flying). */
  startJumpCharge() {
    if (this.airborne || this.fly || this.jumpCharge !== null) return;
    this.jumpCharge = 0;
  }

  /** Space released: jump with the charged power. */
  releaseJump() {
    if (this.jumpCharge === null) return;
    this.jumpPower = Math.max(0.05, Math.min(1, this.jumpCharge));
    this.jumpCharge = null;
    if (!this.airborne && !this.fly) this.wantJump = true;
  }

  /** Jump at full charge right away (used by scripts/tests). */
  jump() {
    if (this.airborne || this.fly) return;
    this.jumpPower = 1;
    this.wantJump = true;
  }

  private beginJump(vx: number, vy: number, dt: number) {
    // ACE MovementSystem.GetJumpHeight: vertical velocity from the Jump skill and the charged power, unburdened
    const skill = this.jumpSkill, power = this.jumpPower;
    const vz = Math.max(0.35, (skill / (skill + 1300) * 22.2 + 0.05) * power);
    this.airborne = true;
    this.airVel.set(vx, vy, vz);
    // the packet carries the velocity in our own frame: x right, y forward, z up
    const fx = -Math.sin(this.yaw), fy = Math.cos(this.yaw);
    const forward = vx * fx + vy * fy, right = vx * fy - vy * fx;
    this.client.jump(power, [right, forward, vz]);
    this.pos.z += vz * dt; // leave the floor this frame so the floor snap doesn't cancel the jump
    // the client animates a jump as the Falling motion: its transitions from Ready / Walk / Run are
    // the takeoff, the cycle is the airborne pose, and the transition back on landing is the landing
    if (this.model) this.model.playMotion(0x40000015, this.model.stance).catch(() => {});
  }
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

  /** current combat stance (non-combat, magic...), as the server last told us */
  stance: number = MotionStance.NonCombat;

  /** Switch stance (the server entered us into magic mode, say): idle in it, move in it, report it. */
  setStance(stance: number) {
    if (stance === this.stance) return;
    this.stance = stance;
    this.model?.playMotion(0x41000003, stance).catch(() => {});
    this.currentCommand = -1;
  }

  /** movement commands we animate ourselves; anything else from the server is a one-off overlay */
  private static readonly MOVEMENT_COMMANDS = new Set([0x03, 0x05, 0x06, 0x07, 0x0d, 0x0e, 0x0f, 0x10]);
  /** seconds left of a one-off animation the server asked for */
  private overlayLeft = 0;

  /** True for a command the player controller drives from the keyboard. */
  static isMovement(command: number): boolean {
    return PlayerController.MOVEMENT_COMMANDS.has(command & 0xffff);
  }

  /**
   * Play a motion the server sent us (picking something up, dropping it, an emote) on top of
   * whatever we are doing, then let our own movement animation take over again.
   */
  async playServerMotion(command: number, stance?: number) {
    if (!this.model || PlayerController.isMovement(command)) return;
    // our own cast animation is already showing these gestures; the server's echo would restart them
    if (this.localCastLeft > 0) return;
    await this.startOverlay(command, stance);
  }

  /** gestures still to play for a cast we started */
  private gestureQueue: number[] = [];
  private gesturePending = false;
  /** while our own cast animation runs, the server's copies of the same gestures are ignored */
  private localCastLeft = 0;

  /**
   * Animate a cast the way the retail client does, right away: each windup gesture, then the
   * cast gesture, in the current (magic) stance. Moving cancels it.
   */
  playCastGestures(gestures: number[]) {
    if (!this.model || !gestures.length) return;
    this.gestureQueue = gestures.slice(1);
    this.localCastLeft = 8;
    this.startOverlay(gestures[0]);
  }

  private async startOverlay(command: number, stance?: number) {
    if (!this.model) return;
    this.gesturePending = true;
    try {
      const st = stance || this.model.stance;
      const seconds = await this.model.motionDuration(command, st);
      if (!await this.model.playMotion(command, st)) return;
      this.overlayLeft = Math.max(0.3, seconds);
      this.currentCommand = -1; // our own motion is re-applied once the overlay ends
    } finally {
      this.gesturePending = false;
    }
  }

  /** Face a world position (server TurnToObject), plus an optional heading offset in degrees. */
  faceTowards(x: number, y: number, offsetDeg = 0) {
    this.yaw = Math.atan2(-(x - this.pos.x), y - this.pos.y) - offsetDeg * Math.PI / 180;
    this.root.rotation.set(0, 0, this.yaw);
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

    const moving = vx !== 0 || vy !== 0 || cmd !== Cmd.Ready;
    if ((vx !== 0 || vy !== 0) && !this.noclip) [vx, vy] = this.slideAlongWalls(vx, vy, dt);
    if (this.jumpCharge !== null) this.jumpCharge = Math.min(1, this.jumpCharge + dt / PlayerController.JUMP_CHARGE_SECONDS);
    if (this.wantJump) { this.wantJump = false; this.beginJump(vx, vy, dt); }
    if (this.fly) {
      // free flight: no floor snapping, vertical keys, position reported as airborne
      const vz = (k.has("KeyR") ? 1 : 0) - (k.has("KeyF") ? 1 : 0);
      this.pos.x += vx * dt; this.pos.y += vy * dt; this.pos.z += vz * this.flySpeed * rate * dt;
    } else if (this.airborne) {
      // ballistic arc: takeoff velocity, gravity 9.8; no air control (as in the game)
      this.airVel.z -= 9.8 * dt;
      let [ax, ay] = [this.airVel.x, this.airVel.y];
      if ((ax !== 0 || ay !== 0) && !this.noclip) [ax, ay] = this.slideAlongWalls(ax, ay, dt);
      const nx = this.pos.x + ax * dt, ny = this.pos.y + ay * dt, nz = this.pos.z + this.airVel.z * dt;
      const floor = this.streamer.floorAt(nx, ny, Math.max(nz, this.pos.z), 0.2, 8) ?? this.streamer.heightAt(nx, ny);
      if (this.airVel.z <= 0 && floor !== null && nz <= floor) {
        this.pos.set(nx, ny, floor);
        this.airborne = false;
        this.airVel.set(0, 0, 0);
        this.currentCommand = -1; // re-evaluate the motion so Falling links back into Ready / Walk / Run
        this.client.sendAutonomousPosition(this.position(), true); // landed: contact again
        this.lastReport = performance.now();
      } else {
        this.pos.set(nx, ny, nz);
      }
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
      // moving cancels a one-off animation, and so does its own length running out; a cast's
      // gestures follow one another
      if (this.overlayLeft > 0) {
        this.overlayLeft = moving ? 0 : this.overlayLeft - dt;
        if (this.overlayLeft <= 0 && this.gestureQueue.length && !moving) this.startOverlay(this.gestureQueue.shift()!);
      }
      if (moving) { this.gestureQueue.length = 0; this.localCastLeft = 0; }
      if (this.localCastLeft > 0) {
        this.localCastLeft -= dt;
        // once the last gesture is done, keep ignoring echoes only briefly
        if (!this.gestureQueue.length && this.overlayLeft <= 0 && !this.gesturePending) this.localCastLeft = Math.min(this.localCastLeft, 0.6);
      }
      if (!this.airborne && this.overlayLeft <= 0 && !this.gesturePending && !this.gestureQueue.length && animKey !== this.currentCommand) {
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
      const m: RawMotion = { holdKey: this.run ? 2 : 1, stance: this.stance };
      if (fwd && !back) m.forward = Cmd.WalkForward;
      else if (back && !fwd) m.forward = Cmd.WalkBackwards;
      if (sr && !sl) m.sidestep = Cmd.SideStepRight;
      else if (sl && !sr) m.sidestep = Cmd.SideStepLeft;
      if (left !== right) { m.turn = left ? Cmd.TurnLeft : Cmd.TurnRight; m.turnSpeed = 1; }
      this.client.sendMoveToState(m, this.position(), this.contact && !this.fly && !this.airborne);
      this.lastReport = now;
    } else if ((cmd !== Cmd.Ready || this.fly || this.airborne) && now - this.lastReport > 1000) {
      this.client.sendAutonomousPosition(this.position(), this.contact && !this.fly && !this.airborne);
      this.lastReport = now;
    }
  }
}
