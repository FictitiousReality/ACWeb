/**
 * Animation sequencing ported from ACE.Server.Physics.Animation.Sequence:
 * a list of animation segments (id, low/high frame, framerate), stepped by
 * time, with the tail of the list looping as the cyclic idle.
 */
import type { Animation, AnimationFrame, MotionTable, AnimData } from "../dat/mod.ts";
import { motionKey } from "../dat/motionenums.ts";

const EPSILON = 0.0002;

export interface AnimNode {
  anim: Animation;
  framerate: number;
  lowFrame: number;
  highFrame: number;
}

export class AnimSequence {
  nodes: AnimNode[] = [];
  firstCyclic = 0;
  current = -1;
  frameNum = 0;
  placement: AnimationFrame | null = null;
  /** called with the hooks of each frame the sequence advances past (forward play) */
  onHooks: ((hooks: AnimationFrame["hooks"]) => void) | null = null;

  private static node(anim: Animation, d: AnimData): AnimNode {
    const high = d.highFrame === -1 ? anim.numFrames - 1 : d.highFrame;
    return { anim, framerate: d.framerate, lowFrame: d.lowFrame, highFrame: high };
  }

  private startFrame(n: AnimNode): number {
    return n.framerate >= 0 ? n.lowFrame : n.highFrame + 1 - EPSILON;
  }
  private endFrame(n: AnimNode): number {
    return n.framerate >= 0 ? n.highFrame + 1 - EPSILON : n.lowFrame;
  }

  clear(): void {
    this.nodes = [];
    this.firstCyclic = 0;
    this.current = -1;
    this.frameNum = 0;
  }

  /** Append a segment; the last appended segment becomes the cyclic one. */
  append(anim: Animation, d: AnimData): void {
    this.nodes.push(AnimSequence.node(anim, d));
    this.firstCyclic = this.nodes.length - 1;
    if (this.current < 0) {
      this.current = 0;
      this.frameNum = this.startFrame(this.nodes[0]);
    }
  }

  /** Mark everything appended from this point on as the looping cycle. */
  markCyclicStart(): void {
    this.firstCyclic = this.nodes.length;
  }

  get currentFrame(): AnimationFrame | null {
    if (this.current < 0) return this.placement;
    const n = this.nodes[this.current];
    const idx = Math.floor(this.frameNum);
    return n.anim.partFrames[Math.max(0, Math.min(n.anim.numFrames - 1, idx))] ?? this.placement;
  }

  update(dt: number): void {
    if (this.current < 0) return;
    let n = this.nodes[this.current];
    const frametime = n.framerate * dt;
    const before = Math.floor(this.frameNum);
    this.frameNum += frametime;
    if (this.onHooks && frametime > 0) {
      // ACE executes a frame's hooks when the sequence advances past it (Forward or Both)
      const upto = Math.min(Math.floor(this.frameNum), n.highFrame + 1);
      for (let f = before; f < upto; f++) {
        const hooks = n.anim.partFrames[f]?.hooks;
        if (hooks && hooks.length) this.onHooks(hooks.filter((h) => h.direction >= 0));
      }
    } else if (this.onHooks && frametime < 0) {
      // reversed segments (e.g. spell power-up loops) fire Backward or Both hooks
      const downto = Math.max(Math.floor(this.frameNum), n.lowFrame - 1);
      for (let f = before; f > downto; f--) {
        const hooks = n.anim.partFrames[f]?.hooks;
        if (hooks && hooks.length) this.onHooks(hooks.filter((h) => h.direction <= 0));
      }
    }
    let done = false;
    let leftover = 0;
    if (frametime > 0 && Math.floor(this.frameNum) > n.highFrame) {
      leftover = Math.max(0, this.frameNum - n.highFrame - 1) / n.framerate;
      this.frameNum = n.highFrame;
      done = true;
    } else if (frametime < 0 && Math.floor(this.frameNum) < n.lowFrame) {
      leftover = Math.min(0, this.frameNum - n.lowFrame) / n.framerate;
      this.frameNum = n.lowFrame;
      done = true;
    }
    if (done) {
      if (frametime >= 0) {
        this.current = this.current + 1 < this.nodes.length ? this.current + 1 : Math.min(this.firstCyclic, this.nodes.length - 1);
      } else {
        this.current = this.current > 0 ? this.current - 1 : this.nodes.length - 1;
      }
      n = this.nodes[this.current];
      this.frameNum = this.startFrame(n);
      if (Math.abs(leftover) > 1e-6 && Math.abs(leftover) < 1) this.update(leftover);
    }
  }
}

export type AnimLookup = (id: number) => Animation | null;

/** Resolve the transition (link) + cycle segments for playing `motion` from `current`. */
export function motionSegments(mt: MotionTable, stance: number, motion: number, current: number): { link: AnimData[]; cycle: AnimData[] } {
  let link: AnimData[] = [];
  const md = mt.links.get(motionKey(stance, current))?.get(motion);
  if (md) link = md.anims;
  else {
    // no direct transition: go through the stance's default motion (ACE MotionTable.do_link)
    const def = mt.styleDefaults.get(stance);
    if (def !== undefined && def !== current) {
      const toDef = mt.links.get(motionKey(stance, current))?.get(def);
      const fromDef = mt.links.get(motionKey(stance, def))?.get(motion);
      link = [...(toDef?.anims ?? []), ...(fromDef?.anims ?? [])];
    } else if (def !== undefined) {
      link = mt.links.get(motionKey(stance, def))?.get(motion)?.anims ?? [];
    }
  }
  const cycle = mt.cycles.get(motionKey(stance, motion))?.anims ?? [];
  return { link, cycle };
}

/** Default motion for a stance (the idle cycle), or null. */
export function defaultMotion(mt: MotionTable, stance: number): number | null {
  return mt.styleDefaults.get(stance) ?? null;
}
