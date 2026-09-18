import { runCLI } from "./run.js";

const control = new AbortController();
const stop = () => control.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
void runCLI(process.argv.slice(2), { signal: control.signal })
  .then((code) => {
    process.exitCode = code;
  })
  .catch(() => {
    process.stderr.write("herdr-agent 启动失败。\n");
    process.exitCode = 1;
  })
  .finally(() => {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  });
