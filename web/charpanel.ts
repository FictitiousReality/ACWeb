/**
 * The character panel: paper doll, attributes, skills, spellbook, inventory,
 * allegiance and client settings. Everything it shows comes from the server's
 * player description and object list, plus names and icons from the dats.
 */
import type { GameClient, WorldObject, AllegianceProfile } from "../src/net/client.ts";
import type { Assets } from "../src/render/assets.ts";
import { parseSkillTable, SKILLTABLE_ID, parseSpellTable, SPELLTABLE_ID, parseXpTable, XPTABLE_ID, costOfNextRank } from "../src/dat/mod.ts";
import type { SkillBase, SpellBase, XpTable } from "../src/dat/mod.ts";
import { VITAL_IDS } from "../src/net/client.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** paired equipment slots: wear the item on whichever side is free */
const PAIRED_SLOTS = [[0x00010000, 0x00020000], [0x00040000, 0x00080000]];

/**
 * Where to wear an item. Clothing and armor use their whole coverage mask; for wrists and
 * rings, which have a left and a right, the free side is chosen.
 */
export function wieldLocationFor(item: WorldObject, worn: WorldObject[]): number {
  const valid = item.validLocations ?? 0;
  for (const pair of PAIRED_SLOTS) {
    if ((valid & (pair[0] | pair[1])) === (pair[0] | pair[1])) {
      return pair.find((bit) => !worn.some((w) => w.wieldedLocation & bit)) ?? pair[0];
    }
  }
  return valid;
}

/**
 * True for a loose item lying in the world. Only dynamically created objects can be picked
 * up; doors, chests and other fixtures placed in the landblock have low guids and are stuck,
 * and creatures are not items.
 */
export function isOnGround(o: WorldObject): boolean {
  return o.guid >= 0x80000000 && o.container === null && o.wielder === null && !!o.position;
}

/**
 * What double-clicking an item should do: take it off, pick it up, wear it, or use it.
 * Using clothing does nothing on the server ("ActOnUse ... undefined"), so equippable items
 * must be wielded instead.
 */
export function itemAction(c: GameClient, o: WorldObject): { verb: string; run(): void } {
  if (o.wielder === c.playerGuid) return { verb: "unequip", run: () => c.pickUp(o.guid) };
  if (isOnGround(o)) return { verb: "pick up", run: () => c.pickUp(o.guid) };
  if (o.validLocations) {
    const worn = [...c.objects.values()].filter((w) => w.wielder === c.playerGuid);
    return { verb: "equip", run: () => c.wield(o.guid, wieldLocationFor(o, worn)) };
  }
  return { verb: "use", run: () => c.use(o.guid) };
}

export type CharTab = "doll" | "status" | "skills" | "spells" | "items" | "alleg" | "settings";

/** A client-side setting rendered as a control on the Settings tab and kept in localStorage. */
export interface SettingDef {
  key: string;
  label: string;
  hint?: string;
  kind: "range" | "toggle";
  min?: number;
  max?: number;
  step?: number;
  get(): number | boolean;
  set(v: number | boolean): void;
}

export interface CharPanelDeps {
  client(): GameClient | null;
  assets(): Assets | null;
  icon(textureId: number): Promise<string | null>;
  log(line: string, cls?: string): void;
  targetGuid(): number | null;
  settings: SettingDef[];
  /** called whenever the panel opens, closes or changes tab, so a launcher can highlight the right button */
  onChange?(open: boolean, tab: CharTab): void;
  /** put a spell on the spell bar being shown */
  addToSpellBar?(spellId: number): void;
  spellBarName?(): string;
}

