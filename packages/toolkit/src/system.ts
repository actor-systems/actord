// @actord/toolkit/system: the typed system declaration (system.ts) and the types derived from it.
//
// A system declares its messages (versioned, schema-validated contracts), its actors (native Durable
// Object classes), the external effects they may perform, and the routes that say which actor may send
// which message to which. Routes are the one source of truth for who sends and receives what: an
// undeclared actor or message in a route is a TypeScript error, and the runtime refuses a message on an
// undeclared route. Payload schemas are Standard Schema objects (zod 4, valibot, arktype, ...).

/** Standard Schema v1 (https://standardschema.dev), with the optional Standard JSON Schema extension. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
    readonly jsonSchema?: {
      readonly input: (options: { readonly target: string }) => Record<string, unknown>;
    };
  };
}

export type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<{ readonly message: string; readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> }> };

export type InferInput<S> = S extends StandardSchemaV1<infer I, unknown> ? I : never;
export type InferOutput<S> = S extends StandardSchemaV1<unknown, infer O> ? O : never;

/** Why an entity deserves to be an actor rather than a function. The boundary critic checks these. */
export type Justification = "identity" | "state" | "lifecycle" | "isolation" | "scheduling" | "permissions";

/** deterministic: plain code. model-assisted: fixed control flow that calls a model. agent: model-driven. */
export type ActorKind = "deterministic" | "model-assisted" | "agent";

/** "30s", "15m", "6h", "1d". */
export type Duration = `${number}${"s" | "m" | "h" | "d"}`;

export interface MessageSpec<S extends StandardSchemaV1 = StandardSchemaV1> {
  /** Positive integer. Bump it for any change an old receiver or sender couldn't handle. */
  readonly version: number;
  readonly description: string;
  readonly payload: S;
}

/** A schedule: a fixed period (`every`) or a cron expression (`cron`, in UTC), delivering `message`. */
export type ScheduleSpec =
  | { readonly every: Duration; readonly message: string; readonly cron?: never }
  | { readonly cron: string; readonly message: string; readonly every?: never };

export interface ActorSpec {
  /** The Durable Object binding name in wrangler.jsonc, such as "RELEASE_LEDGER". */
  readonly binding: string;
  readonly kind: ActorKind;
  /** One sentence: what this actor owns and does. */
  readonly purpose: string;
  /** At least one reason this is an actor. An empty list is a check error. */
  readonly justification: readonly Justification[];
  /** Periodic wakes, each delivered as its `message` on a route from "@clock". */
  readonly schedules?: readonly ScheduleSpec[];
  /** Names of external effects (keys of the system's `effects`) this actor may request. */
  readonly effects?: readonly string[];
  /**
   * Required for model-assisted and agent actors: bounds on one unit of model work. A model-assisted actor
   * sets maxAttempts and timeoutMs; an agent sets usd, turns and wallClock.
   */
  readonly budget?: {
    readonly maxAttempts?: number;
    readonly timeoutMs?: number;
    readonly maxTokens?: number;
    readonly usd?: number;
    readonly turns?: number;
    readonly wallClock?: Duration;
  };
  /** Agent actors: the harness that runs the agent loop. */
  readonly harness?: HarnessSpec;
  /** Agent actors: the model the agent runs on. */
  readonly model?: { readonly id: string; readonly reasoning?: "low" | "medium" | "high" };
  /** Agent actors: path from system.ts to the instructions file. */
  readonly instructions?: string;
  /** Agent actors: "workspace.*", "workspace.<name>", or names of effects in this actor's `effects`. */
  readonly tools?: readonly string[];
  /** Agent actors: which messages drive the agent, and what each does with the session. */
  readonly on?: Readonly<Record<string, AgentVerb>>;
  /** Agent actors: the message the agent's final answer is delivered as. */
  readonly returns?: string;
}

/** What a message does to an agent's session. */
export type AgentVerb = "start" | "steer" | "stop";

export interface ContainerBackendSpec {
  readonly kind: "container";
  readonly image: string;
  readonly instance?: string;
}

