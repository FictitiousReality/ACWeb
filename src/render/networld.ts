/**
 * Renders server world objects (creatures, players, items on the ground, doors...) from
 * GameClient events. Moving creatures are dead-reckoned from their interpreted motion
 * state (the way the real client's apply_raw_movement simulates nearby players) and the
 * server's periodic UpdatePosition messages only correct the estimate.
 */
import * as THREE from "three";
import type { Assets } from "./assets.ts";
import type { ObjectRenderer } from "./objects.ts";
import { AnimatedModel } from "./animated.ts";
import type { ParticleSystem } from "./particles.ts";
import type { MovementData, Position, PositionUpdate } from "../net/messages.ts";
import type { WorldObject } from "../net/client.ts";
import { commandFromKey } from "../dat/motionenums.ts";
import { BLOCK_LENGTH } from "../world/terrain.ts";

const CMD_READY = 0x41000003, CMD_RUN = 0x44000007, CMD_WALK = 0x45000005;

export function positionToWorld(p: Position, out = new THREE.Vector3()): THREE.Vector3 {
  const lbx = p.cell >>> 24, lby = (p.cell >>> 16) & 0xff;
  return out.set(lbx * BLOCK_LENGTH + p.x, lby * BLOCK_LENGTH + p.y, p.z);
}

export interface Entity {
  obj: WorldObject;
  root: THREE.Group;
  model: AnimatedModel | null;
  /** server-authoritative estimate: last reported position advanced by the motion state */
  simPos: THREE.Vector3;
  simYaw: number;
  simQuat: THREE.Quaternion;
  /** object-space velocity (x right, y forward) and yaw rate from the motion state */
  localVel: THREE.Vector3;
  omega: number;
  /** MoveTo target (NPC walking somewhere) */
  moveTo: { target: THREE.Vector3; speed: number } | null;
  lastUpdate: number;
  yaw: number;
  motionSerial: number;
  /** rendered = estimate + offset; the offset absorbs corrections and decays to zero */
  offset: THREE.Vector3;
  yawOffset: number;
}

/** yaw about +Z from a position quaternion (AC creatures only rotate about Z) */
function yawOf(p: Position): number {
  return 2 * Math.atan2(p.qz, p.qw);
}

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

export class NetWorld {
  readonly group = new THREE.Group();
  readonly entities = new Map<number, Entity>();
  onLog: ((s: string) => void) | null = null;
  /** optional floor lookup so moving creatures follow terrain and floors between updates */
  groundAt: ((x: number, y: number, z: number) => number | null) | null = null;
  private now = 0;

  constructor(private assets: Assets, private objects: ObjectRenderer, private particles: ParticleSystem | null = null) {}

  async create(obj: WorldObject, isPlayer = false): Promise<Entity | null> {
    this.remove(obj.guid);
    if (!obj.setup || obj.parent || !obj.position) return null; // inventory / wielded / no model
    const root = new THREE.Group();
    root.name = `obj_${obj.guid.toString(16)}_${obj.name}`;
    const e: Entity = {
      obj, root, model: null, simPos: new THREE.Vector3(), simYaw: 0, simQuat: new THREE.Quaternion(),
      localVel: new THREE.Vector3(), omega: 0, moveTo: null, lastUpdate: this.now, yaw: 0, motionSerial: 0,
      offset: new THREE.Vector3(), yawOffset: 0,
    };
    this.entities.set(obj.guid, e);
    this.group.add(root);
    this.applyPosition(e, obj.position, true);
    if (obj.setup >>> 24 === 0x02) {
      const m = await AnimatedModel.create(this.assets, this.objects, obj.setup, obj.mtable, obj.raw.objDesc);
      if (m) {
        e.model = m;
        if (this.particles) {
          m.attachParticles(this.particles, obj.petable);
          if ((obj.physicsState & 0x80000) && obj.defaultScript) m.playScript(obj.defaultScript, obj.defaultScriptIntensity || 1);
        }
        root.add(m.root);
        if (obj.movement) await this.applyMotion(e, obj.movement);
      }
    } else {
      const tmpl = await this.objects.model(obj.setup);
      if (tmpl) root.add(tmpl.clone());
    }
    if (obj.scale && obj.scale !== 1) root.scale.setScalar(obj.scale);
    if (!this.entities.has(obj.guid)) { this.group.remove(root); return null; } // deleted while loading
    void isPlayer;
    return e;
  }

