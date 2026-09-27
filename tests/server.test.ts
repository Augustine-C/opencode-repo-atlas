import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { hostname } from "node:os"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RegistryStore } from "../src/registry"
import { startServer, type ServerHandle } from "../src/server"

const HOST = hostname()

async function withServer<T>(port: number, fn: (port: number) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "repo-atlas-srv-"))
  try {
    const store = new RegistryStore(join(root, "registry.json"))
    await store.load()
    const handle: ServerHandle = await startServer({
      port,
      store,
      self: { key: undefined, directory: undefined, missing: () => [] },
      onChange: () => {},
    })
    try {
      return await fn(handle.port)
    } finally {
      await handle.stop()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function post(port: number, path: string, body: unknown) {
  const res = await fetch(`http://localhost:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

describe("POST /api/repos by local path", () => {
  test("detects git remote and registers the checkout", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "repo-atlas-billing-"))
    try {
      Bun.spawnSync(["git", "-C", repoDir, "init", "-q"])
      Bun.spawnSync(["git", "-C", repoDir, "remote", "add", "origin", "git@github.com:acme/Billing.git"])

      await withServer(45990, async (port) => {
        const added = await post(port, "/api/repos", { path: repoDir, description: "计费" })
        expect(added.status).toBe(200)
        expect(added.body.key).toBe("github.com/acme/billing")
        expect(added.body.repo.checkouts[HOST]).toEqual([repoDir])

        const duplicate = await post(port, "/api/repos", { path: repoDir })
        expect(duplicate.status).toBe(409)

        const noGit = await post(port, "/api/repos", { path: mkdtempSync(join(tmpdir(), "nogit-")) })
        expect(noGit.status).toBe(400)
        expect(noGit.body.error).toContain("no git remote")

        const badUrl = await post(port, "/api/repos", { url: "not-a-remote" })
        expect(badUrl.status).toBe(400)
        expect(badUrl.body.error).toBe("unrecognized remote URL")
      })
    } finally {
      rmSync(repoDir, { recursive: true, force: true })
    }
  })
})

describe("POST /api/edges", () => {
  test("rejects reversed duplicate edge", async () => {
    await withServer(45991, async (port) => {
      await post(port, "/api/repos", { key: "github.com/acme/a" })
      await post(port, "/api/repos", { key: "github.com/acme/b" })
      const first = await post(port, "/api/edges", { a: "github.com/acme/a", b: "github.com/acme/b" })
      expect(first.status).toBe(200)
      const reversed = await post(port, "/api/edges", { a: "github.com/acme/b", b: "github.com/acme/a" })
      expect(reversed.status).toBe(409)
    })
  })
})