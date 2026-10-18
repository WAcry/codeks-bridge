import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  source: { type: "string" }, tag: { type: "string" }, model: { type: "string" }, output: { type: "string" },
} });
if (!values.source || !values.tag || !values.model || !values.output) {
  throw new Error("Usage: node scripts/import-catalog.ts --source PATH/models.json --tag TAG --model SLUG --output NEW_FILE.json");
}

const sourcePath = resolve(values.source);
const git = (...args: string[]) => execFileSync("git", ["-C", dirname(sourcePath), ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
const root = git("rev-parse", "--show-toplevel").trim();
const sourceRelative = relative(root, sourcePath).split("\\").join("/");
const commit = git("rev-parse", "--verify", `${values.tag}^{commit}`).trim();
const source = readFileSync(sourcePath, "utf8");
if (source !== git("show", `${commit}:${sourceRelative}`)) {
  throw new Error(`Source file does not match ${values.tag}; use an unchanged catalog from that tag`);
}
const models = JSON.parse(source).models;
if (!Array.isArray(models)) throw new Error("Source catalog must contain a models array");
const model = models.find((entry: any) => entry.slug === values.model);
if (!model) throw new Error(`Source catalog has no model: ${values.model}`);

const candidate = {
  source: {
    repository: "https://github.com/openai/codex", tag: values.tag,
    commit, path: sourceRelative, model: values.model,
  },
  adjustments: [],
  adapter: "gpt-responses",
  model,
};
writeFileSync(resolve(values.output), `${JSON.stringify(candidate, null, 2)}\n`, { flag: "wx" });
console.log(`Wrote candidate for ${values.model} to ${values.output}. Review it before replacing a curated entry.`);
