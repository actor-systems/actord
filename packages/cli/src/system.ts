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

export interface ActorSpec {
  /** The Durable Object binding name in wrangler.jsonc, such as "RELEASE_LEDGER". */
  readonly binding: string;
  readonly kind: ActorKind;
  /** One sentence: what this actor owns and does. */
  readonly purpose: string;
  /** At least one reason this is an actor. An empty list is a check error. */
  readonly justification: readonly Justification[];
  /** A periodic wake, delivered as `message` on a route from "@clock". */
  readonly schedule?: { readonly every: Duration; readonly message: string };
  /** Names of external effects (keys of the system's `effects`) this actor may request. */
  readonly effects?: readonly string[];
  /** Required for model-assisted and agent actors: bounds on one unit of model work. */
  readonly budget?: { readonly maxAttempts: number; readonly timeoutMs: number; readonly maxTokens?: number };
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
  /**
   * A message delivered back to the requesting actor with the outcome ({ key, status, value | error }),
   * on a route from the actor to itself. This makes the external wait an explicit message boundary.
   */
  readonly result?: string;
}

/** "@clock" delivers scheduled messages; "@ingress" is the Worker's own entry point (fetch, cron). */
export type ExternalSender = "@clock" | "@ingress";

export interface RouteSpec<A extends string = string, M extends string = string> {
  readonly from: A | ExternalSender;
  readonly message: M;
  readonly to: A;
}

/** Per-actor references that must name declared effects and messages. */
export type ActorRefs<Msgs, Effects> = {
  readonly effects?: readonly Extract<keyof Effects, string>[];
  readonly schedule?: { readonly every: Duration; readonly message: Extract<keyof Msgs, string> };
};

export interface SystemSpec<
  Msgs extends Record<string, MessageSpec>,
  Actors extends Record<string, ActorSpec>,
  Effects extends Record<string, EffectSpec>,
  Routes extends readonly RouteSpec[],
> {
  readonly name: string;
  readonly description?: string;
  readonly messages: Msgs;
  readonly actors: Actors & { readonly [K in keyof Actors]: ActorRefs<NoInfer<Msgs>, NoInfer<Effects>> };
  readonly effects?: Effects;
  readonly routes: Routes;
}

export const SYSTEM_BRAND = "@actord/toolkit/system@1";

export interface System<
  Msgs extends Record<string, MessageSpec> = Record<string, MessageSpec>,
  Actors extends Record<string, ActorSpec> = Record<string, ActorSpec>,
  Effects extends Record<string, EffectSpec> = Record<string, EffectSpec>,
  Routes extends readonly RouteSpec[] = readonly RouteSpec[],
> extends SystemSpec<Msgs, Actors, Effects, Routes> {
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
  const Routes extends readonly RouteSpec<Extract<keyof NoInfer<Actors>, string>, Extract<keyof NoInfer<Msgs>, string>>[],
  const Effects extends Record<string, EffectSpec> = Record<never, EffectSpec>,
>(spec: SystemSpec<Msgs, Actors, Effects, Routes>): System<Msgs, Actors, Effects, Routes> {
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

type AnySystem = System<Record<string, MessageSpec>, Record<string, ActorSpec>, Record<string, EffectSpec>, readonly RouteSpec[]>;

export type ActorName<S extends AnySystem> = Extract<keyof S["actors"], string>;
export type MessageName<S extends AnySystem> = Extract<keyof S["messages"], string>;
export type EffectName<S extends AnySystem> = Extract<keyof NonNullable<S["effects"]>, string>;

/** Messages an actor receives: those on a route whose `to` is the actor. */
export type MessagesTo<S extends AnySystem, A extends string> = Extract<Extract<S["routes"][number], { to: A }>["message"], MessageName<S>>;
/** Messages an actor may send: those on a route whose `from` is the actor. */
export type MessagesFrom<S extends AnySystem, A extends string> = Extract<Extract<S["routes"][number], { from: A }>["message"], MessageName<S>>;
/** Messages the Worker may send to actor A from its own code (route sender "@ingress"). */
export type IngressMessages<S extends AnySystem, A extends string> = Extract<Extract<S["routes"][number], { from: "@ingress"; to: A }>["message"], MessageName<S>>;
/** The receivers of message M from actor A. */
export type Receivers<S extends AnySystem, A extends string, M extends string> = Extract<S["routes"][number], { from: A; message: M }>["to"];

export type PayloadIn<S extends AnySystem, M extends MessageName<S>> = InferInput<S["messages"][M]["payload"]>;
export type PayloadOut<S extends AnySystem, M extends MessageName<S>> = InferOutput<S["messages"][M]["payload"]>;
