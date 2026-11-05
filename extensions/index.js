/**
 * pi-quota-status — index.js
 *
 * Pi extension: replaces the default footer with a single-line version showing
 * ONLY the selected elements — cache hit rate, context usage, plan quota —
 * with the model id right-aligned on the same line.
 *
 * Line layout (line 1 is cwd with a git branch suffix when available):
 *   📁 ~/path (main)
 *   CH95.3%  12.3%/200k  5h 1% (3h12m) | 7d 0.4% (4d6h)          glm-5
 * Statuses registered by other extensions via ctx.ui.setStatus() appear as a third line.
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

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-quota-status", "config.json");

function loadConfig() {
	try {
		const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
		return config?.providers && typeof config.providers === "object" ? config.providers : {};
	} catch (err) {
		if (err?.code !== "ENOENT") console.warn(`pi-quota-status: could not read config file ${CONFIG_PATH}: ${err.message}`);
		return {};
	}
}

const CONFIG = loadConfig();

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
			const { orgId, projectId } = CONFIG["zai-coding-cn"] ?? {};
			return fetchGlm(auth.key, { host: "open.bigmodel.cn", scheme: "raw", orgId, projectId });
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
			const cookie = (CONFIG["xiaomi-token-plan-cn"]?.cookie || process.env.XIAOMI_MIMO_CONSOLE_COOKIE)?.trim();
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

/** Compact token count: 950 → "950", 28,000 → "28k", 1,400,000 → "1.4M" */
function fmtTokens(n) {
	if (!Number.isFinite(n) || n <= 0) return "";
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

export default function (pi) {
	const cache = new Map(); // providerId → { ...entry, at }
	const inflight = new Map(); // providerId → Promise<entry>
	let timer = null;
	let lastCtx = null;
	let tuiRef = null;
	let quotaText = null; // cached renderStatus output for the current provider
	let quotaIcon = ""; // emoji marker shown before quotaText (💰)
	let activeProviderId = null;

	// all-quota widget (opened by /quota-all, closed by Esc)
	const ALL_WIDGET_KEY = "quota-all";
	let allOpen = false;
	let unsubInput = null;
	let editorFocus = null; // focused component when the widget opened (pi's main editor)

	function providerStatusLine(spec, entry) {
		const text = entry ? renderStatus(spec.label, entry) : `${spec.label} checking…`;
		// renderStatus omits the provider name in the normal state — prefix it there
		return text.startsWith(spec.label) ? text : `${spec.label}  ${text}`;
	}

	async function refreshAll(ctx) {
		await Promise.all(Object.keys(PROVIDERS).map((id) => refresh(id, ctx)));
		tuiRef?.requestRender();
	}

	function openAllView(ctx) {
		allOpen = true;
		// pi's selector UIs (settings, /model, …) are NOT overlays — they replace the
		// editor and steal focus. Snapshot the focused component now (the editor) so the
		// Esc handler can tell "editor focused" from "a selector is open".
		editorFocus = tuiRef?.focusedComponent ?? null;
		ctx.ui.setWidget(ALL_WIDGET_KEY, (tui, theme) => {
			tuiRef = tui;
			return {
				invalidate() {},
				dispose() {},
				render(width) {
					const lines = Object.entries(PROVIDERS).map(([providerId, spec]) =>
						truncateToWidth(theme.fg("dim", providerStatusLine(spec, cache.get(providerId))), width),
					);
					lines.push(theme.fg("muted", "esc to close"));
					return lines;
				},
			};
		});
		void refreshAll(ctx).catch(() => {});
	}

	function closeAllView(ctx) {
		allOpen = false;
		try {
			ctx.ui.setWidget(ALL_WIDGET_KEY, undefined);
		} catch {}
	}

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
			quotaIcon = "";
			activeProviderId = null;
			tuiRef?.requestRender();
			return;
		}
		// drop the previous provider's snapshot immediately so a switch renders instantly
		// (same-provider refreshes keep the old snapshot to avoid flicker)
		if (activeProviderId !== providerId) {
			quotaText = null;
			quotaIcon = "";
			tuiRef?.requestRender();
		}
		activeProviderId = providerId;
		try {
			const entry = await refresh(providerId, ctx, force);
			// the user may have switched models while the request was in flight —
			// a stale response must never overwrite the new provider's state
			if (activeProviderId !== providerId) return;
			quotaText = entry.rows?.length ? renderStatus(spec.label, entry) : null;
		} catch {
			// refresh never rejects; keep the previous snapshot just in case
		}
		tuiRef?.requestRender();
	}

	function mountFooter(ctx) {
		ctx.ui.setFooter((tui, theme, footerData) => {
			tuiRef = tui;
			return {
				invalidate() {},
				dispose() {},
				render(width) {
					// line 1: cwd (~-abbreviated), like the built-in footer
					let cwd = ctx.sessionManager.getCwd?.() || ctx.cwd || "";
					const home = process.env.HOME || process.env.USERPROFILE || "";
					if (home && (cwd === home || cwd.startsWith(home + "/"))) cwd = "~" + cwd.slice(home.length);
					const branch = footerData.getGitBranch();
					if (branch) cwd += ` (${branch})`;
					const pwdLine = truncateToWidth(theme.fg("dim", `📁 ${cwd}`), width, theme.fg("dim", "…"));

					// line 2 left side, in order: cache hit rate, context usage, plan quota
					const parts = [];

					// CH — prompt cache hit rate from the latest assistant message
					let latestHit;
					for (const e of ctx.sessionManager.getEntries()) {
						if (e.type === "message" && e.message.role === "assistant" && e.message.usage) {
							const u = e.message.usage;
							const denom = (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
							if (denom > 0) latestHit = ((u.cacheRead || 0) / denom) * 100;
						}
					}
					if (latestHit !== undefined) parts.push(theme.fg("dim", `⚡ ${latestHit.toFixed(1)}%`));

					// context usage — colorized by threshold like the built-in footer
					const cu = ctx.getContextUsage();
					if (cu?.percent != null) {
						const ctxStr = `🌡️ ${cu.percent.toFixed(1)}%`;
						parts.push(
							cu.percent > 90
								? theme.fg("error", ctxStr)
								: cu.percent > 70
									? theme.fg("warning", ctxStr)
									: theme.fg("dim", ctxStr),
						);
					}

					// plan quota / balance — one 💰 for both; numbers vs times tell them apart
					if (quotaText) parts.push(theme.fg("dim", `💰 ${quotaText}`));

					// right side: (provider) model • thinking — same format as the built-in footer
					let rightPlain = ctx.model?.id || "";
					if (rightPlain && ctx.model?.reasoning) {
						const level = ctx.thinkingLevel || "off";
						rightPlain += `:${level}`;
					}
					if (rightPlain && footerData.getAvailableProviderCount() > 1 && ctx.model) {
						rightPlain = `(${ctx.model.provider}) ${rightPlain}`;
					}
					const right = rightPlain ? theme.fg("dim", `🧠 ${rightPlain}`) : "";
					const rightWidth = rightPlain ? visibleWidth(`🧠 ${rightPlain}`) : 0;

					const sep = theme.fg("dim", "  ");
					let left = parts.join(sep);
					const leftWidth = parts.reduce((a, p) => a + visibleWidth(p), 0) + Math.max(0, parts.length - 1) * 2;

					const minPadding = 2;
					let line;
					if (!parts.length) {
						line = right;
					} else if (leftWidth + minPadding + rightWidth <= width) {
						const pad = " ".repeat(width - leftWidth - rightWidth);
						line = left + pad + right;
					} else {
						// too wide: truncate the left side, keep the model name
						const avail = width - rightWidth - minPadding;
						if (avail > 0) {
							left = truncateToWidth(left, avail, theme.fg("dim", "…"));
							const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - rightWidth));
							line = left + pad + right;
						} else {
							line = truncateToWidth(left, width, theme.fg("dim", "…"));
						}
					}
					const lines = [pwdLine, line];
					const extensionStatuses = footerData.getExtensionStatuses();
					if (extensionStatuses.size > 0) {
						const statusLine = Array.from(extensionStatuses.entries())
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, text]) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim())
							.join(" ");
						lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "…")));
					}
					return lines;
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

	pi.on("session_start", (_event, ctx) => {
		lastCtx = ctx;
		stopTimer();
		if (ctx.mode === "tui" && ctx.hasUI) {
			mountFooter(ctx);
			// close the all-quota widget on Esc; only consumed while it is open,
			// so Esc keeps its normal meaning otherwise
			unsubInput?.();
			unsubInput = ctx.ui.onTerminalInput?.((data) => {
				// Esc arrives as "\x1b" (legacy) or "\x1b[27u" (kitty keyboard protocol, which pi enables)
				const isEsc = data === "\x1b" || data === "\x1b[27u";
				if (!allOpen || !isEsc) return undefined;
				// never steal Esc when focus moved away from the editor (settings, /model,
				// selectors, overlays, …) — extension input listeners run before those in
				// the TUI pipeline, so this is our only chance to yield
				if (tuiRef?.hasOverlay?.()) return undefined;
				if (editorFocus && tuiRef?.focusedComponent !== editorFocus) return undefined;
				closeAllView(lastCtx);
				return { consume: true };
			});
		}
		timer = setInterval(() => {
			if (!lastCtx) return;
			update(lastCtx).catch(() => {}); // keeps the countdown ticking
			if (allOpen) refreshAll(lastCtx).catch(() => {}); // keeps every row fresh
		}, REFRESH_INTERVAL_MS);
		timer.unref?.(); // never keep the process alive just for the refresh timer
		void update(ctx).catch(() => {});
	});

	pi.on("model_select", (_event, ctx) => {
		lastCtx = ctx;
		void update(ctx).catch(() => {}); // background only — never block the switch
	});

	pi.on("session_shutdown", () => {
		stopTimer();
		unsubInput?.();
		unsubInput = null;
		allOpen = false;
	});

	pi.registerCommand("quota-all", {
		description: "Toggle the all-quota widget (Esc closes it)",
		handler: async (_args, ctx) => {
			if (allOpen) {
				closeAllView(ctx);
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify("The all-quota widget needs an interactive UI", "warning");
				return;
			}
			openAllView(ctx);
		},
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
