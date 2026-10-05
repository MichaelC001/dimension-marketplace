/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: `device_tap {label}` taps the
 *  wrong control, or taps where a control WAS. The label path is what an agent
 *  should use instead of guessing pixels from a screenshot, so it has to read
 *  the UI Automator dump faithfully, refuse an ambiguous label with numbered
 *  choices instead of picking one, and look at the screen again right before the
 *  tap.
 */
import { describe, expect, test } from "bun:test";
import { centerOf, dumpXml, findByLabel, parseUiDump } from "../src/android/ui-tree";
import { SimulatorError, type UiNode, type UiSnapshot } from "../src/contracts";
import { tapLabel } from "../src/server";
import { FakeBackend, node, snapshot } from "./fake-backend";

const ATTRS = 'checkable="false" checked="false" focused="false" long-clickable="false" password="false" selected="false"';

function xmlNode(attrs: Record<string, string>, close: "/>" | ">"): string {
  const merged = { text: "", "resource-id": "", class: "android.view.View", package: "com.example.app", "content-desc": "", clickable: "false", enabled: "true", focusable: "false", scrollable: "false", ...attrs };
  return `<node ${Object.entries(merged)
    .map(([key, value]) => `${key}="${value}"`)
    .join(" ")} ${ATTRS} ${close}`;
}

const DUMP = [
  "WARNING: linker: some noise before the XML",
  "<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>",
  '<hierarchy rotation="0">',
  xmlNode({ package: "", bounds: "[0,0][1080,2400]", class: "android.widget.FrameLayout" }, ">"),
  xmlNode({ package: "com.android.systemui", bounds: "[0,0][1080,120]" }, "/>"),
  xmlNode({ text: "Sign in", "resource-id": "com.example.app:id/sign_in", class: "android.widget.Button", clickable: "true", bounds: "[100,1000][980,1160]" }, "/>"),
  xmlNode({ bounds: "[0,200][1080,600]", scrollable: "true", class: "androidx.recyclerview.widget.RecyclerView" }, ">"),
  xmlNode({ text: "Tom &amp; Jerry &#8211; &#x1F600; &lt;3", bounds: "[0,200][1080,300]" }, "/>"),
  xmlNode({ text: "Not listed: bounds are garbage", bounds: "[oops]" }, "/>"),
  "</node>",
  xmlNode({ text: "Disabled", enabled: "false", bounds: "[100,1200][980,1300]" }, "/>"),
  "</node>",
  "</hierarchy>",
  "UI hierarchy dumped to: /dev/tty",
].join("\n");

describe("parseUiDump", () => {
  const parsed = parseUiDump(DUMP);

  test("reads the nodes, ignoring the noise before the XML and the trailer after it", () => {
    expect(parsed.nodes.map(item => item.text)).toEqual(["", "", "Sign in", "", "Tom & Jerry \u2013 \u{1F600} <3", "Disabled"]);
  });

  test("decodes named, decimal and hex entities in attribute values", () => {
    expect(parsed.nodes.find(item => item.text.startsWith("Tom"))?.text).toBe("Tom & Jerry \u2013 \u{1F600} <3");
  });

  test("depth follows nesting: self-closing nodes add none, closers take one away", () => {
    const depthOf = (text: string): number | undefined => parsed.nodes.find(item => item.text === text)?.depth;
    expect(parsed.nodes[0]?.depth).toBe(0);
    expect(depthOf("Sign in")).toBe(1);
    expect(depthOf("Tom & Jerry \u2013 \u{1F600} <3")).toBe(2);
    expect(depthOf("Disabled")).toBe(1);
  });

  test("a node whose bounds cannot be read is not listed, and its siblings are unharmed", () => {
    expect(parsed.nodes.some(item => item.text.startsWith("Not listed"))).toBe(false);
    expect(parsed.nodes.find(item => item.text === "Disabled")?.bounds).toEqual({ left: 100, top: 1200, right: 980, bottom: 1300 });
  });

  test("the display is the root's size, and the foreground app is the first real package that is not system UI", () => {
    expect(parsed.display).toEqual({ width: 1080, height: 2400 });
    expect(parsed.package).toBe("com.example.app");
  });

  test("flags: clickable, scrollable, enabled=false", () => {
    expect(parsed.nodes.find(item => item.text === "Sign in")).toMatchObject({ clickable: true, enabled: true, id: "com.example.app:id/sign_in" });
    expect(parsed.nodes.find(item => item.text === "Disabled")?.enabled).toBe(false);
    expect(parsed.nodes.find(item => item.cls.endsWith("RecyclerView"))?.scrollable).toBe(true);
  });

  test("a dump with no hierarchy fails with the reason and the way out, not with an empty screen", () => {
    expect(() => dumpXml("ERROR: null root node returned by UiTestAutomationBridge.")).toThrow(SimulatorError);
    expect(() => dumpXml("ERROR: null root node returned by UiTestAutomationBridge.")).toThrow(/null root node.*retry/is);
  });
});

