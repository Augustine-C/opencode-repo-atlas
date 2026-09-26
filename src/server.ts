import { existsSync, statSync } from "node:fs"
import { hostname } from "node:os"
import { join, resolve } from "node:path"
import { expandHome } from "./paths"
import { normalizeRemote, repoNameFromKey } from "./identity"
import {
  groupId,
  isRepoKey,
  neighborsOf,
  removeRepo,
  type Edge,
  type Group,
  type Registry,
  type RegistryStore,
} from "./registry"

export interface ServerInput {
  port: number
  store: RegistryStore
  /** Fired after every successful registry mutation in this process. */
  onChange: () => void
  self: {
    key: string | undefined
    directory: string | undefined
    /** Neighbor keys currently missing a local checkout on this host. */
    missing: () => readonly string[]
  }
}

export interface ServerHandle {
  port: number
  stop(): Promise<void>
}

const NO_STORE = { "cache-control": "no-store" }

export async function startServer(input: ServerInput): Promise<ServerHandle> {
  let server: Bun.Server<undefined>
  try {
    server = Bun.serve({ port: input.port, fetch: (req) => route(req, input) })
  } catch (error) {
    if (isAddrInUse(error)) {
      console.log(`[related-repos] port ${input.port} busy — web ui already served there`)
      return { port: input.port, stop: async () => {} }
    }
    throw error
  }
  const port = server.port ?? input.port
  console.log(`[related-repos] web ui: http://localhost:${port}`)
  return {
    port,
    stop: async () => {
      server.stop(true)
    },
  }
}

function isAddrInUse(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "EADDRINUSE"
}

async function route(req: Request, input: ServerInput): Promise<Response> {
  const url = new URL(req.url)
  const { pathname } = url
  const method = req.method
  try {
    if (pathname === "/" || pathname === "/index.html") return file("index.html")
    if (pathname === "/app.js") return file("app.js")
    if (pathname === "/style.css") return file("style.css")

    if (pathname === "/api/state" && method === "GET") return json(apiState(input))
    if (pathname === "/api/graph" && method === "GET") return json(graph(input.store.current))
    if (pathname === "/api/related" && method === "GET") {
      const key = queryKey(url)
      if (!input.store.current.repos[key]) return json({ error: `repo ${key} not found` }, 404)
      return json(related(input.store.current, key))
    }

    if (pathname === "/api/repos" && method === "POST") return json(await addRepo(input, await body(req)))
    if (pathname === "/api/repos" && method === "PATCH") return json(await patchRepo(input, url, await body(req)))
    if (pathname === "/api/repos" && method === "DELETE") return json(await deleteRepo(input, url))

    if (pathname === "/api/checkouts" && method === "POST") return json(await addCheckout(input, await body(req)))
    if (pathname === "/api/checkouts" && method === "DELETE") return json(await deleteCheckout(input, url))

    if (pathname === "/api/groups" && method === "POST") return json(await addGroup(input, await body(req)))
    if (pathname === "/api/groups" && method === "PATCH") return json(await patchGroup(input, url, await body(req)))
    if (pathname === "/api/groups" && method === "DELETE") return json(await deleteGroup(input, url))

    if (pathname === "/api/edges" && method === "POST") return json(await addEdge(input, await body(req)))
    if (pathname === "/api/edges" && method === "DELETE") return json(await deleteEdge(input, url))

    return json({ error: "not found" }, 404)
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status)
    console.error("[related-repos] request failed:", error)
    return json({ error: "internal error" }, 500)
  }
}

/** Run a registry mutation and notify listeners only after the save completed. */
async function mutate<T>(input: ServerInput, run: (reg: Registry) => T | Promise<T>): Promise<T> {
  const result = await input.store.update(run)
  input.onChange()
  return result
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...NO_STORE },
  })
}

