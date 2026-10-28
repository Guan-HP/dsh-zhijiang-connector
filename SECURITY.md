# Security

## What this plugin touches

Be clear-eyed about it before you install: this plugin handles **credentials for a
billing site**, so it is worth knowing exactly what it does with them.

| Thing | What happens |
|---|---|
| Your `sk-` API key | Read from the harness credential store at request time; sent only to your configured site as a `Bearer` token |
| Your dashboard access token (`nap_…`) | Same — read at request time, sent only to your configured site |
| Disk | One cache file, `$DSH_HOME/storages/zhijiang-connector.json`: the last good snapshot plus a bounded spend history |
| Settings | `$DSH_HOME/storages/zhijiang-connector-settings.json` (reference names and thresholds — **no secrets**) |
| Network | `GET /api/status`, `GET /api/usage/token/`, `GET /api/user/self` on your configured site. Nothing else, ever |
| The browser | The plugin's own panel. It receives figures and credential *presence*, never a credential value |

The plugin holds **no secrets of its own**. It stores *references* — names — and
resolves the values through the harness credential seam when it needs them. A
screenshot of the panel, a devtools capture, or the plugin's settings file cannot
leak a key.

## Deliberately out of scope

- No embedded payment, proxy payment or redemption-code handling. A plugin should
  hold neither a login session nor payment credentials.
- No probe requests to models. They cost real money, which is the exact thing
  this plugin exists to measure.
- No new standalone page routes. The harness's static frontend owns the fallback
  seat, so plugins contribute slots and panels only.

## Network surface

Five endpoints under `/api/zhijiang/`, all fenced to **loopback peers** — a page
in another browser tab cannot read your balance or change your settings. The
fence is applied per handler rather than assumed from the mount point, because
exact routes bypass the harness's own RPC trust fence.

The two write endpoints cap their request body at 8 KiB and reject unknown
fields instead of silently ignoring them.

## Reporting a vulnerability

Please **do not open a public issue** for anything involving credential handling,
the loopback fence, or request forgery.

Report privately through GitHub's [Security Advisories](https://github.com/OWNER/dsh-zhijiang-connector/security/advisories/new),
or by email to the address on the repository owner's GitHub profile.

Include the version (`dsh plugin list` reports it), your harness version, and
what you observed. Please **never paste a real API key or access token** into a
report — a redacted prefix is enough to identify the shape of the value.

Expect an acknowledgement within a few days. This is a single-maintainer project
with no paid support, so please allow reasonable time before disclosing publicly.

## Scope

In scope:

- A credential value reaching a place it should not (logs, the browser, the cache
  file, an error message).
- A non-loopback peer reaching any `/api/zhijiang/` route.
- The plugin writing outside `$DSH_HOME/storages/`.
- A request to a host other than the configured site.

Out of scope:

- The security of the relay site itself. Report that to the site.
- Whether the site's own API returns correct figures.
- Anything that requires an attacker who already controls your user account.
