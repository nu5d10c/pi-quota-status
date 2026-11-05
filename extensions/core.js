/**
 * pi-quota-status — core.js
 *
 * Request + formatting logic for each provider's coding plan / balance API.
 * Pure module: imports nothing from pi, testable standalone.
 *
 * Endpoint contracts (verified 2026-02, cross-checked against pi-usage-meters,
 * pi-toolkit, OmniRoute and others):
 * - GLM global   GET https://api.z.ai/api/monitor/usage/quota/limit        (Authorization: Bearer <key>)
 * - GLM China    GET https://open.bigmodel.cn/api/monitor/usage/quota/limit (Authorization: <key>, raw)
 *     → { success, data: { level, limits: [{ unit, number, usage, currentValue, remaining, percentage, nextResetTime }] } }
 * - Codex        GET https://chatgpt.com/backend-api/wham/usage             (OAuth Bearer + ChatGPT-Account-Id)
 *     → { plan_type, rate_limit: { primary_window, secondary_window: { limit_window_seconds, used_percent, reset_at } }, credits }
 * - MiMo CN      GET https://platform.xiaomimimo.com/api/v1/tokenPlan/usage (console session cookie; tp- inference keys are rejected)
 *                GET https://platform.xiaomimimo.com/api/v1/tokenPlan/detail → planName + currentPeriodEnd
 *     → { code: 0, data: { usage: { items: [{ name, used, limit, percent }] }, monthUsage: { items: [...] } } }
 * - DeepSeek     GET https://api.deepseek.com/user/balance                  (Bearer; pay-as-you-go, balance only)
 *     → { is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }
 *
 * These endpoints are undocumented and may change at any time. Each request
 * fails independently and never affects the others.
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
			redirect: "error", // a quota endpoint never redirects; never carry a credential to a second host
			headers: { Accept: "application/json", ...headers },
		});
		if (!res.ok) {
			const err = new Error(`HTTP ${res.status}`);
			err.httpStatus = res.status;
			throw err;
		}
		const text = await res.text();
		if (text.length > MAX_BYTES) throw new Error("response too large");
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

// ─── Formatting ──────────────────────────────────────────────────────────────

export function fmtInt(n) {
	return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function fmtPct(p) {
	if (!Number.isFinite(p)) return "?";
	const v = Math.abs(p) >= 9.95 ? Math.round(p) : Math.round(p * 10) / 10;
	return `${v}%`;
}

/** Milliseconds → "3h12m" / "45m" / "4d6h" / "<1m" */
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
 * Unified result shape for all fetchers:
 * {
 *   plan?:  string       — plan name / level
 *   rows:   [{ label, percent?, used?, limit?, detail?, resetAt? }]
 *   hint?:  string       — shown when data cannot be fetched (team seat, missing cookie, ...)
 * }
 * resetAt is epoch milliseconds; percent is used-percentage 0–100.
 */

function row({ label, percent, used, limit, resetAt }) {
	const detail =
		Number.isFinite(used) && Number.isFinite(limit) && limit > 0
			? `${fmtInt(used)} / ${fmtInt(limit)}`
			: undefined;
	return { label, percent: Number.isFinite(percent) ? percent : undefined, detail, resetAt: resetAt || undefined };
}

// ─── GLM (api.z.ai global / open.bigmodel.cn China) ─────────────────────────

const GLM_UNITS = { 1: "min", 3: "h", 4: "d", 6: "7d", 7: "mo" };

function glmWindowLabel(limit) {
	const n = Number(limit?.number) || 1;
	const u = GLM_UNITS[limit?.unit] ?? `unit${limit?.unit}`;
	// unit labels that already embed a number ("7d") are used verbatim;
	// plain units compose with the count (5h, 1d, 30min)
	return /\d/.test(u) ? u : `${n}${u}`;
}

