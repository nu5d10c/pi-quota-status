/**
 * pi-quota-status — core.js
 *
 * 各家 Coding Plan / 余额接口的请求与格式化逻辑。
 * 纯函数模块,不 import pi 的任何内容,可独立测试。
 *
 * 契约(2026-02 实测 / 对照 pi-usage-meters、pi-toolkit、OmniRoute 等实现):
 * - GLM 国际站  GET https://api.z.ai/api/monitor/usage/quota/limit        (Authorization: Bearer <key>)
 * - GLM 国内站  GET https://open.bigmodel.cn/api/monitor/usage/quota/limit (Authorization: <key> 裸 key)
 *     → { success, data: { level, limits: [{ unit, number, usage, currentValue, remaining, percentage, nextResetTime }] } }
 * - Codex       GET https://chatgpt.com/backend-api/wham/usage             (OAuth Bearer + ChatGPT-Account-Id)
 *     → { plan_type, rate_limit: { primary_window, secondary_window: { limit_window_seconds, used_percent, reset_at } }, credits }
 * - MiMo CN     GET https://platform.xiaomimimo.com/api/v1/tokenPlan/usage (控制台会话 Cookie,tp- 推理 key 无效)
 *               GET https://platform.xiaomimimo.com/api/v1/tokenPlan/detail → planName + currentPeriodEnd
 *     → { code: 0, data: { usage: { items: [{ name, used, limit, percent }] }, monthUsage: { items: [...] } } }
 * - DeepSeek    GET https://api.deepseek.com/user/balance                  (Bearer,按量计费,只有余额)
 *     → { is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }
 *
 * 这些接口均未公开文档化,可能随时变动;每个请求独立失败,不互相影响。
 */

export const TIMEOUT_MS = 8000;
const MAX_BYTES = 64 * 1024;

// ─── HTTP ────────────────────────────────────────────────────────────────────

async function getJson(url, headers = {}, timeoutMs = TIMEOUT_MS) {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(url, {
			signal: ctrl.signal,
			redirect: "error", // 额度接口不应重定向;绝不把凭据带到第二个主机
			headers: { Accept: "application/json", ...headers },
		});
		if (!res.ok) {
			const err = new Error(`HTTP ${res.status}`);
			err.httpStatus = res.status;
			throw err;
		}
		const text = await res.text();
		if (text.length > MAX_BYTES) throw new Error("响应过大");
		return JSON.parse(text);
	} finally {
		clearTimeout(timer);
	}
}

async function getJsonOptional(url, headers = {}) {
	try {
		return await getJson(url, headers);
	} catch {
		return null;
	}
}

// ─── 格式化 ──────────────────────────────────────────────────────────────────

export function fmtInt(n) {
	return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function fmtPct(p) {
	if (!Number.isFinite(p)) return "?";
	const v = Math.abs(p) >= 9.95 ? Math.round(p) : Math.round(p * 10) / 10;
	return `${v}%`;
}

/** 毫秒 → "3h12m" / "45m" / "4d6h" / "<1m" */
export function fmtCountdown(ms) {
	if (!Number.isFinite(ms) || ms <= 0) return null;
	const m = Math.floor(ms / 60000);
	if (m < 1) return "<1m";
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	const rm = m % 60;
	if (h < 48) return rm ? `${h}h${rm}m` : `${h}h`;
	const d = Math.floor(h / 24);
	return `${d}d${h % 24 ? `${h % 24}h` : ""}`;
}

/**
 * 结果形状(所有 fetcher 统一):
 * {
 *   plan?:  string       — 套餐名 / 等级
 *   rows:   [{ label, percent?, used?, limit?, detail?, resetAt? }]
 *   hint?:  string       — 拿不到数据时的提示(团队席位、缺少 Cookie 等)
 * }
 * resetAt 为 epoch 毫秒;percent 为 0–100 的已用百分比。
 */

function row({ label, percent, used, limit, resetAt }) {
	const detail =
		Number.isFinite(used) && Number.isFinite(limit) && limit > 0
			? `${fmtInt(used)} / ${fmtInt(limit)}`
			: undefined;
	return { label, percent: Number.isFinite(percent) ? percent : undefined, detail, resetAt: resetAt || undefined };
}

// ─── GLM(z.ai 国际站 / open.bigmodel.cn 国内站)─────────────────────────────

const GLM_UNITS = { 1: "min", 3: "h", 4: "天", 6: "周", 7: "月" };

function glmWindowLabel(limit) {
	const n = Number(limit?.number) || 1;
	const u = GLM_UNITS[limit?.unit] ?? `unit${limit?.unit}`;
	// 1 周 / 1 天 / 1 月省略数字,5h 保留
	return n === 1 && !/\d/.test(u) ? u : `${n}${u}`;
}

export async function fetchGlm(key, { host = "api.z.ai", scheme = "bearer" } = {}) {
	const data = await getJson(`https://${host}/api/monitor/usage/quota/limit`, {
		Authorization: scheme === "bearer" ? `Bearer ${key}` : key,
	});
	if (data && data.success === false) {
		const err = new Error(String(data.msg || "接口返回失败"));
		err.noPlan = /coding plan/i.test(String(data.msg ?? ""));
		throw err;
	}
	const limits = data?.data?.limits;
	if (!Array.isArray(limits) || limits.length === 0) {
		// 团队席位需要组织 ID 才能查询,个人套餐不会走到这里
		return { plan: data?.data?.level, rows: [], hint: "团队席位或无套餐数据(缺少组织 ID,暂无法查询)" };
	}
	return {
		plan: data?.data?.level,
		rows: limits.map((l) =>
			row({
				label: glmWindowLabel(l),
				percent: Number(l.percentage),
				used: Number(l.currentValue),
				limit: Number(l.usage),
				resetAt: Number(l.nextResetTime),
			}),
		),
	};
}

// ─── Codex(ChatGPT 订阅)────────────────────────────────────────────────────

export function codexAccountId(token) {
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
		return payload?.["https://api.openai.com/auth"]?.chatgpt_account_id || undefined;
	} catch {
		return undefined;
	}
}

