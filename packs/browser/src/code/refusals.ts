// Written for the Browser pack. The texts a host answers a cell with when it refuses something the contract says it must refuse, kept in one place so the host, prompt.md and the tests say the same thing.

/**
 * What a host answers, as the `code_needs_consent` refusal (contract rule 6), when a cell's `browser.open` asks for a saved profile. The gate stops that API route; it does not stop a cell, which runs as the user with
 * full Node and can read a profile's files, and the text says so rather than imply a boundary. It names the one route a saved profile has for the model (`profileTool`, which needs the person's approval) and what code can do
 * meanwhile, with the tools a code space has; prompt.md says the same in fewer words.
 */
export function savedProfileRefusal(profile: string): string {
  const name = JSON.stringify(profile);
  return `a saved profile (${name}) is not opened from a code cell. Instead of code, call browser_run({ profileTool: { kind: "open", profile: ${name} } }): it is refused until the person approves this profile for this chat (they see it in the Browser profile menu), then profileTool drives it. `
    + `That approval covers the browser tools; a code cell runs as the user with full Node, so it is not a limit on code. The person can also open it themselves: browser_view({ profile: ${name} }). `
    + "Meanwhile code can use a throwaway browser (leave profile out) or, if the user has allowed it, their own Chrome (app: { relay: true }).";
}
