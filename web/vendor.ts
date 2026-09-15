/**
 * Vendor window: what the vendor sells (buy with a quantity per item) and what it will buy
 * from you (tick items to sell). Prices use the vendor's rates exactly as the server does; the
 * server has the final say and refusals come back as a UseDone error.
 */
import type { GameClient, VendorInfo, WorldObject } from "../src/net/client.ts";
import { vendorBuyPrice, vendorSellPrice } from "../src/net/messages.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
/** walk this far from the vendor and the window closes */
const CLOSE_DISTANCE = 8;

export interface VendorDeps {
  client(): GameClient | null;
  icon(textureId: number): Promise<string | null>;
  log(line: string, cls?: string): void;
  /** metres from the player to an object, or null if unknown */
  distanceTo(guid: number): number | null;
}

export function createVendorWindow(deps: VendorDeps) {
  const root = $("vendor");
  let vendor: VendorInfo | null = null;
  let tab: "buy" | "sell" = "buy";
  const cart = new Map<number, number>();  // vendor item guid -> quantity
  const selling = new Set<number>();      // our item guids
  let pending = false;

  const coins = (c: GameClient) => c.properties.int.get(20) ?? 0; // PropertyInt CoinValue
  const currencyName = () => vendor?.altCurrency ? (vendor.altCurrencyName || "tokens") : "pyreals";
  const money = (c: GameClient) => vendor?.altCurrency ? vendor.altCurrencyCount : coins(c);

  /** items of ours the vendor would take (ACE Player.VerifySellItems): the kinds it deals in, worth
   *  something, not worn, and any pack must be empty. The server still has the last word. */
  function sellable(c: GameClient): WorldObject[] {
    if (!vendor) return [];
    const holdsSomething = (guid: number) => [...c.objects.values()].some((o) => o.container === guid);
    return c.inventory().filter((o) =>
      !o.wielder && (o.itemType & vendor!.itemTypes) !== 0 && o.value > 0 &&
      !((o.itemType & 0x200) !== 0 && holdsSomething(o.guid))
    );
  }

  function open(v: VendorInfo) {
    const same = vendor?.guid === v.guid && root.classList.contains("show");
    vendor = v;
    // the server re-sends the list after each transaction; keep the player's tab and choices in that case
    if (!same) { cart.clear(); selling.clear(); pending = false; tab = "buy"; }
    else for (const guid of [...cart.keys()]) if (!v.items.some((i) => i.guid === guid)) cart.delete(guid);
    root.classList.add("show");
    render();
  }
  function close() {
    root.classList.remove("show");
    vendor = null;
  }

  function row(iconId: number, name: string, price: number, control: HTMLElement, note = ""): HTMLElement {
    const el = document.createElement("div");
    el.className = "vrow";
    const img = document.createElement("img");
    img.alt = "";
    deps.icon(iconId).then((u) => { if (u) img.src = u; });
    const label = document.createElement("span");
    label.className = "vname";
    label.textContent = name;
    if (note) label.title = note;
    const cost = document.createElement("span");
    cost.className = "vprice";
    cost.textContent = price.toLocaleString();
    el.append(img, label, cost, control);
    return el;
  }

  function render() {
    const c = deps.client();
    if (!vendor || !c) return;
    const name = c.objects.get(vendor.guid)?.name ?? "Vendor";
    $("vendorName").textContent = name;
    $("vendorCoins").textContent = `${money(c).toLocaleString()} ${currencyName()}`;
    for (const b of root.querySelectorAll<HTMLButtonElement>("#vendorTabs button")) b.classList.toggle("active", b.dataset.vtab === tab);
    const list = $("vendorList");
    list.innerHTML = "";
    if (tab === "buy") {
      if (!vendor.items.length) list.textContent = "This vendor has nothing for sale.";
      for (const it of vendor.items) {
        const each = vendorSellPrice(vendor, it.weenie.value ?? 0, it.weenie.itemType);
        const qty = document.createElement("input");
        qty.type = "number"; qty.min = "0"; qty.step = "1";
        if (it.stock > 0) qty.max = String(it.stock);
        qty.value = String(cart.get(it.guid) ?? 0);
        qty.oninput = () => {
          const n = Math.max(0, Math.floor(Number(qty.value) || 0));
          const capped = it.stock > 0 ? Math.min(n, it.stock) : n;
          if (String(capped) !== qty.value) qty.value = String(capped);
          if (capped) cart.set(it.guid, capped); else cart.delete(it.guid);
          renderTotal();
        };
        const stock = it.stock < 0 ? "" : `  (${it.stock} left)`;
        list.appendChild(row(it.weenie.icon, it.weenie.name + stock, each, qty));
      }
    } else {
      const items = sellable(c);
      if (!items.length) list.textContent = "You have nothing this vendor will buy.";
      for (const o of items) {
        const pay = vendorBuyPrice(vendor, o.value, o.itemType);
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = selling.has(o.guid);
        box.onchange = () => { if (box.checked) selling.add(o.guid); else selling.delete(o.guid); renderTotal(); };
        list.appendChild(row(o.icon, o.stackSize > 1 ? `${o.name} ×${o.stackSize}` : o.name, pay, box));
      }
    }
    renderTotal();
  }

  function renderTotal() {
    const c = deps.client();
    if (!vendor || !c) return;
    const go = $<HTMLButtonElement>("vendorGo");
    let total = 0;
    if (tab === "buy") {
      for (const [guid, n] of cart) {
        const it = vendor.items.find((x) => x.guid === guid);
        if (it) total += vendorSellPrice(vendor, it.weenie.value ?? 0, it.weenie.itemType) * n;
      }
      const afford = total <= money(c);
      $("vendorTotal").textContent = total ? `Total ${total.toLocaleString()} ${currencyName()}${afford ? "" : " (not enough)"}` : "Choose quantities to buy";
      go.textContent = "Buy";
      go.disabled = pending || !total || !afford;
    } else {
      for (const guid of selling) {
        const o = c.objects.get(guid);
        if (o) total += vendorBuyPrice(vendor, o.value, o.itemType);
      }
      $("vendorTotal").textContent = total ? `You receive ${total.toLocaleString()} pyreals` : "Tick items to sell";
      go.textContent = "Sell";
      go.disabled = pending || !total;
    }
  }

  function transact() {
    const c = deps.client();
    if (!vendor || !c || pending) return;
    if (tab === "buy") {
      const items = [...cart].map(([guid, amount]) => ({ guid, amount }));
      if (!items.length) return;
      c.buyItems(vendor.guid, items);
      deps.log(`buying ${items.reduce((n, i) => n + i.amount, 0)} item(s)...`, "c-system");
    } else {
      const items = [...selling].map((guid) => ({ guid, amount: c.objects.get(guid)?.stackSize ?? 1 }));
      if (!items.length) return;
      c.sellItems(vendor.guid, items);
      deps.log(`selling ${items.length} item(s)...`, "c-system");
    }
    pending = true;
    renderTotal();
  }

  for (const b of root.querySelectorAll<HTMLButtonElement>("#vendorTabs button")) b.onclick = () => { tab = b.dataset.vtab as "buy" | "sell"; render(); };
  $("vendorClose").onclick = close;
  $("vendorGo").onclick = transact;

  return {
    open, close, render,
    isOpen: () => root.classList.contains("show"),
    /** the server finished our buy or sell: clear what went through */
    onUseDone(code: number, text: string) {
      if (!pending) return;
      pending = false;
      if (code) deps.log(`the vendor refused: ${text}`, "c-error");
      else { if (tab === "buy") cart.clear(); else selling.clear(); }
      render();
    },
    /** close when the player walks away */
    tick() {
      if (!vendor) return;
      const d = deps.distanceTo(vendor.guid);
      if (d !== null && d > CLOSE_DISTANCE) close();
    },
  };
}
