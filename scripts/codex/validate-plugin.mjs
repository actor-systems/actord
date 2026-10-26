import fs from "node:fs";
import path from "node:path";
import Ajv from "ajv/dist/2020.js";
import YAML from "yaml";
export function validatePlugin(root) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "plugin.json"), "utf8"),
  );
  const schema = JSON.parse(
    fs.readFileSync(
      new URL("../../docs/codex-plugin.schema.json", import.meta.url),
      "utf8",
    ),
  );
  const ajv = new Ajv();
  const validate = ajv.compile(schema);
  if (!validate(manifest)) throw Error(JSON.stringify(validate.errors));
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version))
    throw Error("strict SemVer required");
  const names = new Set();
  const skills = [];
  for (const dir of fs
    .readdirSync(path.join(root, "skills"))
    .filter((dir) => fs.statSync(path.join(root, "skills", dir)).isDirectory())
    .sort()) {
    const file = path.join(root, "skills", dir, "SKILL.md");
    if (fs.lstatSync(path.dirname(file)).isSymbolicLink())
      throw Error("symlink skill");
    const body = fs.readFileSync(file, "utf8");
    const match = body.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match || Buffer.byteLength(body) > 1048576)
      throw Error("skill frontmatter/size");
    const meta = YAML.parse(match[1]);
    if (
      typeof meta.name !== "string" ||
      !meta.name.trim() ||
      typeof meta.description !== "string" ||
      !meta.description.trim() ||
      names.has(meta.name)
    )
      throw Error("skill metadata");
    names.add(meta.name);
    skills.push(meta.name);
    for (const link of body.matchAll(/\]\(([^)]+)\)/g)) {
      if (link[1].startsWith("https://")) continue;
      const target = path.resolve(path.dirname(file), link[1]);
      if (
        !target.startsWith(path.resolve(root) + path.sep) ||
        !fs.existsSync(target)
      )
        throw Error("unsafe or missing skill link");
    }
  }
  const onboarding = manifest.extensions?.["com.openai"]?.onboardingSkill;
  const onboardingTarget = path.resolve(root, onboarding ?? "");
  if (
    !onboarding?.startsWith("./skills/") ||
    !onboardingTarget.startsWith(path.resolve(root) + path.sep) ||
    !fs.existsSync(path.resolve(root, onboarding))
  )
    throw Error("missing onboarding skill");
  for (const forbidden of ["mcp.json", "hooks"])
    if (fs.existsSync(path.join(root, forbidden)))
      throw Error("core must not require hooks/MCP");
  return { schemaVersion: 1, status: "passed", name: manifest.name, skills };
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    console.log(
      JSON.stringify(
        validatePlugin(
          process.argv[2] ??
            new URL("../../plugins/codex", import.meta.url).pathname,
        ),
        null,
        2,
      ),
    );
  } catch {
    console.error(JSON.stringify({ status: "failed", code: "PLUGIN_INVALID" }));
    process.exitCode = 1;
  }
}
