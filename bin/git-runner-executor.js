#!/usr/bin/env node

import { runExecutorCli } from "../src/executor.js";

runExecutorCli(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
}).catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
