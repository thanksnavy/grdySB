import { defineConfig } from "vitest/config";

/**
 * Test configuration.
 *
 * Runs in the Node environment. Everything under test here is pure request
 * handling — validation, routing decisions, SSE transcoding — and the
 * Workers-only pieces (the `AI` and `ASSETS` bindings) are mocked in the
 * tests, so Node's undici `Request`/`Response`/`ReadableStream` globals are
 * sufficient and the suite stays fast and deterministic.
 *
 * To add runtime-fidelity tests later (real `workerd`, actual binding
 * behaviour), switch `environment` to "workers" via
 * `@cloudflare/vitest-pool-workers`, which is already a devDependency:
 *
 *   import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
 *   export default defineWorkersConfig({
 *     test: { poolOptions: { workers: { wrangler: { configPath: "./wrangler.jsonc" } } } },
 *   });
 */
export default defineConfig({
	test: {
		environment: "node",
		include: ["test/**/*.test.ts"],
	},
});
