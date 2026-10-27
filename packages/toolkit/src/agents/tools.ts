// An agent actor's declared effects as Pi tools. Each call is one effect request, keyed "<session>:<callId>": pi gives
// a call the same id when it runs it again after a restart, so the rerun finds the request's row instead of making a
// second. Whether pi may run it again is the effect's idempotency: a keyed effect is safe to rerun (actord retries
// its attempt, and the rerun waits for it); any other is not, so pi tells the model it was interrupted, and actord
// records the attempt in doubt.
//
// An effect that needs a person's approval answers at once that it waits, and the run goes on (or ends its turn).
// The agent runtime records the wait (`ToolSession.waiting`), and steers the result into the session when the
// effect's result message arrives.
import type { ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import { jsonSchemaOf } from "../model/manifest.ts";
import type { ActorRuntime, SettledOutcome } from "../runtime/index.ts";
import type { EffectSpec, StandardSchemaV1, System } from "../system.ts";

type AnySystem = System;

/** What a tool needs to know of the agent session it runs in, and how it records a wait there. */
export interface ToolSession {
  /** pi's session id. */
  session: string;
  /** The message that started the session: what the tool's effects are caused by and correlated with. */
  causationId: string;
  correlationId: string;
  /** Record that request `key` answered "waiting", so its result is steered in. The first record wins; its expiry is returned. */
  waiting(key: string, effect: string, expiresAt: number): number;
  /** When request `key` answered "waiting" before (a rerun after a restart answers the same), its expiry. */
  waited(key: string): number | undefined;
}

/** A Pi tool's name for an effect: its name with "." → "_". */
const toolName = (effect: string) => effect.replaceAll(".", "_");

const text = (t: string): ToolExecutionResult["output"] => [{ type: "text", text: t }];
/** A value as the model reads it: a string as is, anything else as JSON. */
export const shown = (value: unknown) => (typeof value === "string" ? value : (JSON.stringify(value) ?? ""));

/** What a tool that needs approval answers at once. */
const waitingText = (effect: string, key: string, expiresAt: number) =>
  `Waiting for a person to approve ${effect} (request ${key}, expires ${new Date(expiresAt).toISOString()}). The result will arrive as a message; continue with other work or end your turn.`;

/**
 * One Pi tool per effect in `tools`: name = effect name with "." → "_", parameters from `input`, replay by idempotency.
 * `session` tells a tool which session a pi conversation is (undefined: one this actor didn't start). `workspace.*`
 * entries aren't effects and are left to the workspace's own tools.
 */
export function effectTools(runtime: ActorRuntime, system: AnySystem, actor: string, session: (conversationId: string) => ToolSession | undefined): ToolRegistration[] {
  const spec = system.actors[actor];
  const tools: ToolRegistration[] = [];
  for (const name of spec?.tools ?? []) {
    if (name.startsWith("workspace.")) continue;
    const effect = system.effects?.[name];
    // `actord check` reports these as AGENT_TOOL_UNDECLARED.
    if (!effect || !spec?.effects?.includes(name)) throw new Error(`actord: agent actor ${actor} lists tool ${name}, which isn't an effect it declares`);
    tools.push(effectTool(runtime, actor, name, effect, session));
  }
  return tools;
}

function effectTool(runtime: ActorRuntime, actor: string, name: string, effect: EffectSpec, session: (conversationId: string) => ToolSession | undefined): ToolRegistration {
  const approval = effect.approval === "human";
  return {
    name: toolName(name),
    description: approval ? `${effect.description} A person must approve each call: it answers at once that it waits, and the result arrives later as a message.` : effect.description,
    // `actord check` reports an effect tool without `input` (AGENT_TOOL_INPUT_MISSING); without one, any object.
    parameters: ((effect.input && jsonSchemaOf(effect.input)) ?? { type: "object" }) as ToolRegistration["parameters"],
    // A keyed effect's rerun finds its row and waits for it; any other could run twice, so pi must not rerun it.
    replay: effect.idempotency === "key" ? "safe" : "unsafe",
    async execute(args, api, context) {
      const s = session(String(api.conversationId));
      if (!s) return { isError: true, output: text(`This session wasn't started by ${actor}, so it can't request ${name}.`) };
      const key = `${s.session}:${api.callId}`;
      const before = s.waited(key);
      if (before !== undefined) return { output: text(waitingText(name, key, before)) };
      // pi checked the arguments against the JSON Schema; the input schema may say more, and the adapter gets its value.
      let input: unknown = args;
      if (effect.input) {
        const validated = await (effect.input as StandardSchemaV1)["~standard"].validate(args);
        if (validated.issues) {
          const issues = validated.issues.map((i) => `- ${i.path?.length ? `${i.path.map((p) => String(typeof p === "object" ? p.key : p)).join(".")}: ` : ""}${i.message}`);
          return { isError: true, output: text(`The arguments don't match ${name}'s input:\n${issues.join("\n")}`) };
        }
        input = validated.value;
      }
      let state: Awaited<ReturnType<ActorRuntime["requestEffect"]>>;
      try {
        state = await runtime.requestEffect(name, input, { key, causationId: s.causationId, correlationId: s.correlationId });
      } catch (err) {
        return { isError: true, output: text(`${name} was refused: ${err instanceof Error ? err.message : String(err)}`) };
      }
      if (state.status === "awaiting_approval") return { output: text(waitingText(name, key, s.waiting(key, name, state.expiresAt))) };
      const outcome = state.status === "running" ? await untilAborted(state.outcome, context.abortSignal) : state;
      return resultOf(name, outcome);
    },
  };
}

/** The tool's answer for a settled request. */
function resultOf(name: string, outcome: SettledOutcome): ToolExecutionResult {
  if (outcome.status === "confirmed") return { output: text(shown(outcome.value)) };
  if (outcome.status === "in_doubt") return { isError: true, output: text(`${outcome.error}\nThe outcome is unknown: ${name} may or may not have taken effect.`) };
  return { isError: true, output: text(outcome.error) };
}

/** Waits for `promise`, or throws once the session's run is aborted: a stopped session stops waiting on its effects. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (v) => (signal.removeEventListener("abort", abort), resolve(v)),
      (e) => (signal.removeEventListener("abort", abort), reject(e)),
    );
  });
}
