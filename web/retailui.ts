/**
 * Draws the game's own windows. A LayoutDesc from the language dat is a tree of elements with
 * rectangles, sprites and text; this walks that tree onto a canvas using the same art and the
 * same bitmap fonts the retail client used. Nothing here is styled by us.
 *
 * Most elements own nothing: 36 of the 42 in the vendor window inherit through baseElement (an
 * element id) and baseLayout (the layout that element lives in), pointing at shared widget
 * libraries - buttons in 0x21000040, text and tabs in 0x2100003F, lists in 0x2100003D,
 * scrollbars in 0x2100003E - and those prototypes chain on further. Art, states, fonts and
 * properties are therefore resolved along the whole chain, nearest first.
 *
 * This is the drawing half only: no input, no binding to game state yet.
 */
import type { Assets } from "../src/render/assets.ts";
import {
  BasePropertyType,
  BinReader,
  LAYOUT_DIDMAPPER_ID,
  MASTERPROPERTY_ID,
  MediaType,
  parseDidMapper,
  parseEnumMapper,
  UIELEMENTID_ENUMMAPPER_ID,
  parseFont,
  parseLayoutDesc,
  parseMasterProperty,
  parsePalette,
  parseStringTable,
  parseTexture,
  propertyTypes,
  type ElementDesc,
  type Font,
  type LayoutDesc,
  type MediaDesc,
  type PropertyValue,
  type StateDesc,
} from "../src/dat/mod.ts";
import { decodeTexture } from "../src/world/decode.ts";

/** property ids, from the MasterProperty table's own names */
const P = {
  textJustifyH: 0x0014,
  textJustifyV: 0x0015,
  marginLeft: 0x0023,
  marginRight: 0x0024,
  marginTop: 0x0025,
  marginBottom: 0x0026,
  textEntry: 0x0017,
  textFont: 0x0018,
  textColor: 0x0019,
  /** the scalar font/colour ids are never used; the array forms carry them instead */
  textFonts: 0x001a,
  textColors: 0x001b,
  /** a tab panel's pages: each entry pairs a tab element with a page element and an open flag */
  meterPosition: 0x0069,
  panelPages: 0x002e,
  tabElement: 0x0030,
  pageElement: 0x0031,
  pageOpen: 0x0032,
  tileOffset: 0x0056,
} as const;

/** UIElement_ItemList: inventory, toolbar and paperdoll slots */
const ITEM_LIST = 0x10000031;

/** a base chain should be a few hops; this only stops a cycle in bad data */
const MAX_CHAIN = 8;

/** what one element contributed to the canvas, for diagnosing a draw */
export interface DrawRecord {
  id: string;
  rect: string;
  art: string | null;
  painted: boolean;
  text: string | null;
}

export interface RetailUi {
  /** layout name (classic_vendor, classic_spellcasting, ...) to its data id */
  layouts: Map<string, number>;
  /** drive a meter from live game state: 0..1 */
  setFill(elementId: number, fraction: number): void;
  setItems(elementId: number, items: { icon: number }[]): void;
  elementName(id: number): string | undefined;
  host(fieldId: number, did: number): void;
  preload(did: number): Promise<void>;
  showPage(groupId: number, pageId: number): void;
  isHidden(e: ElementDesc): boolean;
  itemContainers(did: number): Promise<{ elementId: number; slots: number }[]>;
  clickTab(elementId: number): boolean;
  load(did: number): Promise<LayoutDesc>;
  /** draw a whole layout, or one element of it by element id; pass `trace` to record what drew */
  draw(
    ctx: CanvasRenderingContext2D,
    layout: LayoutDesc,
    did: number,
    rootElementId?: number,
    trace?: DrawRecord[],
  ): Promise<void>;
}

