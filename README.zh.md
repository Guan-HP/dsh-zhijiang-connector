# dsh-zhijiang-connector

[English](README.md) | 中文

把 [开物云](https://ai.zhijianginc.com)（New API 中转站）的**余额、消耗与充值入口**接入 DeepSeek Harness 的 Web GUI：侧边栏常驻徽标，点击展开面板，余额不足时自动变色。

本插件回答的是一个 dsh 内置用量统计回答不了的问题：**我在这个站上还剩多少钱、还能撑多久。**

## 功能

- **侧栏徽标**：`开物云 ¥16.80`，随严重程度变黄 / 变红。
- **浮层面板**：余额、已用、近 24 小时消耗、日均消耗、**可用天数**、密钥名、到期时间。
- **充值入口**：一键打开站点钱包页；插件不接触任何支付信息。
- **双通道读取**：优先账户级余额（PAT），无 PAT 时用 `sk-` 密钥读该密钥额度。
- **降级不空白**：上游超时 / 限流时保留上次成功值并标注「数据已过期」。
- **换算不硬编码**：每次刷新都从 `/api/status` 读 `quota_per_unit` 与汇率。

## 明确不做

- 不做内嵌支付、代付或兑换码核销（插件不应持有登录态与支付凭据）。
- 不新增独立页面路由（dsh 的静态前端独占 fallback 席位，插件只能做插槽与面板）。
- 不发探测性模型请求（会真实扣费），因此没有「模型连通性检测」。
- 不修改 `llm-pi-ai` 的 provider 配置（模型同步属于后续独立方案）。

## 安装

```powershell
# 从 npm 安装（推荐）
dsh plugin --profile web add dsh-zhijiang-connector

# 或从 git 仓库安装
dsh plugin --profile web add git+https://github.com/OWNER/dsh-zhijiang-connector.git
```

桌面端需先完全退出 Electron 再执行：

```powershell
dsh plugin --profile desktop add dsh-zhijiang-connector
```

安装后包会被写入 `$DSH_HOME/profiles/<profile>/package.json` 的 `dsh.profile.bundles`，并按其 `cordis.patch.yml` 挂载宿主半区。

## 配置

**两个框，一个保存按钮。**

1. 打开 Web GUI → 侧栏「设置」→「开物云」。
2. 粘贴 `sk-` 密钥到「API 密钥」，粘贴 `nap_` 令牌到「余额查询令牌」。
3. 点一次「保存」。余额立即出现在侧边栏，无需再点其他按钮。

站点地址、刷新间隔、预警阈值收在「▸ 高级设置」里，默认站点已正确，一般不需要展开。

凭据名（密钥存在凭据库里的哪个名字下）默认只读展示为「保存为：`zhijiangApiKey`」，点「更改」才能修改——多站点用户可以为每个站点指定不同的名字，普通用户则完全不必关心。**清除**是独立按钮，留空保存不会删除已有密钥。

| 配置项 | 默认 | 说明 |
|---|---|---|
| `baseURL` | `https://ai.zhijianginc.com` | 站点地址，热生效 |
| `credentialRef` | `zhijiangApiKey` | 存放 `sk-` 密钥的凭据名 |
| `accountCredentialRef` | 空 | 存放访问令牌（PAT）的凭据名；空则只用密钥通道。保存令牌后自动指向 `ZHIJIANG_ACCESS_TOKEN`，清除令牌时一并清空 |
| `accountUserId` | 空 | PAT 通道的 `new-api-user` 头（**仅 profile 可配**，设置页不提供） |
| `refreshSeconds` | `300` | 刷新间隔，最小 60 |
| `warningDays` | `3` | 剩余天数低于此值转黄 |
| `criticalDays` | `1` | 低于此值转红 |
| `showBadge` | `true` | 是否显示侧栏徽标（**仅 profile 可配**，设置页不提供） |
| `walletURL` | `<baseURL>/console/wallet` | 充值深链 |

**关于凭据**：推荐在开物云「安全与访问 → 访问令牌」新建一个**只勾选「用量:查看」+「钱包:查看」**的 PAT，而不是复用其他用途的令牌。密钥落在 `~/.dsh/.credentials.yaml`（明文，仅本用户可读）。

## HTTP 接口

`/api/zhijiang/` 下共 5 个路径，全部施加**回环围栏**（仅接受 loopback 对端）。两个只读、一个只写、两个同时响应 GET 与 POST。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/zhijiang/snapshot` | 读缓存或触发刷新，返回统一快照 |
| POST | `/api/zhijiang/refresh` | 强制刷新 |
| GET | `/api/zhijiang/status` | 健康检查与最近一次错误 |
| GET | `/api/zhijiang/credential` | 密钥与令牌是否已存（只报存在性，**永不返回值**） |
| POST | `/api/zhijiang/credential` | 保存或清除一个凭据（`kind: apiKey \| accessToken`） |
| GET | `/api/zhijiang/settings` | 读取解析后的可编辑配置 |
| POST | `/api/zhijiang/settings` | 校验、持久化并立即应用配置补丁 |

两个写入接口就是设置页用的那两个。请求体超过 8 KiB 会被拒绝；校验失败返回 400 并带**字段级** `reason`，而不是一句笼统的「保存失败」。**任何接口都不会返回密钥值**：`GET /credential` 只报 `configured` 与 `source`，所以截图或开发者工具抓包都拿不到密钥。

快照形状：

```json
{
  "ok": true,
  "fetchedAt": "2026-10-26T08:42:03.000Z",
  "stale": false,
  "source": "token",
  "site": { "name": "开物云", "baseURL": "https://ai.zhijianginc.com",
            "currency": "CNY", "quotaPerUnit": 500000, "exchangeRate": 7 },
  "balance": { "known": false, "remaining": null, "used": null, "total": null,
               "currency": "CNY", "unlimited": false, "expiresAt": null },
  "keyCap": { "unlimited": true, "granted": 33.6, "available": null,
              "currency": "CNY", "expiresAt": null },
  "label": "<密钥名>",
  "usage": { "last24h": null, "total": 33.6, "requests": null, "windowDays": null },
  "forecast": { "dailyAvg": null, "daysLeft": null, "level": "unknown" },
  "warnings": ["account-channel-not-configured"]
}
```

上面是**只配置了 `sk-` 密钥**时的真实快照。注意 `balance.known = false`、`remaining = null`：这不是错误，而是「当前凭据读不到钱包」。

`level` 取值 `normal` / `warning` / `critical` / `unknown`。**`unknown` 是一等公民**：新装插件没有消耗历史，此时不会谎报「剩余 0 天」。

## 两个通道：密钥额度 ≠ 账户余额

这是本插件最容易搞错、也已经专门修过的地方。

| 通道 | 接口 | 需要什么 | 能回答什么 |
|---|---|---|---|
| 密钥通道 | `GET /api/usage/token/` | `sk-` 密钥 | 这把密钥的额度上限、经它产生的消耗 |
| 账户通道 | `GET /api/user/self` | **访问令牌（PAT）** | 账户余额（钱包里还剩多少钱） |

**关键区别**：`/api/usage/token/` 返回的 `unlimited_quota: true` 意思是「**这把密钥没有额度上限**」，消费照旧从有限的账户余额里扣。两者可以同时成立：密钥「无限制」，账户余额却所剩无几。

因此：

- 只配 `sk-` 密钥时，插件**不显示余额**（显示 `—`），并提示补配访问令牌；
- 密钥自身的「无上限」单独显示在「密钥额度」一行，不会冒充余额；
- `sk-` 密钥读 `/api/user/self` 会得到 **401**，这是站点设计，不是配置错误。

要看到图一那样的真实余额，请在开物云「安全与访问 → 访问令牌」新建一个只勾选「用量:查看 + 钱包:查看」的 PAT，填入设置页的「账户令牌引用名」。

## 换算规则

```
金额 = 原始 quota / quota_per_unit × 汇率
```

开物云实测值：`quota_per_unit = 500000`、`quota_display_type = CNY`、`usd_exchange_rate = 7`。
CNY 制式下若站点未给汇率，插件**报错并回退缓存**，不会猜测默认值——猜错会让所有金额静默失真。

## 目录结构

```
lib/normalize.js   纯函数：原始响应 → 统一快照（唯一做换算的地方）
lib/upstream.js    唯一发网络请求的模块
lib/cache.js       唯一读写磁盘的模块（$DSH_HOME/storages/zhijiang-connector.json）
lib/service.js     编排：通道选择、降级、陈旧判定、消耗采样
lib/routes.js      序列化 + 回环围栏
lib/config.js      配置 schema 与安全默认值
lib/index.js       宿主入口：name / inject / apply
lib/client.js      浏览器半区（预构建 __ModuleLoader__ bundle）
```

职责是单向的：`upstream` 不做换算，`normalize` 不做 I/O，`routes` 不做业务判断。这样换算逻辑可以离线单测，新增通道只需在 `upstream` 加一个函数。

## 依赖

- 宿主服务：`webServer`、`credentials`、`settings`
- 客户端服务：`slots`
- peer：`@deepseek-ai/dsh` `>=0.2.1-rc.1 <0.3.0-0`（开发与验证于 0.2.1-rc.3）
- 第三方运行时依赖：**无**（仅 Node 内置 `fetch` / `fs` / `path` / `os`）

与 `@ychris12138/dsh-usage-stats`、`dsh-token-usage` 等用量插件**功能不重叠**：那些统计本地 token 与估算成本，本插件读站点真实账单。二者可并存，各自占用 `sidebar.footer.action` 的不同 `order`。

## 开发

```powershell
npm run check   # 语法检查全部文件
npm test        # 47 项测试：换算 / 降级 / 陈旧 / 路由 / 回环围栏
```

`npm run test:live` 与 `npm run verify:account` 会用凭据库里的真实凭据驱动真实服务打真实站点，只打印派生数值，不打印密钥。

`lib/client.js` 是手写 bundle，**改动后需重新安装或重启**；宿主侧 `lib/*.js` 在启用 HMR 的 profile 下可热重载。

## 已知限制

- 请求数（`requests`）目前返回 `null`：New API 没有轻量的单次查询接口，站点概览里的计数来自另一条数据链路。留待后续方案补齐。
- 面板不显示账户分组倍率与峰谷价明细，这些属于「用量看板」方案的范畴。
- 无上限密钥在花超授权额度后，`total_available` 会变成负数（实测于真实站点：`total_granted` 很小、`total_used` 远大于它、`total_available` 为负）。负数不是额度，插件会丢弃它而不是把它当成负的上限显示。
- 一个实例读一个站点。多站点需要为每个站点在不同引用名下各存一份凭据，但设置页一次只编辑一个。

## License

MIT