function codexWindowLabel(seconds) {
	if (seconds >= 17000 && seconds <= 19000) return "5小时";
	if (seconds >= 580000 && seconds <= 620000) return "周";
	if (seconds > 0) return fmtCountdown(seconds * 1000) || `${seconds}s`;
	return "窗口";
}

export async function fetchCodex(token) {
	const headers = { Authorization: `Bearer ${token}` };
	const accountId = codexAccountId(token);
	if (accountId) headers["ChatGPT-Account-Id"] = accountId;
	const usage = await getJson("https://chatgpt.com/backend-api/wham/usage", headers);
	const rows = [];
	for (const w of [usage?.rate_limit?.primary_window, usage?.rate_limit?.secondary_window]) {
		if (!w) continue;
		rows.push(
			row({
				label: codexWindowLabel(Number(w.limit_window_seconds) || 0),
				percent: Number(w.used_percent),
				resetAt: Number(w.reset_at) ? Number(w.reset_at) * 1000 : undefined,
			}),
		);
	}
	const credits = usage?.credits;
	if (credits?.has_credits === true && Number.isFinite(Number(credits.balance))) {
		rows.push({ label: "Credits", detail: `${Number(credits.balance)}`, resetAt: undefined });
	}
	if (!rows.length) return { plan: usage?.plan_type, rows: [], hint: "未返回额度窗口" };
	return { plan: usage?.plan_type, rows };
}

// ─── 小米 MiMo Token Plan(仅国内;控制台 Cookie 认证)────────────────────────

const MIMO_BASE = "https://platform.xiaomimimo.com/api/v1";

/** 控制台返回的 "YYYY-MM-DD HH:mm:ss" 视为 UTC 解析 */
export function parseMimoTime(value) {
	if (typeof value !== "string") return undefined;
	const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(value.trim());
	if (!m) return undefined;
	const [, y, mo, d, h, mi, s] = m;
	const ts = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
	return Number.isFinite(ts) ? ts : undefined;
}

export const MIMO_COOKIE_HINT = "需控制台 Cookie:设置 XIAOMI_MIMO_CONSOLE_COOKIE(tp- 推理 key 无法查询)";

export async function fetchMimo(cookie) {
	const headers = { Cookie: cookie };
	const [usage, detail] = await Promise.all([
		getJson(`${MIMO_BASE}/tokenPlan/usage`, headers),
		getJsonOptional(`${MIMO_BASE}/tokenPlan/detail`, headers),
	]);
	if (usage?.code !== 0) {
		const err = new Error(String(usage?.message || "接口返回失败"));
		err.httpStatus = 401; // Cookie 失效时按鉴权失败提示
		throw err;
	}
	const find = (list, name) => (Array.isArray(list) ? list : []).find((i) => i?.name === name);
	const planItems = usage?.data?.usage?.items;
	const monthItems = usage?.data?.monthUsage?.items;
	const periodEnd = parseMimoTime(detail?.data?.currentPeriodEnd);
	const rows = [];
	const plan = find(planItems, "plan_total_token");
	if (plan) rows.push(row({ label: "Plan", percent: Number(plan.percent), used: Number(plan.used), limit: Number(plan.limit) }));
	const comp = find(planItems, "compensation_total_token");
	if (comp && Number(comp.limit) > 0)
		rows.push(row({ label: "补偿", percent: Number(comp.percent), used: Number(comp.used), limit: Number(comp.limit) }));
	const month = find(monthItems, "month_total_token");
	if (month)
		rows.push(row({ label: "月", percent: Number(month.percent), used: Number(month.used), limit: Number(month.limit), resetAt: periodEnd }));
	if (!rows.length) return { plan: detail?.data?.planName, rows: [], hint: "未返回用量数据" };
	return { plan: detail?.data?.planName, rows };
}