  /**
   * UpdateObject (0xF745) re-sends a full object description. ACE sends these often for
   * moving players; rebuilding the model each time resets the animation and snaps the
   * position, so refresh in place when the model is unchanged.
   */
  async updateObject(obj: WorldObject): Promise<Entity | null> {
    const e = this.entities.get(obj.guid);
    const sameModel = e && e.obj.setup === obj.setup && e.obj.mtable === obj.mtable && e.obj.scale === obj.scale &&
      JSON.stringify(e.obj.raw.objDesc ?? null) === JSON.stringify(obj.raw.objDesc ?? null);
    if (!e || !sameModel || obj.parent || !obj.position) return this.create(obj);
    e.obj = obj;
    this.applyPosition(e, obj.position);
    if (obj.movement) await this.applyMotion(e, obj.movement);
    return e;
  }

  remove(guid: number) {
    const e = this.entities.get(guid);
    if (!e) return;
    this.group.remove(e.root);
    e.model?.dispose();
    this.entities.delete(guid);
  }

  onPlayEffect(obj: WorldObject, script: number, mod: number) {
    this.entities.get(obj.guid)?.model?.playScript(script, mod);
  }

  onPlayScriptId(obj: WorldObject, scriptId: number) {
    this.entities.get(obj.guid)?.model?.playScriptId(scriptId);
  }

  applyPosition(e: Entity, p: Position, snap = false) {
    const prev = e.simPos.clone(), prevYaw = e.simYaw;
    positionToWorld(p, e.simPos);
    e.simYaw = yawOf(p);
    e.simQuat.set(p.qx, p.qy, p.qz, p.qw);
    e.lastUpdate = this.now;
    if (snap || prev.distanceTo(e.simPos) > 30) {
      e.offset.set(0, 0, 0); e.yawOffset = 0;
      e.root.position.copy(e.simPos);
      e.yaw = e.simYaw;
      if (e.model) e.root.rotation.set(0, 0, e.yaw); else e.root.quaternion.copy(e.simQuat);
    } else {
      // keep the rendered pose where it was and let the difference decay
      e.offset.add(prev.sub(e.simPos));
      e.yawOffset = wrapAngle(e.yawOffset + prevYaw - e.simYaw);
    }
  }

  onPosition(obj: WorldObject, u: PositionUpdate) {
    const e = this.entities.get(obj.guid);
    if (e) this.applyPosition(e, u.position);
  }

