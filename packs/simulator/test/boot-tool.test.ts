/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: what the agent is TOLD about a
 *  boot, and what it may stop. The agent only sees the tool's text: if the
 *  "booting, call again" instruction, the software-graphics fallback note or the
 *  emulator's own failure message is dropped on the way, it cannot recover from a
 *  slow or hung boot; and device_stop must reach only emulators this pack booted.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { emulatorDevice, FakeBackend } from "./fake-backend";
import { until } from "./fake-android-tools";
import { connectServer, type McpSession, type ServerFolder, serverFolder } from "./mcp-session";
import type { SimulatorSettings } from "../src/settings";

let folder: ServerFolder;
const open: McpSession[] = [];

beforeAll(() => {
  folder = serverFolder();
});

afterAll(() => {
  folder.dispose();
});

afterEach(async () => {
  for (const session of open.splice(0)) await session.close();
});

async function connect(backend: FakeBackend, settings: Partial<SimulatorSettings> = {}): Promise<McpSession> {
  const session = await connectServer(folder, backend, settings);
  open.push(session);
  return session;
}

function world(): FakeBackend {
  const backend = new FakeBackend();
  backend.avdNames = ["Pixel_A", "Pixel_B"];
  return backend;
}

describe("device_boot", () => {
  test("an AVD that already runs, started by the person, is returned and not booted again", async () => {
    const backend = world();
    backend.devices = [emulatorDevice("emulator-5554", "Pixel_A")];
    const session = await connect(backend);
    const answer = await session.call("device_boot", { avd: "Pixel_A" });
    expect(answer.isError).toBe(false);
    expect(answer.text).toContain("emulator-5554");
    expect(answer.text).toContain("already running; not booted again");
    expect(answer.text).toContain("not booted by this pack");
    expect(backend.boots).toHaveLength(0);
  });

  test("a boot that outlasts the call says to call again, and what the boot reports in the meantime reaches the next answer", async () => {
    const backend = world();
    const session = await connect(backend);
    const first = await session.call("device_boot", { avd: "Pixel_A", waitSeconds: 0 });
    expect(first.isError).toBe(false);
    expect(first.text).toContain("Pixel_A is booting");
    expect(first.text).toContain("Call device_boot again (avd: Pixel_A)");

    // The backend gave up on the host GPU and relaunched, and the console is now matched.
    const boot = backend.boots[0];
    if (boot === undefined) throw new Error("no boot");
    boot.observer.note("Fell back to software graphics: the host GPU never answered.");
    boot.observer.serial("emulator-5556");

    const second = await session.call("device_boot", { avd: "Pixel_A", waitSeconds: 0 });
    expect(second.isError).toBe(false);
    expect(second.text).toContain("emulator-5556 (Pixel_A) is booting");
    expect(second.text).toContain("Call device_boot again (avd: Pixel_A)");
    expect(second.text).toContain("Fell back to software graphics: the host GPU never answered.");
    expect(backend.boots).toHaveLength(1);
  });

  test("a boot that fails reaches the agent as an error carrying the emulator's own words", async () => {
    const backend = world();
    const session = await connect(backend);
    const call = session.call("device_boot", { avd: "Pixel_A", waitSeconds: 5 });
    await until(() => backend.boots.length === 1, "the boot to spawn");
    backend.boots[0]?.ready.reject(new Error("the emulator for Pixel_A exited with code 1 before it finished booting.\nLast 1 line of the emulator log (/logs/Pixel_A.log):\nERROR | Not enough disk space"));
    const answer = await call;
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("exited with code 1");
    expect(answer.text).toContain("ERROR | Not enough disk space");
  });

  test("the cap is refused with the number and the way out", async () => {
    const backend = world();
    const session = await connect(backend, { maxDevices: 1 });
    await session.call("device_boot", { avd: "Pixel_A", waitSeconds: 0 });
    const answer = await session.call("device_boot", { avd: "Pixel_B", waitSeconds: 0 });
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("cap 1");
    expect(answer.text).toContain("device_stop");
    expect(backend.boots).toHaveLength(1);
  });
});

describe("device_stop", () => {
  test("stops an emulator this pack booted, by the process it spawned", async () => {
    const backend = world();
    const session = await connect(backend);
    const booting = session.call("device_boot", { avd: "Pixel_A", waitSeconds: 5 });
    await until(() => backend.boots.length === 1, "the boot to spawn");
    const boot = backend.boots[0];
    if (boot === undefined) throw new Error("no boot");
    boot.observer.serial("emulator-5556");
    const info = emulatorDevice("emulator-5556", "Pixel_A");
    backend.devices.push(info);
    boot.ready.resolve(info);
    expect((await booting).text).toContain("booted by this pack");

    const answer = await session.call("device_stop", { serial: "emulator-5556" });
    expect(answer).toEqual({ isError: false, text: "emulator-5556 stopped." });
    expect(backend.stops).toEqual([{ process: boot.process, serial: "emulator-5556" }]);
  });

  test("refuses an emulator the person started, and nothing is stopped", async () => {
    const backend = world();
    backend.devices = [emulatorDevice("emulator-5554", "Pixel_B")];
    const session = await connect(backend);
    const answer = await session.call("device_stop", { serial: "emulator-5554" });
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("was not booted by this pack");
    expect(backend.stops).toEqual([]);
  });

  test("a pid that is gone is reported as already exited, and nothing is killed", async () => {
    const backend = world();
    const session = await connect(backend);
    const booting = session.call("device_boot", { avd: "Pixel_A", waitSeconds: 5 });
    await until(() => backend.boots.length === 1, "the boot to spawn");
    const boot = backend.boots[0];
    if (boot === undefined) throw new Error("no boot");
    boot.observer.serial("emulator-5556");
    const info = emulatorDevice("emulator-5556", "Pixel_A");
    backend.devices.push(info);
    boot.ready.resolve(info);
    await booting;
    // The emulator died by itself some time ago.
    backend.processes.delete(boot.process.pid);

    const answer = await session.call("device_stop", { serial: "emulator-5556" });
    expect(answer.isError).toBe(false);
    expect(answer.text).toContain("had already exited; the pack killed nothing");
  });
});
