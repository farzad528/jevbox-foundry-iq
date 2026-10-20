import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { boundsSchema, stageSchema } from "../shared/personal-file";
import { z } from "zod";
import { PersonalStore } from "../server/personal-file/store";
import { loadPersonalConfig } from "../server/personal-file/app";
import { cliCredential } from "../server/personal-file/native";
import { readPersonalPreflight } from "../server/personal-file/preflight";

export async function personalOperator(args: string[], env: NodeJS.ProcessEnv = process.env) {
  const [action, value, detail] = args;
  const directory = resolve(env.PERSONAL_FILE_DATA_DIR ?? ".data/personal-file");
  const config = loadPersonalConfig(env.PERSONAL_FILE_CONFIG);
  if (!config) throw new Error("A verified private personal runtime configuration is required");
  const store = new PersonalStore(directory);
  try {
    if (action === "preflight") {
      const evidence = await readPersonalPreflight(config, cliCredential(config));
      store.recordPreflight(config, evidence);
      writeFileSync(join(directory, `preflight-${Date.now()}.private.json`), JSON.stringify(evidence, null, 2), { flag: "wx", mode: 0o600 });
      console.log("Exact resource/model/role metadata readback retained privately. No content query, write or inference occurred; current pricing and remaining budget still require review.");
    } else if (action === "plan" && value && detail) {
      const stage = stageSchema.parse(value), bounds = boundsSchema.parse(JSON.parse(readFileSync(resolve(detail), "utf8")));
      const plan = store.makePlan(stage, config, bounds), file = join(directory, `${plan.id}.personal-plan.local.json`);
      writeFileSync(file, JSON.stringify(plan, null, 2), { flag: "wx", mode: 0o600 });
      console.log(JSON.stringify({ pendingOperation: plan.id, stage, mode: plan.mode, files: plan.manifest.map(({ path, size }) => ({ path, size })),
        source: config.sourceName, kb: config.kbName, bounds, expiresAt: plan.expiresAt,
        privateEnvelope: file, approved: false, notice: "Review the exact targets/data/cost/security disclosures in chat. Planning is not execution approval." }, null, 2));
    } else if (action === "approve" && value && detail) {
      store.approve(value, detail);
      console.log("Exact operation approved locally with the supplied human approval reference. No Azure request was made. Run only that operation from the local app.");
    } else throw new Error("Usage: personal:operator preflight, plan <ingest|kb|chat|inspect> <private-bounds.json>, or approve <operation-id> <explicit-human-approval-reference>");
  } finally { store.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  personalOperator(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof z.ZodError ? `Invalid private fields: ${error.issues.map((issue) => issue.path.join(".")).join(", ")}`
      : error instanceof Error ? error.message : "Operator request failed");
    console.error("No Azure mutation or inference was authorized by this command."); process.exitCode = 2;
  });
