/**
 * The retail interface, as data. The game describes its own windows in the dats: LayoutDesc
 * records (0x21, in the language dat) hold a tree of elements, each with a type, a rectangle,
 * states, and the sprites that draw it. Text comes from bitmap fonts (0x40) and string tables
 * (0x23), and property values are typed by the MasterProperty table (0x39000001), which has to
 * be read first because it says how many bytes each property occupies.
 *
 * Formats follow ACE.DatLoader (FileTypes/{LayoutDesc,MasterProperty,DidMapper,EnumMapper,
 * StringTable,Font}.cs and Entity/{ElementDesc,StateDesc,MediaDesc,BaseProperty}.cs).
 */
import { BinReader } from "../reader.ts";

export const MASTERPROPERTY_ID = 0x39000001;
/** DidMapper listing every layout by name */
export const LAYOUT_DIDMAPPER_ID = 0x2500000e;
/** EnumMapper naming the element ids inside a layout */
export const UIELEMENTID_ENUMMAPPER_ID = 0x2200001b;
/** EnumMapper naming the state ids */
export const UISTATEID_ENUMMAPPER_ID = 0x2200001c;

export enum BasePropertyType {
  Invalid = 0,
  Bool = 1,
  Integer = 2,
  LongInteger = 3,
  Float = 4,
  Vector = 5,
  Color = 6,
  String = 7,
  StringInfo = 8,
  Enum = 9,
  DataFile = 10,
  Waveform = 11,
  InstanceID = 12,
  Position = 13,
  TimeStamp = 14,
  Bitfield32 = 15,
  Bitfield64 = 16,
  Array = 17,
  Struct = 18,
  StringToken = 19,
  PropertyName = 20,
}

export enum MediaType {
  Undef = 0,
  Movie = 1,
  Alpha = 2,
  Animation = 3,
  Cursor = 4,
  Image = 5,
  Jump = 6,
  Message = 7,
  Pause = 8,
  Sound = 9,
  State = 10,
  Fade = 11,
  Stretch = 12,
}

/** which of an element's rectangle fields are present in the stream */
export enum IncorporationFlags {
  PassToChildren = 0x1,
  X = 0x2,
  Y = 0x4,
  Width = 0x8,
  Height = 0x10,
  ZLevel = 0x20,
}

// ---------- MasterProperty: the schema every property value is read against ----------

export interface PropertyDesc {
  name: number;
  type: BasePropertyType;
  group: number;
  provider: number;
  data: number;
}

/** the default/min/max values the schema can carry, whose width depends on the property's type */
function skipTypedValue(r: BinReader, type: BasePropertyType) {
  switch (type) {
    case BasePropertyType.Bool:
      r.u8();
      break;
    case BasePropertyType.Color:
    case BasePropertyType.DataFile:
    case BasePropertyType.Enum:
      r.u32();
      break;
    case BasePropertyType.Float:
      r.f32();
      break;
    case BasePropertyType.Integer:
      r.i32();
      break;
    case BasePropertyType.Vector:
      r.vec3();
      break;
    default:
      throw new Error(`unhandled default value for property type ${type}`);
  }
}

export function parsePropertyDesc(r: BinReader): PropertyDesc {
  const name = r.u32();
  const type = r.u32() as BasePropertyType;
  const group = r.u32(), provider = r.u32(), data = r.u32();
  r.i32(); // always zero
  if (r.u8()) skipTypedValue(r, type);
  const hasMax = r.u8() !== 0;
  if (hasMax) type === BasePropertyType.Float ? r.f32() : r.i32();
  const hasMin = r.u8() !== 0;
  if (hasMin) type === BasePropertyType.Float ? r.f32() : r.i32();
  r.f32(); // prediction timeout
  r.u8(); // inheritance type
  r.u8(); // dat file type
  r.u8(); // propagation type
  for (let i = 0; i < 10; i++) r.u8(); // required, read-only, propagate, no-checkpoint, ...
  const n = r.u8();
  for (let i = 0; i < n; i++) { r.u32(); r.u32(); } // available properties
  return { name, type, group, provider, data };
}

export interface MasterProperty {
  id: number;
  /** property id -> name */
  names: Map<number, string>;
  properties: Map<number, PropertyDesc>;
}

export function parseMasterProperty(r: BinReader): MasterProperty {
  const id = r.u32();
  r.u32();
  r.u32();
  r.u8(); // bucket
  const names = new Map<number, string>();
  const n = r.compressedU32();
  for (let i = 0; i < n; i++) names.set(r.u32(), r.pstring(1));
  r.u8(); // bucket
  const properties = r.smartMapU32(parsePropertyDesc);
  return { id, names, properties };
}

/** property id -> type, which is all a layout parse needs from the master table */
export function propertyTypes(m: MasterProperty): Map<number, BasePropertyType> {
  return new Map([...m.properties].map(([k, v]) => [k, v.type]));
}

// ---------- mappers: enum value <-> data id, and enum value -> name ----------

