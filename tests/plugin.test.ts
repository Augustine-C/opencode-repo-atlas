import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { hostname } from "node:os"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import plugin from "../src/index"

const HOST = hostname()

function scaffold(root: string) {
  const selfDir = join(root, "self")
  const neighborDir = join(root, "neighbor")
  const missingDir = join(root, "missing")
  for (const dir of [selfDir, neighborDir, missingDir]) mkdirSync(dir, { recursive: true })
  Bun.spawnSync(["git", "-C", selfDir, "init", "-q"])
  Bun.spawnSync(["git", "-C", selfDir, "remote", "add", "origin", "https://GitHub.com/acme/Self.git"])

  const registryPath = join(root, "registry.json")
  writeFileSync(
    registryPath,
    JSON.stringify({
      version: 1,
      repos: {
        "github.com/acme/self": { name: "self", checkouts: {} },
        "github.com/acme/neighbor": { name: "neighbor", description: "邻居服务", checkouts: { [HOST]: [neighborDir] } },
        "github.com/acme/remote-only": { name: "remote-only", checkouts: {} },
      },
      groups: [
        { id: "platform", name: "platform", members: ["github.com/acme/self", "github.com/acme/neighbor"] },
      ],
      edges: [{ a: "github.com/acme/self", b: "github.com/acme/remote-only", note: "契约" }],
    }),
  )
  return { selfDir, neighborDir, registryPath }
}

describe("plugin setup", () => {
  test("injects references for related repos and serves the api", async () => {
    const root = mkdtempSync(join(tmpdir(), "repo-atlas-e2e-"))
    try {
      const { selfDir, neighborDir, registryPath } = scaffold(root)

      const added = new Map()
      let reloads = 0
      const ctx = {
        location: { directory: selfDir },
        options: { registryPath, port: 45987 },
        reference: {
          transform: async (callback: (editor: never) => void) => {
            callback({
              add: (name: string, source: unknown) => added.set(name, source),
              remove: () => {},
              list: () => [...added],
              get: (name: string) => added.get(name),
            } as never)
            return { dispose: async () => {} }
          },
          reload: async () => {
            reloads++
          },
        },
      }

      const cleanup = await (plugin.setup as (input: unknown) => Promise<() => Promise<void>>)(ctx)

      // self checkout was registered for the identified repo
      const reg = await Bun.file(registryPath).json()
      expect(reg.repos["github.com/acme/self"].checkouts[HOST]).toEqual([resolve(selfDir)])

      // one reference per related repo with a local checkout; remote-only is skipped
      expect([...added.keys()]).toEqual(["neighbor"])
      expect(added.get("neighbor")).toEqual({
        type: "local",
        path: resolve(neighborDir),
        description: "Related repository neighbor: 邻居服务",
      })
      expect(reloads).toBe(0)

      // api reports the identified self and its registration state
      const state = await fetch("http://localhost:45987/api/state").then((r) => r.json())
      expect(state.self.key).toBe("github.com/acme/self")
      expect(state.self.registered).toBe(true)
      expect(state.self.missing).toEqual(["github.com/acme/remote-only"])

      const related = await fetch("http://localhost:45987/api/related?key=github.com/acme/self").then((r) => r.json())
      expect(related.neighbors.map((n: { key: string }) => n.key).sort()).toEqual([
        "github.com/acme/neighbor",
        "github.com/acme/remote-only",
      ])
      const neighbor = related.neighbors.find((n: { key: string }) => n.key === "github.com/acme/neighbor")
      expect(neighbor.via).toEqual(["group:platform"])
      expect(neighbor.path).toBe(resolve(neighborDir))

      await cleanup()
      await expect(fetch("http://localhost:45987/api/state")).rejects.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("idles cleanly outside a git repo but still serves the api", async () => {
    const root = mkdtempSync(join(tmpdir(), "repo-atlas-e2e-"))
    try {
      const plainDir = join(root, "plain")
      mkdirSync(plainDir)
      const registryPath = join(root, "registry.json")
      const added: unknown[] = []
      const ctx = {
        location: { directory: plainDir },
        options: { registryPath, port: 45988 },
        reference: {
          transform: async (callback: (editor: { add: () => void }) => void) => {
            callback({ add: () => added.push(1) } as never)
            return { dispose: async () => {} }
          },
          reload: async () => {},
        },
      }
      const cleanup = await (plugin.setup as (input: unknown) => Promise<() => Promise<void>>)(ctx)
      expect(added).toHaveLength(0)
      const state = await fetch("http://localhost:45988/api/state").then((r) => r.json())
      expect(state.self.key).toBeUndefined()
      await cleanup()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
