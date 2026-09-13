/// <reference lib="deno.unstable" />
/**
 * WebSocket <-> UDP relay so the browser can speak the AC protocol.
 * Each WS message is [portOffset:u8][datagram]; portOffset 0 = server port,
 * 1 = server port + 1 (the ConnectResponse / S2C port). Inbound datagrams
 * are framed the same way.
 *
 *   deno task proxy [listenPort]
 *   ws://127.0.0.1:8001/?host=play.coldeve.ac&port=9000
 */
/** Start the WebSocket <-> UDP relay on a local port. */
export function startRelay(listenPort: number, quiet = false) {
  return Deno.serve({ port: listenPort, hostname: "127.0.0.1", onListen: quiet ? () => {} : undefined }, relayHandler);
}

async function resolve(host: string): Promise<string> {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return host;
  const a = await Deno.resolveDns(host, "A");
  if (!a.length) throw new Error(`cannot resolve ${host}`);
  return a[0];
}

async function relayHandler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (req.headers.get("upgrade") !== "websocket") return new Response("acweb udp relay", { status: 200 });
  const host = url.searchParams.get("host") ?? "127.0.0.1";
  const port = Number(url.searchParams.get("port") ?? 9000);
  let ip: string;
  try {
    ip = await resolve(host);
  } catch (e) {
    return new Response(`resolve failed: ${(e as Error).message}`, { status: 502 });
  }
  const { socket, response } = Deno.upgradeWebSocket(req);
  socket.binaryType = "arraybuffer";
  const udp = Deno.listenDatagram({ port: 0, transport: "udp", hostname: "0.0.0.0" });
  let closed = false;
  let rx = 0, tx = 0;
  console.log(`[relay] client -> ${host} (${ip}):${port}/${port + 1}`);

  (async () => {
    try {
      for await (const [data, addr] of udp) {
        if (closed) break;
        const from = addr as Deno.NetAddr;
        const offset = from.port === port + 1 ? 1 : 0;
        if (++rx <= 3) console.log(`[relay] <- ${from.hostname}:${from.port} ${data.length} bytes`);
        const framed = new Uint8Array(data.length + 1);
        framed[0] = offset;
        framed.set(data, 1);
        if (socket.readyState === WebSocket.OPEN) socket.send(framed);
      }
    } catch (e) {
      if (!closed) console.log("[relay] udp error", (e as Error).message);
    }
  })();

  socket.onmessage = async (ev) => {
    const msg = new Uint8Array(ev.data as ArrayBuffer);
    if (msg.length < 1) return;
    const offset = msg[0];
    if (++tx <= 3) console.log(`[relay] -> ${ip}:${port + offset} ${msg.length - 1} bytes`);
    try {
      await udp.send(msg.subarray(1), { transport: "udp", hostname: ip, port: port + offset });
    } catch (e) {
      console.log("[relay] send error", (e as Error).message);
    }
  };
  socket.onclose = () => {
    closed = true;
    try { udp.close(); } catch { /* ignore */ }
    console.log(`[relay] client closed (sent ${tx}, received ${rx} datagrams)`);
  };
  socket.onerror = () => socket.close();
  return response;
}

if (import.meta.main) startRelay(Number(Deno.args[0] ?? 8001));