export interface DidMapper {
  id: number;
  clientEnumToId: Map<number, number>;
  clientEnumToName: Map<number, string>;
  serverEnumToId: Map<number, number>;
  serverEnumToName: Map<number, string>;
}

export function parseDidMapper(r: BinReader): DidMapper {
  const id = r.u32();
  r.u8(); // numbering type
  const clientEnumToId = r.smartMapU32((x) => x.u32());
  r.u8();
  const clientEnumToName = r.smartMapU32((x) => x.pstring(1));
  r.u8();
  const serverEnumToId = r.smartMapU32((x) => x.u32());
  r.u8();
  const serverEnumToName = r.smartMapU32((x) => x.pstring(1));
  return { id, clientEnumToId, clientEnumToName, serverEnumToId, serverEnumToName };
}

export interface EnumMapper {
  id: number;
  baseEnumMap: number;
  idToString: Map<number, string>;
}

export function parseEnumMapper(r: BinReader): EnumMapper {
  const id = r.u32();
  const baseEnumMap = r.u32();
  r.u8(); // numbering type
  const idToString = r.smartMapU32((x) => x.pstring(1));
  return { id, baseEnumMap, idToString };
}

// ---------- strings ----------

export interface StringInfo {
  token: number;
  stringId: number;
  /** the StringTable (0x23) to look the id up in */
  tableId: number;
}

export function parseStringInfo(r: BinReader): StringInfo {
  const token = r.u8();
  const stringId = r.u32();
  const tableId = r.u32();
  r.u8(); // override
  r.u8();
  r.u8();
  return { token, stringId, tableId };
}

export interface StringTableEntry {
  id: number;
  varNames: string[];
  vars: string[];
  strings: string[];
}

export function parseStringTableEntry(r: BinReader): StringTableEntry {
  const id = r.u32();
  const varNames: string[] = [];
  for (let i = r.u16(); i > 0; i--) varNames.push(r.unicodeString());
  const vars: string[] = [];
  for (let i = r.u16(); i > 0; i--) vars.push(r.unicodeString());
  const strings: string[] = [];
  for (let i = r.u32(); i > 0; i--) strings.push(r.unicodeString());
  for (let i = r.u32(); i > 0; i--) r.u32(); // comments
  r.u8();
  return { id, varNames, vars, strings };
}

export interface StringTable {
  id: number;
  language: number;
  entries: StringTableEntry[];
}

export function parseStringTable(r: BinReader): StringTable {
  const id = r.u32();
  const language = r.u32();
  r.u8();
  return { id, language, entries: r.smartList(parseStringTableEntry) };
}

// ---------- fonts ----------

export interface FontChar {
  unicode: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
  before: number;
  after: number;
  verticalBefore: number;
}

export interface Font {
  id: number;
  maxCharHeight: number;
  maxCharWidth: number;
  chars: FontChar[];
  horizontalBorder: number;
  verticalBorder: number;
  baselineOffset: number;
  /** Texture (0x06) holding every glyph */
  foregroundSurface: number;
  backgroundSurface: number;
}

export function parseFont(r: BinReader): Font {
  const id = r.u32();
  const maxCharHeight = r.u32(), maxCharWidth = r.u32();
  const n = r.u32();
  const chars: FontChar[] = [];
  for (let i = 0; i < n; i++) {
    chars.push({
      unicode: r.u16(), offsetX: r.u16(), offsetY: r.u16(),
      width: r.u8(), height: r.u8(), before: r.u8(), after: r.u8(), verticalBefore: r.u8(),
    });
  }
  return {
    id, maxCharHeight, maxCharWidth, chars,
    horizontalBorder: r.u32(), verticalBorder: r.u32(), baselineOffset: r.u32(),
    foregroundSurface: r.u32(), backgroundSurface: r.u32(),
  };
}

// ---------- the layouts themselves ----------

export interface MediaDesc {
  type: MediaType;
  /** the data id this media draws or plays: a Texture (0x06) when the type is Image or Cursor */
  file: number;
  drawMode: number;
  stateId: number;
}

export function parseMediaDesc(r: BinReader): MediaDesc {
  const type = r.u32() as MediaType;
  r.u32(); // the type again
  const m: MediaDesc = { type, file: 0, drawMode: 0, stateId: 0 };
  switch (type) {
    case MediaType.Movie:
      r.pstring(1);
      r.u8();
      break;
    case MediaType.Alpha:
      m.file = r.u32();
      break;
    case MediaType.Animation: {
      r.f32();
      m.drawMode = r.u32();
      for (let i = r.u32(); i > 0; i--) r.u32(); // frames
      break;
    }
    case MediaType.Cursor:
      m.file = r.u32();
      r.u32(); // x hotspot
      r.u32(); // y hotspot
      break;
    case MediaType.Image:
      m.file = r.u32();
      m.drawMode = r.u32();
      break;
    case MediaType.Jump:
      r.u32();
      r.f32();
      break;
    case MediaType.Message:
      r.u32();
      r.f32();
      break;
    case MediaType.Pause:
      r.f32();
      r.f32();
      break;
    case MediaType.Sound:
      m.file = r.u32();
      r.u32();
      break;
    case MediaType.State:
      m.stateId = r.u32();
      r.f32();
      break;
    case MediaType.Fade:
      r.f32();
      r.f32();
      r.f32();
      break;
  }
  return m;
}