  /** Turn a server motion state into a velocity, a yaw rate, and the animation to play. */
  async applyMotion(e: Entity, md: MovementData) {
    const serial = ++e.motionSerial;
    const m = e.model;
    e.lastUpdate = this.now;
    if (md.type === 6 || md.type === 7) { // MoveToObject / MoveToPosition
      if (md.moveTo && md.moveTo.cell) {
        const target = positionToWorld({ cell: md.moveTo.cell, x: md.moveTo.x, y: md.moveTo.y, z: md.moveTo.z, qw: 1, qx: 0, qy: 0, qz: 0 });
        const runRate = md.moveTo.runRate > 0 ? md.moveTo.runRate : 1;
        const run = m ? await m.cycleVelocity(CMD_RUN, md.stance) : [0, 4, 0];
        if (serial !== e.motionSerial) return;
        const speed = (run[1] || 4) * runRate;
        e.moveTo = { target, speed };
        e.localVel.set(0, 0, 0); e.omega = 0;
        if (m) await m.playMotion(CMD_RUN, md.stance, runRate);
      }
      return;
    }
    if (md.type === 8 || md.type === 9) { // TurnToObject / TurnToHeading (degrees, clockwise from north)
      if (md.moveTo) e.simYaw = -md.moveTo.heading * Math.PI / 180;
      e.omega = 0;
      return;
    }
    if (!md.state) return;
    const st = md.state;
    const stance = st.stance || md.stance;
    e.moveTo = null;
    const forward = st.forward ? commandFromKey(st.forward) : CMD_READY;
    const sidestep = st.sidestep ? commandFromKey(st.sidestep) : 0;
    const turn = st.turn ? commandFromKey(st.turn) : 0;
    // velocity: forward and sidestep cycles scaled by the server's speeds
    // (computed into locals: another applyMotion may run while we await the animations)
    let vx = 0, vy = 0, omega = 0;
    if (m) {
      if (forward !== CMD_READY) {
        const v = await m.cycleVelocity(forward, stance);
        vx += v[0] * st.forwardSpeed; vy += v[1] * st.forwardSpeed;
      }
      if (sidestep) {
        const v = await m.cycleVelocity(sidestep, stance);
        vx += v[0] * st.sidestepSpeed; vy += v[1] * st.sidestepSpeed;
      }
      if (turn) omega = m.cycleOmega(turn, stance) * st.turnSpeed;
      if (serial !== e.motionSerial) return;
    }
    e.localVel.set(vx, vy, 0);
    e.omega = omega;
    // animation: forward motion, else sidestep, else turn-in-place, else the stance's idle
    let base = CMD_READY, speed = 1;
    if (forward !== CMD_READY) { base = forward; speed = st.forwardSpeed; }
    else if (sidestep) { base = sidestep; speed = st.sidestepSpeed; }
    else if (turn) { base = turn; speed = st.turnSpeed; }
    if (m) {
      await m.playMotion(base, stance, speed);
      if (serial !== e.motionSerial) return;
      // actions (emotes, spell power-ups, gestures) play on top and return to the base cycle
      for (const c of st.commands) {
        const cmd = commandFromKey(c.command);
        if (cmd !== base) await m.playMotion(cmd, stance, c.speed || 1);
      }
    }
  }

  onMotion(obj: WorldObject, md: MovementData) {
    const e = this.entities.get(obj.guid);
    if (e) this.applyMotion(e, md);
  }

  update(dt: number) {
    this.now += dt;
    for (const e of this.entities.values()) {
      // advance the server-side estimate
      if (e.moveTo) {
        const d = e.moveTo.target.clone().sub(e.simPos); d.z = 0;
        const dist = d.length();
        if (dist < 0.3) {
          e.moveTo = null;
          e.model?.playMotion(CMD_READY, e.model.stance);
        } else {
          e.simYaw = Math.atan2(-d.x, d.y);
          const step = Math.min(dist, e.moveTo.speed * dt);
          e.simPos.addScaledVector(d.normalize(), step);
        }
      } else if (e.localVel.x !== 0 || e.localVel.y !== 0 || e.omega !== 0) {
        if (this.now - e.lastUpdate > 4) {
          // nothing from the server for a while: assume it stopped
          e.localVel.set(0, 0, 0); e.omega = 0;
          e.model?.playMotion(CMD_READY, e.model.stance);
        } else {
          e.simYaw += e.omega * dt;
          const c = Math.cos(e.simYaw), s = Math.sin(e.simYaw);
          // object +Y forward is world (-sin, cos); object +X right is world (cos, sin)
          e.simPos.x += (e.localVel.x * c - e.localVel.y * s) * dt;
          e.simPos.y += (e.localVel.x * s + e.localVel.y * c) * dt;
        }
      }
      const moving = e.moveTo !== null || e.localVel.x !== 0 || e.localVel.y !== 0;
      if (moving && this.groundAt) {
        const g = this.groundAt(e.simPos.x, e.simPos.y, e.simPos.z);
        if (g !== null && Math.abs(g - e.simPos.z) < 2) e.simPos.z = g;
      }
      // rendered pose = estimate + decaying correction offset (no steady-state lag while moving)
      const decay = Math.exp(-dt * 4);
      e.offset.multiplyScalar(decay);
      e.yawOffset *= decay;
      if (e.offset.lengthSq() < 1e-6) e.offset.set(0, 0, 0);
      e.root.position.copy(e.simPos).add(e.offset);
      if (e.model) {
        e.yaw = e.simYaw + e.yawOffset;
        e.root.rotation.set(0, 0, e.yaw);
      } else {
        e.root.quaternion.slerp(e.simQuat, Math.min(1, dt * 8));
      }
      e.model?.update(dt);
    }
  }
}
