import { homedir } from "node:os"
import { join } from "node:path"

export function defaultRegistryPath(): string {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(dataHome, "opencode", "related-repos.json")
}

export function expandHome(input: string): string {
  if (input === "~") return homedir()
  if (input.startsWith("~/")) return join(homedir(), input.slice(2))
  return input
}
