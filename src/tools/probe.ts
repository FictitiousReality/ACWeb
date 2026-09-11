/// <reference lib="deno.unstable" />
/**
 * Probe an AC server: send a LoginRequest with an empty password (servers
 * reject it without creating an account) and print what comes back.
 *
 *   deno task probe play.coldeve.ac 9000
 */
import { NetSession, type Transport } from "../net/session.ts";

const host = Deno.args[0] ?? "play.coldeve.ac";
const port = Number(Deno.args[1] ?? 9000);
const ip = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host : (await Deno.resolveDns(host, "A"))[0];
console.log(`probing ${host} (${ip}):${port}`);

const udp = Deno.listenDatagram({ port: 0, transport: "udp", hostname: "0.0.0.0" });
const transport: Transport = {
  send(offset, data) {
    udp.send(data, { transport: "udp", hostname: ip, port: port + offset }).catch((e) => console.log("send error", e.message));
  },
  close() { try { udp.close(); } catch { /* */ } },
};
const session = new NetSession(transport, {
  onLog: (l) => console.log("  " + l),
  onState: (s, d) => console.log(`state: ${s} ${d ?? ""}`),
  onMessage: (m) => console.log(`  message opcode 0x${m.opcode.toString(16)} (${m.data.length} bytes)`),
});
session.debug = true;
session.login("acweb-probe", "");
setTimeout(() => { console.log("done"); session.close(); Deno.exit(0); }, 6000);
for await (const [data, addr] of udp) {
  const a = addr as Deno.NetAddr;
  session.receive(a.port === port + 1 ? 1 : 0, data);
}