export interface WorkspaceSpec {
  readonly kind: "computer";
  /** Where commands run; without one the agent can read and edit files but not run commands. */
  readonly backend?: ContainerBackendSpec;
  /** Paths kept on the container's disk only (Computer's `ignore`): each starts with "/" or "**\/". */
  readonly localOnly?: readonly string[];
  readonly egress?: "none" | "registry-read";
  /** The longest a tool's command may run; default 10 minutes. */
  readonly execTimeoutMs?: number;
}

export interface HarnessSpec {
  readonly kind: "pi";
  readonly workspace?: WorkspaceSpec;
}

/** Declare a Pi harness. */
export function pi(spec: { workspace?: WorkspaceSpec } = {}): HarnessSpec {
  return { ...spec, kind: "pi" };
}

/** Declare a Computer workspace. */
export function computer(spec: Omit<WorkspaceSpec, "kind"> = {}): WorkspaceSpec {
  return { ...spec, kind: "computer" };
}

/** Declare a container backend for a workspace's commands. */
export function containerBackend(spec: { image: string; instance?: string }): ContainerBackendSpec {
  return { ...spec, kind: "container" };
}

/** One question put to a Clef model. It answers each with a probability for every allowed answer. */
export type ClefQuestion =
  | { readonly type: "noul"; readonly instructions: string; readonly criteria?: { readonly true?: string; readonly false?: string } }
  | { readonly type: "choice"; readonly instructions: string; readonly criteria: Readonly<Record<string, string | null>> }
  | { readonly type: "score"; readonly instructions: string; readonly criteria: readonly string[] };

/** One typed value a Clairic model extracts from text, with its confidence. */
export interface ClairicField {
  readonly type: "text" | "number" | "date" | "time" | "datetime" | "duration" | "list" | "estimate" | "forecast";
  readonly instructions?: string;
  readonly unit?: string;
  readonly integer?: boolean;
  readonly decimals?: number;
  readonly items?: "text" | "number" | "date";
  readonly min?: number | string;
  readonly max?: number | string;
  readonly step?: number | "month" | "year";
  readonly scale?: "linear" | "log";
  readonly null_threshold?: number;
  readonly horizon?: number;
  readonly interval?: "step" | "minute" | "hour" | "day" | "week" | "month" | "quarter" | "year";
}

export interface EffectSpec {
  readonly description: string;
  /**
   * "key": the destination deduplicates by an idempotency key, so a retry after a lost acknowledgment
   * is safe. "none": it doesn't, so an unacknowledged attempt is reported as in doubt, never retried
   * blindly, and never reported as delivered.
   */
  readonly idempotency: "key" | "none";
  /** True when the outcome of an unacknowledged attempt can be looked up afterwards. */
  readonly reconcile?: boolean;
  /** "human": the effect goes through an approval gateway before it runs. */
  readonly approval?: "human" | "none";
  /** How long an approval request waits for a person before it expires and the actor hears it failed. Default "3d". Only with approval: "human". */
  readonly expires?: Duration;
  /**
   * A message delivered back to the requesting actor with the outcome ({ key, status, value | error, usage? }),
   * on a route from the actor to itself. This makes the external wait an explicit message boundary.
   */
  readonly result?: string;
  /** Bounds for one run of this effect. They take precedence over the requesting actor's budget. */
  readonly budget?: { readonly maxAttempts?: number; readonly timeoutMs?: number };
  /**
   * "call" (the default): one request answered within the effect's timeout. "job": work that outlives a
   * request (an agent session, a CI run). The adapter's start() returns a handle; the job is settled once,
   * later, by its completion message, its probe, its deadline (in_doubt) or a cancel. See decision 0018.
   * "decision": asks a Clef model questions and gets a probability for every allowed answer. "extraction":
   * asks a Clairic model for typed values with confidence. Both are pure reads.
   */
  readonly kind?: "call" | "job" | "decision" | "extraction";
  /** A decision's Clef model (`@cf/cloudflare/clef` or `@cf/cloudflare/clef-flash`), or an extraction's Clairic model (`@cf/cloudflare/clairic`). */
  readonly model?: string;
  /** For a decision: 1 to 64 questions by id. */
  readonly questions?: Readonly<Record<string, ClefQuestion>>;
  /** For an extraction: the values to extract, by name. */
  readonly fields?: Readonly<Record<string, ClairicField>>;
  /** For a decision: "act" (the default) delivers the answer; "shadow" records it for the scorecard and delivers nothing. */
  readonly mode?: "act" | "shadow";
  /** Required for a job: how long it may wait before its outcome is in_doubt. */
  readonly deadline?: Duration;
  /** For a job: ask the adapter's probe(handle) this often until it reports done. */
  readonly probe?: { readonly every: Duration };
  /** For a job: the message whose handler settles it with ctx.settleJob(...). It names that message for checks and the graph. */
  readonly completes?: { readonly message: string };
  /** True when the effect makes something public (a post, a release). It requires approval: "human", and an emailed approval of it must be answered from a verified sender. */
  readonly publishes?: boolean;
  /** The parameters of the tool an agent sees for this effect. */
  readonly input?: StandardSchemaV1;
}

