import { describe, expect, test } from "bun:test"
import { normalizeRemote, repoNameFromKey } from "../src/identity"

describe("normalizeRemote", () => {
  const cases: Array<[string, string | undefined]> = [
    ["git@github.com:acme/Billing.git", "github.com/acme/billing"],
    ["https://github.com/acme/billing.git", "github.com/acme/billing"],
    ["https://user:token@github.com/Acme/Billing.git", "github.com/acme/billing"],
    ["ssh://git@gitlab.com:2222/acme/billing.git", "gitlab.com/acme/billing"],
    ["git@gitlab.com:group/sub/billing.git", "gitlab.com/group/sub/billing"],
    ["github.com/acme/billing", "github.com/acme/billing"],
    ["https://github.com/acme/billing/", "github.com/acme/billing"],
    ["git@github.com:acme/billing", "github.com/acme/billing"],
    ["", undefined],
    ["   ", undefined],
    ["/srv/git/billing.git", undefined],
    ["C:\\repo\\billing.git", undefined],
    ["file:///srv/git/billing.git", undefined],
  ]
  for (const [input, expected] of cases) {
    test(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      expect(normalizeRemote(input)).toBe(expected)
    })
  }
})

describe("repoNameFromKey", () => {
  test("last path segment", () => {
    expect(repoNameFromKey("github.com/acme/billing")).toBe("billing")
  })
})
