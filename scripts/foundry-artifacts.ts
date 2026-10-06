import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { buildNativeArtifacts } from "../server/foundry/setup-artifacts";

const [configPath, outputPath] = process.argv.slice(2);
if (!configPath || !outputPath)
  throw new Error("Usage: node --import tsx scripts/foundry-artifacts.ts <approved-config.json> <output-directory>. Offline generation only.");
const artifacts = buildNativeArtifacts(JSON.parse(await readFile(resolve(configPath), "utf8")));
await mkdir(resolve(outputPath), { recursive: true });
for (const [name, definition] of Object.entries(artifacts))
  await writeFile(resolve(outputPath, `${name}.json`), JSON.stringify(definition, null, 2) + "\n", { flag: "wx" });
console.log("Offline artifacts generated. No Azure request, deployment, upload or paid invocation was performed.");
