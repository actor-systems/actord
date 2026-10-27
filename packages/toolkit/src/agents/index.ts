// @actord/toolkit/agents: agent actors on Pi and Computer. The only entry point that imports @earendil-works/* or
// @cloudflare/computer, so the runtime, system, sources and testing entry points stay free of them.
export { type ScriptedTurn, scriptedModel } from "./scripted-model.ts";
