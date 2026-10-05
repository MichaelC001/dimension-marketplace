# Simulator

An Android emulator in a View beside your conversation. You watch it as live
video and tap and type on it; your agent drives the **same device** through
typed tools. Built as a community plugin on standard MCP and MCP Apps: one
artifactory (the MCP server and its View), a dock component, a connector and a
skill. No new primitive, no host internals.

Desktop only. The pane declares `phone: "none"` ([doc 94 §4.7.1](../../../docs/design/94-dimension-mobile.md)):
on a phone the host draws its own "Open on your computer" card for it.

## What it does

- **Live for you, cheap for the agent.** The View decodes H.264 from the
  emulator with WebCodecs onto a canvas (30 fps by default). The agent gets
  `device_screenshot` (a PNG scaled to a token budget) and `device_ui_tree`
  (labelled views with pixel centres), and taps by *label* before coordinates.
- **Two lanes, never mixed.** *Control* is MCP: JSON request/response, one short
  text per call. *Frames* is a dedicated binary WebSocket on loopback that only
  the View uses. A burst of video never makes a tool call wait.
- **One shared encoder per device.** The encoder (scrcpy-server) runs only while
  a viewer is attached and stops a second after the last one leaves. A second
  viewer is handed the cached config and the key frame with the deltas since, so
  it shows a picture at once and nothing restarts.
- **Boots only what it owns.** The pack records which emulators *it* booted. It
  stops only those, caps them (`simulator.maxDevices`, default 2), stops an idle
  one after `simulator.idleMinutes` (default 15), and stops them all on exit. An
  emulator you started yourself is never stopped.
- **Honest when something is missing.** No adb, no emulator, no AVD, no scrcpy:
  each is its own state in the pane (and a line in `device_list`) with the fix.
  Without scrcpy or WebCodecs the pane says **Shot fallback** and shows still
  pictures a few times a second. It is never labelled Live.

## Tools

| Tool | Does |
| --- | --- |
| `device_list` | Running devices, bootable AVDs, missing prerequisites with fixes. |
| `device_boot {avd?, headless?, cold?, waitSeconds?}` | Boot an emulator. Returns within 25 s; call again with the same `avd` to wait. An already running device is returned, not duplicated. |
| `device_stop {serial}` | Stop an emulator this pack booted (refused for any other). |
| `device_screenshot {serial?, maxEdge?}` | PNG, at most `maxEdge` px on the long edge (default 1024); the text gives the scale to device pixels. |
| `device_tap {label}` or `{x, y}` | Tap. `label` re-reads UI Automator right before tapping; ambiguous labels are refused with the numbered choices (`occurrence`). |
| `device_swipe`, `device_type`, `device_key` | Swipe/scroll, type printable ASCII, press home/back/recents/power/volume/enter/delete/tab/escape/menu. |
| `device_open_url {url}` | Open a URL in whatever handles it. |
| `device_install {apk}` / `device_launch {package}` | Install (`-r -g -t`) an absolute-path `.apk`; launch by package or component. |
| `device_ui_tree {maxNodes?, all?}` | One line per labelled or interactive view: `#12 Button "Sign in" id=login @540,1630 clickable`. |
| `device_open {serial?, avd?, boot?}` | Show the pane beside the conversation. |
| `device_stream` (app only) | The View's door to the frames lane: a loopback WebSocket address with a one-use token. |

`serial` may be left out when exactly one device runs (or the pane holds one in
this session). With several, name it.

## Prerequisites