export async function createRetailUi(assets: Assets): Promise<RetailUi | null> {
  const lang = assets.lang;
  if (!lang) return null;

  const master = parseMasterProperty(new BinReader((await assets.portal.readFile(MASTERPROPERTY_ID))!));
  const types = propertyTypes(master);
  // slots are ordinary elements that carry an item-slot property, not a distinct element type:
  // the paperdoll's Inv_HandSlot and friends are 32x32 type-0 elements with UI_ItemList_ItemSlotID
  const propId = (name: string) => [...master.names].find(([, n]) => n === name)?.[0] ?? 0;
  const SLOT_PROP = propId("UI_ItemList_ItemSlotID");
  const HIDE_PROP = propId("UICore_Element_hide");
  const elementNames = parseEnumMapper(new BinReader((await assets.portal.readFile(UIELEMENTID_ENUMMAPPER_ID))!)).idToString;
  const mapper = parseDidMapper(new BinReader((await assets.portal.readFile(LAYOUT_DIDMAPPER_ID))!));
  const layouts = new Map<string, number>();
  for (const [enumValue, did] of mapper.clientEnumToId) {
    const name = mapper.clientEnumToName.get(enumValue);
    if (name && did >>> 24 === 0x21) layouts.set(name, did);
  }

  /**
   * Fields that host another layout. classic_floatypanel's PanelPages holds one 300x362 field per
   * panel (inventory 7, character info 3, skills 0xB, spells 0xD, social 0xC...), classic_inventory
   * hosts PaperDollField, BackpackField and ThreeDItemsField, and so on. A hosted layout is drawn
   * at the field's origin as if it were the field's own subtree.
   */
  const hosted = new Map<number, number>(); // field element id -> layout did drawn inside it
  /** which page a PanelPages-style field group currently shows, by the host element id */
  const activePage = new Map<number, number>();

  /** live meter fills by element id, so vitals can be driven by the game */
  const fills = new Map<number, number>();
  /** live item-list contents by element id: the icons to show in the slots */
  const itemsOf = new Map<number, { icon: number }[]>();
  /** which page a tab panel has open, when the player has clicked a tab */
  const openPage = new Map<number, number>();
  /** tab element -> the panel and page it switches to, learned while drawing */
  const tabOwner = new Map<number, { panel: number; page: number }>();

  const layoutCache = new Map<number, Promise<LayoutDesc | null>>();
  function load(did: number): Promise<LayoutDesc | null> {
    let p = layoutCache.get(did);
    if (!p) {
      p = (async () => {
        try {
          const buf = await lang!.readFile(did);
          return buf ? parseLayoutDesc(new BinReader(buf), types) : null;
        } catch {
          return null;
        }
      })();
      layoutCache.set(did, p);
    }
    return p;
  }

  /** every element of a layout, by element id, so a base reference can find its prototype */
  const indexCache = new Map<number, Promise<Map<number, ElementDesc>>>();
  function indexOf(did: number): Promise<Map<number, ElementDesc>> {
    let p = indexCache.get(did);
    if (!p) {
      p = (async () => {
        const out = new Map<number, ElementDesc>();
        const l = await load(did);
        if (l) {
          (function walk(m: Map<number, ElementDesc>) {
            for (const e of m.values()) {
              out.set(e.elementId, e);
              walk(e.children);
            }
          })(l.elements);
        }
        return out;
      })();
      indexCache.set(did, p);
    }
    return p;
  }

  /** an element followed up its base chain, nearest first */
  async function chainOf(e: ElementDesc, did: number): Promise<ElementDesc[]> {
    const chain = [e];
    let cur = e, curDid = did;
    for (let i = 0; i < MAX_CHAIN && cur.baseElement; i++) {
      const baseDid = cur.baseLayout || curDid;
      const next = (await indexOf(baseDid)).get(cur.baseElement);
      if (!next || chain.includes(next)) break;
      chain.push(next);
      cur = next;
      curDid = baseDid;
    }
    return chain;
  }

  const imagesOf = (s: { media: MediaDesc[] }) => s.media.filter((m) => m.type === MediaType.Image && m.file);

  /**
   * Which state an element draws in. defaultState is rarely a selector - only 108 of the 467
   * elements that declare states have one matching it - and the ids are layout-local slots, not
   * the values in EnumMapper 0x2200001C. Across every layout 0001 is the normal state (194 uses,
   * 139 with art), 0003 the rollover and 000D the pressed, so prefer 0001 and otherwise take the
   * lowest state that actually carries art.
   */
  const NORMAL_STATE = 0x0001;
  function restingState(states: Map<number, StateDesc>): StateDesc | undefined {
    const normal = states.get(NORMAL_STATE);
    if (normal && imagesOf(normal).length) return normal;
    const withArt = [...states.entries()].filter(([, st]) => imagesOf(st).length).sort((a, b) => a[0] - b[0]);
    return withArt[0]?.[1] ?? normal ?? [...states.values()][0];
  }
  /** the nearest link in the chain that actually carries something */
  function nearest<T>(chain: ElementDesc[], pick: (e: ElementDesc) => T | undefined): T | undefined {
    for (const e of chain) {
      const v = pick(e);
      if (v !== undefined) return v;
    }
    return undefined;
  }
  /** a property from the drawn state, else from any link of the chain or that link's own states */
  function propOf(chain: ElementDesc[], st: StateDesc | undefined, id: number): PropertyValue | undefined {
    const fromState = st?.properties.get(id);
    if (fromState) return fromState;
    for (const e of chain) {
      const own = e.properties.get(id);
      if (own) return own;
      for (const s of e.states.values()) {
        const v = s.properties.get(id);
        if (v) return v;
      }
    }
    return undefined;
  }
  /** UICore_Text_fonts and _font_colors are arrays of nested values; entry zero is the default */
  const firstOf = (p: PropertyValue | undefined): PropertyValue | undefined =>
    p && Array.isArray(p.value) ? (p.value as PropertyValue[])[0] : undefined;

  // ---- sprites ----
  const sprites = new Map<number, Promise<HTMLCanvasElement | null>>();
  function sprite(id: number): Promise<HTMLCanvasElement | null> {
    let p = sprites.get(id);
    if (!p) {
      p = (async () => {
        const t = await assets.portal.get(id, parseTexture);
        if (!t || !t.width) return null;
        const palette = t.defaultPaletteId ? (await assets.portal.get(t.defaultPaletteId, parsePalette))?.colors : undefined;
        const img = decodeTexture(t, { palette });
        if (!img || !img.width) return null;
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        const g = c.getContext("2d")!;
        const data = g.createImageData(img.width, img.height);
        data.data.set(img.data);
        g.putImageData(data, 0, 0);
        return c;
      })();
      sprites.set(id, p);
    }
    return p;
  }

  // ---- fonts: an A8 glyph sheet, tinted per colour ----
  const fonts = new Map<number, Promise<{ font: Font; sheet: HTMLCanvasElement | null } | null>>();
  function font(id: number) {
    let p = fonts.get(id);
    if (!p) {
      p = (async () => {
        try {
          const buf = await assets.portal.readFile(id);
          if (!buf) return null;
          const f = parseFont(new BinReader(buf));
          return { font: f, sheet: f.foregroundSurface ? await sprite(f.foregroundSurface) : null };
        } catch {
          return null;
        }
      })();
      fonts.set(id, p);
    }
    return p;
  }
  const tinted = new Map<string, HTMLCanvasElement>();
  function tint(sheet: HTMLCanvasElement, color: string): HTMLCanvasElement {
    const key = `${sheet.width}x${sheet.height}:${color}`;
    let c = tinted.get(key);
    if (!c) {
      c = document.createElement("canvas");
      c.width = sheet.width;
      c.height = sheet.height;
      const g = c.getContext("2d")!;
      g.drawImage(sheet, 0, 0);
      g.globalCompositeOperation = "source-in"; // the sheet is a coverage mask; paint it
      g.fillStyle = color;
      g.fillRect(0, 0, c.width, c.height);
      tinted.set(key, c);
    }
    return c;
  }

  // ---- strings ----
  const tables = new Map<number, Promise<Map<number, string>>>();
  function strings(tableId: number) {
    let p = tables.get(tableId);
    if (!p) {
      p = (async () => {
        try {
          const buf = await lang!.readFile(tableId);
          if (!buf) return new Map<number, string>();
          const t = parseStringTable(new BinReader(buf));
          return new Map(t.entries.map((e) => [e.id, e.strings[0] ?? ""]));
        } catch {
          return new Map<number, string>();
        }
      })();
      tables.set(tableId, p);
    }
    return p;
  }

  const argb = (v: number) => {
    const a = (v >>> 24) & 0xff;
    return `rgba(${(v >> 16) & 0xff}, ${(v >> 8) & 0xff}, ${v & 0xff}, ${a ? a / 255 : 1})`;
  };

  async function drawText(
    ctx: CanvasRenderingContext2D,
    chain: ElementDesc[],
    st: StateDesc | undefined,
    x: number,
    y: number,
  ): Promise<string | null> {
    const entry = propOf(chain, st, P.textEntry);
    const info = entry?.value as { stringId: number; tableId: number } | undefined;
    if (!info || typeof info !== "object" || !("stringId" in info) || !info.tableId) return null;
    const text = (await strings(info.tableId)).get(info.stringId);
    if (!text) return null;

    const fontProp = propOf(chain, st, P.textFont) ?? firstOf(propOf(chain, st, P.textFonts));
    const fontId = fontProp && fontProp.type === BasePropertyType.DataFile ? Number(fontProp.value) : 0;
    if (!fontId) return null;
    const loaded = await font(fontId);
    if (!loaded?.sheet) return null;
    const colorProp = propOf(chain, st, P.textColor) ?? firstOf(propOf(chain, st, P.textColors));
    const glyphs = tint(loaded.sheet, colorProp ? argb(Number(colorProp.value)) : "#e8dcc0");
    const chars = new Map(loaded.font.chars.map((c) => [c.unicode, c]));
    const el = chain[0];

    // verticalBefore is each glyph's own drop from the line top, so glyphs hang from the top of
    // the line rather than from a baseline (across all 49 fonts, verticalBefore + height matches
    // baselineOffset for only about a third of the 153k glyphs, so it is not a baseline identity).
    // The horizontal bearings are signed bytes - 8,738 'before' and 7,048 'after' values exceed
    // 127, meaning negative - so they must be sign-extended or those glyphs fly off to the right.
    const signed = (b: number) => (b > 127 ? b - 256 : b);
    const advance = (g: { before: number; width: number; after: number }) => signed(g.before) + g.width + signed(g.after);

    // Placement follows the justification the element asks for, as OpenAC's ElementReader maps it:
    // 1 centres, 3 and 5 push to the far edge, anything else is left/top. Margins are properties
    // 0x23-0x26. Without this every caption sat in its element's top-left corner.
    let lineWidth = 0;
    for (const ch of text) {
      const g = chars.get(ch.charCodeAt(0));
      if (g) lineWidth += advance(g);
    }
    const enumOf = (id: number) => Number(propOf(chain, st, id)?.value ?? 0);
    const intOf = (id: number) => Number(propOf(chain, st, id)?.value ?? 0);
    const hj = enumOf(P.textJustifyH), vj = enumOf(P.textJustifyV);
    const marginL = intOf(P.marginLeft), marginR = intOf(P.marginRight);
    const contentLeft = marginL;
    const contentRight = (el.width || lineWidth) - marginR;
    const lineHeight = loaded.font.maxCharHeight;
    const startX = x + (hj === 1
      ? Math.max(contentLeft, contentLeft + (contentRight - contentLeft - lineWidth) / 2)
      : hj === 3 || hj === 5
      ? Math.max(contentLeft, contentRight - lineWidth)
      : contentLeft);
    const lineTop = y + (vj === 1
      ? ((el.height || lineHeight) - lineHeight) / 2
      : vj === 3 || vj === 5
      ? (el.height || lineHeight) - lineHeight
      : intOf(P.marginTop));

    let penX = startX;
    for (const ch of text) {
      const g = chars.get(ch.charCodeAt(0));
      if (!g) continue;
      penX += signed(g.before);
      if (g.width && g.height) {
        ctx.drawImage(glyphs, g.offsetX, g.offsetY, g.width, g.height, penX, lineTop + g.verticalBefore, g.width, g.height);
      }
      penX += g.width + signed(g.after);
    }
    return text;
  }

  async function paint(ctx: CanvasRenderingContext2D, images: MediaDesc[], x: number, y: number, w: number, h: number) {
    let painted = false;
    for (const m of images) {
      const img = await sprite(m.file);
      if (!img) continue;
      const dw = w || img.width, dh = h || img.height;
      if (img.width < dw || img.height < dh) {
        // the art is smaller than the element: repeat it, the way the client fills a panel
        const pattern = ctx.createPattern(img, "repeat");
        if (pattern) {
          ctx.save();
          ctx.translate(x, y);
          ctx.fillStyle = pattern;
          ctx.fillRect(0, 0, dw, dh);
          ctx.restore();
          painted = true;
          continue;
        }
      }
      ctx.drawImage(img, x, y, dw, dh);
      painted = true;
    }
    return painted;
  }

  /**
   * Paint order among siblings. readOrder is unique among siblings in all 101 layouts (and only
   * globally unique in 29), so it is a per-parent order. It does not explain the tab strip: the
   * vendor window's TabBackground is a childless type-8 tab-panel shell whose opaque backing art
   * would bury the three tabs its sibling panel draws. zLevel is no help either - it is a
   * window-level stacking value (RootSmartBox 9999, RootChat 900, tooltips 0xFFFFFFFF) and the
   * reference client never reads it. Treating an empty tab-panel shell as backing that paints
   * first is a heuristic, not something the data states outright.
   */
  const isBackingShell = (e: ElementDesc) => e.type === 8 && e.children.size === 0 && !e.properties.has(P.panelPages);
  const inPaintOrder = (list: ElementDesc[]) =>
    [...list].sort((a, b) =>
      (isBackingShell(a) ? 0 : 1) - (isBackingShell(b) ? 0 : 1) || a.readOrder - b.readOrder
    );

  /**
   * A meter (type 7) is two three-slice tracks held in its own type-3 template children: the
   * first container is the back, the second the front, and each container's children supply the
   * left, tile and right sprites ordered by x (OpenAC DatWidgetFactory.BuildMeter / SliceIds).
   * The front is clipped to the fill fraction, so a bar at 60% shows 60% of its width.
   */
  function sliceIds(container: ElementDesc): [number, number, number] {
    const slices = [...container.children.values()]
      .map((c) => ({ x: c.x, file: imagesOf(stateOfAny(c) ?? c)[0]?.file ?? 0 }))
      .filter((s) => s.file)
      .sort((a, b) => a.x - b.x);
    return [slices[0]?.file ?? 0, slices[1]?.file ?? 0, slices[2]?.file ?? 0];
  }
  const stateOfAny = (e: ElementDesc) =>
    imagesOf(e).length ? e : [...e.states.values()].find((st) => imagesOf(st).length);

  /** left cap, tiled middle, right cap across a width */
  async function drawTrack(
    ctx: CanvasRenderingContext2D,
    [left, tile, right]: [number, number, number],
    x: number,
    y: number,
    w: number,
    h: number,
  ) {
    if (w <= 0) return;
    const l = left ? await sprite(left) : null;
    const r = right ? await sprite(right) : null;
    const t = tile ? await sprite(tile) : null;
    const lw = l ? Math.min(l.width, w) : 0;
    const rw = r ? Math.min(r.width, Math.max(0, w - lw)) : 0;
    if (l && lw) ctx.drawImage(l, 0, 0, lw, l.height, x, y, lw, h || l.height);
    if (t) {
      const mid = Math.max(0, w - lw - rw);
      if (mid > 0) {
        const pattern = ctx.createPattern(t, "repeat");
        ctx.save();
        ctx.beginPath();
        ctx.rect(x + lw, y, mid, h || t.height);
        ctx.clip();
        if (pattern) {
          ctx.translate(x + lw, y);
          ctx.fillStyle = pattern;
          ctx.fillRect(0, 0, mid, h || t.height);
        }
        ctx.restore();
      }
    }
    if (r && rw) ctx.drawImage(r, 0, 0, rw, r.height, x + w - rw, y, rw, h || r.height);
  }

  /** returns true when the element was drawn as a meter */
  async function drawMeter(ctx: CanvasRenderingContext2D, e: ElementDesc, chain: ElementDesc[], x: number, y: number) {
    if (e.type !== 7) return false;
    const owner = chain.find((c) => [...c.children.values()].some((k) => k.type === 3)) ?? e;
    const tracks = [...owner.children.values()].filter((c) => c.type === 3).sort((a, b) => a.readOrder - b.readOrder);
    if (!tracks.length) return false;
    const back = sliceIds(tracks[0]);
    const front = tracks[1] ? sliceIds(tracks[1]) : null;
    await drawTrack(ctx, back, x, y, e.width, e.height);
    const fillProp = propOf(chain, undefined, P.meterPosition);
    const fill = fills.get(e.elementId) ?? (typeof fillProp?.value === "number" ? fillProp.value : 0);
    if (front && fill > 0) await drawTrack(ctx, front, x, y, Math.round(e.width * Math.min(1, fill)), e.height);
    return true;
  }

  /** retail item slots are a 32px grid; a list fits as many columns as its width allows */
  const SLOT = 32;
  const isItemContainer = (e: ElementDesc, chain: ElementDesc[]) =>
    e.type === ITEM_LIST || (SLOT_PROP !== 0 && propOf(chain, undefined, SLOT_PROP) !== undefined);

  async function drawItemList(ctx: CanvasRenderingContext2D, e: ElementDesc, chain: ElementDesc[], x: number, y: number) {
    if (!isItemContainer(e, chain)) return false;
    const items = itemsOf.get(e.elementId);
    if (!items?.length) return true; // a real list with nothing in it yet
    const columns = Math.max(1, Math.floor(e.width / SLOT));
    for (let i = 0; i < items.length; i++) {
      const cx = x + (i % columns) * SLOT, cy = y + Math.floor(i / columns) * SLOT;
      if (cy + SLOT > y + e.height) break;
      const icon = items[i].icon ? await sprite(items[i].icon) : null;
      if (icon) ctx.drawImage(icon, cx, cy, SLOT, SLOT);
    }
    return true;
  }

  /** draw a layout that lives inside a field of another layout */
  const hostingNow = new Set<number>(); // layouts currently being drawn as hosts, to stop a cycle
  async function drawHosted(ctx: CanvasRenderingContext2D, did: number, x: number, y: number, w: number, h: number, trace?: DrawRecord[]) {
    if (hostingNow.has(did) || hostingNow.size > 6) return; // a field that hosts an ancestor, or too deep
    const l = await load(did);
    if (!l) return;
    hostingNow.add(did);
    try {
    const root = [...l.elements.values()].sort((a, b) => b.children.size - a.children.size)[0];
    if (!root) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    // the hosted root is authored at its own position; the field decides where it really goes
    await drawElement(ctx, root, did, x - root.x, y - root.y, trace);
    ctx.restore();
    } finally {
      hostingNow.delete(did);
    }
  }

  async function drawElement(
    ctx: CanvasRenderingContext2D,
    e: ElementDesc,
    did: number,
    ox: number,
    oy: number,
    trace?: DrawRecord[],
  ) {
    const x = ox + e.x, y = oy + e.y;
    const hostedDid = hosted.get(e.elementId);
    if (hostedDid) {
      trace?.push({ id: e.elementId.toString(16).toUpperCase(), rect: `${x},${y} ${e.width}x${e.height}`, art: "hosted", painted: true, text: null });
      await drawHosted(ctx, hostedDid, x, y, e.width, e.height, trace);
      return;
    }
    const chain = await chainOf(e, did);
    // the element's own art, else the nearest inherited art
    const own = nearest(chain, (c) => {
      const imgs = imagesOf(c);
      return imgs.length ? imgs : undefined;
    });
    if (await drawItemList(ctx, e, chain, x, y)) {
      trace?.push({ id: e.elementId.toString(16).toUpperCase(), rect: `${x},${y} ${e.width}x${e.height}`, art: "items", painted: true, text: null });
      return;
    }
    if (await drawMeter(ctx, e, chain, x, y)) {
      trace?.push({ id: e.elementId.toString(16).toUpperCase(), rect: `${x},${y} ${e.width}x${e.height}`, art: "meter", painted: true, text: null });
      return;
    }
    let painted = own ? await paint(ctx, own, x, y, e.width, e.height) : false;

    // states carry the button and tab art; prototypes higher up often declare states with no
    // art at all, so look for the nearest link whose states actually draw something
    const states = nearest(chain, (c) => {
      if (!c.states.size) return undefined;
      return [...c.states.values()].some((st) => imagesOf(st).length) ? c.states : undefined;
    }) ?? nearest(chain, (c) => (c.states.size ? c.states : undefined));
    const st = states ? restingState(states) : undefined;
    if (st) painted = (await paint(ctx, imagesOf(st), x, y, e.width, e.height)) || painted;

    const drewText = await drawText(ctx, chain, st, x, y);
    trace?.push({
      id: e.elementId.toString(16).toUpperCase(),
      rect: `${x},${y} ${e.width}x${e.height}`,
      art: own?.[0] ? own[0].file.toString(16).toUpperCase() : (st && imagesOf(st)[0] ? imagesOf(st)[0].file.toString(16).toUpperCase() : null),
      painted,
      text: drewText,
    });

    // a tab panel stacks its pages in the same rectangle and opens one at a time, so the closed
    // ones must not be drawn (without this the last page painted simply wins)
    const closed = new Set<number>();
    const pages = propOf(chain, st, P.panelPages);
    if (Array.isArray(pages?.value)) {
      for (const entry of pages.value as PropertyValue[]) {
        if (!(entry.value instanceof Map)) continue;
        const fields = entry.value as Map<number, PropertyValue>;
        const pageEl = Number(fields.get(P.pageElement)?.value ?? 0);
        const tabEl = Number(fields.get(P.tabElement)?.value ?? 0);
        const chosen = openPage.get(e.elementId);
        const open = chosen ? chosen === pageEl : fields.get(P.pageOpen)?.value === true;
        if (pageEl) {
          tabOwner.set(tabEl, { panel: e.elementId, page: pageEl });
          if (!open) closed.add(pageEl);
        }
      }
    }

    const pageOf = activePage.get(e.elementId);
    for (const c of inPaintOrder([...e.children.values()])) {
      if (closed.has(c.elementId)) continue;
      // a page group shows one page: the chosen one, else the first that hosts a layout
      if (pageOf !== undefined && hosted.has(c.elementId) && c.elementId !== pageOf) continue;
      await drawElement(ctx, c, did, x, y, trace);
    }
  }

  return {
    /** drive a meter from live game state: 0..1 */
    setFill(elementId: number, fraction: number) { fills.set(elementId, fraction); },
    /**
     * Fetch every texture a layout and its hosted layouts will draw, all at once. Drawing awaits
     * sprites one by one, which made a first paint of the whole screen take seven seconds over
     * HTTP range requests; warmed in parallel it is a fraction of that.
     */
    async preload(did: number) {
      const ids = new Set<number>();
      const seenLayouts = new Set<number>();
      const collect = async (d: number) => {
        if (seenLayouts.has(d) || seenLayouts.size > 40) return;
        seenLayouts.add(d);
        const l = await load(d);
        if (!l) return;
        const stack = [...l.elements.values()];
        while (stack.length) {
          const e = stack.pop()!;
          const chain = await chainOf(e, d);
          for (const c of chain) {
            for (const m of imagesOf(c)) ids.add(m.file);
            for (const st of c.states.values()) for (const m of imagesOf(st)) ids.add(m.file);
            const f = firstOf(propOf([c], undefined, P.textFonts));
            if (f && typeof f.value === "number") ids.add(f.value);
          }
          const h = hosted.get(e.elementId);
          if (h) await collect(h);
          stack.push(...e.children.values());
        }
      };
      await collect(did);
      await Promise.all([...ids].map((id) => (id >>> 24 === 0x40 ? font(id) : sprite(id))));
    },
    /** draw layout `did` inside field element `fieldId` */
    host(fieldId: number, did: number) { hosted.set(fieldId, did); },
    /** of the fields under `groupId`, show only `pageId` */
    showPage(groupId: number, pageId: number) { activePage.set(groupId, pageId); },
    /** the game's own name for an element id, from EnumMapper 0x2200001B */
    elementName: (id: number) => elementNames.get(id),
    /** whether an element is authored hidden (UICore_Element_hide) */
    isHidden: (e: ElementDesc) => HIDE_PROP !== 0 && e.properties.get(HIDE_PROP)?.value === true,
    /** fill an item list with icons */
    setItems(elementId: number, items: { icon: number }[]) { itemsOf.set(elementId, items); },
    /** every element of a layout that holds items: grids and single equipment slots */
    async itemContainers(did: number) {
      const l = await load(did);
      const out: { elementId: number; slots: number }[] = [];
      if (l) {
        const walk = async (m: Map<number, ElementDesc>) => {
          for (const e of m.values()) {
            const chain = await chainOf(e, did);
            if (isItemContainer(e, chain)) {
              out.push({ elementId: e.elementId, slots: Math.max(1, Math.floor(e.width / SLOT) * Math.max(1, Math.floor(e.height / SLOT))) });
            }
            await walk(e.children);
          }
        };
        await walk(l.elements);
      }
      return out;
    },
    /** a click on a tab: switch its panel to that tab's page. true when it was a tab. */
    clickTab(elementId: number) {
      const owner = tabOwner.get(elementId);
      if (!owner) return false;
      openPage.set(owner.panel, owner.page);
      return true;
    },
    layouts,
    async load(did: number) {
      const l = await load(did);
      if (!l) throw new Error(`layout ${did.toString(16)} could not be read`);
      return l;
    },
    async draw(
      ctx: CanvasRenderingContext2D,
      layout: LayoutDesc,
      did: number,
      rootElementId?: number,
      trace?: DrawRecord[],
    ) {
      const tops = inPaintOrder([...layout.elements.values()]);
      const chosen = rootElementId === undefined ? tops : tops.filter((e) => e.elementId === rootElementId);
      for (const e of chosen) await drawElement(ctx, e, did, 0, 0, trace);
    },
  };
}
