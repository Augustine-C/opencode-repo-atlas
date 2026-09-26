import { mkdir, rename, stat } from "node:fs/promises"
import { dirname } from "node:path"

export interface RepoEntry {
  name: string
  description?: string
  /** host -> absolute local checkout paths */
  checkouts: Record<string, string[]>
}

export interface Group {
  id: string
  name: string
  members: string[]
}

export interface Edge {
  a: string
  b: string
  note?: string
}

export interface Registry {
  version: 1
  repos: Record<string, RepoEntry>
  groups: Group[]
  edges: Edge[]
}

export function emptyRegistry(): Registry {
  return { version: 1, repos: {}, groups: [], edges: [] }
}

export function isRepoKey(value: unknown): value is string {
  return typeof value === "string" && value.includes("/") && !value.includes(" ")
}

export function groupId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug || `group-${Date.now().toString(36)}`
}

/**
 * Effective neighbors of a repo: members of every group containing it plus both
 * endpoints of every edge touching it. Each neighbor carries the reasons it is linked.
 */
export function neighborsOf(reg: Registry, key: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const push = (neighbor: string, via: string) => {
    if (neighbor === key) return
    const reasons = out.get(neighbor) ?? []
    if (!reasons.includes(via)) reasons.push(via)
    out.set(neighbor, reasons)
  }
  for (const group of reg.groups) {
    if (!group.members.includes(key)) continue
    for (const member of group.members) push(member, `group:${group.name || group.id}`)
  }
  for (const edge of reg.edges) {
    if (edge.a === key) push(edge.b, `edge:${edge.note || edge.b}`)
    if (edge.b === key) push(edge.a, `edge:${edge.note || edge.a}`)
  }
  return out
}

/** Remove a repo and prune it from every group and edge. */
export function removeRepo(reg: Registry, key: string): void {
  delete reg.repos[key]
  reg.groups = reg.groups
    .map((group) => ({ ...group, members: group.members.filter((member) => member !== key) }))
    .filter((group) => group.members.length > 0)
  reg.edges = reg.edges.filter((edge) => edge.a !== key && edge.b !== key)
}

/** Read fresh from disk, apply the mutation, and save atomically when it reports a change. */
export type Mutation<T> = (reg: Registry) => T | Promise<T>

export class RegistryStore {
  readonly #path: string
  #cache: Registry = emptyRegistry()
  #stamp = { mtimeMs: -1, size: -1 }

  constructor(path: string) {
    this.#path = path
  }

  get path(): string {
    return this.#path
  }

  /** In-memory view of the last load/save; safe to read synchronously inside transforms. */
  get current(): Registry {
    return this.#cache
  }

  async load(): Promise<Registry> {
    const file = Bun.file(this.#path)
    if (!(await file.exists())) {
      this.#cache = emptyRegistry()
      this.#stamp = { mtimeMs: -1, size: -1 }
      return this.#cache
    }
    let value: unknown
    try {
      value = await file.json()
    } catch (error) {
      const backup = `${this.#path}.corrupt-${Date.now()}`
      await rename(this.#path, backup).catch(() => {})
      console.error(`[related-repos] registry unreadable, moved to ${backup}:`, error)
      this.#cache = emptyRegistry()
      return this.#cache
    }
    this.#cache = decode(value)
    await this.#refreshStamp()
    return this.#cache
  }

  async save(reg: Registry): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true })
    const tmp = `${this.#path}.tmp-${process.pid}-${Date.now()}`
    await Bun.write(tmp, `${JSON.stringify(reg, null, 2)}\n`)
    await rename(tmp, this.#path)
    this.#cache = reg
    await this.#refreshStamp()
  }

  async update<T>(mutate: Mutation<T>): Promise<T> {
    const reg = await this.load()
    const result = await mutate(reg)
    if (result === false) return result
    await this.save(reg)
    return result
  }

  /** True when the file on disk differs from the state captured by the last load/save. */
  async changed(): Promise<boolean> {
    try {
      const info = await stat(this.#path)
      return info.mtimeMs !== this.#stamp.mtimeMs || info.size !== this.#stamp.size
    } catch {
      return this.#stamp.mtimeMs !== -1
    }
  }

  async #refreshStamp(): Promise<void> {
    try {
      const info = await stat(this.#path)
      this.#stamp = { mtimeMs: info.mtimeMs, size: info.size }
    } catch {
      this.#stamp = { mtimeMs: -1, size: -1 }
    }
  }
}

function decode(value: unknown): Registry {
  const reg = emptyRegistry()
  if (!value || typeof value !== "object") return reg
  const source = value as Record<string, unknown>
  if (Array.isArray(source.groups)) reg.groups = source.groups.filter(isGroup)
  if (Array.isArray(source.edges)) reg.edges = source.edges.filter(isEdge)
  if (source.repos && typeof source.repos === "object") {
    for (const [key, entry] of Object.entries(source.repos as Record<string, unknown>)) {
      if (!isRepoEntry(entry)) continue
      reg.repos[key] = entry
    }
  }
  return reg
}

function isRepoEntry(value: unknown): value is RepoEntry {
  if (!value || typeof value !== "object") return false
  const entry = value as Record<string, unknown>
  if (typeof entry.name !== "string") return false
  if (entry.description !== undefined && typeof entry.description !== "string") return false
  if (!entry.checkouts || typeof entry.checkouts !== "object") return false
  return true
}

function isGroup(value: unknown): value is Group {
  if (!value || typeof value !== "object") return false
  const group = value as Record<string, unknown>
  return (
    typeof group.id === "string" &&
    typeof group.name === "string" &&
    Array.isArray(group.members) &&
    group.members.every((member) => typeof member === "string")
  )
}

function isEdge(value: unknown): value is Edge {
  if (!value || typeof value !== "object") return false
  const edge = value as Record<string, unknown>
  if (typeof edge.a !== "string" || typeof edge.b !== "string") return false
  return edge.note === undefined || typeof edge.note === "string"
}