| Tool | Needed for | Where it is looked for |
| --- | --- | --- |
| **adb** (Android SDK platform-tools) | everything | `simulator.sdkPath` → `$ANDROID_HOME` → `$ANDROID_SDK_ROOT` → the default Android Studio SDK location → `PATH` → `~/.inso/tools/mobile-sim/**` |
| **emulator** (Android Emulator + an AVD) | booting a device (a running emulator or a USB phone works without it) | the same SDK roots, then `PATH` |
| **scrcpy-server** | live H.264 video (Shot fallback without it) | `$SCRCPY_SERVER_PATH` → `~/.inso/tools/mobile-sim/**` (and `$INSO_HOME`'s) → next to a `scrcpy` on `PATH` → the package manager's share directory |

Nothing is hard-coded: `src/toolchain.ts` resolves the above at run time, and a
missing tool is reported with the command to get it. The SDK's adb is preferred
over a scrcpy bundle's own (a second adb binary against the user's server is how
"adb server version doesn't match" restarts happen).

**Pinned versions this pack was built and measured against** (installed outside
the repo, under `~/.inso/tools/mobile-sim/`):

| Tool | Version | License | SHA-256 |
| --- | --- | --- | --- |
| scrcpy (`scrcpy-win64-v5.0.zip`) | 5.0 | Apache-2.0 | `44c10d9e82f20ea67227d14d37bf9fbe3603117c5736df3f514544a02ba20a73` |
| `scrcpy-server` (inside it) | 5.0 | Apache-2.0 | `26cbc9ad0aced6c2282455bef4fb43462605c1f8758c74b4ab1dbf818c229daa` |
| avdslim (`avdslim_v1.0.15_windows_amd64.zip`), optional | 1.0.15 | MIT | `8d32d97e4ca65ae08d976d30d0b15a73d06cede36ebf2250cf731323ba02f72a` |
| `avdslim.exe` (inside it) | 1.0.15 | MIT | `df2868d453053159c1174de5e2e56c26b8bbd323c603fa7b4ddbbe1c4d758d00` |

The scrcpy-server wire format (`src/android/scrcpy-wire.ts`) is version 5.0's,
measured against a live emulator: the server refuses to run unless the client
names its exact version, so the pack asks the jar its version once (it prints it
when told a wrong one) instead of trusting a folder name. A different scrcpy
release may change the protocol: pin it, and the first Live attach tells you
loudly if it does (the stream is rejected, the pane falls to Shot).

**avdslim** is optional. The pack boots with avdslim's slimming flags itself
(`-no-audio -no-boot-anim -gpu host -camera-* none -no-snapshot-save`, and QEMU's
`-lowram`). If `avdslim bake <avd>` has made the `avdslim_clean` golden snapshot,
the pack boots from it (about 1.5 s) unless you ask for `cold: true`.

## How a picture gets from the emulator to the pane

```
emulator ── adb ── scrcpy-server (H.264 encoder, control socket)
                        │ adb forward (loopback)
         ┌──────────────┴───────────────┐
   video socket                     control socket
         │                               ▲
   packet parser ─► frame cache (config + key + deltas)    pointer / key / text
         │                               │
   frame relay: ws://127.0.0.1:<port>/f/<token>  ◄──── View (sandboxed iframe, Origin: null)
        binary frames ─►  WebCodecs VideoDecoder ─► canvas
```

- The View asks `device_stream` for `{url, mode}` and connects. The token is 24
  random bytes, per View and per connection; the listener exists only while a
  token or viewer does. A request must carry `Host: 127.0.0.1:<port>` (DNS
  rebinding), `Origin` absent or `null` (the sandboxed View's own; any real web
  origin is refused) and a live token. A wrong token and an unknown path are both
  404. The View's resource declares `_meta.ui.csp.connectDomains: ["ws://127.0.0.1:*"]`,
  the one thing the host's CSP needs to allow.
- **Frame gate** (shared by the server, per viewer, and the View, per decoder):
  `awaiting-config → awaiting-keyframe → streaming`. A delta is never decoded
  without its key frame, a key frame never without its config.
- **Backpressure:** when a viewer's socket backlog passes 1 MiB, pictures are
  *dropped*, never queued; the viewer waits at the gate for the next key frame.
  Key-frame requests restart the encoder for everyone, so they are throttled to
  one per second with one trailing request.
