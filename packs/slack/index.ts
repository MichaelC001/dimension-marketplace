import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerSlackBot } from "./bot";
import { registerSlackUser } from "./user";

export default function slackExtension(pi: ExtensionAPI): void {
	registerSlackBot(pi);
	registerSlackUser(pi);
}