describe("findByLabel", () => {
  function row(index: number, over: Partial<UiNode>, top: number): UiNode {
    return node({ index, bounds: { left: 100, top, right: 980, bottom: top + 100 }, ...over });
  }

  test("ranks exact text, then resource id, then prefix, then contains: a better tier wins over reading order", () => {
    const screen = snapshot([
      row(1, { text: "Reopen the file" }, 100),
      row(2, { text: "Open file" }, 300),
      row(3, { id: "com.example.app:id/open" }, 500),
      row(4, { text: "Open" }, 700),
    ]);
    const found = findByLabel(screen, "open");
    expect(found.map(match => [match.node.index, match.tier])).toEqual([
      [4, "exact"],
      [3, "id"],
      [2, "prefix"],
      [1, "contains"],
    ]);
  });

  test("content description counts as the label", () => {
    const screen = snapshot([row(1, { desc: "Navigate up", cls: "android.widget.ImageButton" }, 100)]);
    expect(findByLabel(screen, "navigate up").map(match => match.tier)).toEqual(["exact"]);
  });

  test("case, padding and runs of spaces do not matter", () => {
    expect(findByLabel(snapshot([row(1, { text: "Sign   in" }, 100)]), "  SIGN in ")).toHaveLength(1);
  });

  test("an empty label matches nothing", () => {
    expect(findByLabel(snapshot([row(1, { text: "Sign in" }, 100)]), "   ")).toEqual([]);
  });

  test("within a tier, a clickable control comes before a plain view that says the same", () => {
    const screen = snapshot([row(1, { text: "Save" }, 100), row(2, { text: "Save", clickable: true }, 900)]);
    expect(findByLabel(screen, "save").map(match => match.node.index)).toEqual([2, 1]);
  });

  test("a clickable row and the label inside it are one target, not two", () => {
    const screen = snapshot([
      node({ index: 1, text: "Wi-Fi", clickable: true, bounds: { left: 0, top: 500, right: 1080, bottom: 620 } }),
      node({ index: 2, text: "Wi-Fi", bounds: { left: 40, top: 520, right: 1040, bottom: 600 } }),
    ]);
    const found = findByLabel(screen, "wi-fi");
    expect(found.map(match => match.node.index)).toEqual([1]);
  });

  test("only enabled, visible, non-empty views can be tapped", () => {
    const screen = snapshot([
      row(1, { text: "Go", enabled: false }, 100),
      row(2, { text: "Go" }, 5000),
      node({ index: 3, text: "Go", bounds: { left: 10, top: 10, right: 10, bottom: 200 } }),
      node({ index: 4, text: "Go", bounds: { left: -300, top: 100, right: -100, bottom: 200 } }),
      row(5, { text: "Go" }, 300),
    ]);
    expect(findByLabel(screen, "go").map(match => match.node.index)).toEqual([5]);
  });
});