function file(name: string): Response {
  return new Response(Bun.file(join(import.meta.dir, "..", "web", name)), { headers: NO_STORE })
}

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const value = await req.json()
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  } catch {
    throw new HttpError(400, "invalid JSON body")
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new HttpError(400, `${field} is required`)
  return value.trim()
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function keyParam(value: unknown, field: string): string {
  const key = typeof value === "string" ? value.trim() : ""
  if (!isRepoKey(key)) throw new HttpError(400, `valid ${field} is required`)
  return key
}

function queryKey(url: URL, field = "key"): string {
  return keyParam(url.searchParams.get(field), field)
}

function repoKey(payload: Record<string, unknown>): string {
  if (typeof payload.url === "string" && payload.url.trim().length > 0) {
    const normalized = normalizeRemote(payload.url)
    if (!normalized) throw new HttpError(400, "unrecognized remote URL")
    return normalized
  }
  return keyParam(payload.key, "key or url")
}

// --- handlers ---------------------------------------------------------------

function apiState(input: ServerInput) {
  const reg = input.store.current
  const selfKey = input.self.key
  return {
    host: hostname(),
    registry: reg,
    self: {
      key: selfKey,
      directory: input.self.directory,
      registered: selfKey ? reg.repos[selfKey] !== undefined : false,
      missing: input.self.missing(),
    },
  }
}

function related(reg: Registry, key: string) {
  const host = hostname()
  const neighbors = [...neighborsOf(reg, key)].map(([neighbor, via]) => {
    const repo = reg.repos[neighbor]
    return {
      key: neighbor,
      name: repo?.name ?? repoNameFromKey(neighbor),
      description: repo?.description,
      via,
      path: localCheckout(repo, host),
    }
  })
  return { key, neighbors }
}

function localCheckout(repo: { checkouts: Record<string, string[]> } | undefined, host: string): string | null {
  for (const candidate of repo?.checkouts[host] ?? []) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

async function addRepo(input: ServerInput, payload: Record<string, unknown>) {
  const key = repoKey(payload)
  const name = optionalString(payload.name) ?? repoNameFromKey(key)
  const description = optionalString(payload.description)
  return mutate(input, (reg) => {
    if (reg.repos[key]) throw new HttpError(409, `repo ${key} already exists`)
    reg.repos[key] = { name, ...(description ? { description } : {}), checkouts: {} }
    return { key, repo: reg.repos[key] }
  })
}

async function patchRepo(input: ServerInput, url: URL, payload: Record<string, unknown>) {
  const key = queryKey(url)
  const name = optionalString(payload.name)
  const description = optionalString(payload.description)
  return mutate(input, (reg) => {
    const repo = requireRepo(reg, key)
    if (name !== undefined) repo.name = name
    if (description !== undefined) repo.description = description
    return { key, repo }
  })
}

async function deleteRepo(input: ServerInput, url: URL) {
  const key = queryKey(url)
  return mutate(input, (reg) => {
    requireRepo(reg, key)
    removeRepo(reg, key)
    return { deleted: key }
  })
}

async function addCheckout(input: ServerInput, payload: Record<string, unknown>) {
  const key = keyParam(payload.key, "key")
  const path = resolve(expandHome(requiredString(payload.path, "path")))
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new HttpError(400, `not a directory: ${path}`)
  return mutate(input, (reg) => {
    const repo = requireRepo(reg, key)
    const host = hostname()
    const existing = repo.checkouts[host] ?? []
    if (existing.includes(path)) throw new HttpError(409, `checkout already registered for ${host}`)
    repo.checkouts[host] = [...existing, path]
    return { key, host, path }
  })
}

async function deleteCheckout(input: ServerInput, url: URL) {
  const key = queryKey(url)
  const path = requiredString(url.searchParams.get("path"), "path")
  return mutate(input, (reg) => {
    const repo = requireRepo(reg, key)
    const host = hostname()
    const existing = repo.checkouts[host] ?? []
    if (!existing.includes(path)) throw new HttpError(404, "checkout not found on this host")
    const remaining = existing.filter((entry) => entry !== path)
    if (remaining.length === 0) delete repo.checkouts[host]
    else repo.checkouts[host] = remaining
    return { key, host, path }
  })
}

async function addGroup(input: ServerInput, payload: Record<string, unknown>) {
  const name = requiredString(payload.name, "name")
  const members = memberList(payload.members)
  return mutate(input, (reg) => {
    assertKnownRepos(reg, members)
    const group: Group = { id: uniqueGroupId(reg, name), name, members }
    reg.groups.push(group)
    return { group }
  })
}

async function patchGroup(input: ServerInput, url: URL, payload: Record<string, unknown>) {
  const id = requiredString(url.searchParams.get("id"), "id")
  const name = optionalString(payload.name)
  const members = Array.isArray(payload.members) ? memberList(payload.members) : undefined
  return mutate(input, (reg) => {
    const group = reg.groups.find((entry) => entry.id === id)
    if (!group) throw new HttpError(404, `group ${id} not found`)
    if (members !== undefined) assertKnownRepos(reg, members)
    if (name !== undefined) group.name = name
    if (members !== undefined) group.members = members
    return { group }
  })
}

async function deleteGroup(input: ServerInput, url: URL) {
  const id = requiredString(url.searchParams.get("id"), "id")
  return mutate(input, (reg) => {
    const before = reg.groups.length
    reg.groups = reg.groups.filter((group) => group.id !== id)
    if (reg.groups.length === before) throw new HttpError(404, `group ${id} not found`)
    return { deleted: id }
  })
}

async function addEdge(input: ServerInput, payload: Record<string, unknown>) {
  const a = keyParam(payload.a, "a")
  const b = keyParam(payload.b, "b")
  if (a === b) throw new HttpError(400, "cannot relate a repo to itself")
  const note = optionalString(payload.note)
  return mutate(input, (reg) => {
    requireRepo(reg, a)
    requireRepo(reg, b)
    if (reg.edges.some((edge) => edge.a === a && edge.b === b)) throw new HttpError(409, "edge already exists")
    const edge: Edge = { a, b, ...(note ? { note } : {}) }
    reg.edges.push(edge)
    return { edge }
  })
}

async function deleteEdge(input: ServerInput, url: URL) {
  const index = Number(url.searchParams.get("index"))
  if (!Number.isInteger(index) || index < 0) throw new HttpError(400, "valid edge index is required")
  return mutate(input, (reg) => {
    if (index >= reg.edges.length) throw new HttpError(404, "edge not found")
    const removed = reg.edges.splice(index, 1)[0]
    if (!removed) throw new HttpError(404, "edge not found")
    return { deleted: removed }
  })
}

// --- helpers ---------------------------------------------------------------

function requireRepo(reg: Registry, key: string) {
  const repo = reg.repos[key]
  if (!repo) throw new HttpError(404, `repo ${key} not found`)
  return repo
}

function memberList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const members = value.filter((entry): entry is string => typeof entry === "string" && isRepoKey(entry))
  return [...new Set(members)]
}

function assertKnownRepos(reg: Registry, keys: readonly string[]) {
  for (const key of keys) requireRepo(reg, key)
}

function uniqueGroupId(reg: Registry, name: string): string {
  const base = groupId(name)
  let id = base
  let counter = 2
  while (reg.groups.some((group) => group.id === id)) id = `${base}-${counter++}`
  return id
}

/** Pairwise links with aggregated reasons, for the graph view. */
function graph(reg: Registry) {
  const pairs = new Map<string, { source: string; target: string; reasons: string[] }>()
  const push = (a: string, b: string, reason: string) => {
    if (a === b || !reg.repos[a] || !reg.repos[b]) return
    const [source, target] = a < b ? [a, b] : [b, a]
    const id = `${source}|${target}`
    const pair = pairs.get(id) ?? { source, target, reasons: [] }
    if (!pair.reasons.includes(reason)) pair.reasons.push(reason)
    pairs.set(id, pair)
  }
  for (const group of reg.groups) {
    for (let i = 0; i < group.members.length; i++) {
      for (let j = i + 1; j < group.members.length; j++) {
        push(group.members[i] as string, group.members[j] as string, group.name || group.id)
      }
    }
  }
  for (const edge of reg.edges) push(edge.a, edge.b, edge.note || "edge")

  return {
    nodes: Object.entries(reg.repos).map(([key, repo]) => ({
      key,
      name: repo.name,
      description: repo.description,
      groups: reg.groups.filter((group) => group.members.includes(key)).map((group) => group.id),
      hasLocalCheckout: localCheckout(repo, hostname()) !== null,
    })),
    links: [...pairs.values()].map((pair) => ({ ...pair, label: pair.reasons.join(", ") })),
    groups: reg.groups.map((group) => ({ id: group.id, name: group.name, members: group.members })),
  }
}
