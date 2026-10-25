declare const __ACTORS_VERSION__: string | undefined;

/** The toolkit version, injected at build time; "0.0.0-dev" when run from source. */
export const VERSION: string = typeof __ACTORS_VERSION__ === "string" ? __ACTORS_VERSION__ : "0.0.0-dev";

/** Version of every machine-readable document the CLI prints. Bump on any breaking shape change. */
export const SCHEMA_VERSION = 1;
