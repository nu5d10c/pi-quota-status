# pi-quota-status

[Pi](https://pi.dev) extension: replaces the default footer with two lines — **cwd**, then **cache hit rate · context usage · plan quota** with the model right-aligned.

```
📁 ~/Github/pi-quota-status
⚡95.3%  📶12.3%/200k  💰 5h 1% (3h12m) | 7d 0.4% (4d6h)          🧠 (zai) glm-5 • high
```

Emoji markers: 📁 cwd · ⚡ cache hit rate · 📶 context (dim → warning >70% → error >90%) ·
💰 quota — plan windows show `time (countdown)`, balance shows a plain number · 🧠 model
(provider shown only when >1 provider available).
- `/quota` shows the multi-row detail (emoji meter, used/total, reset countdown) and force-refreshes
- Fetches are async and cached (60s); rendering never blocks on the network
- The quota part follows model switches; for unsupported providers the line shows only CH + context
- Auto-refreshes every 60s; one provider failing never affects the others

## Supported providers

| Provider (pi id) | Shows | Credentials |
|---|---|---|
| `zai` — GLM global | 5h / weekly window usage + reset countdown + plan level | API key from pi's credential store |
| `zai-coding-cn` — GLM China | Same (pay-as-you-go keys show "no coding plan") | API key from pi's credential store |
| `openai-codex` | 5h / weekly window usage + reset countdown + credits | pi OAuth (`/login openai-codex`) |
| `xiaomi-token-plan-cn` — MiMo China | Plan / bonus / monthly usage + period end | Console session cookie (see below) |
| `deepseek` | Account balance (pay-as-you-go, no reset window) | API key from pi's credential store |

## Install

```bash
pi install git:github.com/nu5d10c/pi-quota-status
```

For local development:

```bash
pi -e ./pi-quota-status
```

## MiMo notes

MiMo Token Plan usage lives behind Xiaomi SSO; the `tp-`/`mk-` inference key cannot query it. You need the browser console session cookie:

1. Log in to [platform.xiaomimimo.com](https://platform.xiaomimimo.com)
2. Open DevTools → Network, reload, find a request to `platform.xiaomimimo.com`
3. Copy the full `Cookie` request header value
4. `export XIAOMI_MIMO_CONSOLE_COOKIE='<paste>'` (put it in your shell config)

The cookie expires with the browser session; when it does, the status shows the hint again.

## Known limitations

- **GLM team seats**: querying requires an organization ID, which is not supported; the status shows a hint instead of an error.
- The GLM / Codex quota endpoints are undocumented; official changes will require an update here.
- DeepSeek is a topped-up balance with no "reset" concept — only the balance is shown.

## Privacy

Credentials are read only from pi's own credential store (`~/.pi/agent/auth.json` / OAuth) and sent only to the matching issuer's quota endpoint — GLM keys only to z.ai / bigmodel.cn, the Codex token only to chatgpt.com. Never sent to third parties, never logged, never entered into model context.

## License

MIT
