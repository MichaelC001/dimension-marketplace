// Example Agents is a DATA pack: one space and one General Agent, no runtime.
//
// It is the reference a contributor copies. The space (`example-hub`) scopes
// its picker to exactly the agents named in `generalAgents.list`; the agent
// itself lives at `general-agents/example-cmo/agent.md` — deliberately not
// `agents/`, which is the open subagent standard. The agent ships
// `defaultEnabled: false`, so a user turns it on in Capabilities → General
// Agents before the Example Hub can open a session as it.
export {};
