/**
 * pi-quota-status — index.js
 *
 * pi 扩展:使用对应模型的 provider 时,在状态栏显示该套餐的额度与刷新倒计时。
 *
 * 支持:
 *   zai                    → GLM Coding Plan 国际站(api.z.ai)
 *   zai-coding-cn          → GLM Coding Plan 国内站(open.bigmodel.cn)
 *   openai-codex           → Codex(ChatGPT 订阅,OAuth)
 *   xiaomi-token-plan-cn   → 小米 MiMo Token Plan 国内站(需控制台 Cookie)
 *   deepseek               → DeepSeek 账户余额(按量计费)
 *
 * key 全部取自 pi 自己的凭据存储(ctx.modelRegistry.getProviderAuth),
 * 每个 key 只发往其所属厂商的额度接口,不落日志、不进模型上下文。
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
			if (!auth.key) return { rows: [], hint: "未配置 API key(/login zai 或环境变量)" };
			return fetchGlm(auth.key, { host: "api.z.ai", scheme: "bearer" });
		},
	},
	"zai-coding-cn": {
		label: "GLM-CN",
		fetch: (auth) => {
			if (!auth.key) return { rows: [], hint: "未配置 API key" };
			return fetchGlm(auth.key, { host: "open.bigmodel.cn", scheme: "raw" });
		},
	},
	"openai-codex": {
		label: "Codex",
		fetch: (auth) => {
			if (!auth.token) return { rows: [], hint: "未登录:运行 /login openai-codex" };
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
			if (!auth.key) return { rows: [], hint: "未配置 API key" };
			return fetchDeepseek(auth.key);
		},
	},
};

/**
 * 从 pi 凭据存储解析认证。兼容多种返回形状:
 *   { source, auth: { apiKey } }          — API key
 *   { source: "OAuth", auth: { apiKey | headers } } — OAuth,token 在 apiKey 或 headers.authorization
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
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		try {
			const entry = await refresh(providerId, ctx, force);
			ctx.ui.setStatus(STATUS_KEY, renderStatus(spec.label, entry));
		} catch {
			// refresh 不应抛出;保险起见不更新状态栏
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
			if (lastCtx) update(lastCtx); // 定时刷新,让刷新倒计时保持走动
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
		description: "查看当前模型的套餐额度与刷新时间",
		handler: async (_args, ctx) => {
			const providerId = ctx.model?.provider;
			const spec = providerId ? PROVIDERS[providerId] : undefined;
			if (!spec) {
				ctx.ui.notify(
					`当前模型 ${ctx.model?.provider ?? "?"} 不在监控范围\n支持:zai · zai-coding-cn · openai-codex · xiaomi-token-plan-cn · deepseek`,
					"warning",
				);
				return;
			}
			const entry = await refresh(providerId, ctx, true);
			const lines = renderDetail(spec.label, entry);
			ctx.ui.notify(lines.join("\n"), entry.error ? "warning" : "info");
			await update(ctx, { force: true });
		},
	});
}
