/** Build the standalone launcher for every supported target into dist/ (deno task release). */
const targets = ["aarch64-apple-darwin", "x86_64-apple-darwin", "x86_64-pc-windows-msvc", "x86_64-unknown-linux-gnu"];
const flags = ["--unstable-net", "--allow-read", "--allow-net", "--allow-env", "--allow-run", "--allow-write=captures.log", "--include", "web/"];
for (const t of targets) {
  const out = `dist/acweb-${t}${t.includes("windows") ? ".exe" : ""}`;
  console.log(`compiling ${out}`);
  const r = await new Deno.Command(Deno.execPath(), { args: ["compile", ...flags, "--target", t, "--output", out, "src/tools/launcher.ts"], stdout: "inherit", stderr: "inherit" }).output();
  if (!r.success) { console.error(`failed: ${t}`); Deno.exit(1); }
}
console.log("done");
