import { canOpenSession, describeSession, openSession } from "@dimension/mcp-app-kit/sessions";
import { Button } from "@fraym/ui/elements/button";
import { IconButton } from "@fraym/ui/elements/icon-button";
import { Icon } from "@fraym/ui/icons";
import { cn } from "@fraym/ui/lib/cn";
import type { App } from "@modelcontextprotocol/ext-apps";
import { useEffect, useState } from "react";
import { FOCUS } from "../focus-ring";
import { useCopied } from "../use-copied";
import { errorText } from "./library-tools";

const SHOWN_ID_CHARS = 8;

function sessionLabel(sessionId: string): string {
	return sessionId.length > SHOWN_ID_CHARS ? `…${sessionId.slice(-SHOWN_ID_CHARS)}` : sessionId;
}

function useSessionTitle(app: Pick<App, "request">, sessionId: string, enabled: boolean): string | null {
	const [title, setTitle] = useState<{ readonly id: string; readonly text: string } | null>(null);
	useEffect(() => {
		if (!enabled) return;
		let live = true;
		describeSession(app, sessionId)
			.then(result => {
				if (live && result.title.trim() !== "") setTitle({ id: sessionId, text: result.title });
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, [app, enabled, sessionId]);
	return title?.id === sessionId ? title.text : null;
}

export function SessionRow({ app, sessionId }: { readonly app: Pick<App, "request" | "getHostCapabilities">; readonly sessionId: string }) {
	const { copied, copy } = useCopied(sessionId);
	const canOpen = canOpenSession(app);
	const title = useSessionTitle(app, sessionId, canOpen);
	const [refusal, setRefusal] = useState<string | null>(null);
	const [opening, setOpening] = useState(false);
	const open = (): void => {
		setRefusal(null);
		setOpening(true);
		openSession(app, sessionId)
			.catch(cause => setRefusal(errorText(cause)))
			.finally(() => setOpening(false));
	};
	return (
		<>
			<dt className="text-fr-text-3">Made in</dt>
			<dd className="flex min-w-0 items-center gap-1">
				{title === null ? (
					<code title={sessionId} className="min-w-0 truncate rounded-sm bg-fr-surface-2 px-1.5 py-0.5 font-mono text-fr-text-2">
						{sessionLabel(sessionId)}
					</code>
				) : (
					<span title={`${title}\n${sessionId}`} className="min-w-0 truncate text-fr-text">
						{title}
					</span>
				)}
				<IconButton className={cn("size-6 shrink-0", FOCUS)} aria-label={copied ? "Session id copied" : "Copy session id"} title={copied ? "Session id copied" : sessionId} onClick={copy}>
					<Icon name={copied ? "check" : "copy"} size={12} />
				</IconButton>
				{canOpen ? (
					<Button type="button" size="sm" variant="outline" disabled={opening} onClick={open}>
						<Icon name="chat" size={12} />
						Open
					</Button>
				) : null}
			</dd>
			{refusal === null ? null : (
				<dd role="status" className="col-start-2 text-fr-del [overflow-wrap:anywhere]">
					{refusal}
				</dd>
			)}
		</>
	);
}
