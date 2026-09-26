import { hostname } from "node:os"
import { resolve } from "node:path"
import { Plugin } from "@opencode/plugin"
import { identify, type RepoIdentity } from "./identity"
import { parseOptions } from "./options"
import { RegistryStore } from "./registry"
import { References } from "./references"

export default Plugin.define({
  id: "related-repos",
  async setup(ctx) {
    const options = parseOptions(ctx.options as Record<string, unknown> | undefined)
    const store = new RegistryStore(options.registryPath)
    await store.load()

    const identity = await identify(ctx.location.directory)
    if (identity) await registerSelf(store, identity, ctx.location.directory)

    const references = new References({
      ctx,
      store,
      selfKey: identity?.key,
      roots: options.roots,
    })
    await references.start()

    const watcher = startWatcher(store, async () => {
      if (identity) await registerSelf(store, identity, ctx.location.directory)
      await references.refresh()
    })

    return () => {
      watcher.stop()
      void references.stop()
    }
  },
})

/** Record this machine's checkout path for a registered repo; no-op for unknown repos. */
async function registerSelf(store: RegistryStore, identity: RepoIdentity, directory: string): Promise<void> {
  const directory_ = resolve(directory)
  await store.update((reg) => {
    const repo = reg.repos[identity.key]
    if (!repo) return false
    const host = hostname()
    const existing = repo.checkouts[host] ?? []
    if (existing.includes(directory_)) return false
    repo.checkouts[host] = [...existing, directory_]
    return true
  })
}

/** Poll the registry file and re-apply references when another writer changed it. */
function startWatcher(store: RegistryStore, onChange: () => Promise<void>, intervalMs = 3000) {
  let stopped = false
  const timer = setInterval(() => {
    void (async () => {
      if (stopped) return
      try {
        if (!(await store.changed())) return
        await store.load()
        await onChange()
      } catch (error) {
        console.error("[related-repos] watcher tick failed:", error)
      }
    })()
  }, intervalMs)
  timer.unref?.()
  return {
    stop: () => {
      stopped = true
      clearInterval(timer)
    },
  }
}
