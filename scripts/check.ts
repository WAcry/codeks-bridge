import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" });
const privateFile = process.env.PRIVATE_TERMS_FILE ?? join(homedir(), ".config", "codeks", "private-terms");
const patterns = existsSync(privateFile)
  ? readFileSync(privateFile, "utf8").split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#")).map(line => new RegExp(line, "i"))
  : [];
const sources = new Map<string, string>();
for (const file of new Set(git("ls-files", "-co", "--exclude-standard", "-z").split("\0").filter(Boolean))) {
  if (existsSync(file) && lstatSync(file).isFile()) sources.set(file, readFileSync(file, "utf8"));
}
sources.set("branch", git("branch", "--show-current"));
sources.set("commit metadata", git("log", "--format=%an <%ae>%n%cn <%ce>%n%B"));
let failures = 0;
for (const [name, content] of sources) {
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (patterns.some(pattern => pattern.test(line))) {
      // Report locations only, so a failed check never prints private data.
      process.stderr.write(`${name}:${index + 1}: private term matched\n`);
      failures++;
    }
  }
}
const lock = sources.get("package-lock.json");
if (lock) {
  const packages = JSON.parse(lock).packages ?? {};
  for (const [name, metadata] of Object.entries(packages) as [string, any][]) {
    if (metadata.resolved && !metadata.resolved.startsWith("https://registry.npmjs.org/")) {
      process.stderr.write(`${name}: package resolution must use the public npm registry\n`);
      failures++;
    }
  }
}
if (failures) process.exitCode = 1;
else process.stdout.write(`Checked ${sources.size} sources${patterns.length ? " with private terms" : " (no local private-terms file)"}.\n`);
