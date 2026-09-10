export enum DatType {
  Cell = 1,
  Portal = 2,
  Language = 3,
  HighRes = 4,
}

/** File type by object id prefix inside client_portal.dat. */
export enum PortalKind {
  GfxObj = 0x01,
  Setup = 0x02,
  Animation = 0x03,
  Palette = 0x04,
  SurfaceTexture = 0x05,
  Texture = 0x06,
  Surface = 0x08,
  MotionTable = 0x09,
  Wave = 0x0a,
  Environment = 0x0d,
  PaletteSet = 0x0f,
  Clothing = 0x10,
  DegradeInfo = 0x11,
  Scene = 0x12,
  Region = 0x13,
  KeyMap = 0x14,
  RenderTexture = 0x15,
  SoundTable = 0x20,
  EnumMapper = 0x22,
  DidMapper = 0x25,
  ActionMap = 0x26,
  DualDidMapper = 0x27,
  CombatTable = 0x30,
  String = 0x31,
  ParticleEmitter = 0x32,
  PhysicsScript = 0x33,
  PhysicsScriptTable = 0x34,
  MasterProperty = 0x39,
  Font = 0x40,
  DbProperties = 0x78,
}

export function portalKind(id: number): PortalKind {
  return (id >>> 24) as PortalKind;
}

export const REGION_ID = 0x13000000;
export const ITERATION_ID = 0xffff0001;

export enum PixelFormat {
  R8G8B8 = 20,
  A8R8G8B8 = 21,
  X8R8G8B8 = 22,
  R5G6B5 = 23,
  A1R5G5B5 = 25,
  A4R4G4B4 = 26,
  A8 = 28,
  P8 = 41,
  INDEX16 = 101,
  CUSTOM_R8G8B8A8 = 240,
  CUSTOM_A8B8G8R8 = 241,
  CUSTOM_B8G8R8 = 242,
  CUSTOM_LSCAPE_R8G8B8 = 243,
  CUSTOM_LSCAPE_ALPHA = 244,
  CUSTOM_RAW_JPEG = 500,
  DXT1 = 827611204,
  DXT3 = 861165636,
  DXT5 = 894720068,
}

export enum SurfaceFlags {
  Base1Solid = 0x1,
  Base1Image = 0x2,
  Base1ClipMap = 0x4,
  Translucent = 0x10,
  Diffuse = 0x20,
  Luminous = 0x40,
  Alpha = 0x100,
  InvAlpha = 0x200,
  Additive = 0x10000,
  Detail = 0x20000,
  Gouraud = 0x10000000,
  Stippled = 0x40000000,
  Perspective = 0x80000000,
}

export enum CullMode {
  Landblock = 0,
  None = 1,
  Clockwise = 2,
  CounterClockwise = 3,
}

export enum Stippling {
  None = 0,
  Positive = 1,
  Negative = 2,
  Both = 3,
  NoPos = 4,
  NoNeg = 8,
}

export enum BSPType {
  Drawing = 0,
  Physics = 1,
  Cell = 2,
}

export enum Placement {
  Default = 0,
  Resting = 101,
}