- **Input:** the View sends pointer positions normalized to the canvas (0..1).
  The server maps them to the video size and injects them on the scrcpy control
  socket (real press/move/release). In Shot fallback there is no control socket:
  a press-and-release becomes an `adb shell input tap`, a drag a `swipe`.
- **Shot** (the agent's picture, and the pane's fallback): `adb exec-out screencap`
  *raw*, box-scaled and PNG-encoded in this process with `zlib` alone (no image
  library), yielding to the event loop between bands so video and tool calls are
  never held by a screenshot.

## Settings

`simulator.maxDevices` (2), `simulator.idleMinutes` (15), `simulator.sdkPath`
(empty). The engine does not hand a pack's MCP server its settings, so the server
reads the same user config the engine does (`$PI_CODING_AGENT_DIR` or
`~/<$PI_CONFIG_DIR | .omp>/agent/config.yml`) when it needs a value; the
environment variables `SIMULATOR_MAX_DEVICES`, `SIMULATOR_IDLE_MINUTES`,
`SIMULATOR_SDK_PATH` override it.

`mcp.json` sets an `env` block on purpose: a server entry with an `env` is
launched with the engine's full environment (so `ANDROID_HOME` and `PATH` are
visible), one without gets only the SDK's minimal default.

## Honest limits

- **Android only.** There is no iOS backend, and no iOS entry in the pane.
  `src/backend.ts` is the seam: an iOS simulator is a **macOS-host backend** that
  implements `DeviceBackend` with `xcrun simctl` (lifecycle: `list`, `boot`,
  `shutdown`; pictures: `io screenshot`, which the existing Shot lane carries;
  input and install: `simctl` verbs such as `openurl`, `launch`, `install`). Live
  video would need a capture helper feeding the same relay; that is not designed
  here. Synara's route (loading CoreSimulator's private frameworks from a native
  addon for frames and HID) is **rejected**: private APIs break on Xcode releases
  and cannot be shipped to customers. None of it can be built or tested without
  Xcode on a Mac (the only Mac available has none), so none of it is here.
- `device_type` sends printable ASCII; other characters need the pane open (the
  View types them through the live control socket) or an app-side paste.
  `adb`'s `input text` reads a literal `%s` as a space.
- A device's *display rotation* changes the video size mid-stream; the pane
  follows (a new session + config + key frame), but `adb`-path coordinates are in
  the current rotation: re-read `device_ui_tree` after rotating.
- `device_ui_tree` needs UI Automator: secure screens and an app mid-transition
  can refuse a dump (the tool retries once and then says so).
- Mouse-wheel scrolling is not mapped; drag. Modifier shortcuts (Ctrl/Cmd/Alt)
  are not forwarded to the device. Clipboard sync is not implemented.
- One scrcpy session per device. A user running their own `scrcpy` window on the
  same device uses a different server file path and abstract socket (this pack's
  are `inso-sim-scrcpy.jar` and `scrcpy_<random>`), so they do not collide, but
  both encode.
- `device_install` of a very large APK can outlast the host's tool timeout
  (30 s on the desktop); `device_list` shows whether it landed.
- The connector's `requires.commands` is checked against `PATH` by the engine,
  which does not know `ANDROID_HOME`: on a machine whose SDK is not on `PATH`, the
  connect state reads "adb is not installed" although the pack finds it itself.
  Add the SDK's `platform-tools` and `emulator` folders to `PATH` to clear it.

## Develop

```sh
bun run build      # esbuild only: app/server.mjs, app/view.html (self-contained), dist/index.mjs (the dock)
```

`bun`, not `node`: the SDK's `@dimension/sdk/artifactory` is TypeScript source.
The built artifacts are committed (a pack installs with no build step). The View
is plain TypeScript and DOM, not React: the part that matters (pictures, 30 per
second) never goes through a render. It imports the kit's `--fr-*` tokens from
`@fraym/ui/theme.css`; Tailwind's own import in that file resolves to an empty
sheet at build time, because the View needs the tokens, not the utilities.