/** equipment slots in the order they are drawn, with the EquipMask bits each covers */
const SLOTS: { key: string; label: string; mask: number }[] = [
  { key: "head", label: "Head", mask: 0x00000001 },
  { key: "neck", label: "Neck", mask: 0x00008000 },
  { key: "chest", label: "Chest", mask: 0x00000202 },
  { key: "abdomen", label: "Abdomen", mask: 0x00000404 },
  { key: "upperarm", label: "Upper arms", mask: 0x00000808 },
  { key: "lowerarm", label: "Lower arms", mask: 0x00001010 },
  { key: "hands", label: "Hands", mask: 0x00000020 },
  { key: "upperleg", label: "Upper legs", mask: 0x00002040 },
  { key: "lowerleg", label: "Lower legs", mask: 0x00004080 },
  { key: "feet", label: "Feet", mask: 0x00000100 },
  { key: "cloak", label: "Cloak", mask: 0x08000000 },
  { key: "wristl", label: "Left wrist", mask: 0x00010000 },
  { key: "wristr", label: "Right wrist", mask: 0x00020000 },
  { key: "fingerl", label: "Left finger", mask: 0x00040000 },
  { key: "fingerr", label: "Right finger", mask: 0x00080000 },
  { key: "weapon", label: "Weapon", mask: 0x02100000 },
  { key: "shield", label: "Shield", mask: 0x00200000 },
  { key: "missile", label: "Missile", mask: 0x00400000 },
  { key: "ammo", label: "Ammunition", mask: 0x00800000 },
  { key: "held", label: "Held", mask: 0x01000000 },
  { key: "trinket", label: "Trinket", mask: 0x04000000 },
];

const SCHOOLS = ["", "War Magic", "Life Magic", "Item Enchantment", "Creature Enchantment", "Void Magic"];
const ADVANCEMENT = ["Undeveloped", "Untrained", "Trained", "Specialized"];
const SKILL_CATEGORIES = ["", "Combat", "Other", "Magic"];
/** PropertyAttribute ids used by the skill formulas */
const ATTR_BY_ID = ["", "strength", "endurance", "quickness", "coordination", "focus", "self"] as const;