/** One webhook event, named `${X-GitHub-Event}.${action}` (the bare event name when the payload has no action). */
export interface WebhookEventSpec {
  /** The system message this event becomes. */
  readonly message: string;
  /** Picks the receiving actor's instance. It is not a dedupe id: the delivery id (`X-GitHub-Delivery`) is the envelope id that removes duplicates. */
  readonly key: (event: any) => string;
  /** Maps the provider's payload to the message's payload. */
  readonly map: (event: any) => unknown;
}

/** A webhook source. `secret` names an `env` entry holding the signing secret; it is never the value. */
export interface WebhookSourceSpec {
  readonly kind: "webhook";
  readonly path: `/${string}`;
  readonly verify: "github";
  readonly secret: string;
  readonly events: Readonly<Record<string, WebhookEventSpec>>;
}

/** An email source for approvals by reply. `secret`, `owner`, `from`, `send` and `authserv` name `env` entries (a secret, three variables and a send_email binding). */
export interface EmailSourceSpec {
  readonly kind: "email";
  readonly secret: string;
  readonly owner: string;
  readonly from: string;
  readonly send: string;
  /**
   * Names the env entry holding the authserv-id of the receiving server, whose topmost Authentication-Results
   * header alone can make a reply authenticated: "pass". With it, mail from the owner's address that isn't
   * "pass" is refused without a reply, and an empty entry refuses all mail. Without it every reply is "unknown",
   * so an effect that publishes can't be approved by email.
   */
  readonly authserv?: string;
  readonly message: string;
}

export type SourceSpec = WebhookSourceSpec | EmailSourceSpec;

/** Declare a webhook source. Its name in `sources` becomes the route sender `@<name>`. */
export function webhook<const S extends Omit<WebhookSourceSpec, "kind">>(spec: S): S & { readonly kind: "webhook" } {
  return { ...spec, kind: "webhook" };
}

/** Declare an inbound email source. Its name in `sources` becomes the route sender `@<name>`. */
export function inboundEmail<const S extends Omit<EmailSourceSpec, "kind">>(spec: S): S & { readonly kind: "email" } {
  return { ...spec, kind: "email" };
}

/** "@clock" delivers scheduled messages; "@ingress" is the Worker's own entry point (fetch, cron); "@timer" delivers timers an actor set for itself. */
export type ExternalSender = "@clock" | "@ingress" | "@timer";

export interface RouteSpec<A extends string = string, M extends string = string, Src extends string = string> {
  readonly from: A | ExternalSender | `@${Src}`;
  readonly message: M;
  readonly to: A;
}

/** Per-actor references that must name declared effects and messages. */
export type ActorRefs<Msgs, Effects> = {
  readonly effects?: readonly Extract<keyof Effects, string>[];
  readonly schedules?: readonly (
    | { readonly every: Duration; readonly message: Extract<keyof Msgs, string>; readonly cron?: never }
    | { readonly cron: string; readonly message: Extract<keyof Msgs, string>; readonly every?: never }
  )[];
};

export interface SystemSpec<
  Msgs extends Record<string, MessageSpec>,
  Actors extends Record<string, ActorSpec>,
  Effects extends Record<string, EffectSpec>,
  Routes extends readonly RouteSpec[],
  Sources extends Record<string, SourceSpec> = Record<never, SourceSpec>,
