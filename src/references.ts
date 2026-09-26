import { existsSync } from "node:fs"
import { hostname } from "node:os"
import { join, resolve } from "node:path"
import type { Registry, RepoEntry } from "./registry"
import { neighborsOf } from "./registry"
import { repoNameFromKey } from "./identity"
import { uniqueAlias } from "./alias"

interface Registration {
  dispose(): Promise<void>
}

interface ReferenceEditor {
  add(name: string, source: { type: "local"; path: string; description?: string; hidden?: boolean }): void
  list(): readonly (readonly [string, unknown])[]
}

interface ReferenceContext {
  reference: {
    transform(callback: (editor: ReferenceEditor) => void): Promise<Registration>
    reload(): Promise<void>
  }
}

export interface ReferencesInput {
  ctx: ReferenceContext
  store: { current: Registry }
  selfKey: string | undefined
  roots?: readonly string[]
}

/**
 * Injects one local reference per effectively-related repo that has a known local
 * checkout on this host. The transform closure reads the current registry on every
 * replay, so `reference.reload()` after a registry change is enough to add and
 * remove references without re-registering.
 */
export class References {
  readonly #ctx: ReferenceContext
  readonly #store: ReferencesInput["store"]
  readonly #selfKey: string | undefined
  readonly #roots: readonly string[]
  #registration: Registration | undefined
  /** Neighbor keys skipped during the last apply because no local checkout was found. */
  missing: string[] = []

  constructor(input: ReferencesInput) {
    this.#ctx = input.ctx
    this.#store = input.store
    this.#selfKey = input.selfKey
    this.#roots = input.roots ?? []
  }

  async start(): Promise<void> {
    this.#registration = await this.#ctx.reference.transform((editor) => this.#apply(editor))
  }

  async refresh(): Promise<void> {
    await this.#ctx.reference.reload()
  }

  async stop(): Promise<void> {
    await this.#registration?.dispose()
    this.#registration = undefined
  }

  #apply(editor: ReferenceEditor): void {
    this.missing = []
    if (!this.#selfKey) return
    const reg = this.#store.current
    const used = new Set(editor.list().map(([name]) => name))
    const host = hostname()
    for (const [key] of neighborsOf(reg, this.#selfKey)) {
      const repo = reg.repos[key]
      if (!repo) continue
      const path = this.#resolveCheckout(repo, host)
      if (!path) {
        this.missing.push(key)
        continue
      }
      editor.add(uniqueAlias(repo.name || repoNameFromKey(key), used), {
        type: "local",
        path,
        description: describe(repo),
      })
    }
  }

  #resolveCheckout(repo: RepoEntry, host: string): string | undefined {
    for (const candidate of repo.checkouts[host] ?? []) {
      if (existsSync(candidate)) return resolve(candidate)
    }
    for (const root of this.#roots) {
      const guess = join(root, repo.name)
      if (existsSync(guess)) return resolve(guess)
    }
    return undefined
  }
}

function describe(repo: RepoEntry): string {
  return repo.description ? `Related repository ${repo.name}: ${repo.description}` : `Related repository ${repo.name}`
}
