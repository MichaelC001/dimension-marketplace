import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import puppeteer from "puppeteer-core";
import { renderToStaticMarkup } from "react-dom/server";
import { BlankTab } from "../app/view/start-page";
import { BROWSER_TEST_TIMEOUT_MS, chromePath, describeWithChrome } from "./fixture";

const STYLESHEET = readFileSync(join(import.meta.dir, "../app/view/style.css"), "utf8");
const HERO_BAR_HEIGHT_PX = 52;

describeWithChrome("blank tab layout", () => {
	test(
		"the address bar of a new tab keeps its hero height",
		async () => {
			const markup = renderToStaticMarkup(<BlankTab disabled={false} onNavigate={() => undefined} />);
			const browser = await puppeteer.launch({ executablePath: chromePath, headless: true });
			try {
				const page = await browser.newPage();
				await page.setViewport({ width: 800, height: 900 });
				await page.setContent(`<!doctype html><style>body{margin:0;height:100vh;display:flex;flex-direction:column}</style><style>${STYLESHEET}</style>${markup}`);
				const height = await page.evaluate(() => document.querySelector(".bx-blank .bx-omni")?.getBoundingClientRect().height);
				expect(height).toBe(HERO_BAR_HEIGHT_PX);
			} finally {
				await browser.close();
			}
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});
