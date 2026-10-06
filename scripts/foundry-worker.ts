import { createFoundryApp } from "../server/foundry/app";
process.env.JEVBOX_PROFILE = "foundry-iq";
const runtime = await createFoundryApp({
  origin: process.env.APP_ORIGIN ?? "http://localhost:4310", workers: true,
});
if (!runtime.activated) {
  console.error("Foundry worker activation is blocked; no legacy work or cloud calls started.");
  await runtime.close();
  process.exitCode = 1;
} else {
  console.log("Native Foundry workers are ready");
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => { void runtime.close().then(() => process.exit(0)); });
}
