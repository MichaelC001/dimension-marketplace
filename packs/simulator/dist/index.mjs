// src/dock/simulator-dock.tsx
import { Button } from "@fraym/ui";
import { useMemo } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
function SimulatorDock({ sessionId, store }) {
  const open = useMemo(() => store && sessionId ? () => store.act("openArtifactoryView", { tool: "device_open", args: {} }) : null, [store, sessionId]);
  return /* @__PURE__ */ jsxs("div", { className: "flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3", "data-slot": "simulator-dock", children: [
    /* @__PURE__ */ jsx("p", { className: "text-fr-sm text-fr-text-2", children: "An Android emulator beside your chat. Watch it, tap and type on it, and let your agent drive the same device." }),
    /* @__PURE__ */ jsx("div", { children: /* @__PURE__ */ jsx(Button, { type: "button", size: "sm", disabled: !open, onClick: () => open?.(), children: "Open simulator" }) }),
    !open ? /* @__PURE__ */ jsx("p", { className: "text-fr-xs text-fr-text-3", "data-slot": "simulator-dock-hint", children: "Start or open a chat first \u2014 the simulator opens beside it." }) : null
  ] });
}
export {
  SimulatorDock,
  SimulatorDock as default
};
