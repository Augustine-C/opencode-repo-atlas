// Smoke-test host: starts the web server against a temp registry, no OpenCode needed.
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RegistryStore } from "../src/registry"
import { startServer } from "../src/server"

const dir = mkdtempSync(join(tmpdir(), "related-smoke-"))
const store = new RegistryStore(join(dir, "registry.json"))
await store.load()

const handle = await startServer({
  port: Number(process.env.SMOKE_PORT ?? 4579),
  store,
  self: { key: undefined, directory: undefined, missing: () => [] },
  onChange: () => {},
})
console.log("READY", handle.port)