export async function fetchGlm(key, { host = "api.z.ai", scheme = "bearer" } = {}) {
	const data = await getJson(`https://${host}/api/monitor/usage/quota/limit`, {
		Authorization: scheme === "bearer" ? `Bearer ${key}` : key,
	});
	if (data && data.success === false) {
		const err = new Error(String(data.msg || "request failed"));
		err.noPlan = /coding plan/i.test(String(data.msg ?? ""));
		throw err;
	}
	const limits = data?.data?.limits;
	if (!Array.isArray(limits) || limits.length === 0) {
		// team seats need an organization ID to query; personal plans never land here
		return { plan: data?.data?.level, rows: [], hint: "team seat or no plan data (org ID required, not supported)" };
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

// ─── Codex (ChatGPT subscription) ────────────────────────────────────────────

export function codexAccountId(token) {
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
		return payload?.["https://api.openai.com/auth"]?.chatgpt_account_id || undefined;
	} catch {
		return undefined;
	}
}

function codexWindowLabel(seconds) {
	if (seconds >= 17000 && seconds <= 19000) return "5h";
	if (seconds >= 580000 && seconds <= 620000) return "7d";
	if (seconds > 0) return fmtCountdown(seconds * 1000) || `${seconds}s`;
	return "window";
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
	if (!rows.length) return { plan: usage?.plan_type, rows: [], hint: "no quota windows returned" };
	return { plan: usage?.plan_type, rows };
}

// ─── Xiaomi MiMo Token Plan (China only; console-cookie auth) ───────────────

const MIMO_BASE = "https://platform.xiaomimimo.com/api/v1";

/** The console returns naive "YYYY-MM-DD HH:mm:ss" wall time; parse as UTC. */
export function parseMimoTime(value) {
	if (typeof value !== "string") return undefined;
	const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(value.trim());
	if (!m) return undefined;
	const [, y, mo, d, h, mi, s] = m;
	const ts = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
	return Number.isFinite(ts) ? ts : undefined;
}

export const MIMO_COOKIE_HINT = "needs a console cookie: set XIAOMI_MIMO_CONSOLE_COOKIE (tp- inference keys cannot query usage)";

export async function fetchMimo(cookie) {
	const headers = { Cookie: cookie };
	const [usage, detail] = await Promise.all([
		getJson(`${MIMO_BASE}/tokenPlan/usage`, headers),
		getJsonOptional(`${MIMO_BASE}/tokenPlan/detail`, headers),
	]);
	if (usage?.code !== 0) {
		const err = new Error(String(usage?.message || "request failed"));
		err.httpStatus = 401; // an expired cookie reports as an auth failure
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
		rows.push(row({ label: "Bonus", percent: Number(comp.percent), used: Number(comp.used), limit: Number(comp.limit) }));
	const month = find(monthItems, "month_total_token");
	if (month)
		rows.push(row({ label: "mo", percent: Number(month.percent), used: Number(month.used), limit: Number(month.limit), resetAt: periodEnd }));
	if (!rows.length) return { plan: detail?.data?.planName, rows: [], hint: "no usage rows returned" };
	return { plan: detail?.data?.planName, rows };
}

// ─── DeepSeek (pay-as-you-go balance) ────────────────────────────────────────

// Emoji markers: 💰 = balance/pay-as-you-go, 🟢🟡🔴 = coding-plan usage level
const CURRENCY_SYMBOLS = { CNY: "¥", USD: "$", EUR: "€", GBP: "£", SGD: "S$", HKD: "HK$" };

export async function fetchDeepseek(key) {
	const data = await getJson("https://api.deepseek.com/user/balance", { Authorization: `Bearer ${key}` });
	const infos = Array.isArray(data?.balance_infos) ? data.balance_infos : [];
	const rows = infos
		.map((bi) => {
			const n = Number(bi.total_balance);
			return {
				label: CURRENCY_SYMBOLS[bi.currency] ?? bi.currency ?? "?",
				detail: Number.isFinite(n) ? fmtInt(n) : String(bi.total_balance ?? "?"),
				numeric: Number.isFinite(n) ? n : 0,
			};
		})
		// DeepSeek returns one wallet per currency (CNY for the CN platform, USD for
		// the international one). Drop zero wallets unless every wallet is empty.
		.filter((r) => r.numeric > 0 || !infos.some((bi) => Number(bi.total_balance) > 0))
		.map(({ numeric, ...r }) => r);
	if (!rows.length) return { rows: [], hint: "no balance returned" };
	return { rows };
}

// ─── Rendering ───────────────────────────────────────────────────────────────

/** Pad to a visible width (CJK counts as 2 columns) so detail rows align. */
function padLabel(label, width) {
	const w = [...label].reduce((a, c) => a + (c.codePointAt(0) > 0x2e7f ? 2 : 1), 0);
	return label + " ".repeat(Math.max(0, width - w));
}

/** Usage level → theme color name. */
export function levelColor(percent) {
	return percent >= 90 ? "error" : percent >= 70 ? "warning" : "success";
}

/** Usage level → emoji: 🟢 <70% 🟡 <90% 🔴 ≥90% */
export function loadEmoji(percent) {
	if (!Number.isFinite(percent)) return "💰";
	return percent >= 90 ? "🔴" : percent >= 70 ? "🟡" : "🟢";
}

/** Emoji meter for the detail rows. */
function barEmoji(percent) {
	const filled = Math.max(0, Math.min(10, Math.round((percent || 0) / 10)));
	const cell = percent >= 90 ? "🟥" : percent >= 70 ? "🟨" : "🟩";
	return cell.repeat(filled) + "⬜".repeat(10 - filled);
}

function countdownText(r) {
	if (r.resetAt) return `⏳${fmtCountdown(r.resetAt - Date.now())}`;
	return null;
}

function rowText(r, { compact = true } = {}) {
	if (r.percent !== undefined) {
		const countdown = countdownText(r);
		if (!compact) {
			const parts = [`${padLabel(r.label, 5)} ${barEmoji(r.percent)} ${fmtPct(r.percent).padStart(5)}`];
			if (r.detail) parts.push(r.detail);
			if (countdown) parts.push(`⏳${countdown}`);
			return parts.join("  ");
		}
		return `${r.label} ${fmtPct(r.percent)}${countdown ? ` ⏳${countdown}` : ""}`;
	}
	return r.detail ? `${r.label} ${r.detail}` : r.label;
}

/** One status line: 🟢 GLM·max 5h 1% ⏳3h12m | week 0.4% ⏳4d6h */
export function renderStatus(label, entry) {
	const head = label + (entry.plan ? `·${entry.plan}` : "");
	if (entry.error) return `⛔ ${head} ${entry.error}`;
	if (entry.hint && !entry.rows?.length) return `💡 ${head} ${entry.hint}`;
	const body = (entry.rows ?? []).map((r) => rowText(r)).join(" | ");
	if (!body) return `💡 ${head} ${entry.hint ?? "no data"}`;
	const worst = Math.max(...(entry.rows ?? []).map((r) => Number(r.percent) || 0));
	return `${loadEmoji(worst)} ${head} ${body}`;
}

/**
 * Widget rendering (theme colors). Compact = one line; expanded = multi-row.
 * Returns ANSI-bearing lines; the caller truncates with truncateToWidth.
 */
export function renderWidget(label, entry, { expanded = false } = {}, theme) {
	if (!entry) return [theme.fg("dim", `checking…`)];
	const plan = entry.plan ? theme.fg("text", entry.plan) : "";
	const head = label + (entry.plan ? `·${entry.plan}` : "");
	if (entry.error) return [theme.fg("error", `⛔ ${head} ${entry.error}`)];
	if (entry.hint && (!entry.rows?.length || !expanded))
		return [theme.fg("warning", `💡 ${head} ${entry.hint}`)];

	const rows = entry.rows ?? [];
	// signal light 🟢🟡🔴 for usage windows, 💰 for balance/pay-as-you-go rows
	const hasUsage = rows.some((r) => r.percent !== undefined);
	const icon = hasUsage ? loadEmoji(Math.max(...rows.map((r) => Number(r.percent) || 0))) : "💰";
	if (!expanded) {
		const body = rows
			.map((r) => {
				if (r.percent === undefined)
					return theme.fg("text", `${r.label} ${r.detail ?? r.label}`);
				const countdown = countdownText(r);
				const main = theme.fg(levelColor(r.percent), `${r.label} ${fmtPct(r.percent)}`);
				return countdown ? `${main} ${theme.fg("dim", countdown)}` : main;
			})
			.join(theme.fg("dim", " | "));
		return [`${[icon, plan, body].filter(Boolean).join(" ")}`];
	}

	const first = [plan, entry.hint ? `💡 ${entry.hint}` : ""].filter(Boolean).join("  ");
	const lines = first ? [theme.fg("muted", first)] : [];
	for (const r of rows) {
		if (r.percent === undefined) {
			lines.push(`  ${theme.fg("text", `${r.label} ${r.detail ?? ""}`)}`);
			continue;
		}
		const filled = Math.max(0, Math.min(10, Math.round((r.percent || 0) / 10)));
		const bar =
			theme.fg(levelColor(r.percent), "█".repeat(filled)) +
			theme.fg("dim", "░".repeat(10 - filled));
		const countdown = countdownText(r);
		const parts = [
			theme.fg("dim", padLabel(r.label, 5)),
			bar,
			theme.fg(levelColor(r.percent), fmtPct(r.percent).padStart(5)),
		];
		if (r.detail) parts.push(theme.fg("muted", r.detail));
		if (countdown) parts.push(theme.fg("dim", countdown));
		lines.push("  " + parts.join("  "));
	}
	return lines;
}

/** Multi-line detail (kept for tests / alternative UIs). */
export function renderDetail(label, entry) {
	const lines = [];
	const head = `${label}${entry.plan ? ` (${entry.plan})` : ""}${entry.error ? ` — ${entry.error}` : ""}`;
	lines.push(head);
	if (entry.hint) lines.push(`  💡 ${entry.hint}`);
	for (const r of entry.rows ?? []) lines.push(`  ${rowText(r, { compact: false })}`);
	if (!entry.rows?.length && !entry.hint && !entry.error) lines.push("  no data");
	return lines;
}

/** Error → short human-readable phrase. */
export function describeError(err) {
	if (err?.name === "AbortError") return "timed out";
	if (err?.httpStatus === 401 || err?.httpStatus === 403) return "auth failed (invalid or expired key)";
	if (err?.noPlan) return "no coding plan (pay-as-you-go)";
	const msg = String(err?.message ?? "unknown error").slice(0, 40);
	return msg;
}
