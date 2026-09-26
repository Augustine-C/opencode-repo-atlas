const INVALID_ALIAS = /[/\\\s`,]/g

/** Turn a repo name into an alias OpenCode references accept. */
export function sanitizeAlias(name: string): string {
  const cleaned = name.replace(INVALID_ALIAS, "-").replace(/-+/g, "-").replace(/^-|-$/g, "")
  return cleaned || "repo"
}

/** First free alias derived from `name`, marking the returned alias as used. */
export function uniqueAlias(name: string, used: Set<string>): string {
  const base = sanitizeAlias(name)
  let alias = base
  let counter = 2
  while (used.has(alias)) alias = `${base}-${counter++}`
  used.add(alias)
  return alias
}
