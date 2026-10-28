# dsh-zhijiang-connector

English | [中文](README.zh.md)

Brings the **balance, spend and top-up entry point** of [Kaiwu Cloud](https://ai.zhijianginc.com) (a New API relay) into the DeepSeek Harness web GUI: a persistent sidebar badge, a floating panel on click, and a colour change when the balance runs low.

This plugin answers a question the built-in usage statistics cannot: **how much money is left on this site, and how long will it last.**

## Features

- **Sidebar badge**: `开物云 ¥16.80`, turning amber or red with severity.
- **Floating panel**: balance, used, last 24 hours, daily average, **runway in days**, key name, expiry.
- **Top-up entry**: one click opens the site's wallet page; the plugin never touches payment data.
- **Two read channels**: account-level balance via a dashboard access token (PAT) when configured, otherwise the `sk-` key's own quota.
- **Degrades without blanking**: on timeout or rate limiting the last good value stays visible, marked stale.
- **No hard-coded conversion**: `quota_per_unit` and the exchange rate are re-read from `/api/status` on every refresh.

## Explicitly out of scope

- No embedded payment, proxy payment or redemption-code handling — a plugin should hold neither a login session nor payment credentials.
- No new standalone page routes; the harness's static frontend owns the fallback seat, so plugins contribute slots and panels only.
- No probe requests to models (they cost real money), hence no "model connectivity check".
- No edits to `llm-pi-ai` provider configuration; model syncing is a separate proposal.

## Install

```powershell
# From npm (recommended)
dsh plugin --profile web add dsh-zhijiang-connector

# Or from the git repository
dsh plugin --profile web add git+https://github.com/OWNER/dsh-zhijiang-connector.git
```

For the desktop app, quit Electron completely first:

```powershell
dsh plugin --profile desktop add dsh-zhijiang-connector
```

Installation records the package in `$DSH_HOME/profiles/<profile>/package.json` under `dsh.profile.bundles` and mounts the host half from its `cordis.patch.yml`.

## Configure

**Two boxes, one save button.**

1. Open the web GUI → sidebar **Settings** → **Kaiwu Cloud**.
2. Paste the `sk-` key into **API key**, the `nap_` token into **Balance token**.
3. Press **Save** once. The balance appears in the sidebar; there is no second button to hunt for.

The site address, refresh interval and warning thresholds live behind **▸ Advanced**, collapsed by default — the default site is already correct.

The credential name (which slot in the store the secret occupies) is shown read-only as **Stored as: `zhijiangApiKey`**; **Change** reveals the input for multi-site users. **Clear** is a separate button, so saving an empty box never deletes a stored secret.

| Field | Default | Meaning |
|---|---|---|
| `baseURL` | `https://ai.zhijianginc.com` | Site address, hot-reloaded |
| `credentialRef` | `zhijiangApiKey` | Credential name holding the `sk-` key |
| `accountCredentialRef` | empty | Credential name holding a dashboard access token; empty disables the account channel. Saving a token points it at `ZHIJIANG_ACCESS_TOKEN`; clearing the token clears the name too |
| `accountUserId` | empty | Numeric user id sent as `new-api-user` (**profile-only**; not on the settings page) |
| `refreshSeconds` | `300` | Refresh interval, minimum 60 |
| `warningDays` | `3` | Badge turns amber below this runway |
| `criticalDays` | `1` | Badge turns red below this runway |
| `showBadge` | `true` | Whether to render the badge (**profile-only**; not on the settings page) |
| `walletURL` | `<baseURL>/console/wallet` | Top-up deep link |

**On credentials**: prefer creating a PAT scoped to **usage:read + wallet:read only** under the site's "Security & Access → Access Tokens", rather than reusing a token that has other powers. Secrets land in `~/.dsh/.credentials.yaml` (plaintext, readable only by this user).

## HTTP surface

Five paths under `/api/zhijiang/`, every one of them fenced to loopback peers. Two are read-only, one is write-only, and two answer both methods.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/zhijiang/snapshot` | Read the cache or trigger a refresh; returns the snapshot |
| POST | `/api/zhijiang/refresh` | Force a refresh |
| GET | `/api/zhijiang/status` | Health and last error |
| GET | `/api/zhijiang/credential` | Whether a key and a token are stored — presence only, never the values |
| POST | `/api/zhijiang/credential` | Store or clear one credential (`kind: apiKey \| accessToken`) |
| GET | `/api/zhijiang/settings` | The editable configuration, as resolved |
| POST | `/api/zhijiang/settings` | Validate, persist and apply a settings patch |

The two write routes are what the settings page uses. Both refuse a request whose
body exceeds 8 KiB, and both answer 400 with a per-field `reason` rather than one
opaque failure. **No route ever returns a secret**: `GET /credential` reports
`configured` and `source`, so a devtools capture or a screenshot cannot leak a key.

Snapshot shape:

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
  "label": "<key name>",
  "usage": { "last24h": null, "total": 33.6, "requests": null, "windowDays": null },
  "forecast": { "dailyAvg": null, "daysLeft": null, "level": "unknown" },
  "warnings": ["account-channel-not-configured"]
}
```

That is the real shape for a **key-only** setup. Note `balance.known = false` and `remaining = null`: not an error, but "the configured credential cannot see the wallet".

`level` is `normal`, `warning`, `critical` or `unknown`. **`unknown` is a first-class outcome**: a fresh install has no spend history, and the panel says so instead of claiming zero days remain.

## Two channels: a key's cap is not the account balance

This is the one place this plugin has already had a real bug, so it is worth stating precisely.

| Channel | Endpoint | Needs | Answers |
|---|---|---|---|
| Key | `GET /api/usage/token/` | an `sk-` key | this key's ceiling, and the spend attributed to it |
| Account | `GET /api/user/self` | a **dashboard access token (PAT)** | how much money the wallet holds |

`/api/usage/token/` returning `unlimited_quota: true` means **this key has no spending cap**, not that the account is rich. Both can be true at once: an uncapped key billed to a nearly empty wallet.

So:

- With only an `sk-` key, the plugin **does not show a balance** (`—`) and tells you to add an access token;
- The key's own "uncapped" status appears on a separate 「密钥额度」 row and never stands in for the balance;
- `sk-` keys get **401** from `/api/user/self` by design — that is not a misconfiguration.

To see the real balance, create a PAT scoped to usage:read + wallet:read under the site's "Security & Access → Access Tokens" and put its reference in the settings page.

## Conversion rule

```
amount = rawQuota / quota_per_unit * exchangeRate
```

Measured on Kaiwu Cloud: `quota_per_unit = 500000`, `quota_display_type = CNY`, `usd_exchange_rate = 7`.
Under CNY, a site that omits the exchange rate makes the plugin **fail and fall back to cache** rather than assume a default — a wrong guess would silently misstate every amount.

## Layout

```
lib/normalize.js   Pure: raw responses to one snapshot (the only place money is converted)
lib/upstream.js    The only module performing network I/O
lib/cache.js       The only module touching disk ($DSH_HOME/storages/zhijiang-connector.json)
lib/service.js     Orchestration: channel choice, degradation, staleness, spend sampling
lib/routes.js      Serialisation plus the loopback fence
lib/config.js      Configuration schema and safe defaults
lib/index.js       Host entry: name / inject / apply
lib/client.js      Browser half (pre-built __ModuleLoader__ bundle)
```

Responsibility flows one way: `upstream` never converts, `normalize` never does I/O, `routes` never makes business decisions. That is what keeps the arithmetic unit-testable offline and makes a fourth channel a single new function.

## Dependencies

- Host services: `webServer`, `credentials`, `settings`
- Client services: `slots`
- Peer: `@deepseek-ai/dsh` `>=0.2.1-rc.1 <0.3.0-0` (developed and verified against 0.2.1-rc.3)
- Third-party runtime dependencies: **none** (Node built-ins only)

It does not overlap with `@ychris12138/dsh-usage-stats` or `dsh-token-usage`: those aggregate local token counts and estimate cost, while this plugin reads the site's real bill. They coexist, each taking a different `order` in `sidebar.footer.action`.

## Development

```powershell
npm run check   # syntax-check every file
npm test        # 47 tests: conversion, degradation, staleness, routes, loopback fence
```

`npm run test:live` and `npm run verify:account` drive the real service against the
real site with a credential from the harness store; they print derived figures
only, never the secret.

`lib/client.js` is a hand-written bundle: **reinstall or restart after editing it**. Host-side `lib/*.js` hot-reloads on profiles with HMR enabled.

## Known limitations

- `requests` is `null`: New API has no lightweight single-query endpoint for it, and the dashboard's counter comes from a different data path. Left for a follow-up.
- Group multipliers and peak/off-peak pricing are not shown; those belong to the usage-dashboard proposal.
- `total_available` on an uncapped key can come back negative once the key has spent past its grant (observed on a live site: a small `total_granted`, a much larger `total_used`, and a negative `total_available`). A negative remainder is not a ceiling, so it is discarded rather than rendered as one.
- The panel reads one site per instance. Multiple sites need multiple credentials under distinct reference names, but the settings page edits one at a time.

## License

MIT
