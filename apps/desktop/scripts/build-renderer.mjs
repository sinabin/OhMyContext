import { fileURLToPath } from "node:url";

// Vite and the React transform must agree even when the parent shell contains
// a nonstandard NODE_ENV value such as `prd`.
process.env.NODE_ENV = "production";

const { build } = await import("vite");
await build({
  configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
});
