# pi-quota-status

[pi](https://pi.dev) 扩展:使用对应模型时,在**输入框上方的 widget** 实时显示该套餐的额度与刷新倒计时。

```
🟢 GLM·max 5h 1% ⏳3h12m | 周 0.4% ⏳4d6h
```

- 运行 `/quota` 展开多行详情(彩色用量条 + 已用/总量 + 刷新倒计时),再跑一次收起
- 用量等级:🟢 <70% · 🟡 <90% · 🔴 ≥90%,文字部分按主题配色(success/warning/error);`⛔` 为查询失败,`💡` 为提示(如团队席位、缺少 Cookie)
- 切换模型时 widget 自动跟着切换;不在上述范围的 provider 时 widget 零高度、不占空间

## 支持

| Provider(pi 中的 id) | 显示内容 | 凭据来源 |
|---|---|---|
| `zai` — GLM 国际站 | 5h / 周窗口用量 + 刷新倒计时 + 套餐等级 | pi 凭据存储的 API key |
| `zai-coding-cn` — GLM 国内站 | 同上(按量 key 会显示「无套餐」) | pi 凭据存储的 API key |
| `openai-codex` | 5h / 周窗口用量 + 刷新倒计时 + Credits | pi OAuth(`/login openai-codex`) |
| `xiaomi-token-plan-cn` — MiMo 国内 | Plan / 补偿 / 月用量 + 周期截止 | 控制台会话 Cookie(见下) |
| `deepseek` | 账户余额(按量计费,无刷新窗口) | pi 凭据存储的 API key |

切换模型时状态栏自动跟着切换;不在上述范围的 provider 会清空状态栏。
每 60s 自动刷新,数据缓存 60s,单个 provider 失败不影响其他。

## 安装

```bash
pi install git:github.com/nu5d10c/pi-quota-status
```

本地开发:

```bash
pi -e ./pi-quota-status
```

会话内运行 `/quota` 展开多行详情,再跑一次收起;每次运行都会强制刷新数据。

## MiMo 说明

MiMo Token Plan 的用量接口在小米 SSO 之后,`tp-`/`mk-` 推理 key 无法查询,
需要浏览器控制台的会话 Cookie:

1. 登录 [platform.xiaomimimo.com](https://platform.xiaomimimo.com)
2. F12 → Network,刷新页面,找一个发往 `platform.xiaomimimo.com` 的请求
3. 复制 Request Headers 里完整的 `Cookie` 值
4. `export XIAOMI_MIMO_CONSOLE_COOKIE='<粘贴>'`(建议写进 fish/env 配置)

Cookie 随浏览器会话过期,过期后状态栏会重新提示。

## 已知限制

- **GLM 团队席位**:查询需要组织 ID,本扩展暂不支持,状态栏会显示提示而不是报错。
- GLM / Codex 的额度接口未公开文档化,若官方调整会需要跟进更新。
- DeepSeek 为充值制余额,没有「刷新时间」概念,只显示余额。

## 隐私

凭据仅从 pi 自己的凭据存储(`~/.pi/agent/auth.json` / OAuth)读取,
且只发往对应厂商的额度接口——GLM key 只发 z.ai / bigmodel.cn,
Codex token 只发 chatgpt.com,绝不发往第三方、不写日志、不进模型上下文。

## License

MIT
