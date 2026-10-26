// @actord/toolkit/sources: the Worker's handlers for the sources a system declares in system.ts (spec §6).
// Each handler verifies a request, maps it to the system's own message and delivers it under the
// source's sender name ("@<source>"), as `ingress` does; actors never subscribe.
export { handleWebhook } from "./webhook.ts";
