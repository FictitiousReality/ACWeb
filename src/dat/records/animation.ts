import type { BinReader, Frame, Vec3 } from "../reader.ts";

export enum HookType {
  NoOp = 0,
  Sound = 1,
  SoundTable = 2,
  Attack = 3,
  AnimationDone = 4,
  ReplaceObject = 5,
  Ethereal = 6,
  TransparentPart = 7,
  Luminous = 8,
  LuminousPart = 9,
  Diffuse = 10,
  DiffusePart = 11,
  Scale = 12,
  CreateParticle = 13,
  DestroyParticle = 14,
  StopParticle = 15,
  NoDraw = 16,
  DefaultScript = 17,
  DefaultScriptPart = 18,
  CallPES = 19,
  Transparent = 20,
  SoundTweaked = 21,
  SetOmega = 22,
  TextureVelocity = 23,
  TextureVelocityPart = 24,
  SetLight = 25,
  CreateBlockingParticle = 26,
}

export interface AnimationHook {
  type: HookType;
  direction: number;
  // deno-lint-ignore no-explicit-any
  data: Record<string, any>;
}

export function parseHook(r: BinReader): AnimationHook {
  const type = r.u32() as HookType;
  const direction = r.i32();
  const d: Record<string, unknown> = {};
  switch (type) {
    case HookType.Sound:
      d.id = r.u32();
      break;
    case HookType.SoundTable:
      d.soundType = r.u32();
      break;
    case HookType.Attack:
      d.partIndex = r.u32();
      d.leftX = r.f32();
      d.leftY = r.f32();
      d.rightX = r.f32();
      d.rightY = r.f32();
      d.radius = r.f32();
      d.height = r.f32();
      break;
    case HookType.ReplaceObject: {
      const partIndex = r.u16();
      d.partIndex = partIndex & 0xff;
      d.partId = r.dataIdOfKnownType(0x01000000);
      break;
    }
    case HookType.Ethereal:
      d.ethereal = r.i32();
      break;
    case HookType.TransparentPart:
    case HookType.LuminousPart:
    case HookType.DiffusePart:
      d.part = r.u32();
      d.start = r.f32();
      d.end = r.f32();
      d.time = r.f32();
      break;
    case HookType.Luminous:
    case HookType.Diffuse:
    case HookType.Transparent:
      d.start = r.f32();
      d.end = r.f32();
      d.time = r.f32();
      break;
    case HookType.Scale:
      d.end = r.f32();
      d.time = r.f32();
      break;
    case HookType.CreateParticle:
    case HookType.CreateBlockingParticle:
      d.emitterInfoId = r.u32();
      d.partIndex = r.u32();
      d.offset = r.frame();
      d.emitterId = r.u32();
      break;
    case HookType.DestroyParticle:
    case HookType.StopParticle:
      d.emitterId = r.u32();
      break;
    case HookType.NoDraw:
      d.noDraw = r.u32();
      break;
    case HookType.DefaultScriptPart:
      d.partIndex = r.u32();
      break;
    case HookType.CallPES:
      d.pes = r.u32();
      d.pause = r.f32();
      break;
    case HookType.SoundTweaked:
      d.soundId = r.u32();
      d.priority = r.f32();
      d.probability = r.f32();
      d.volume = r.f32();
      break;
    case HookType.SetOmega:
      d.axis = r.vec3();
      break;
    case HookType.TextureVelocity:
      d.uSpeed = r.f32();
      d.vSpeed = r.f32();
      break;
    case HookType.TextureVelocityPart:
      d.partIndex = r.u32();
      d.uSpeed = r.f32();
      d.vSpeed = r.f32();
      break;
    case HookType.SetLight:
      d.lightsOn = r.i32();
      break;
    case HookType.AnimationDone:
    case HookType.DefaultScript:
    case HookType.NoOp:
      break;
    default:
      throw new Error(`Unknown animation hook type ${type}`);
  }
  return { type, direction, data: d };
}

export interface AnimationFrame {
  frames: Frame[];
  hooks: AnimationHook[];
}

export function parseAnimationFrame(r: BinReader, numParts: number): AnimationFrame {
  const frames = r.fixedList(numParts, (rr) => rr.frame());
  const numHooks = r.u32();
  const hooks = new Array<AnimationHook>(numHooks);
  for (let i = 0; i < numHooks; i++) hooks[i] = parseHook(r);
  return { frames, hooks };
}

/** 0x03xxxxxx: keyframed part transforms. */
export interface Animation {
  id: number;
  flags: number;
  numParts: number;
  numFrames: number;
  posFrames: Frame[];
  partFrames: AnimationFrame[];
}

export function parseAnimation(r: BinReader): Animation {
  const id = r.u32();
  const flags = r.u32();
  const numParts = r.u32();
  const numFrames = r.u32();
  const posFrames = flags & 1 ? r.fixedList(numFrames, (rr) => rr.frame()) : [];
  const partFrames = new Array<AnimationFrame>(numFrames);
  for (let i = 0; i < numFrames; i++) partFrames[i] = parseAnimationFrame(r, numParts);
  return { id, flags, numParts, numFrames, posFrames, partFrames };
}

export type { Vec3 };