export interface PropertyValue {
  id: number;
  type: BasePropertyType;
  value: number | boolean | string | StringInfo | PropertyValue[] | Map<number, PropertyValue> | null;
}

/** A property value; its width comes from the MasterProperty table, so that must be loaded first. */
export function parsePropertyValue(r: BinReader, types: Map<number, BasePropertyType>): PropertyValue {
  const id = r.u32();
  const type = types.get(id);
  if (type === undefined) throw new Error(`property ${id.toString(16)} is not in the MasterProperty table`);
  switch (type) {
    case BasePropertyType.Enum:
    case BasePropertyType.DataFile:
    case BasePropertyType.Color:
    case BasePropertyType.Bitfield32:
    case BasePropertyType.InstanceID:
      return { id, type, value: r.u32() };
    case BasePropertyType.Bool:
      return { id, type, value: r.u8() !== 0 };
    case BasePropertyType.Float:
      return { id, type, value: r.f32() };
    case BasePropertyType.Integer:
      return { id, type, value: r.i32() };
    case BasePropertyType.StringInfo:
      return { id, type, value: parseStringInfo(r) };
    case BasePropertyType.Vector:
      r.vec3();
      return { id, type, value: null };
    case BasePropertyType.Bitfield64:
      r.u32();
      r.u32();
      return { id, type, value: null };
    case BasePropertyType.Array: {
      const n = r.u32();
      const items: PropertyValue[] = [];
      for (let i = 0; i < n; i++) items.push(parsePropertyValue(r, types));
      return { id, type, value: items };
    }
    case BasePropertyType.Struct:
      return { id, type, value: r.byteMapU32((x) => parsePropertyValue(x, types)) };
    case BasePropertyType.String:
      return { id, type, value: null }; // unused in the retail dats
    default:
      throw new Error(`unhandled property value type ${type} for ${id.toString(16)}`);
  }
}

export interface StateDesc {
  stateId: number;
  passToChildren: boolean;
  flags: number;
  properties: Map<number, PropertyValue>;
  media: MediaDesc[];
}

export function parseStateDesc(r: BinReader, types: Map<number, BasePropertyType>): StateDesc {
  const stateId = r.u32();
  const passToChildren = r.u8() !== 0;
  const flags = r.u32();
  const properties = r.byteMapU32((x) => parsePropertyValue(x, types));
  const media: MediaDesc[] = [];
  for (let i = r.u8(); i > 0; i--) media.push(parseMediaDesc(r));
  return { stateId, passToChildren, flags, properties, media };
}

export interface ElementDesc extends StateDesc {
  readOrder: number;
  elementId: number;
  /** what kind of widget this is: 1 button, 7 meter, 8 tab panel, 11 scrollbar, 12 text... */
  type: number;
  baseElement: number;
  baseLayout: number;
  defaultState: number;
  x: number;
  y: number;
  width: number;
  height: number;
  zLevel: number;
  edges: [number, number, number, number];
  states: Map<number, StateDesc>;
  children: Map<number, ElementDesc>;
}

export function parseElementDesc(r: BinReader, types: Map<number, BasePropertyType>): ElementDesc {
  const base = parseStateDesc(r, types);
  const readOrder = r.u32(), elementId = r.u32(), type = r.u32();
  const baseElement = r.u32(), baseLayout = r.u32(), defaultState = r.u32();
  const f = base.flags;
  const x = f & IncorporationFlags.X ? r.u32() : 0;
  const y = f & IncorporationFlags.Y ? r.u32() : 0;
  const width = f & IncorporationFlags.Width ? r.u32() : 0;
  const height = f & IncorporationFlags.Height ? r.u32() : 0;
  const zLevel = f & IncorporationFlags.ZLevel ? r.u32() : 0;
  const edges: [number, number, number, number] = [r.u32(), r.u32(), r.u32(), r.u32()];
  const states = r.byteMapU32((s) => parseStateDesc(s, types));
  const children = r.byteMapU32((c) => parseElementDesc(c, types));
  return {
    ...base, readOrder, elementId, type, baseElement, baseLayout, defaultState,
    x, y, width, height, zLevel, edges, states, children,
  };
}

export interface LayoutDesc {
  id: number;
  displayWidth: number;
  displayHeight: number;
  elements: Map<number, ElementDesc>;
}

/** One retail window, as the game describes it. Needs the MasterProperty types. */
export function parseLayoutDesc(r: BinReader, types: Map<number, BasePropertyType>): LayoutDesc {
  const id = r.u32();
  const displayWidth = r.i32();
  const displayHeight = r.i32();
  const elements = r.byteMapU32((e) => parseElementDesc(e, types));
  return { id, displayWidth, displayHeight, elements };
}
