// Reference templates are built from the root examples into the Codex distribution.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";

export function scaffoldTemplate(args, root, env) {
  try {
    const { values, positionals } = parseArgs({
      args: args.slice(1),
      allowPositionals: true,
      options: { template: { type: "string" }, json: { type: "boolean" } },
    });
    if (
      !["release-radar", "briefing-desk"].includes(values.template) ||
      positionals.length !== 1
    )
      throw Error(
        "Use actord init <empty-directory> --template release-radar|briefing-desk [--json].",
      );
    const target = path.resolve(positionals[0]);
    if (fs.existsSync(target) && fs.readdirSync(target).length)
      throw Error("Target is not empty; no files were changed.");
    const dist = path.join(root, "dist");
    const version = fs.readFileSync(path.join(dist, "VERSION"), "utf8").trim();
    const archive = `actord-toolkit-${version}.tgz`;
    const templates = JSON.parse(
      fs.readFileSync(path.join(dist, "reference-templates.json"), "utf8"),
    );
    const files = templates[values.template];
    if (!files || typeof files !== "object")
      throw Error(
        "Reference template missing from Codex distribution; rebuild the toolkit.",
      );
    for (const [file, content] of Object.entries(files)) {
      const destination = path.resolve(target, file);
      if (
        !destination.startsWith(target + path.sep) ||
        typeof content !== "string"
      )
        throw Error("Unsafe reference template path or content.");
    }
    fs.mkdirSync(target, { recursive: true });
    for (const [file, content] of Object.entries(files)) {
      const destination = path.join(target, file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, content);
    }
    fs.mkdirSync(path.join(target, "vendor"), { recursive: true });
    fs.copyFileSync(
      path.join(dist, archive),
      path.join(target, "vendor", archive),
    );
    const pkg = JSON.parse(fs.readFileSync(path.join(target, "package.json")));
    pkg.actord = { host: "codex" };
    pkg.devDependencies["@actord/toolkit"] = `file:vendor/${archive}`;
    fs.writeFileSync(
      path.join(target, "package.json"),
      JSON.stringify(pkg, null, 2) + "\n",
    );
    const result = spawnSync(
      process.execPath,
      [
        path.join(dist, "actord.mjs"),
        "init",
        "--adopt",
        ...(values.json ? ["--json"] : []),
      ],
      { cwd: target, env, stdio: "inherit" },
    );
    return result.status ?? 1;
  } catch (error) {
    console.error(`actord: ${error.message}`);
    return 2;
  }
}