> {
  readonly name: string;
  readonly description?: string;
  readonly messages: Msgs;
  readonly actors: Actors & { readonly [K in keyof Actors]: ActorRefs<NoInfer<Msgs>, NoInfer<Effects>> };
  readonly effects?: Effects;
  /** Where the outside world enters: each name becomes a route sender `@<name>`. */
  readonly sources?: Sources;
  /** `notify`: the effect that tells a person an approval is waiting. */
  readonly approvals?: { readonly notify: string };
  readonly routes: Routes;
}

export const SYSTEM_BRAND = "@actord/toolkit/system@1";

export interface System<
  Msgs extends Record<string, MessageSpec> = Record<string, MessageSpec>,
  Actors extends Record<string, ActorSpec> = Record<string, ActorSpec>,
  Effects extends Record<string, EffectSpec> = Record<string, EffectSpec>,
  Routes extends readonly RouteSpec[] = readonly RouteSpec[],
  Sources extends Record<string, SourceSpec> = Record<string, SourceSpec>,
> extends SystemSpec<Msgs, Actors, Effects, Routes, Sources> {
  readonly kind: typeof SYSTEM_BRAND;
}

/** Declare a message contract. */
export function message<const S extends StandardSchemaV1>(spec: MessageSpec<S>): MessageSpec<S> {
  return spec;
}

/**
 * Declare the system. Routes are checked against the declared actors and messages at compile time;
 * `actord check` covers what the type system can't express.
 */
export function defineSystem<
  const Msgs extends Record<string, MessageSpec>,
  const Actors extends Record<string, ActorSpec>,
  const Routes extends readonly RouteSpec<Extract<keyof NoInfer<Actors>, string>, Extract<keyof NoInfer<Msgs>, string>, Extract<keyof NoInfer<Sources>, string>>[],
  const Effects extends Record<string, EffectSpec> = Record<never, EffectSpec>,
  const Sources extends Record<string, SourceSpec> = Record<never, SourceSpec>,
>(spec: SystemSpec<Msgs, Actors, Effects, Routes, Sources>): System<Msgs, Actors, Effects, Routes, Sources> {
  return { ...spec, kind: SYSTEM_BRAND };
}

export function isSystem(value: unknown): value is System {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === SYSTEM_BRAND;
}

/** Milliseconds for a Duration, or null if it doesn't parse. */
export function durationMs(d: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(s|m|h|d)$/.exec(d);
  if (!m) return null;
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
  return Math.round(Number(m[1]) * unit);
}

// ---- Types derived from a declaration, used by actor implementations and the runtime ----

type AnySystem = System<Record<string, MessageSpec>, Record<string, ActorSpec>, Record<string, EffectSpec>, readonly RouteSpec[], Record<string, SourceSpec>>;

export type ActorName<S extends AnySystem> = Extract<keyof S["actors"], string>;
export type MessageName<S extends AnySystem> = Extract<keyof S["messages"], string>;
export type EffectName<S extends AnySystem> = Extract<keyof NonNullable<S["effects"]>, string>;

/** Messages an actor receives: those on a route whose `to` is the actor. */
export type MessagesTo<S extends AnySystem, A extends string> = Extract<Extract<S["routes"][number], { to: A }>["message"], MessageName<S>>;
/** Messages an actor may send: those on a route whose `from` is the actor. */
export type MessagesFrom<S extends AnySystem, A extends string> = Extract<Extract<S["routes"][number], { from: A }>["message"], MessageName<S>>;
/** Messages the Worker may send to actor A from its own code (route sender "@ingress"). */
export type IngressMessages<S extends AnySystem, A extends string> = Extract<Extract<S["routes"][number], { from: "@ingress"; to: A }>["message"], MessageName<S>>;
/** Messages actor A may set as timers for itself (route sender "@timer"). */
export type TimerMessages<S extends AnySystem, A extends string> = Extract<Extract<S["routes"][number], { from: "@timer"; to: A }>["message"], MessageName<S>>;
/** The receivers of message M from actor A. */
export type Receivers<S extends AnySystem, A extends string, M extends string> = Extract<S["routes"][number], { from: A; message: M }>["to"];

export type PayloadIn<S extends AnySystem, M extends MessageName<S>> = InferInput<S["messages"][M]["payload"]>;
export type PayloadOut<S extends AnySystem, M extends MessageName<S>> = InferOutput<S["messages"][M]["payload"]>;
