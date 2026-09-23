# Running the host probe

`pnpm --filter jey-adapter-dsh typecheck` then `pnpm --filter jey-adapter-dsh test`, run from
the repo root (`D:\codeWork\jev-dsh\repo`). Both are offline: `test/host/ordering.test.ts`
builds a real Cordis context, mounts the published DSH services through
`@deepseek-ai/dsh-agent-loop-testkit`, registers `src/scripted-llm.ts` as the only model
provider (a two-step script: one tool call, then text), registers `src/probe-tool.ts`
through `ToolRuntime`, and drives one user turn to completion while `src/probe-plugin.ts`
records the extension points the host actually fires. No API key, no network, no host
source mock — the assertions read the observed trace and the agent's durable session log.
Re-running overwrites nothing; set `JEY_TRACE_FILE=<path>` to additionally dump the observed
sequence and trace as JSON when regenerating `artifacts/compatibility.json`.
