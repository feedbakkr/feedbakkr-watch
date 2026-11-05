import type { Env as WatchEnv } from "../src/env";

// `env` from cloudflare:test has the worker's bindings.
declare global {
	namespace Cloudflare {
		interface Env extends WatchEnv {}
	}
}
