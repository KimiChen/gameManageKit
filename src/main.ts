import { pathToFileURL } from "node:url";
import type { FastifyInstance } from "fastify";
import { createRuntime, type Runtime } from "./app.js";
import { loadConfig, type GameManageKitConfig } from "./config.js";
import { waitForRequestsDrained } from "./http/common.js";
import { safeErrorDetails } from "./infra/security/security.js";

export interface RunningGameManageKit {
  readonly runtime: Runtime;
  readonly publicAddress: string;
  readonly internalAddress: string;
  close(): Promise<void>;
}

export async function closeWithDeadline(
  apps: readonly FastifyInstance[],
  closeDatabase: () => Promise<void>,
  timeoutMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`graceful shutdown 超过 ${timeoutMs}ms`)), timeoutMs);
    timer.unref();
  });
  try {
    await Promise.race([
      (async () => {
        const closing = apps.map((app) => app.close());
        await Promise.all(apps.map((app) => waitForRequestsDrained(app)));
        for (const app of apps) {
          app.server?.closeIdleConnections?.();
        }
        await Promise.all(closing);
        await closeDatabase();
      })(),
      timeout,
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function start(
  config: GameManageKitConfig = loadConfig(),
): Promise<RunningGameManageKit> {
  const runtime = await createRuntime(config);
  let publicAddress = "";
  let internalAddress = "";
  try {
    publicAddress = await runtime.apps.publicApp.listen({
      host: config.publicHost,
      port: config.publicPort,
    });
    internalAddress = await runtime.apps.internalApp.listen({
      host: config.internalHost,
      port: config.internalPort,
    });
  } catch (error) {
    await Promise.all([
      runtime.apps.publicApp.close().catch(() => undefined),
      runtime.apps.internalApp.close().catch(() => undefined),
    ]);
    await runtime.database.close().catch(() => undefined);
    throw error;
  }

  let closePromise: Promise<void> | null = null;
  return {
    runtime,
    publicAddress,
    internalAddress,
    close() {
      closePromise ??= closeWithDeadline(
        [runtime.apps.publicApp, runtime.apps.internalApp],
        () => runtime.database.close(),
        config.shutdownTimeoutMs,
      );
      return closePromise;
    },
  };
}

async function run(): Promise<void> {
  const running = await start();
  console.log(`[gameManageKit] public listening ${running.publicAddress}`);
  console.log(`[gameManageKit] internal listening ${running.internalAddress}`);

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`[gameManageKit] ${signal} received, draining`);
    void running.close()
      .then(() => {
        console.log("[gameManageKit] shutdown complete");
      })
      .catch((error: unknown) => {
        console.error("[gameManageKit] shutdown failed", safeErrorDetails(error));
        for (const app of [running.runtime.apps.publicApp, running.runtime.apps.internalApp]) {
          app.server.closeAllConnections();
        }
        process.exitCode = 1;
      });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error: unknown) => {
    console.error("[gameManageKit] startup failed", safeErrorDetails(error));
    process.exitCode = 1;
  });
}
