export interface RepoIdentity {
  readonly key: string
  readonly name: string
}

export async function gitRemote(directory: string): Promise<string | undefined> {
  const proc = Bun.spawn(["git", "-C", directory, "remote", "get-url", "origin"], {
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  })
  const exit = await proc.exited
  if (exit !== 0) return undefined
  const out = await new Response(proc.stdout).text()
  const remote = out.trim()
  return remote.length > 0 ? remote : undefined
}

/**
 * Normalize any accepted remote form into a stable identity key:
 * lowercase host + lowercase repo path, credentials, ports and .git suffix dropped.
 *
 * Accepted: git@host:path, ssh://, https://, and bare host/path strings.
 * Local paths and file:// remotes are rejected (identity is repo-based, not machine-based).
 */
export function normalizeRemote(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  let candidate = trimmed
  // scp-like shorthand git@host:path/repo.git — require a slash in the path to
  // avoid misreading git@host:port forms, which git itself does not support.
  const scp = /^([^@/:]+)@([^:/]+):(.+\/.+)$/.exec(trimmed)
  if (scp && !trimmed.includes("://")) candidate = `ssh://${scp[1]}@${scp[2]}/${scp[3]}`
  if (candidate.startsWith("file://")) return undefined
  // local filesystem remotes carry no portable identity
  if (candidate.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(candidate)) return undefined
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) ? candidate : `https://${candidate}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return undefined
  }
  const host = url.hostname.toLowerCase()
  if (host.length === 0) return undefined
  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    pathname = url.pathname
  }
  pathname = pathname.replace(/\.git\/?$/i, "").replace(/\/+$/, "")
  if (pathname.length === 0 || pathname === "/") return undefined
  return `${host}${pathname.toLowerCase()}`
}

export function repoNameFromKey(key: string): string {
  const segments = key.split("/")
  const last = segments[segments.length - 1]
  return last && last.length > 0 ? last : key
}

export async function identify(directory: string): Promise<RepoIdentity | undefined> {
  const remote = await gitRemote(directory)
  if (!remote) return undefined
  const key = normalizeRemote(remote)
  if (!key) return undefined
  return { key, name: repoNameFromKey(key) }
}
