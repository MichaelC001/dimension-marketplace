import type { BrowserEngine } from "../contracts.js";
import type { EngineDriver, EngineOptions } from "./types.js";
import { createPuppeteerDriver } from "./puppeteer.js";
import { createAbpDriver } from "./abp.js";
import { createBrowser4Driver } from "./browser4.js";
import { createPythonDriver } from "./python.js";

const factories: Record<BrowserEngine, (options: EngineOptions) => Promise<EngineDriver>> = {
  chromium: options => createPuppeteerDriver("chromium", options),
  "chrome-relay": options => createPuppeteerDriver("chrome-relay", options),
  abp: createAbpDriver,
  browser4: createBrowser4Driver,
  jev: options => createPythonDriver("jev", options),
  "browser-use": options => createPythonDriver("browser-use", options),
};

export function createEngineDriver(engine: BrowserEngine, options: EngineOptions): Promise<EngineDriver> {
  // `factories` is total over BrowserEngine and the runtime validates the name
  // before it gets here, so there is no unsupported-engine branch to write.
  return factories[engine](options);
}
