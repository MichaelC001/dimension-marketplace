import { OpeningThreadSkeleton, PresenceSurface, SectionSessionScope, Thread, presenceMode, useSettings } from "@fraym/ui";
import { memo } from "react";
import { jsx } from "react/jsx-runtime";
//#region src/index.tsx
/** Implementation of the thread section assembled ENTIRELY from published
*  parts — the composition mirrors the shipped classic one-to-one. */
function IndependentThreadSection(props) {
	const { config } = useSettings();
	return /* @__PURE__ */ jsx(SectionSessionScope, {
		session: props.session ?? null,
		actions: props.actions ?? null,
		capabilities: props.capabilities ?? null,
		children: /* @__PURE__ */ jsx(Thread, {
			presence: /* @__PURE__ */ jsx(PresenceSurface, {
				avatar: props.avatar,
				state: props.vibrState,
				mode: presenceMode(props.vibrMode),
				energy: props.energy,
				emotion: props.emotion,
				behaviour: props.behaviour,
				signals: props.signals,
				bridgedPresences: props.bridgedPresences,
				size: config.vibrSize
			}),
			verb: props.verb,
			showPresence: props.showPresence,
			showAvatar: props.showAvatar,
			agentMetaFallback: props.agentMetaFallback,
			emptyState: props.opening ? /* @__PURE__ */ jsx(OpeningThreadSkeleton, {}) : void 0,
			enterOnMount: props.enterOnMount,
			contentClassName: props.contentClassName ?? "max-w-[780px] px-7 pt-8 pb-12"
		})
	});
}
var src_default = memo(IndependentThreadSection);
//#endregion
export { src_default as default };