export function createCharacterPanel(deps: CharPanelDeps) {
  let tab: CharTab = "doll";
  let skillTable: Map<number, SkillBase> | null = null;
  let spellTable: Map<number, SpellBase> | null = null;
  let xpTable: XpTable | null = null;
  let invSelected: number | null = null;
  let spellFilter = "";

  const panel = $("char");
  const isOpen = () => panel.classList.contains("show");

  async function tables() {
    const a = deps.assets();
    if (!a) return;
    if (!skillTable) skillTable = await a.portal.get(SKILLTABLE_ID, parseSkillTable);
    if (!spellTable) spellTable = await a.portal.get(SPELLTABLE_ID, parseSpellTable);
    if (!xpTable) xpTable = await a.portal.get(XPTABLE_ID, parseXpTable);
  }

  function setTab(t: CharTab) {
    tab = t;
    deps.onChange?.(isOpen(), tab);
    for (const b of panel.querySelectorAll<HTMLButtonElement>("#charTabs button[data-ctab]")) b.classList.toggle("active", b.dataset.ctab === t);
    for (const p of panel.querySelectorAll<HTMLElement>(".cpane")) p.classList.toggle("active", p.id === `cp-${t}`);
    render();
  }

  function toggle(t?: CharTab) {
    const wantOpen = t !== undefined ? !(isOpen() && tab === t) : !isOpen();
    panel.classList.toggle("show", wantOpen);
    if (wantOpen) { if (t) setTab(t); else render(); }
    deps.onChange?.(isOpen(), tab);
  }

  function close() {
    panel.classList.remove("show");
    deps.onChange?.(false, tab);
  }

  /** An icon tile with a name, used by the doll, inventory and spellbook. */
  function tile(textureId: number, label: string, cls = ""): HTMLElement {
    const el = document.createElement("div");
    el.className = `tile ${cls}`;
    const img = document.createElement("img");
    img.alt = "";
    deps.icon(textureId).then((u) => { if (u) img.src = u; });
    const span = document.createElement("span");
    span.textContent = label;
    el.append(img, span);
    el.title = label;
    return el;
  }

  function renderDoll() {
    const c = deps.client();
    const box = $("cp-doll");
    box.innerHTML = "";
    if (!c) { box.textContent = "not connected"; return; }
    const worn = [...c.objects.values()].filter((o) => o.wielder === c.playerGuid);
    const grid = document.createElement("div");
    grid.className = "doll";
    for (const slot of SLOTS) {
      const item = worn.find((o) => (o.wieldedLocation & slot.mask) !== 0);
      const cell = document.createElement("div");
      cell.className = "slot" + (item ? " filled" : "");
      const label = document.createElement("b");
      label.textContent = slot.label;
      cell.appendChild(label);
      if (item) {
        const t = tile(item.icon, item.name);
        t.title = `${item.name} — double-click to take off`;
        t.ondblclick = () => { itemAction(c, item).run(); deps.log(`taking off ${item.name}`, "c-system"); };
        cell.appendChild(t);
      } else {
        const empty = document.createElement("div");
        empty.className = "tile empty";
        cell.appendChild(empty);
      }
      grid.appendChild(cell);
    }
    box.appendChild(grid);
    const note = document.createElement("p");
    note.className = "note";
    note.textContent = worn.length ? "Double-click an item to take it off." : "Nothing equipped.";
    box.appendChild(note);
  }

  const HERITAGE = ["", "Aluvian", "Gharu'ndim", "Sho", "Viamontian", "Shadowbound", "Gearknight", "Tumerok", "Lugian", "Empyrean", "Penumbraen", "Undead"];
  const PK_STATUS: Record<number, string> = { 1: "Protected", 2: "Non-player killer", 4: "Player killer", 8: "Unprotected", 0x20: "Free", 0x40: "PK Lite" };

  /** seconds of play time as "3d 4h 12m" */
  function duration(seconds: number): string {
    const d = Math.floor(seconds / 86400), h = Math.floor(seconds % 86400 / 3600), m = Math.floor(seconds % 3600 / 60);
    return [d && `${d}d`, (d || h) && `${h}h`, `${m}m`].filter(Boolean).join(" ");
  }

  /** experience the character has left to spend */
  function availableXp(c: GameClient): number { return c.properties.int64.get(2) ?? 0; }

  /**
   * "+" raises one rank, "max" spends everything it can. The server derives the new rank from
   * the total experience put into the trait, so both are just an amount of experience to add.
   */
  function raiseControl(cost: number | null, toCap: number, available: number, spend: (xp: number) => void): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "raise";
    if (cost === null) { wrap.textContent = "max"; wrap.classList.add("atcap"); return wrap; }
    const price = document.createElement("i");
    price.textContent = cost.toLocaleString();
    const one = document.createElement("button");
    one.textContent = "+";
    one.title = `raise one rank for ${cost.toLocaleString()} experience`;
    one.disabled = available < cost;
    one.onclick = () => spend(cost);
    wrap.append(price, one);
    const all = Math.min(available, toCap);
    if (all > cost) {
      const many = document.createElement("button");
      many.textContent = "»";
      many.title = `spend ${all.toLocaleString()} experience, as many ranks as that buys`;
      many.onclick = () => spend(all);
      wrap.append(many);
    }
    return wrap;
  }

  function renderStatus() {
    const c = deps.client();
    const box = $("cp-status");
    box.innerHTML = "";
    if (!c) { box.textContent = "not connected"; return; }
    const me = c.objects.get(c.playerGuid);
    const int = c.properties.int, i64 = c.properties.int64, str = c.properties.string;

    const head = document.createElement("h3");
    head.className = "who";
    const level = int.get(25);
    head.textContent = `${me?.name ?? str.get(1) ?? "You"}${level ? `  —  level ${level}` : ""}`;
    box.appendChild(head);
    const sub = [str.get(4) ?? HERITAGE[int.get(188) ?? 0], int.get(113) === 2 ? "female" : int.get(113) === 1 ? "male" : str.get(3), str.get(5)].filter(Boolean).join(", ");
    if (sub) box.appendChild(Object.assign(document.createElement("p"), { className: "note", textContent: sub }));
    const title = str.get(2);
    if (title) box.appendChild(Object.assign(document.createElement("p"), { className: "note", textContent: `"${title}"` }));

    const section = (name: string, withActions = false) => {
      box.appendChild(Object.assign(document.createElement("h4"), { textContent: name }));
      const kv = document.createElement("div");
      kv.className = withActions ? "kv act" : "kv";
      box.appendChild(kv);
      return (k: string, v: string | number | undefined | null, action?: HTMLElement) => {
        if (v === undefined || v === null || v === "") return;
        const a = document.createElement("b"); a.textContent = k;
        const b = document.createElement("span"); b.textContent = String(v);
        kv.append(a, b);
        if (withActions) kv.append(action ?? document.createElement("span"));
      };
    };

    const xp = section("Experience");
    xp("Total experience", i64.get(1)?.toLocaleString());
    xp("Unassigned experience", i64.get(2)?.toLocaleString());
    if (xpTable && level && i64.get(1) !== undefined && level + 1 < xpTable.level.length) {
      const have = i64.get(1)!, next = xpTable.level[level + 1], base = xpTable.level[level];
      const pct = next > base ? Math.max(0, Math.min(100, Math.round((have - base) / (next - base) * 100))) : 0;
      xp(`To level ${level + 1}`, `${Math.max(0, next - have).toLocaleString()} (${pct}%)`);
    }
    const credits = int.get(24), totalCredits = int.get(23);
    xp("Skill credits", credits !== undefined ? `${credits}${totalCredits ? ` of ${totalCredits}` : ""}` : undefined);
    const lum = i64.get(6), maxLum = i64.get(7);
    if (maxLum) xp("Luminance", `${(lum ?? 0).toLocaleString()} / ${maxLum.toLocaleString()}`);
    xp("Enlightenment", int.get(390) || undefined);

    const avail = availableXp(c);
    const at = section("Attributes", !!xpTable);
    const ATTRS = [["strength", "Strength", 1], ["endurance", "Endurance", 2], ["quickness", "Quickness", 3], ["coordination", "Coordination", 4], ["focus", "Focus", 5], ["self", "Self", 6]] as const;
    for (const [key, label, id] of ATTRS) {
      const info = c.attributeInfo[key];
      let action: HTMLElement | undefined;
      if (xpTable) {
        const cost = costOfNextRank(xpTable.attribute, info.xp);
        const toCap = xpTable.attribute[xpTable.attribute.length - 1] - info.xp;
        action = raiseControl(cost, toCap, avail, (xp) => {
          c.raiseAttribute(id, xp);
          deps.log(`spending ${xp.toLocaleString()} experience on ${label}`, "c-system");
        });
      }
      at(label, c.attributes[key], action);
    }

    const vt = section("Vitals", !!xpTable);
    for (const [key, label] of [["health", "Health"], ["stamina", "Stamina"], ["mana", "Mana"]] as const) {
      const info = c.vitalInfo[key];
      let action: HTMLElement | undefined;
      if (xpTable) {
        const cost = costOfNextRank(xpTable.vital, info.xp);
        const toCap = xpTable.vital[xpTable.vital.length - 1] - info.xp;
        action = raiseControl(cost, toCap, avail, (xp) => {
          c.raiseVital(VITAL_IDS[key], xp);
          deps.log(`spending ${xp.toLocaleString()} experience on maximum ${label}`, "c-system");
        });
      }
      vt(label, `${c.vitals[key].current} / ${c.vitals[key].max}`, action);
    }

    const bd = section("Burden");
    const burden = int.get(5);
    // the game's carrying capacity: 150 per point of strength (augmentations add more)
    const capacity = c.attributes.strength * 150;
    if (burden !== undefined && capacity > 0) {
      bd("Carried", `${burden.toLocaleString()} of ${capacity.toLocaleString()}`);
      bd("Burden", `${Math.round(burden / capacity * 100)}%`);
    }
    bd("Item slots", int.get(6));
    bd("Pack slots", int.get(7));

    if (c.allegiance?.totalMembers || c.allegianceRank) {
      const al = section("Allegiance");
      al("Name", c.allegiance?.name || str.get(47) || "(unnamed)");
      al("Your rank", c.allegianceRank || undefined);
      al("Monarch", c.allegiance?.monarch?.name || str.get(21));
      al("Members", c.allegiance?.totalMembers);
      al("Your vassals", c.allegiance?.totalVassals);
    }

    const hs = section("History");
    const age = int.get(125);
    hs("Time played", age ? duration(age) : undefined);
    const born = int.get(98);
    hs("Born", born ? new Date(born * 1000).toLocaleDateString() : str.get(43));
    hs("Deaths", int.get(43));
    hs("Level at last death", int.get(139) || undefined);
    const pk = int.get(134);
    hs("Status", pk !== undefined ? PK_STATUS[pk] ?? `0x${pk.toString(16)}` : undefined);
    hs("Fellowship", str.get(10));
    if (!age && !born && int.get(43) === undefined) {
      box.appendChild(Object.assign(document.createElement("p"), { className: "note", textContent: "Some values only arrive with the login description; reconnect if they are missing." }));
    }
  }

  /** Effective skill value: training bonus + ranks + the attribute part of its dat formula. */
  function skillValue(c: GameClient, id: number): number | null {
    const info = c.skills.get(id), base = skillTable?.get(id);
    if (!info || !base) return null;
    let attr = 0;
    if (base.formula.x !== 0) {
      const a1 = ATTR_BY_ID[base.formula.attr1], a2 = ATTR_BY_ID[base.formula.attr2];
      if (a1) attr += c.attributes[a1];
      if (a2) attr += c.attributes[a2];
      if (base.formula.z > 1) attr = Math.round(attr / base.formula.z);
    }
    return info.initLevel + info.ranks + attr;
  }

  function renderSkills() {
    const c = deps.client();
    const box = $("cp-skills");
    box.innerHTML = "";
    if (!c) { box.textContent = "not connected"; return; }
    if (!skillTable) { box.textContent = "loading skill names..."; return; }
    if (!c.skills.size) { box.textContent = "no skills yet (they arrive with the login description)"; return; }
    const avail = availableXp(c);
    const credits = c.properties.int.get(24) ?? 0;
    const head = document.createElement("p");
    head.className = "note";
    head.textContent = `${avail.toLocaleString()} experience and ${credits} skill credit${credits === 1 ? "" : "s"} to spend`;
    box.appendChild(head);
    const rows = [...c.skills.entries()]
      .map(([id, info]) => ({ id, info, base: skillTable!.get(id) }))
      .filter((r) => r.base && r.info.advancement > 1)
      .sort((a, b) => (a.base!.category - b.base!.category) || a.base!.name.localeCompare(b.base!.name));
    let category = -1;
    const table = document.createElement("div");
    table.className = "kv skills" + (xpTable ? " act" : "");
    for (const r of rows) {
      if (r.base!.category !== category) {
        category = r.base!.category;
        const h = document.createElement("h4");
        h.textContent = SKILL_CATEGORIES[category] ?? "Skills";
        h.className = "span2";
        table.appendChild(h);
      }
      const name = document.createElement("b");
      name.textContent = r.base!.name;
      name.title = `${ADVANCEMENT[r.info.advancement] ?? ""}: ${r.base!.description}`;
      const val = document.createElement("span");
      const v = skillValue(c, r.id);
      val.textContent = `${v ?? "?"}${r.info.advancement === 3 ? "  (specialized)" : ""}`;
      if (r.info.advancement === 3) val.className = "spec";
      table.append(name, val);
      if (xpTable) {
        const ranksTable = r.info.advancement === 3 ? xpTable.specializedSkill : xpTable.trainedSkill;
        const cost = costOfNextRank(ranksTable, r.info.xpSpent);
        const toCap = ranksTable[ranksTable.length - 1] - r.info.xpSpent;
        table.append(raiseControl(cost, toCap, avail, (xp) => {
          c.raiseSkill(r.id, xp);
          deps.log(`spending ${xp.toLocaleString()} experience on ${r.base!.name}`, "c-system");
        }));
      }
    }
    box.appendChild(table);
    const untrained = [...c.skills.entries()]
      .map(([id, info]) => ({ id, info, base: skillTable!.get(id) }))
      .filter((r) => r.base && r.info.advancement <= 1 && r.base.trainedCost > 0)
      .sort((a, b) => a.base!.name.localeCompare(b.base!.name));
    if (untrained.length) {
      box.appendChild(Object.assign(document.createElement("h4"), { textContent: "Untrained" }));
      const ut = document.createElement("div");
      ut.className = "kv act";
      for (const r of untrained) {
        const name = document.createElement("b");
        name.textContent = r.base!.name;
        name.title = r.base!.description;
        const cost = document.createElement("span");
        cost.textContent = `${r.base!.trainedCost} credit${r.base!.trainedCost === 1 ? "" : "s"}`;
        const act = document.createElement("span");
        act.className = "raise";
        const btn = document.createElement("button");
        btn.textContent = "train";
        btn.disabled = credits < r.base!.trainedCost;
        btn.title = `train ${r.base!.name} for ${r.base!.trainedCost} skill credits`;
        btn.onclick = () => {
          c.trainSkill(r.id, r.base!.trainedCost);
          deps.log(`training ${r.base!.name} for ${r.base!.trainedCost} credits`, "c-system");
        };
        act.appendChild(btn);
        ut.append(name, cost, act);
      }
      box.appendChild(ut);
    }
  }

  function renderSpells() {
    const c = deps.client();
    const box = $("cp-spells");
    box.innerHTML = "";
    if (!c) { box.textContent = "not connected"; return; }
    if (!spellTable) { box.textContent = "loading spell names..."; return; }
    if (!c.spells.length) { box.textContent = "your spellbook is empty"; return; }
    const search = document.createElement("input");
    search.placeholder = `filter ${c.spells.length} spells...`;
    search.value = spellFilter;
    search.oninput = () => { spellFilter = search.value; renderSpells(); (($("cp-spells").querySelector("input")) as HTMLInputElement)?.focus(); };
    box.appendChild(search);
    const spells = c.spells
      .map((id) => spellTable!.get(id))
      .filter((s): s is SpellBase => !!s && (!spellFilter || s.name.toLowerCase().includes(spellFilter.toLowerCase())))
      .sort((a, b) => (a.school - b.school) || a.name.localeCompare(b.name));
    let school = -1;
    for (const s of spells) {
      if (s.school !== school) {
        school = s.school;
        const h = document.createElement("h4");
        h.textContent = SCHOOLS[school] ?? `School ${school}`;
        box.appendChild(h);
      }
      const t = tile(s.iconId, s.name, "spell");
      t.title = `${s.name}\n${s.description}\nMana ${s.baseMana}${s.duration ? `, lasts ${Math.round(s.duration / 60)} min` : ""}`;
      const row = document.createElement("div");
      row.className = "spellrow";
      row.appendChild(t);
      if (deps.addToSpellBar) {
        const add = document.createElement("button");
        add.textContent = "+";
        add.title = `add ${s.name} to ${deps.spellBarName?.() ?? "the spell bar"}`;
        add.onclick = () => deps.addToSpellBar!(s.id);
        row.appendChild(add);
      }
      box.appendChild(row);
    }
    if (!spells.length) box.appendChild(Object.assign(document.createElement("p"), { className: "note", textContent: "no spells match" }));
  }

  function renderItems() {
    const c = deps.client();
    const box = $("cp-itemlist");
    box.innerHTML = "";
    if (!c) { box.textContent = "not connected"; return; }
    const items = c.inventory().sort((a, b) => (a.wielder ? 0 : 1) - (b.wielder ? 0 : 1) || a.name.localeCompare(b.name));
    for (const o of items) {
      const row = document.createElement("div");
      row.className = "item" + (o.guid === invSelected ? " sel" : "");
      const img = document.createElement("img");
      img.alt = "";
      deps.icon(o.icon).then((u) => { if (u) img.src = u; });
      const name = document.createElement("span");
      name.textContent = o.stackSize > 1 ? `${o.name} ×${o.stackSize}` : o.name;
      row.append(img, name);
      if (o.wielder) { const eq = document.createElement("span"); eq.className = "eq"; eq.textContent = "(worn)"; row.append(eq); }
      row.onclick = () => { invSelected = o.guid; renderItems(); };
      row.ondblclick = () => { const a = itemAction(c, o); a.run(); deps.log(`${a.verb} ${o.name}`, "c-system"); };
      row.title = `${o.name} — double-click to ${itemAction(c, o).verb}`;
      box.appendChild(row);
    }
    if (!items.length) box.textContent = "(empty)";
    const sel = invSelected ? c.objects.get(invSelected) : null;
    const equip = $<HTMLButtonElement>("itemEquip");
    equip.textContent = sel?.wielder === c.playerGuid ? "Unequip" : "Equip";
    equip.disabled = !sel || (!sel.validLocations && sel.wielder !== c.playerGuid);
  }

  function renderAllegiance(a: AllegianceProfile | null) {
    const box = $("cp-alleg");
    box.innerHTML = "";
    const c = deps.client();
    const refresh = document.createElement("button");
    refresh.textContent = "Refresh";
    refresh.onclick = () => { c?.requestAllegianceUpdate(); deps.log("asked the server for allegiance data", "c-system"); };
    if (!a || !a.totalMembers) {
      box.append(Object.assign(document.createElement("p"), { className: "note", textContent: a ? "You are not in an allegiance." : "No allegiance data yet." }), refresh);
      return;
    }
    const h = document.createElement("h4");
    h.textContent = a.name || "(unnamed allegiance)";
    box.appendChild(h);
    const kv = document.createElement("div");
    kv.className = "kv";
    const row = (k: string, v: string) => { const x = document.createElement("b"); x.textContent = k; const y = document.createElement("span"); y.textContent = v; kv.append(x, y); };
    row("Members", String(a.totalMembers));
    row("Your vassals", String(a.totalVassals));
    if (a.monarch) row("Monarch", `${a.monarch.name}${a.monarch.online ? " (online)" : ""}`);
    if (a.locked) row("Locked", "yes");
    box.appendChild(kv);
    if (a.motd) {
      const m = document.createElement("p");
      m.className = "motd";
      m.textContent = `"${a.motd}"${a.motdSetBy ? ` — ${a.motdSetBy}` : ""}`;
      box.appendChild(m);
    }
    if (a.members.length) {
      const list = document.createElement("div");
      list.className = "kv";
      for (const m of a.members) {
        const n = document.createElement("b");
        n.textContent = m.name + (m.online ? " •" : "");
        const d = document.createElement("span");
        d.textContent = `rank ${m.rank}${m.level ? `, level ${m.level}` : ""}`;
        list.append(n, d);
      }
      box.append(Object.assign(document.createElement("h4"), { textContent: "Patron and vassals" }), list);
    }
    box.appendChild(refresh);
  }

  function renderSettings() {
    const box = $("cp-settings");
    box.innerHTML = "";
    for (const s of deps.settings) {
      const wrap = document.createElement("label");
      wrap.className = "setting";
      const name = document.createElement("b");
      name.textContent = s.label;
      const value = document.createElement("i");
      const input = document.createElement("input");
      if (s.kind === "toggle") {
        input.type = "checkbox";
        input.checked = !!s.get();
        input.onchange = () => { s.set(input.checked); saveSetting(s.key, input.checked); };
      } else {
        input.type = "range";
        input.min = String(s.min ?? 0); input.max = String(s.max ?? 1); input.step = String(s.step ?? 0.1);
        input.value = String(s.get());
        value.textContent = String(s.get());
        input.oninput = () => { const v = Number(input.value); value.textContent = String(v); s.set(v); saveSetting(s.key, v); };
      }
      wrap.append(name, input, value);
      if (s.hint) wrap.append(Object.assign(document.createElement("small"), { textContent: s.hint }));
      box.appendChild(wrap);
    }
    const reset = document.createElement("button");
    reset.textContent = "Reset panel positions";
    reset.onclick = () => { document.dispatchEvent(new CustomEvent("acweb-resetui")); };
    box.appendChild(reset);
  }

  function render() {
    if (!isOpen()) return;
    tables().then(() => {
      if (tab === "doll") renderDoll();
      else if (tab === "status") renderStatus();
      else if (tab === "skills") renderSkills();
      else if (tab === "spells") renderSpells();
      else if (tab === "items") renderItems();
      else if (tab === "alleg") renderAllegiance(deps.client()?.allegiance ?? null);
      else renderSettings();
    });
  }

  for (const b of panel.querySelectorAll<HTMLButtonElement>("#charTabs button[data-ctab]")) {
    b.onclick = () => setTab(b.dataset.ctab as CharTab);
  }
  $("charClose").onclick = close;
  $("itemUse").onclick = () => { if (invSelected) deps.client()?.use(invSelected); };
  $("itemEquip").onclick = () => {
    const c = deps.client(), o = invSelected ? c?.objects.get(invSelected) : null;
    if (!c || !o) return;
    const a = itemAction(c, o);
    a.run();
    deps.log(`${a.verb} ${o.name}`, "c-system");
  };
  $("itemDrop").onclick = () => { if (invSelected) deps.client()?.drop(invSelected); };
  $("itemGive").onclick = () => {
    const c = deps.client(), target = deps.targetGuid();
    if (!c || !invSelected) return;
    if (!target) { deps.log("select a target first (click an NPC)", "c-error"); return; }
    const item = c.objects.get(invSelected);
    c.give(target, invSelected, item?.stackSize ?? 1);
    deps.log(`giving ${item?.name ?? "item"} to ${c.objects.get(target)?.name ?? "target"}...`, "c-system");
  };

  return { toggle, setTab, close, render, isOpen, get tab() { return tab; } };
}

const SETTING_STORE = "acweb.set.";
function saveSetting(key: string, v: number | boolean) {
  try { localStorage.setItem(SETTING_STORE + key, JSON.stringify(v)); } catch { /* storage unavailable */ }
}
/** Apply every stored setting; call once the world is up. */
export function loadSettings(defs: SettingDef[]) {
  for (const s of defs) {
    try {
      const raw = localStorage.getItem(SETTING_STORE + s.key);
      if (raw !== null) s.set(JSON.parse(raw));
    } catch { /* ignore bad values */ }
  }
}

export type { WorldObject };