describe("tapLabel: the labelled tap", () => {
  const SAVE = { text: "Save", clickable: true, cls: "android.widget.Button" } as const;

  function rig(...screens: UiSnapshot[]): FakeBackend {
    const backend = new FakeBackend();
    backend.screens = screens;
    return backend;
  }

  async function refusal(promise: Promise<unknown>): Promise<SimulatorError> {
    const error = await promise.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(SimulatorError);
    return error as SimulatorError;
  }

  test("a label that is on the screen once is tapped at its centre", async () => {
    const backend = rig(snapshot([node({ index: 7, ...SAVE, bounds: { left: 100, top: 1000, right: 980, bottom: 1160 } })]));
    const hit = await tapLabel(backend, "emulator-5554", "save", undefined);
    expect(backend.acts).toEqual(["uiTree emulator-5554", "tap emulator-5554 540,1080"]);
    expect(hit).toMatchObject({ x: 540, y: 1080, package: "com.example.app" });
  });

  test("a label on the screen twice is refused with numbered choices and the way out, and nothing is tapped", async () => {
    const backend = rig(
      snapshot([
        node({ index: 3, ...SAVE, bounds: { left: 100, top: 400, right: 500, bottom: 500 } }),
        node({ index: 9, ...SAVE, bounds: { left: 100, top: 1400, right: 500, bottom: 1500 } }),
      ]),
    );
    const error = await refusal(tapLabel(backend, "emulator-5554", "save", undefined));
    expect(error.code).toBe("label_ambiguous");
    expect(error.message).toContain("matches 2 places");
    expect(error.message).toContain('1) #3 Button "Save" @300,450 clickable');
    expect(error.message).toContain('2) #9 Button "Save" @300,1450 clickable');
    expect(error.message).toContain("Pass occurrence (1-2)");
    expect(backend.acts.some(act => act.startsWith("tap "))).toBe(false);
  });

  test("occurrence picks from those choices, in reading order (top to bottom, then left to right)", async () => {
    const screen = snapshot([
      node({ index: 1, ...SAVE, bounds: { left: 600, top: 400, right: 900, bottom: 500 } }),
      node({ index: 2, ...SAVE, bounds: { left: 100, top: 400, right: 400, bottom: 500 } }),
      node({ index: 3, ...SAVE, bounds: { left: 100, top: 1400, right: 400, bottom: 1500 } }),
    ]);
    const first = rig(screen);
    await tapLabel(first, "emulator-5554", "save", 1);
    const second = rig(screen);
    await tapLabel(second, "emulator-5554", "save", 2);
    const third = rig(screen);
    await tapLabel(third, "emulator-5554", "save", 3);
    expect([first, second, third].map(backend => backend.acts.at(-1))).toEqual(["tap emulator-5554 250,450", "tap emulator-5554 750,450", "tap emulator-5554 250,1450"]);
  });

  test("an occurrence past the last match is refused, not clamped", async () => {
    const backend = rig(snapshot([node({ index: 1, ...SAVE, bounds: { left: 100, top: 400, right: 400, bottom: 500 } })]));
    const error = await refusal(tapLabel(backend, "emulator-5554", "save", 2));
    expect(error.code).toBe("label_occurrence");
    expect(backend.acts.some(act => act.startsWith("tap "))).toBe(false);
  });

  test("a label that is not there is refused with what is on the screen", async () => {
    const backend = rig(snapshot([node({ index: 1, text: "Cancel", bounds: { left: 100, top: 400, right: 400, bottom: 500 } }), node({ index: 2, desc: "Menu", bounds: { left: 100, top: 600, right: 400, bottom: 700 } })]));
    const error = await refusal(tapLabel(backend, "emulator-5554", "save", undefined));
    expect(error.code).toBe("label_not_found");
    expect(error.message).toContain('"Cancel", "Menu"');
    expect(backend.acts.some(act => act.startsWith("tap "))).toBe(false);
  });

  test("an exact match is not made ambiguous by looser ones: 'Settings' beats 'Settings and privacy'", async () => {
    const backend = rig(
      snapshot([
        node({ index: 1, text: "Settings and privacy", clickable: true, bounds: { left: 100, top: 400, right: 900, bottom: 500 } }),
        node({ index: 2, text: "Settings", clickable: true, bounds: { left: 100, top: 900, right: 900, bottom: 1000 } }),
      ]),
    );
    await tapLabel(backend, "emulator-5554", "settings", undefined);
    expect(backend.acts.at(-1)).toBe("tap emulator-5554 500,950");
  });

  test("the screen is read again right before the tap: it taps where the control is NOW", async () => {
    const before = snapshot([node({ index: 1, ...SAVE, bounds: { left: 100, top: 400, right: 500, bottom: 500 } })]);
    const after = snapshot([node({ index: 1, ...SAVE, bounds: { left: 100, top: 1800, right: 500, bottom: 1900 } })]);
    const backend = rig(before, after);
    // What the agent saw when it listed the screen...
    await backend.uiTree("emulator-5554");
    // ...is not what it taps by: the layout moved since.
    await tapLabel(backend, "emulator-5554", "save", undefined);
    expect(backend.acts.at(-1)).toBe(`tap emulator-5554 ${centerOf(after.nodes[0]!).x},${centerOf(after.nodes[0]!).y}`);
    expect(backend.acts.filter(act => act.startsWith("uiTree"))).toHaveLength(2);
  });
});
