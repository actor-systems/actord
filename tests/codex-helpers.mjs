import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
export const root = path.resolve(import.meta.dirname, "..");
export const adapterRoot = path.join(root, "plugins/codex");
export const cli = path.join(adapterRoot, "bin/actord.js");
export const coreVersion = fs
  .readFileSync(path.join(adapterRoot, "dist/VERSION"), "utf8")
  .trim();
export const coreArchive = `actord-toolkit-${coreVersion}.tgz`;
export function run(cwd, args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: os.tmpdir(), ...env },
  });
}
export function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actord-shared-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const modules = path.join(dir, "node_modules");
  fs.mkdirSync(path.join(modules, "@actord"), { recursive: true });
  execFileSync("tar", [
    "-xzf",
    path.join(adapterRoot, "dist", coreArchive),
    "-C",
    modules,
  ]);
  fs.renameSync(
    path.join(modules, "package"),
    path.join(modules, "@actord/toolkit"),
  );
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      type: "module",
      devDependencies: { "@actord/toolkit": coreVersion },
    }),
  );
  fs.writeFileSync(
    path.join(dir, "system.ts"),
    `import {defineSystem} from '@actord/toolkit/system';
 const payload={'~standard':{version:1,vendor:'test',validate:value=>({value}),jsonSchema:{input:()=>({type:'object',properties:{},additionalProperties:false})}}};
 export default defineSystem({name:'fixture',messages:{'thing.created':{version:1,description:'A thing',payload}},actors:{First:{binding:'FIRST',kind:'deterministic',purpose:'accepts inputs',justification:['permissions']},Second:{binding:'SECOND',kind:'deterministic',purpose:'owns state',justification:['state']}},routes:[{from:'First',to:'Second',message:'thing.created'}]});`,
  );
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(
    path.join(dir, "src/index.ts"),
    "export class First {}\nexport class Second {}\n",
  );
  fs.writeFileSync(
    path.join(dir, "wrangler.jsonc"),
    JSON.stringify({
      name: "fixture",
      main: "src/index.ts",
      durable_objects: {
        bindings: [
          { name: "FIRST", class_name: "First" },
          { name: "SECOND", class_name: "Second" },
        ],
      },
      exports: {
        First: { type: "durable-object", storage: "sqlite" },
        Second: { type: "durable-object", storage: "sqlite" },
      },
    }),
  );
  const graph = run(dir, ["graph", "--write"]);
  if (graph.status !== 0) throw Error(graph.stderr || graph.stdout);
  return dir;
}
