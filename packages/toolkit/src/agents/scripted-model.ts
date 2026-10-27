// A deterministic pi-ai model for tests: no network, no real model. Each request is answered with the next scripted
// turn, streamed the way a provider would, with the turn's usage as given (pi-ai's faux provider estimates usage
// from the text, so it can't report a budget's tokens and cost).
import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  type JsonObject,
  type Message,
  type Model,
  type MutableModels,
  type TextContent,
  type ToolCall,
  type TranscriptContext,
  type Usage,
} from "@earendil-works/pi-ai";

export type ScriptedTurn = {
  text?: string;
  calls?: Array<{ name: string; args: unknown }>;
  /** The turn's tokens, and its cost in dollars, which pi records as the response's total cost. */
  usage?: { input: number; output: number; costUsd?: number };
};

const PROVIDER = "scripted";

/**
 * What a scripted function sees of a request: `turn` counts the requests answered before this one, from 0;
 * `lastToolResults` are the tool results the request ends with (pi-ai `ToolResultMessage`s); `messages` is the whole
 * request as the provider gets it, system messages (with their sections) included; `reasoning` is the thinking level
 * the request asks for, if any.
 */
export interface ScriptedRequest {
  turn: number;
  lastToolResults: unknown[];
  messages: Message[];
  reasoning?: string;
}

/**
 * A pi-ai model that answers each request with the next scripted turn (or what `next` returns); for tests only.
 * `next` may return a promise, to hold a request in flight; an abort of the request ends it at once, as a provider's
 * would, whatever the promise does. Running out of turns, or a `next` that throws, answers with an error, as a failed
 * request would.
 */
export function scriptedModel(turns: ScriptedTurn[] | ((request: ScriptedRequest) => ScriptedTurn | Promise<ScriptedTurn>)): {
  models: MutableModels;
  model: Model<Api>;
} {
  const model: Model<Api> = {
    id: "scripted",
    name: "Scripted",
    api: PROVIDER,
    provider: PROVIDER,
    baseUrl: "http://localhost:0",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
  let turn = 0;
  const next = async (context: TranscriptContext, reasoning: string | undefined): Promise<ScriptedTurn> => {
    const request = { turn: turn++, lastToolResults: trailingToolResults(context), messages: context.messages, ...(reasoning === undefined ? {} : { reasoning }) };
    if (typeof turns === "function") return turns(request);
    const scripted = turns[request.turn];
    if (!scripted) throw new Error(`scriptedModel has no turn ${request.turn} (${turns.length} scripted)`);
    return scripted;
  };
  const stream = (requested: Model<Api>, context: TranscriptContext, options?: { signal?: AbortSignal; reasoning?: string }) => {
    const out = createAssistantMessageEventStream();
    // Answer after the caller has the stream, as a provider's response would arrive.
    void (async () => {
      const base = { role: "assistant" as const, api: requested.api, provider: requested.provider, model: requested.id, timestamp: Date.now() };
      let scripted: ScriptedTurn;
      try {
        const signal = options?.signal;
        const answer = next(context, options?.reasoning);
        scripted = await (signal ? Promise.race([answer, abortOf(signal)]) : answer);
        if (signal?.aborted) throw new Error("Request was aborted");
      } catch (err) {
        const error: AssistantMessage = { ...base, content: [], usage: usage(undefined), stopReason: options?.signal?.aborted ? "aborted" : "error", errorMessage: err instanceof Error ? err.message : String(err) };
        out.push({ type: "error", reason: error.stopReason as "aborted" | "error", error });
        out.end(error);
        return;
      }
      const content: Array<TextContent | ToolCall> = [
        ...(scripted.text !== undefined ? [{ type: "text" as const, text: scripted.text }] : []),
        // A fresh id per call: pi keys a call's replay and memos by it, and a recreated script must not reuse one.
        ...(scripted.calls ?? []).map((c) => ({ type: "toolCall" as const, id: `call_${crypto.randomUUID()}`, name: c.name, arguments: c.args as JsonObject })),
      ];
      const message: AssistantMessage = { ...base, content, usage: usage(scripted.usage), stopReason: scripted.calls?.length ? "toolUse" : "stop" };
      const partial: AssistantMessage = { ...message, content: [], stopReason: "pending" };
      out.push({ type: "start", partial });
      // As pi-ai's stream protocol has it: a block starts empty in `partial` and is complete by its end event.
      content.forEach((block, contentIndex) => {
        if (block.type === "text") {
          const live: TextContent = { type: "text", text: "" };
          partial.content = [...partial.content, live];
          out.push({ type: "text_start", contentIndex, partial });
          live.text = block.text;
          out.push({ type: "text_delta", contentIndex, delta: block.text, partial });
          out.push({ type: "text_end", contentIndex, content: block.text, partial });
        } else {
          const live: ToolCall = { ...block, arguments: {} };
          partial.content = [...partial.content, live];
          out.push({ type: "toolcall_start", contentIndex, partial });
          out.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(block.arguments), partial });
          live.arguments = block.arguments;
          out.push({ type: "toolcall_end", contentIndex, toolCall: block, partial });
        }
      });
      out.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
      out.end(message);
    })();
    return out;
  };
  const provider = createProvider({
    id: PROVIDER,
    auth: { apiKey: { name: "Scripted", resolve: async () => ({ auth: {} }) } },
    models: [model],
    api: { stream, streamSimple: stream },
  });
  const models = createModels();
  models.setProvider(provider);
  return { models, model };
}

function usage(scripted: ScriptedTurn["usage"]): Usage {
  const input = scripted?.input ?? 0;
  const output = scripted?.output ?? 0;
  return { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: scripted?.costUsd ?? 0 } };
}

/** Rejects once `signal` aborts (at once if it has), so a held turn doesn't outlive its request. */
function abortOf(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () => reject(new Error("Request was aborted"));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}

/** The tool results at the end of the request: the answers to the previous turn's calls. */
function trailingToolResults(context: TranscriptContext): unknown[] {
  const results: unknown[] = [];
  for (let i = context.messages.length - 1; i >= 0 && context.messages[i]!.role === "toolResult"; i--) results.unshift(context.messages[i]);
  return results;
}
