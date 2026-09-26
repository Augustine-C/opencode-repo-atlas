import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { emptyRegistry, neighborsOf, RegistryStore, removeRepo, type Registry } from "../src/registry"
import { sanitizeAlias, uniqueAlias } from "../src/alias"

function fixture(): Registry {
  return {
    version: 1,
    repos: {
      "github.com/acme/billing": { name: "billing", checkouts: {} },
      "github.com/acme/ledger": { name: "ledger", checkouts: {} },
      "github.com/acme/web": { name: "web", checkouts: {} },
      "github.com/acme/docs": { name: "docs", checkouts: {} },
    },
    groups: [{ id: "payments", name: "支付平台", members: ["github.com/acme/billing", "github.com/acme/ledger", "github.com/acme/web"] }],
    edges: [{ a: "github.com/acme/billing", b: "github.com/acme/docs", note: "API 契约" }],
  }
}

describe("neighborsOf", () => {
  test("union of group members and edge endpoints with reasons", () => {
    const neighbors = neighborsOf(fixture(), "github.com/acme/billing")
    expect([...neighbors.keys()].sort()).toEqual([
      "github.com/acme/docs",
      "github.com/acme/ledger",
      "github.com/acme/web",
    ])
    expect(neighbors.get("github.com/acme/ledger")).toEqual(["group:支付平台"])
    expect(neighbors.get("github.com/acme/docs")).toEqual(["edge:API 契约"])
  })

  test("excludes self from group", () => {
    const neighbors = neighborsOf(fixture(), "github.com/acme/ledger")
    expect(neighbors.has("github.com/acme/ledger")).toBe(false)
  })
})

describe("removeRepo", () => {
  test("prunes groups and edges", () => {
    const reg = fixture()
    removeRepo(reg, "github.com/acme/billing")
    expect(reg.repos["github.com/acme/billing"]).toBeUndefined()
    expect(reg.edges).toHaveLength(0)
    expect(reg.groups[0]?.members).toEqual(["github.com/acme/ledger", "github.com/acme/web"])
  })
})

describe("RegistryStore", () => {
  test("save, load and change detection round trip", async () => {
    const dir = await mkdtemp(join(tmpdir(), "repo-atlas-"))
    try {
      const store = new RegistryStore(join(dir, "nested", "registry.json"))
      await store.load()
      expect(store.current.groups).toHaveLength(0)

      await store.update((reg) => {
        reg.repos["github.com/acme/billing"] = { name: "billing", checkouts: {} }
        return true
      })
      expect(store.current.repos["github.com/acme/billing"]).toBeDefined()
      expect(await store.changed()).toBe(false)

      // external writer
      const other = new RegistryStore(store.path)
      await other.update((reg) => {
        reg.groups.push({ id: "x", name: "X", members: [] })
        return true
      })
      expect(await store.changed()).toBe(true)
      await store.load()
      expect(store.current.groups).toHaveLength(1)

      // no-op mutation does not save
      const before = await Bun.file(store.path).text()
      await store.update(() => false)
      expect(await Bun.file(store.path).text()).toBe(before)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("corrupt file is moved aside and registry resets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "repo-atlas-"))
    try {
      const path = join(dir, "registry.json")
      await Bun.write(path, "{not json")
      const store = new RegistryStore(path)
      await store.load()
      expect(store.current).toEqual(emptyRegistry())
      expect((await readdir(dir)).filter((name) => name.startsWith("registry.json.corrupt-"))).toHaveLength(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("alias", () => {
  test("sanitize replaces invalid characters", () => {
    expect(sanitizeAlias("acme/billing service")).toBe("acme-billing-service")
    expect(sanitizeAlias("a`b,c")).toBe("a-b-c")
    expect(sanitizeAlias("///")).toBe("repo")
  })

  test("uniqueAlias appends counters", () => {
    const used = new Set(["billing"])
    expect(uniqueAlias("billing", used)).toBe("billing-2")
    expect(uniqueAlias("billing", used)).toBe("billing-3")
    expect(used.has("billing-3")).toBe(true)
  })
})
