#!/usr/bin/env node
import { launch } from "../src/launcher.mjs";
process.exitCode = launch(process.argv.slice(2));
