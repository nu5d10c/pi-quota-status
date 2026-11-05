/**
 * pi-quota-status — index.js
 *
 * Pi extension: when the active model's provider matches, that plan's quota and
 * reset countdown are rendered INSIDE the default footer's stats line (injected
 * into the gap between the token stats and the right-aligned model name) — no
 * separate line. Uses ctx.ui.setFooter() with pi's own exported
 * FooterComponent, so pwd/stats/model rendering stays identical to stock.
 *
 * Fetches are fully async and never block rendering: the footer renders from a
 * cached snapshot; network updates land on the next frame via requestRender().
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

import { FooterComponent } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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

/**
 * Inject the quota text into the default stats line's padding gap:
 *   `↑1.2k ↓456 $0.01 12%/200k  <quota>  ...padding...  (zai) glm-5`
 *
 * The built-in footer dims the remainder as ESC[2m + (padding + right side)
 * + ESC[22;39m, and the padding is the only run of 2+ spaces. We re-enter that
 * structure around the injected text so the surrounding dim stays intact.
 * Returns the line unchanged when no wide-enough gap exists.
 */
function injectIntoStatsLine(line, quotaText) {
	const match = /\x1b\[2m( +)/.exec(line);
	if (!match) return null;
	const gapStart = match.index + match[0].length - match[1].length; // first padding space
	const gapLen = match[1].length;
	const width = visibleWidth(quotaText);
	const rem = gapLen - width - 2; // two spaces before the text, rest goes after
	if (rem < 2) return null;
	// inserted inside the open dim segment, so the text inherits the dim style
	return line.slice(0, gapStart) + "  " + quotaText + " ".repeat(rem) + line.slice(gapStart + gapLen);
}

export default function (pi) {
	const cache = new Map(); // providerId → { ...entry, at }
	const inflight = new Map(); // providerId → Promise<entry>
	let timer = null;
	let lastCtx = null;
	let tuiRef = null;
	let quotaText = null; // cached renderStatus output for the current provider

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

	/** Background update: fetch (cached) then refresh the footer snapshot. Never awaited by render. */
	async function update(ctx, { force = false } = {}) {
		const providerId = ctx.model?.provider;
		const spec = providerId ? PROVIDERS[providerId] : undefined;
		if (!spec) {
			quotaText = null;
			tuiRef?.requestRender();
			return;
		}
		try {
			const entry = await refresh(providerId, ctx, force);
			quotaText = renderStatus(spec.label, entry);
		} catch {
			// refresh never rejects; keep the previous snapshot just in case
		}
		tuiRef?.requestRender();
	}

	function mountFooter(ctx) {
		ctx.ui.setFooter((tui, theme, footerData) => {
			tuiRef = tui;
			// FooterComponent needs a session shape; shim one over the extension ctx.
			// Getters keep model / context usage fresh on every render.
			const shim = {
				get state() {
					return { model: ctx.model, thinkingLevel: ctx.thinkingLevel };
				},
				get model() {
					return ctx.model;
				},
				sessionManager: ctx.sessionManager,
				getContextUsage: () => ctx.getContextUsage(),
				routedModel: undefined,
				modelRuntime: { isUsingSubscription: () => false },
			};
			return {
				invalidate() {},
				dispose() {},
				render(width) {
					const inner = new FooterComponent(shim, footerData).render(width);
					if (quotaText) {
						const injected = injectIntoStatsLine(inner[1] ?? "", quotaText);
						if (injected) {
							inner[1] = truncateToWidth(injected, width);
							return inner;
						}
						// no room in the gap: degrade to its own line
						inner.push(truncateToWidth(quotaText, width));
					}
					return inner;
				},
			};
		});
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
		if (ctx.mode === "tui" && ctx.hasUI) mountFooter(ctx);
		timer = setInterval(() => {
			if (lastCtx) update(lastCtx).catch(() => {}); // keeps the countdown ticking
		}, REFRESH_INTERVAL_MS);
		await update(ctx).catch(() => {});
	});

	pi.on("model_select", async (_event, ctx) => {
		lastCtx = ctx;
		await update(ctx).catch(() => {});
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
