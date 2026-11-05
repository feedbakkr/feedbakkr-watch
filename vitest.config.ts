import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests run in the Workers runtime with wrangler.jsonc's bindings and a test
// admin key, so no .dev.vars is needed.
export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				bindings: { FEEDBAKKR_WATCH_ADMIN_KEY: "wcha_test-admin-key-0123456789abcdef" },
			},
		}),
	],
	test: { setupFiles: ["./test/setup.ts"] },
});
