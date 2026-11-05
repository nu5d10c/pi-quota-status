/**
 * pi-quota-status — index.js
 *
 * Pi extension: when the active model's provider matches, its plan quota and
 * reset countdown are attached to the built-in footer's extension status line
 * (ctx.ui.setStatus). /quota shows the multi-row detail and force-refreshes.
 *
 * Supported providers:
 *   zai                    → GLM Coding Plan global (api.z.ai)
 *   zai-coding-cn          → GLM Coding Plan China (open.bigmodel.cn)
 *   openai-codex           → Codex (ChatGPT subscription, OAuth)
 *   xiaomi-token-plan-cn   → Xiaomi MiMo Token Plan China (console cookie)
 *   deepseek               → DeepSeek account balance (pay-as-you-go)
 *
 * All keys come from pi's own credential store (ctx.modelRegistry.getProviderAuth);
 * each key is sent only to its own issuer's quota endpoint — never logged,
 * never entered into model context.
 */

import {
	describeError,
	fetchCodex,
	fetchDeepseek,
	fetchGlm,
	fetchMimo,
	MIMO_COOKIE_HINT,
	renderDetail,
	renderStatus,
} from "./core.js";

const STATUS_KEY = "quota";
const CACHE_TTL_MS = 60_000;
const REFRESH_INTERVAL_MS = 60_000;

const PROVIDERS = {
	zai: {
		label: "GLM",
		fetch: (auth) => {
			if (!auth.key) return { rows: [], hint: "no API key configured (/login zai or env)" };
			return fetchGlm(auth.key, { host: "api.z.ai", scheme: "bearer" });
		},
	},
	"zai-coding-cn": {
		label: "GLM-CN",
		fetch: (auth) => {
			if (!auth.key) return { rows: [], hint: "no API key configured" };
			return fetchGlm(auth.key, { host: "open.bigmodel.cn", scheme: "raw" });
		},
	},
	"openai-codex": {
		label: "Codex",
		fetch: (auth) => {
			if (!auth.token) return { rows: [], hint: "not logged in: run /login openai-codex" };
			return fetchCodex(auth.token);
		},
	},
	"xiaomi-token-plan-cn": {
		label: "MiMo",
		fetch: () => {
			const cookie = process.env.XIAOMI_MIMO_CONSOLE_COOKIE?.trim();
			if (!cookie) return { rows: [], hint: MIMO_COOKIE_HINT };
			return fetchMimo(cookie);
		},
	},
	deepseek: {
		label: "DeepSeek",
		fetch: (auth) => {
			if (!auth.key) return { rows: [], hint: "no API key configured" };
			return fetchDeepseek(auth.key);
		},
	},
};

/**
 * Resolve auth from pi's credential store. Handles several result shapes:
 *   { source, auth: { apiKey } }          — API key
 *   { source: "OAuth", auth: { apiKey | headers } } — OAuth; token lives in
 *   apiKey or in headers.authorization
 */
async function resolveAuth(ctx, providerId) {
	let result;
	try {
		result = await ctx.modelRegistry.getProviderAuth(providerId);
	} catch {
		return { key: undefined, token: undefined, source: undefined };
	}
	const auth = result?.auth ?? result ?? {};
	let key = typeof auth.apiKey === "string" ? auth.apiKey.trim() : "";
	if (!key && typeof result?.apiKey === "string") key = result.apiKey.trim();
	const headers = auth.headers;
	const headerAuth =
		typeof headers?.get === "function"
			? headers.get("authorization")
			: Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === "authorization")?.[1];
	let token = key;
	if (typeof headerAuth === "string") {
		const bearer = headerAuth.replace(/^Bearer\s+/i, "").trim();
		if (bearer) token = bearer;
	}
	return { key: key || token, token, source: result?.source ?? auth.type };
}

export default function (pi) {
	const cache = new Map(); // providerId → { ...entry, at }
	const inflight = new Map(); // providerId → Promise<entry>
	let timer = null;
	let lastCtx = null;

	async function refresh(providerId, ctx, force = false) {
		const cached = cache.get(providerId);
		if (cached && !force && Date.now() - cached.at < CACHE_TTL_MS) return cached;
		const pending = inflight.get(providerId);
		if (pending && !force) return pending;

		const spec = PROVIDERS[providerId];
		const p = (async () => {
			let entry;
			try {
				const auth = await resolveAuth(ctx, providerId);
				entry = await spec.fetch(auth);
			} catch (err) {
				entry = { error: describeError(err) };
			}
			entry.at = Date.now();
			cache.set(providerId, entry);
			return entry;
		})();
		if (!force) {
			inflight.set(providerId, p);
			p.finally(() => inflight.delete(providerId)).catch(() => {});
		}
		return p;
	}

	async function update(ctx, { force = false } = {}) {
		if (!ctx.hasUI) return;
		const providerId = ctx.model?.provider;
		const spec = providerId ? PROVIDERS[providerId] : undefined;
		if (!spec) {
			ctx.ui.setStatus(STATUS_KEY, undefined); // unsupported provider: clear
			return;
		}
		try {
			const entry = await refresh(providerId, ctx, force);
			ctx.ui.setStatus(STATUS_KEY, renderStatus(spec.label, entry));
		} catch {
			// refresh never rejects; leave the previous status just in case
		}
	}

	function stopTimer() {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		stopTimer();
		timer = setInterval(() => {
			if (lastCtx) update(lastCtx); // periodic refresh keeps the countdown ticking
		}, REFRESH_INTERVAL_MS);
		await update(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		lastCtx = ctx;
		await update(ctx);
	});

	pi.on("session_shutdown", () => {
		stopTimer();
	});

	pi.registerCommand("quota", {
		description: "Show quota detail (also force-refreshes)",
		handler: async (_args, ctx) => {
			const providerId = ctx.model?.provider;
			const spec = providerId ? PROVIDERS[providerId] : undefined;
			if (!spec) {
				ctx.ui.notify(
					`Current model ${ctx.model?.provider ?? "?"} is not monitored\nSupported: zai · zai-coding-cn · openai-codex · xiaomi-token-plan-cn · deepseek`,
					"warning",
				);
				return;
			}
			const entry = await refresh(providerId, ctx, true);
			ctx.ui.notify(renderDetail(spec.label, entry).join("\n"), entry.error ? "warning" : "info");
			await update(ctx, { force: true });
		},
	});
}
