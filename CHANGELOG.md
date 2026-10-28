# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-28

First public release.

### Added

- Sidebar badge showing the account balance, turning amber below `warningDays`
  and red below `criticalDays` of runway.
- Floating panel with balance, spend, 24-hour spend, daily average, runway in
  days, key name, group and expiry.
- Two independent read channels: a dashboard access token (PAT) for the wallet,
  and the `sk-` key's own quota.
- Settings page with two fields and one save button; site address, refresh
  interval and thresholds live behind a collapsed **Advanced** section.
- Credential repair: a token pasted into a reference-name field is moved into the
  credential store on the next boot instead of being silently dropped.
- Degradation: on timeout or rate limiting the last good snapshot stays visible,
  marked stale, rather than blanking the panel.
- Conversion factors (`quota_per_unit`, `usd_exchange_rate`) are re-read from
  `/api/status` on every refresh; nothing is hard-coded.

### Verified

- Both upstream endpoints exercised against the live site: `/api/usage/token/`
  answers 200 with `unlimited_quota`, `total_granted`, `total_used`,
  `total_available` and `expires_at`; `/api/user/self` answers 401 for an `sk-`
  key, by design.
- Account channel returns a real balance (remaining and used) through a PAT.
- 47 offline tests cover conversion, degradation, staleness, routes and the
  loopback fence.

### Known limitations

- Request count is not reported; New API has no lightweight endpoint for it.
- Group multipliers and peak/off-peak pricing are not shown.
- One site per instance.

[Unreleased]: https://github.com/OWNER/dsh-zhijiang-connector/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/OWNER/dsh-zhijiang-connector/releases/tag/v0.1.0
