/**
 * An animated Setup instance: one Object3D per part, driven by an AnimSequence
 * and a MotionTable. Part transforms are object-space (AC PartArray semantics).
 */
import * as THREE from "three";
import type { Assets } from "./assets.ts";
import type { ObjectRenderer } from "./objects.ts";
import { parseAnimation, parseMotionTable, Placement, hex } from "../dat/mod.ts";
import type { Animation, MotionTable, Setup } from "../dat/mod.ts";
import { AnimSequence, defaultMotion, motionSegments } from "../world/animation.ts";
import { commandFromKey, MotionStance, stanceFromKey } from "../dat/motionenums.ts";

export class AnimatedModel {
  readonly root = new THREE.Group();
  readonly parts: THREE.Object3D[] = [];
  readonly sequence = new AnimSequence();
  motionTable: MotionTable | null = null;
  stance: number = MotionStance.NonCombat;
  currentMotion = 0;
  private animCache = new Map<number, Animation | null>();

  private constructor(private assets: Assets, readonly setup: Setup) {}

  static async create(assets: Assets, objects: ObjectRenderer, setupId: number): Promise<AnimatedModel | null> {
    const setup = await assets.setup(setupId);
    if (!setup) return null;
    const m = new AnimatedModel(assets, setup);
    m.root.name = `anim_${hex(setupId)}`;
    for (let i = 0; i < setup.parts.length; i++) {
      const tmpl = await objects.gfxObj(setup.parts[i]);
      const part = tmpl ? tmpl.clone() : new THREE.Group();
      const s = setup.defaultScale[i];
      if (s) part.scale.set(s.x, s.y, s.z);
      m.parts.push(part);
      m.root.add(part);
    }
    const placement = setup.placementFrames.get(Placement.Resting) ?? setup.placementFrames.get(Placement.Default) ??
      setup.placementFrames.values().next().value ?? null;
    m.sequence.placement = placement;
    if (setup.defaultMotionTable) {
      m.motionTable = await assets.portal.get(setup.defaultMotionTable, parseMotionTable);
      if (m.motionTable) {
        m.stance = m.motionTable.defaultStyle;
        const idle = defaultMotion(m.motionTable, m.stance);
        if (idle !== null) await m.playMotion(idle);
      }
    } else if (setup.defaultAnimation) {
      const anim = await m.animation(setup.defaultAnimation);
      if (anim) m.sequence.append(anim, { animId: anim.id, lowFrame: 0, highFrame: -1, framerate: 30 });
    }
    m.apply();
    return m;
  }

  private async animation(id: number): Promise<Animation | null> {
    if (!this.animCache.has(id)) this.animCache.set(id, await this.assets.portal.get(id, parseAnimation));
    return this.animCache.get(id)!;
  }

  /** Available (stance, command) pairs from the motion table's cycles and links. */
  motions(): { stance: number; command: number }[] {
    const out = new Map<string, { stance: number; command: number }>();
    if (!this.motionTable) return [];
    for (const key of this.motionTable.cycles.keys()) {
      const stance = stanceFromKey(key), command = commandFromKey(key);
      out.set(`${stance}:${command}`, { stance, command });
    }
    for (const [from, link] of this.motionTable.links) {
      const stance = stanceFromKey(from);
      for (const command of link.keys()) out.set(`${stance}:${command}`, { stance, command });
    }
    return [...out.values()];
  }

  /** Displacement per second produced by a motion's cycle animation (from its position frames). */
  async cycleVelocity(command: number, stance = this.stance): Promise<[number, number, number]> {
    if (!this.motionTable) return [0, 0, 0];
    const { cycle } = motionSegments(this.motionTable, stance, command, this.currentMotion);
    let x = 0, y = 0, z = 0, seconds = 0;
    for (const d of cycle) {
      const anim = await this.animation(d.animId);
      if (!anim || anim.posFrames.length === 0) continue;
      const lo = d.lowFrame, hi = d.highFrame === -1 ? anim.numFrames - 1 : d.highFrame;
      for (let i = lo; i <= hi && i < anim.posFrames.length; i++) {
        x += anim.posFrames[i].origin.x; y += anim.posFrames[i].origin.y; z += anim.posFrames[i].origin.z;
      }
      seconds += (hi - lo + 1) / Math.abs(d.framerate || 30);
    }
    if (seconds === 0) return [0, 0, 0];
    return [x / seconds, y / seconds, z / seconds];
  }

  /** Play a motion: transition animations from the current motion, then loop its cycle. */
  async playMotion(command: number, stance = this.stance): Promise<boolean> {
    if (!this.motionTable) return false;
    if (command === this.currentMotion && stance === this.stance && this.sequence.nodes.length > 0) return true;
    const { link, cycle } = motionSegments(this.motionTable, stance, command, this.currentMotion);
    if (link.length === 0 && cycle.length === 0) return false;
    this.sequence.clear();
    for (const d of link) {
      const anim = await this.animation(d.animId);
      if (anim) this.sequence.append(anim, d);
    }
    this.sequence.markCyclicStart();
    for (const d of cycle) {
      const anim = await this.animation(d.animId);
      if (anim) this.sequence.append(anim, d);
    }
    if (cycle.length === 0) this.sequence.firstCyclic = this.sequence.nodes.length - 1; // hold last transition frame
    this.stance = stance;
    this.currentMotion = command;
    return true;
  }

  update(dt: number): void {
    this.sequence.update(dt);
    this.apply();
  }

  private apply(): void {
    const frame = this.sequence.currentFrame;
    if (!frame) return;
    const n = Math.min(this.parts.length, frame.frames.length);
    for (let i = 0; i < n; i++) {
      const f = frame.frames[i];
      this.parts[i].position.set(f.origin.x, f.origin.y, f.origin.z);
      this.parts[i].quaternion.set(f.rotation.x, f.rotation.y, f.rotation.z, f.rotation.w);
    }
  }
}
