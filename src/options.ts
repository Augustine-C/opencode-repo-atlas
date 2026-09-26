import { expandHome, defaultRegistryPath } from "./paths"

export interface Options {
  readonly port: number
  readonly registryPath: string
  /** Convention roots used to locate a sibling checkout by repo name when the registry has none. */
  readonly roots: readonly string[]
}

export const DEFAULT_PORT = 4579

export function parseOptions(raw: Readonly<Record<string, unknown>> | undefined): Options {
  const port =
    typeof raw?.port === "number" && Number.isInteger(raw.port) && raw.port > 0 && raw.port < 65536
      ? raw.port
      : DEFAULT_PORT
  const registryPath =
    typeof raw?.registryPath === "string" && raw.registryPath.trim().length > 0
      ? expandHome(raw.registryPath.trim())
      : defaultRegistryPath()
  const roots = Array.isArray(raw?.roots)
    ? raw.roots
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        .map((entry) => expandHome(entry.trim()))
    : []
  return { port, registryPath, roots }
}
