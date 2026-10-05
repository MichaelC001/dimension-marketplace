# Driving the browser with code

For a session whose tool list has `browser_run`. If you cannot see it, this file does not apply to you: read [steps.md](steps.md) instead. The rest of what a browser is (profiles, the Browser View, take over, reading a public page) is in [SKILL.md](../SKILL.md); this file adds the code tool's own side of it. The tool's own text is the reference for the `browser` object, the tab helpers and the 25 s rule; what follows is what that text does not say.

## The browser a cell opens

`await browser.open({ name, url })` opens (or reuses) this session's headless browser, a throwaway: nothing is saved, and it closes after 30 minutes with no calls (`persist: true` keeps it). The Browser View shows it when the user opens the View in this session, and the user can watch and drive it there. Close it with `browser.close({ all: true })`.

## What a cell does not do for you

- **A saved profile is not opened from a cell** (`browser.open({ profile })` is refused with `code_needs_consent`). Use `browser_run({ profileTool: { kind: "open", profile: "work" } })` instead of `code`: it is refused until the person approves that profile for this chat in the Browser profile menu (the refusal leaves a pending request; retry once they allow), then `profileTool` drives it (`state`, `snapshot`, `screenshot`, `inspect`, `act`, `close`). The approval covers those browser tools. A cell runs as the user with full Node, which the approval does not limit. The person can also open a profile themselves with `browser_view({ profile: "work" })`. Meanwhile a cell can use a throwaway browser (leave `profile` out).
- **A password field is refused**: `tab.type`, `tab.fill` and a text-typing `tab.press` do not type into one. Ask the user to type it in the Browser View, where they can drive this browser, then carry on from the page they leave. Anything you type lands in the session transcript, which is why.
- **A browser the user took over stops the cell** with `human_driving`. `tab.observe()` and `tab.url()` still read it; ask the user to hand it back before you act.
- **Memory is limited.** A cell's worker may hold `DIMENSION_BROWSER_CODE_MEMORY_MB` (1,536 MB by default). A `Buffer`, `ArrayBuffer` or typed array that would pass it throws `CellMemoryError` in the cell, which can catch it, and allocates nothing. A worker that holds more by another route is ended, the cell fails, and its variables are reset.

## Reading what the user sees

`await browser.active().observe()` reads the page the user is looking at or has just marked, with no name and no `browserId`; `browser.tabs()` lists every tab of the session. After an annotation, start there.