// ─── DeepSeek(按量计费余额)──────────────────────────────────────────────────

const CURRENCY_SYMBOLS = { CNY: "¥", USD: "$", EUR: "€", GBP: "£", SGD: "S$", HKD: "HK$" };

export async function fetchDeepseek(key) {
	const data = await getJson("https://api.deepseek.com/user/balance", { Authorization: `Bearer ${key}` });
	const infos = Array.isArray(data?.balance_infos) ? data.balance_infos : [];
	const rows = infos.map((bi) => {
		const n = Number(bi.total_balance);
		return {
			label: CURRENCY_SYMBOLS[bi.currency] ?? bi.currency ?? "?",
			detail: Number.isFinite(n) ? fmtInt(n) : String(bi.total_balance ?? "?"),
		};
	});
	if (!rows.length) return { rows: [], hint: "未返回余额" };
	return { rows };
}

// ─── 渲染 ────────────────────────────────────────────────────────────────────

/** 按可见宽度补空格(CJK 记 2 列),让详情行对齐 */
function padLabel(label, width) {
	const w = [...label].reduce((a, c) => a + (c.codePointAt(0) > 0x2e7f ? 2 : 1), 0);
	return label + " ".repeat(Math.max(0, width - w));
}

function rowText(r, { compact = true } = {}) {
	if (r.percent !== undefined) {
		const countdown = r.resetAt ? fmtCountdown(r.resetAt - Date.now()) : null;
		if (!compact) {
			const filled = Math.max(0, Math.min(10, Math.round((r.percent || 0) / 10)));
			const bar = "█".repeat(filled) + "░".repeat(10 - filled);
			const parts = [`${padLabel(r.label, 5)} ${bar} ${fmtPct(r.percent).padStart(5)}`];
			if (r.detail) parts.push(r.detail);
			if (countdown) parts.push(`⟳${countdown}后刷新`);
			return parts.join("  ");
		}
		return `${r.label} ${fmtPct(r.percent)}${countdown ? `⟳${countdown}` : ""}`;
	}
	return r.detail ? `${r.label} ${r.detail}` : r.label;
}

/** 状态栏一行:GLM·max 5h 1%⟳3h12m · 周 0.4%⟳4d6h */
export function renderStatus(label, entry) {
	const head = label + (entry.plan ? `·${entry.plan}` : "");
	if (entry.error) return `${head} ${entry.error}`;
	if (entry.hint && !entry.rows?.length) return `${head} ${entry.hint}`;
	const body = (entry.rows ?? []).map((r) => rowText(r)).join(" · ");
	if (!body) return `${head} ${entry.hint ?? "无数据"}`;
	const warn = (entry.rows ?? []).some((r) => Number(r.percent) >= 90) ? "⚠ " : "";
	return `${warn}${head} ${body}`;
}

/** /quota 命令的多行详情 */
export function renderDetail(label, entry) {
	const lines = [];
	const head = `${label}${entry.plan ? ` (${entry.plan})` : ""}${entry.error ? ` — ${entry.error}` : ""}`;
	lines.push(head);
	if (entry.hint) lines.push(`  ⚠ ${entry.hint}`);
	for (const r of entry.rows ?? []) lines.push(`  ${rowText(r, { compact: false })}`);
	if (!entry.rows?.length && !entry.hint && !entry.error) lines.push("  无数据");
	return lines;
}

/** 错误 → 人类可读短语 */
export function describeError(err) {
	if (err?.name === "AbortError") return "超时";
	if (err?.httpStatus === 401 || err?.httpStatus === 403) return "鉴权失败(key 无效或过期)";
	if (err?.noPlan) return "无 Coding Plan 套餐(按量计费)";
	const msg = String(err?.message ?? "未知错误").slice(0, 40);
	return msg;
}
