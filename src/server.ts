import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig();
const server = createApp(config);

server.listen(config.port, () => {
  console.log(`listening on port ${config.port} (version ${config.appVersion})`);
});

// Docker sends SIGTERM on stop; finish in-flight requests before exiting.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
