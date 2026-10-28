/**
 * dsh-zhijiang-connector — browser half.
 *
 * Hand-written `__ModuleLoader__` bundle: the harness loads profile client
 * bundles as pre-built artifacts, so this file is the build output as well as
 * the source. There is no JSX and no transpile step; elements are created with
 * `react.createElement` directly.
 *
 * The client is deliberately thin. It renders what the host already normalised
 * and never converts money itself: the conversion factors, the runway and the
 * severity level all come from `/api/zhijiang/snapshot`. That keeps exactly one
 * implementation of the arithmetic, on the side that can be unit tested.
 *
 * Surfaces:
 *   - `sidebar.footer.action` — the badge and its floating panel
 *   - `settings.section`      — the configuration page
 */

window.__ModuleLoader__.load({
	id: 'dsh-zhijiang-connector',
	factory: (require) => {
		const module = { exports: {} };
		const exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const react = require('react');

		/** Snapshot endpoint served by this package's host half. */
		const SNAPSHOT_URL = '/api/zhijiang/snapshot';
		/** Forced-refresh endpoint. */
		const REFRESH_URL = '/api/zhijiang/refresh';
		/** How often the badge re-reads while the tab is visible. */
		const POLL_MS = 60000;

		/**
		 * Read one service from a Cordis context, or `undefined` when it is absent.
		 *
		 * The client context is a Proxy whose `get` throws for any service that is
		 * not declared in the plugin's `inject` list, and also for a declared
		 * service that has not started yet. A plain `ctx.locale && …` guard does
		 * not help: the throw happens on the property read itself, before the
		 * `&&` is evaluated. This wrapper is what makes "optional" actually
		 * optional, so a missing locale degrades the UI instead of failing the
		 * client entry.
		 *
		 * @param {object} ctx - client root context.
		 * @param {string} name - service name.
		 * @returns {object | undefined} the service, or undefined.
		 */
		function readService(ctx, name) {
			try {
				const service = ctx?.[name];
				return service ?? undefined;
			} catch {
				return undefined;
			}
		}

		/**
		 * Format an amount with its currency symbol.
		 * @param {number | null} value - amount.
		 * @param {string} currency - ISO currency code.
		 * @returns {string} display text.
		 */
		function money(value, currency) {
			if (value === null || value === undefined || !Number.isFinite(value)) return '—';
			const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : '';
			const fixed = Math.abs(value) >= 1000 ? value.toFixed(0) : value.toFixed(2);
			return `${symbol}${fixed}`;
		}

		/**
		 * Format a day count for the panel.
		 * @param {number | null} days - days left.
		 * @returns {string} display text.
		 */
		function days(daysLeft) {
			if (daysLeft === null || daysLeft === undefined || !Number.isFinite(daysLeft)) return '—';
			if (daysLeft >= 100) return '99+ 天';
			if (daysLeft >= 1) return `${daysLeft.toFixed(1)} 天`;
			return `${Math.max(0, Math.round(daysLeft * 24))} 小时`;
		}

		/**
		 * Map a severity level onto a colour token.
		 * @param {string} level - normal / warning / critical / unknown.
		 * @returns {string} CSS colour.
		 */
		function levelColor(level) {
			if (level === 'critical') return '#f43146';
			if (level === 'warning') return '#eeba18';
			return 'inherit';
		}

		/**
		 * Short badge text for a snapshot.
		 *
		 * When the wallet is unreadable (a key-only setup), the badge shows the
		 * money actually spent instead of a balance. It must never claim
		 * "unlimited": an uncapped key still draws from a finite account.
		 *
		 * @param {object | null} snapshot - the snapshot.
		 * @returns {string} badge label.
		 */
		function badgeText(snapshot) {
			if (!snapshot) return '开物云 —';
			const currency = snapshot.site?.currency;
			if (snapshot.balance?.known === false) {
				const spent = snapshot.usage?.total;
				return typeof spent === 'number' ? `开物云 已用 ${money(spent, currency)}` : '开物云 —';
			}
			return `开物云 ${money(snapshot.balance?.remaining, currency)}`;
		}

		/**
		 * Fetch the snapshot, tolerating a host that has not been configured.
		 * @param {boolean} [force] - bypass the host cache.
		 * @returns {Promise<{snapshot: object | null, error: object | null}>} the read result.
		 */
		async function loadSnapshot(force) {
			try {
				const response = await fetch(force ? REFRESH_URL : SNAPSHOT_URL, {
					method: force ? 'POST' : 'GET',
					headers: { accept: 'application/json' }
				});
				const body = await response.json();
				if (!response.ok || body?.ok === false) {
					return { snapshot: null, error: body?.error ?? { reason: `http-${response.status}` } };
				}
				return { snapshot: body, error: null };
			} catch (cause) {
				return { snapshot: null, error: { reason: 'unreachable', message: String(cause) } };
			}
		}

		/**
		 * One labelled figure row.
		 * @param {{label: string, value: string, tone?: string}} props - row content.
		 * @returns {object} React element.
		 */
		function Row({ label, value, tone }) {
			return react.createElement('div', {
				style: {
					display: 'flex',
					justifyContent: 'space-between',
					gap: '12px',
					padding: '3px 0',
					fontSize: '12px'
				}
			},
			react.createElement('span', { style: { opacity: 0.72 } }, label),
			react.createElement('span', { style: { fontVariantNumeric: 'tabular-nums', color: tone ?? 'inherit' } }, value));
		}

		/**
		 * Render the panel into `document.body` instead of inside the sidebar.
		 *
		 * The sidebar foot is a plain flex row with no positioning context, so an
		 * absolutely-positioned child escapes the column and is clipped by the
		 * sidebar's overflow. Portalling to the body lets the panel anchor to the
		 * badge's on-screen rectangle and float above everything, which is also
		 * how the sibling usage plugin avoids the same trap.
		 *
		 * @param {{anchor: {left: number, top: number}, children: object}} props - anchor rect and content.
		 * @returns {object | null} portal element, or the content when no DOM is present.
		 */
		function FloatingLayer({ anchor, children }) {
			const host = typeof document !== 'undefined' && document.body ? document.body : null;
			if (!host) return children;

			const style = {
				position: 'fixed',
				left: `${Math.max(8, Math.min(anchor.left, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 252))}px`,
				bottom: `${Math.max(8, (typeof window !== 'undefined' ? window.innerHeight : 800) - anchor.top + 8)}px`,
				zIndex: 2147483000
			};

			const content = react.createElement('div', { style }, children);
			return typeof react.createPortal === 'function'
				? react.createPortal(content, host)
				: content;
		}

		/**
		 * The floating panel behind the badge.
		 * @param {{snapshot: object|null, error: object|null, busy: boolean,
		 *   onRefresh: Function, onClose: Function}} props - panel state.
		 * @returns {object} React element.
		 */
		function Panel({ snapshot, error, busy, onRefresh, onClose }) {
			const level = snapshot?.forecast?.level ?? 'unknown';
			const currency = snapshot?.site?.currency ?? 'CNY';

			const header = react.createElement('div', {
				style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px' }
			},
			react.createElement('div', { style: { fontSize: '13px', fontWeight: 600 } }, snapshot?.site?.name ?? '开物云'),
			react.createElement('button', {
				type: 'button',
				onClick: onClose,
				style: { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '14px', opacity: 0.6 }
			}, '×'));

			// The wallet is only readable through the account channel. A key-only
			// setup reports `known: false`, and the honest rendering is a dash plus
			// an explanation — never "unlimited", which was the original defect.
			const known = snapshot ? snapshot.balance?.known !== false : false;
			const balanceText = !snapshot
				? '—'
				: known
					? money(snapshot.balance?.remaining ?? null, currency)
					: '—';

			const keyCapText = (() => {
				const cap = snapshot?.keyCap;
				if (!cap) return null;
				if (cap.unlimited) return '无上限';
				if (typeof cap.available === 'number') return money(cap.available, currency);
				return '—';
			})();

			const rows = react.createElement('div', { style: { marginTop: '8px' } },
				react.createElement(Row, { label: '账户余额', value: balanceText, tone: levelColor(level) }),
				react.createElement(Row, {
					label: '已用',
					value: money(snapshot?.usage?.total ?? null, currency)
				}),
				react.createElement(Row, {
					label: '近 24 小时',
					value: money(snapshot?.usage?.last24h ?? null, currency)
				}),
				react.createElement(Row, { label: '日均消耗', value: money(snapshot?.forecast?.dailyAvg ?? null, currency) }),
				react.createElement(Row, {
					label: '可用时长',
					value: known ? days(snapshot?.forecast?.daysLeft ?? null) : '—',
					tone: levelColor(level)
				}),
				keyCapText
					? react.createElement(Row, { label: '密钥额度', value: keyCapText })
					: null,
				snapshot?.label
					? react.createElement(Row, { label: '密钥', value: String(snapshot.label) })
					: null,
				snapshot?.balance?.expiresAt
					? react.createElement(Row, { label: '到期', value: snapshot.balance.expiresAt.slice(0, 10) })
					: null);

			const notice = error
				? react.createElement('div', {
					style: { marginTop: '8px', fontSize: '11px', color: '#f43146', lineHeight: 1.5 }
				}, error.reason === 'not-configured'
					? '尚未配置密钥，请在 设置 → 开物云 中填写。'
					: `读取失败：${error.reason ?? 'unknown'}`)
				: snapshot && snapshot.balance?.known === false
					// The key can spend but cannot see the wallet. Say which one is
					// missing and what to add, rather than implying an infinite balance.
					? react.createElement('div', {
						style: { marginTop: '8px', fontSize: '11px', opacity: 0.7, lineHeight: 1.5 }
					}, '余额需要「访问令牌」才能读取；当前密钥无额度上限，但消费仍从账户余额扣除。请在 设置 → 开物云 中填写访问令牌。')
					: snapshot?.stale
						? react.createElement('div', {
							style: { marginTop: '8px', fontSize: '11px', opacity: 0.65, lineHeight: 1.5 }
						}, `数据已过期，上次更新于 ${snapshot.fetchedAt?.slice(11, 16) ?? '—'}`)
						: null;

			const actions = react.createElement('div', {
				style: { display: 'flex', gap: '8px', marginTop: '10px' }
			},
			react.createElement('button', {
				type: 'button',
				disabled: busy,
				onClick: onRefresh,
				style: { flex: 1, padding: '5px 0', fontSize: '12px', cursor: busy ? 'default' : 'pointer' }
			}, busy ? '刷新中…' : '刷新'),
			react.createElement('button', {
				type: 'button',
				onClick: () => {
					const url = snapshot?.site?.baseURL ? `${snapshot.site.baseURL}/console/wallet` : 'https://ai.zhijianginc.com/console/wallet';
					if (typeof window !== 'undefined' && typeof window.open === 'function') window.open(url, '_blank', 'noopener');
				},
				style: { flex: 1, padding: '5px 0', fontSize: '12px', cursor: 'pointer' }
			}, '去充值'));

			return react.createElement('div', {
				style: {
					width: '232px',
					padding: '12px',
					borderRadius: '10px',
					border: '1px solid rgba(128,128,128,0.28)',
					background: 'Canvas',
					color: 'CanvasText',
					boxShadow: '0 8px 28px rgba(0,0,0,0.22)'
				}
			}, header, rows, notice, actions);
		}

		/**
		 * Sidebar footer action: badge plus floating panel.
		 *
		 * Polling stops while the document is hidden, so a backgrounded window
		 * does not keep waking the relay.
		 *
		 * @returns {object} React element.
		 */
		function ConnectorBadge(props) {
			const [snapshot, setSnapshot] = react.useState(null);
			const [error, setError] = react.useState(null);
			const [open, setOpen] = react.useState(false);
			const [busy, setBusy] = react.useState(false);
			const anchorRef = react.useRef({ left: 8, top: 800 });
			const wide = !props || props.wide !== false;

			react.useEffect(() => {
				let cancelled = false;

				const read = async (force) => {
					const result = await loadSnapshot(force);
					if (cancelled) return;
					if (result.snapshot) setSnapshot(result.snapshot);
					setError(result.error);
				};

				void read(false);
				const timer = setInterval(() => {
					if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
					void read(false);
				}, POLL_MS);

				return () => {
					cancelled = true;
					clearInterval(timer);
				};
			}, []);

			const onRefresh = async () => {
				setBusy(true);
				const result = await loadSnapshot(true);
				setBusy(false);
				if (result.snapshot) setSnapshot(result.snapshot);
				setError(result.error);
			};

			const level = snapshot?.forecast?.level ?? 'unknown';
			const tone = error ? '#f43146' : levelColor(level) === 'inherit' ? '#41ba41' : levelColor(level);

			// The badge is one compact chip in a shared flex row. It must not claim
			// the full width: the sibling usage plugin renders into the same row,
			// and a `width: 100%` child squeezes it to nothing.
			//
			// `flex: 0 0 auto` is the load-bearing part. The usage plugin's entry is
			// a `width: 100%` button with the default `flex-shrink: 1`; with a
			// shrinkable badge (the old `0 1 auto`) both sides competed and this one
			// collapsed to zero width, which read as "the badge disappeared". Opting
			// out of shrinking makes the full-width sibling absorb the deficit
			// instead, so the two entries sit side by side and both stay clickable.
			return react.createElement('div', {
				style: {
					flex: '0 0 auto',
					flexShrink: 0,
					minWidth: 0,
					display: 'flex',
					alignItems: 'center'
				}
			},
				react.createElement('button', {
					type: 'button',
					onClick: (event) => {
						const rect = event?.currentTarget?.getBoundingClientRect?.();
						if (rect) anchorRef.current = { left: rect.left, top: rect.top };
						setOpen((value) => !value);
					},
					title: badgeText(snapshot),
					style: {
						display: 'inline-flex',
						alignItems: 'center',
						gap: '6px',
						minWidth: 0,
						maxWidth: '100%',
						padding: '5px 8px',
						border: 'none',
						borderRadius: '8px',
						background: 'transparent',
						color: tone,
						cursor: 'pointer',
						fontSize: '12px',
						lineHeight: '18px',
						fontVariantNumeric: 'tabular-nums'
					}
				},
				react.createElement('span', {
					style: { width: '6px', height: '6px', borderRadius: '50%', flex: 'none', background: tone }
				}),
				wide
					? react.createElement('span', {
						style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
					}, badgeText(snapshot))
					: null),
				open
					? react.createElement(FloatingLayer, { anchor: anchorRef.current ?? { left: 8, top: 800 } },
						react.createElement(Panel, {
							snapshot,
							error,
							busy,
							onRefresh,
							onClose: () => setOpen(false)
						}))
					: null);
		}

		/**
		/**
		 * A credential row: input plus a separate destructive clear.
		 *
		 * There is no per-row save. Saving is one gesture for the whole page (the
		 * bottom button), because a key and a token belong to the same setup step;
		 * three same-weight buttons were exactly what made a two-field job look
		 * like a five-step one.
		 *
		 * Clearing is spelled as its own button rather than "save an empty value":
		 * that old spelling put a destructive action behind the same gesture as an
		 * ordinary save and contradicted the field's own "leave empty to keep"
		 * placeholder.
		 *
		 * @param {{label: string, hint?: string, value: string, placeholder: string,
		 *   status: string, disabled: boolean, canClear: boolean, onChange: Function,
		 *   onClear: Function}} props - row state.
		 * @returns {object} React element.
		 */
		function CredentialRow(props) {
			const actionButton = (text, onClick, tone) => react.createElement('button', {
				type: 'button',
				disabled: props.disabled || (tone === 'danger' && !props.canClear),
				onClick,
				style: {
					padding: '5px 12px',
					fontSize: '12px',
					borderRadius: '6px',
					border: tone === 'primary' ? 'none' : '1px solid rgba(128,128,128,0.35)',
					background: tone === 'primary' ? '#1a6dff' : 'transparent',
					color: tone === 'primary' ? '#fff' : 'inherit',
					cursor: props.disabled ? 'default' : 'pointer',
					opacity: props.disabled || (tone === 'danger' && !props.canClear) ? 0.45 : 1
				}
			}, text);

			// One wrapper child, not two: a row and its status line belong together,
			// and a single element keeps the tree shape the render tests walk.
			return react.createElement(Field, { label: props.label, hint: props.hint },
				react.createElement('div', null,
					react.createElement('div', { style: { display: 'flex', gap: '8px' } },
						react.createElement('div', { style: { flex: 1 } },
							react.createElement(TextInput, {
								value: props.value,
								mono: true,
								placeholder: props.placeholder,
								onChange: props.onChange,
								disabled: props.disabled
							})),
						actionButton('清除', props.onClear, 'danger')),
					react.createElement('div', { style: { fontSize: '11px', opacity: 0.6, marginTop: '4px' } }, props.status)));
		}

		/**
		 * The credential name a secret is stored under, shown read-only.
		 *
		 * The name addresses a slot in the credential store; it is not something a
		 * new user should have to invent. It stays visible (so nobody has to guess
		 * where the key went) but out of the way. "更改" reveals the input for the
		 * multi-site case that genuinely needs a different slot.
		 *
		 * @param {{label: string, effective: string, editing: boolean, draft: string,
		 *   disabled: boolean, onEdit: Function, onChange: Function,
		 *   onCommit: Function, onCancel: Function}} props - row state.
		 * @returns {object} React element.
		 */
		function CredentialRefRow(props) {
			if (!props.editing) {
				return react.createElement('div', {
					style: {
						display: 'flex',
						alignItems: 'center',
						gap: '8px',
						fontSize: '11px',
						opacity: 0.7,
						marginTop: '-6px',
						marginBottom: '12px',
						lineHeight: 1.5
					}
				},
				react.createElement('span', null, `${props.label}：`),
				react.createElement('code', { style: { fontFamily: 'ui-monospace, monospace' } }, props.effective || '—'),
				react.createElement('button', {
					type: 'button',
					disabled: props.disabled,
					onClick: props.onEdit,
					style: {
						border: 'none',
						background: 'transparent',
						color: '#1a6dff',
						cursor: props.disabled ? 'default' : 'pointer',
						fontSize: '11px',
						padding: 0
					}
				}, '更改'));
			}

			return react.createElement('div', { style: { marginTop: '-6px', marginBottom: '12px' } },
				react.createElement('div', { style: { fontSize: '11px', opacity: 0.7, marginBottom: '4px' } },
					`${props.label}（凭据库中的名称；与已有密钥同名才能复用）`),
				react.createElement('div', { style: { display: 'flex', gap: '8px' } },
					react.createElement('div', { style: { flex: 1 } },
						react.createElement(TextInput, {
							value: props.draft,
							mono: true,
							placeholder: props.effective,
							onChange: props.onChange,
							disabled: props.disabled
						})),
					react.createElement('button', {
						type: 'button',
						disabled: props.disabled,
						onClick: props.onCommit,
						style: { padding: '5px 12px', fontSize: '12px', borderRadius: '6px', border: 'none', background: '#1a6dff', color: '#fff', cursor: props.disabled ? 'default' : 'pointer' }
					}, '确定'),
					react.createElement('button', {
						type: 'button',
						disabled: props.disabled,
						onClick: props.onCancel,
						style: { padding: '5px 12px', fontSize: '12px', borderRadius: '6px', border: '1px solid rgba(128,128,128,0.35)', background: 'transparent', color: 'inherit', cursor: props.disabled ? 'default' : 'pointer' }
					}, '取消')));
		}

		/**
		 * One labelled row of the settings form.
		 * @param {{label: string, hint?: string, children: object}} props - row content.
		 * @returns {object} React element.
		 */
		function Field({ label, hint, children }) {
			return react.createElement('div', { style: { marginBottom: '14px' } },
				react.createElement('div', { style: { fontSize: '12px', fontWeight: 500, marginBottom: '4px' } }, label),
				children,
				hint
					? react.createElement('div', { style: { fontSize: '11px', opacity: 0.6, marginTop: '4px', lineHeight: 1.5 } }, hint)
					: null);
		}

		/**
		 * A text input styled to sit inside the settings panel.
		 * @param {object} props - input props.
		 * @returns {object} React element.
		 */
		function TextInput(props) {
			return react.createElement('input', {
				type: 'text',
				value: props.value,
				placeholder: props.placeholder,
				disabled: props.disabled,
				onChange: (event) => props.onChange(event.target.value),
				style: {
					width: '100%',
					boxSizing: 'border-box',
					padding: '6px 8px',
					fontSize: '12px',
					borderRadius: '6px',
					border: '1px solid rgba(128,128,128,0.35)',
					background: 'transparent',
					color: 'inherit',
					fontFamily: props.mono ? 'ui-monospace, monospace' : 'inherit'
				}
			});
		}

		/**
		 * Editable settings page for the connector.
		 *
		 * Two different write paths meet here, because the harness splits them:
		 * ordinary fields are persisted through `configForms` (the same store the
		 * profile's patch layer feeds), while the API key can only be stored by
		 * the host half. The key is therefore POSTed to this plugin's own route
		 * and never echoed back — the form only ever learns whether one exists.
		 *
		 * @param {{entryId?: string}} props - slot props; `entryId` identifies the
		 *   host plugin entry whose configuration this page edits.
		 * @returns {object} React element.
		 */
		/**
		 * Editable settings page for the connector.
		 *
		 * The page is deliberately shaped like the job: two credentials, one save.
		 * Secrets are written through the host's credential route (the browser can
		 * learn whether one exists, never its value), and every other field is one
		 * settings patch — so the two writes cannot drift apart the way they did
		 * when each had its own button.
		 *
		 * @param {{entryId?: string}} props - slot props; `entryId` identifies the
		 *   host plugin entry whose configuration this page edits.
		 * @returns {object} React element.
		 */
		function SettingsSection(props) {
			// Optional translate seat: `apply` passes the locale-bound one, tests and
			// bare renders call this component without it.
			const t = (props && props.t) || ((key, fallback) => fallback ?? key);
			const [draft, setDraft] = react.useState(null);
			const [presence, setPresence] = react.useState(null);
			const [keyDraft, setKeyDraft] = react.useState('');
			const [tokenDraft, setTokenDraft] = react.useState('');
			const [status, setStatus] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [advanced, setAdvanced] = react.useState(false);
			const [refEditing, setRefEditing] = react.useState({ key: false, token: false });
			const [refDraft, setRefDraft] = react.useState({ key: '', token: '' });

			/**
			 * Re-read which credentials exist. Presence only, never values.
			 * @returns {Promise<object | null>} the presence payload.
			 */
			const refreshPresence = async () => {
				try {
					const response = await fetch('/api/zhijiang/credential', { headers: { accept: 'application/json' } });
					const body = await response.json();
					setPresence(body);
					return body;
				} catch {
					setPresence({ configured: false, writable: false });
					return null;
				}
			};

			/**
			 * Re-read the resolved configuration, so the form shows reality rather
			 * than the schema defaults.
			 * @returns {Promise<object>} the resolved values.
			 */
			const reloadSettings = async () => {
				try {
					const response = await fetch('/api/zhijiang/settings', { headers: { accept: 'application/json' } });
					const body = await response.json();
					const values = body && body.ok ? { ...body.values } : {};
					setDraft(values);
					return values;
				} catch {
					setDraft({});
					return {};
				}
			};

			react.useEffect(() => {
				let cancelled = false;
				void (async () => {
					await reloadSettings();
					if (cancelled) return;
					await refreshPresence();
				})();
				return () => {
					cancelled = true;
				};
			}, []);

			const current = draft ?? {};
			const update = (field, value) => setDraft({ ...current, [field]: value });

			const keyConfigured = Boolean(presence && presence.configured);
			const tokenPresence = presence && presence.accessToken ? presence.accessToken : null;
			const tokenConfigured = Boolean(tokenPresence && tokenPresence.configured);
			const complete = keyConfigured && tokenConfigured;

			/**
			 * Persist everything in one gesture.
			 *
			 * Order matters: credentials first, because they are what makes a
			 * balance readable, then the ordinary fields. A credential that fails to
			 * store stops the sequence before a settings write could make the page
			 * look configured when it is not.
			 *
			 * @returns {Promise<void>} resolves once the attempt settles.
			 */
			const saveAll = async () => {
				if (!draft) return;
				setBusy(true);
				setStatus(null);

				const failures = [];

				// One credential at a time; an empty box means "keep what is stored".
				const writeCredential = async (kind, value) => {
					const payload = kind === 'accessToken' ? { kind, value } : { value };
					const response = await fetch('/api/zhijiang/credential', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify(payload)
					});
					const body = await response.json().catch(() => null);
					if (!response.ok || !body || body.ok === false) {
						const detail = body && body.error ? (body.error.message ?? body.error.reason) : `HTTP ${response.status}`;
						failures.push(`${kind === 'accessToken' ? '余额查询令牌' : 'API 密钥'}：${detail}`);
						return false;
					}
					return true;
				};

				try {
					let credentialChanged = false;
					if (keyDraft.trim() !== '') {
						if (await writeCredential('apiKey', keyDraft.trim())) credentialChanged = true;
						else throw new Error('credential');
					}
					if (tokenDraft.trim() !== '') {
						if (await writeCredential('accessToken', tokenDraft.trim())) credentialChanged = true;
						else throw new Error('credential');
					}

					const response = await fetch('/api/zhijiang/settings', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify(draft)
					});
					const body = await response.json().catch(() => null);
					if (!response.ok || !body || body.ok === false) {
						const first = body && body.errors ? Object.entries(body.errors)[0] : null;
						failures.push(first ? `${first[1]}` : `保存被拒绝（HTTP ${response.status}）`);
						throw new Error('settings');
					}

					setDraft({ ...body.values });
					setKeyDraft('');
					setTokenDraft('');
					const after = await refreshPresence();
					setStatus({
						ok: true,
						text: credentialChanged
							? '已保存，余额已刷新，无需再点其他按钮'
							: '已保存'
					});
					// Keep the completion banner honest: it reads the same presence
					// payload the rows do.
					if (after && after.configured && after.accessToken && after.accessToken.configured) {
						setStatus({ ok: true, text: '已保存，余额已刷新，无需再点其他按钮' });
					}
				} catch (error) {
					if (error && error.message === 'credential') {
						setStatus({ ok: false, text: failures[0] ?? '凭据保存失败' });
					} else if (error && error.message === 'settings') {
						setStatus({ ok: false, text: failures[0] ?? '设置保存失败' });
					} else {
						setStatus({ ok: false, text: `保存失败：${error && error.message ? error.message : 'unknown'}` });
					}
				} finally {
					setBusy(false);
				}
			};

			/**
			 * Remove one stored credential.
			 *
			 * Destructive and separate from save, so "leave the box empty" can mean
			 * the harmless thing it says.
			 *
			 * @param {'apiKey'|'accessToken'} kind - which credential.
			 * @returns {Promise<void>} resolves once the attempt settles.
			 */
			const clearCredential = async (kind) => {
				setBusy(true);
				setStatus(null);
				try {
					const response = await fetch('/api/zhijiang/credential', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ kind, value: '' })
					});
					const body = await response.json().catch(() => null);
					if (!response.ok || !body || body.ok === false) {
						const detail = body && body.error ? (body.error.message ?? body.error.reason) : `HTTP ${response.status}`;
						setStatus({ ok: false, text: `清除失败：${detail}` });
					} else {
						if (kind === 'apiKey') setKeyDraft('');
						else setTokenDraft('');
						await refreshPresence();
						await reloadSettings();
						setStatus({ ok: true, text: kind === 'accessToken' ? '余额查询令牌已清除' : 'API 密钥已清除' });
					}
				} catch (error) {
					setStatus({ ok: false, text: `清除失败：${error && error.message ? error.message : 'unknown'}` });
				} finally {
					setBusy(false);
				}
			};

			const button = (text, onClick, primary) => react.createElement('button', {
				type: 'button',
				disabled: busy,
				onClick,
				style: {
					padding: '5px 12px',
					fontSize: '12px',
					borderRadius: '6px',
					border: primary ? 'none' : '1px solid rgba(128,128,128,0.35)',
					background: primary ? '#1a6dff' : 'transparent',
					color: primary ? '#fff' : 'inherit',
					cursor: busy ? 'default' : 'pointer',
					opacity: busy ? 0.6 : 1
				}
			}, text);

			/**
			 * Commit one reference-name edit.
			 * @param {'key'|'token'} which - which credential.
			 * @returns {void}
			 */
			const commitRef = (which) => {
				const field = which === 'key' ? 'credentialRef' : 'accountCredentialRef';
				const next = refDraft[which].trim();
				update(field, next);
				setRefEditing({ ...refEditing, [which]: false });
			};

			const siteHint = current.baseURL ? '' : 'https://ai.zhijianginc.com';

			return react.createElement('div', { style: { padding: '4px 0', lineHeight: 1.6, maxWidth: '560px' } },
				react.createElement('div', { style: { fontSize: '12px', opacity: 0.8, marginBottom: '14px', lineHeight: 1.6 } },
					'把开物云（New API 中转站）的余额与消耗接入侧边栏。密钥与令牌只保存在本机凭据库，不会写入插件配置，也不会回显。'),

				complete
					? react.createElement('div', {
						style: { fontSize: '12px', color: '#41ba41', marginBottom: '14px', lineHeight: 1.6 }
					}, '✓ 配置完成，余额已接入侧边栏')
					: null,

				react.createElement(CredentialRow, {
					label: 'API 密钥',
					hint: '粘贴以 sk- 开头的密钥。用于读取这把密钥的额度与消耗。',
					value: keyDraft,
					placeholder: keyConfigured ? '已保存 · 输入新值可替换' : 'sk-...',
					status: `状态：${presence === null ? '读取中…' : keyConfigured ? '已配置' : '未配置'}`,
					disabled: busy,
					canClear: keyConfigured,
					onChange: setKeyDraft,
					onSave: saveAll,
					onClear: () => clearCredential('apiKey')
				}),

				react.createElement(CredentialRefRow, {
					label: '保存为',
					value: current.credentialRef ?? '',
					effective: current.credentialRef || 'zhijiangApiKey',
					editing: refEditing.key,
					draft: refDraft.key,
					disabled: busy,
					onEdit: () => {
						setRefDraft({ ...refDraft, key: current.credentialRef ?? '' });
						setRefEditing({ ...refEditing, key: true });
					},
					onChange: (value) => setRefDraft({ ...refDraft, key: value }),
					onCommit: () => commitRef('key'),
					onCancel: () => setRefEditing({ ...refEditing, key: false })
				}),

				react.createElement(CredentialRow, {
					label: '余额查询令牌',
					hint: '粘贴以 nap_ 开头的访问令牌（站点「安全与访问 → 访问令牌」创建，勾选「用量:查看」+「钱包:查看」）。用于读取账户余额。',
					value: tokenDraft,
					placeholder: tokenConfigured ? '已保存 · 输入新值可替换' : 'nap_...',
					status: `状态：${presence === null ? '读取中…' : tokenConfigured ? '已配置' : '未配置'}`,
					disabled: busy,
					canClear: tokenConfigured,
					onChange: setTokenDraft,
					onSave: saveAll,
					onClear: () => clearCredential('accessToken')
				}),

				react.createElement(CredentialRefRow, {
					label: '保存为',
					value: current.accountCredentialRef ?? '',
					effective: current.accountCredentialRef || 'ZHIJIANG_ACCESS_TOKEN',
					editing: refEditing.token,
					draft: refDraft.token,
					disabled: busy,
					onEdit: () => {
						setRefDraft({ ...refDraft, token: current.accountCredentialRef ?? '' });
						setRefEditing({ ...refEditing, token: true });
					},
					onChange: (value) => setRefDraft({ ...refDraft, token: value }),
					onCommit: () => commitRef('token'),
					onCancel: () => setRefEditing({ ...refEditing, token: false })
				}),

				react.createElement('button', {
					type: 'button',
					onClick: () => setAdvanced(!advanced),
					style: {
						border: 'none',
						background: 'transparent',
						color: 'inherit',
						opacity: 0.75,
						cursor: 'pointer',
						fontSize: '12px',
						padding: 0,
						marginBottom: advanced ? '10px' : '4px'
					}
				}, `${advanced ? '▾' : '▸'} 高级设置（站点地址 / 刷新间隔 / 预警阈值）`),

				advanced
					? react.createElement('div', null,
						react.createElement(Field, { label: '站点地址' },
							react.createElement(TextInput, {
								value: current.baseURL ?? '',
								placeholder: siteHint,
								onChange: (value) => update('baseURL', value),
								disabled: busy
							})),
						react.createElement(Field, {
							label: '刷新间隔（秒）',
							hint: '最小 60 秒。默认 300 秒。'
						},
						react.createElement(TextInput, {
							value: current.refreshSeconds ?? '',
							placeholder: '300',
							onChange: (value) => update('refreshSeconds', Number(value) || ''),
							disabled: busy
						})),
						react.createElement(Field, {
							label: '预警阈值（天）',
							hint: '剩余可用天数低于「转黄」变琥珀色，低于「转红」变红色。'
						},
						react.createElement('div', { style: { display: 'flex', gap: '8px' } },
							react.createElement('div', { style: { flex: 1 } },
								react.createElement(TextInput, {
									value: current.warningDays ?? '',
									placeholder: '转黄 3',
									onChange: (value) => update('warningDays', Number(value) || ''),
									disabled: busy
								})),
							react.createElement('div', { style: { flex: 1 } },
								react.createElement(TextInput, {
									value: current.criticalDays ?? '',
									placeholder: '转红 1',
									onChange: (value) => update('criticalDays', Number(value) || ''),
									disabled: busy
								})))),
						react.createElement(Field, { label: '充值页地址' },
							react.createElement(TextInput, {
								value: current.walletURL ?? '',
								placeholder: 'https://ai.zhijianginc.com/console/wallet',
								onChange: (value) => update('walletURL', value),
								disabled: busy
							})))
					: null,

				react.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', marginTop: '14px' } },
					button('保存', saveAll, true),
					status
						? react.createElement('span', {
							style: { fontSize: '11px', color: status.ok ? '#41ba41' : '#f43146' }
						}, status.text)
						: null),

				react.createElement('div', { style: { fontSize: '11px', opacity: 0.6, marginTop: '12px', lineHeight: 1.6 } },
					'保存后写入本机设置文件（$DSH_HOME/storages/zhijiang-connector-settings.json），优先于 profile 配置，立即生效。'));
		}

		/**
		 * Services required by the client half.
		 *
		 * `locale` must be listed here, not merely tested for. The Cordis context
		 * is a proxy: reading an undeclared service throws
		 * `cannot get property "locale" without inject`, and that throw lands
		 * inside `apply` — which the harness reports as a failed client entry
		 * ("web boot: N entries did not activate"). Declaring it makes the
		 * dependency real and lets the fiber wait for the service instead of
		 * crashing on first read.
		 */
		const inject = ['slots', 'locale'];

		/**
		 * Dictionary namespace for this package's UI text.
		 *
		 * The package ships `locale/zh.json` and `locale/en.json`; registering them
		 * here is what makes those files load-bearing instead of decorative. The
		 * translate function falls back to the key's own Chinese text when the
		 * locale service is absent, so a page still renders on a stripped profile.
		 */
		const LOCALE_NS = 'zhijiang-connector';

		/**
		 * Register the badge and the editable settings section.
		 *
		 * The settings page does not depend on the harness config form: it reads
		 * and writes the plugin's own settings route, so it keeps working on a
		 * profile where the config-form seam is absent or rejects writes.
		 *
		 * @param {object} ctx - client root context.
		 * @returns {void}
		 */
		function apply(ctx) {
			// Read the optional locale service through one guarded accessor.
			//
			// `ctx` is a Cordis proxy: reading a *declared* service that has not
			// started yet throws, and reading an *undeclared* one always throws.
			// This plugin only uses locale for cosmetic strings, so a missing
			// service must degrade to the built-in Chinese text instead of taking
			// the whole client entry down with it.
			const locale = readService(ctx, 'locale');

			// Register the shipped dictionaries when the locale service is present.
			// Without this, `locale/*.json` would be dead weight in the package.
			if (locale && typeof locale.register === 'function') {
				ctx.effect(() => locale.register(LOCALE_NS, {
					zh: {
						'settings.title': '开物云',
						'settings.apiKey': 'API 密钥',
						'settings.token': '余额查询令牌',
						'settings.saveAs': '保存为',
						'settings.save': '保存',
						'settings.clear': '清除',
						'settings.advanced': '高级设置（站点地址 / 刷新间隔 / 预警阈值）',
						'settings.change': '更改',
						'settings.confirm': '确定',
						'settings.cancel': '取消'
					},
					en: {
						'settings.title': 'Kaiwu Cloud',
						'settings.apiKey': 'API key',
						'settings.token': 'Balance token',
						'settings.saveAs': 'Stored as',
						'settings.save': 'Save',
						'settings.clear': 'Clear',
						'settings.advanced': 'Advanced (site, refresh interval, thresholds)',
						'settings.change': 'Change',
						'settings.confirm': 'OK',
						'settings.cancel': 'Cancel'
					}
				}), 'zhijiang-connector: dictionaries');
			}

			ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
				name: 'sidebar.footer.action',
				id: 'zhijiang-connector',
				// Renders after the usage plugin's order 10. Both are list entries in
				// one flex row, so the numbers only decide which side each sits on.
				order: 20
			}, ConnectorBadge));

			// Bind once per apply: the returned function reads the active locale at
			// call time, so a language switch needs no re-registration.
			const t = locale && typeof locale.bind === 'function'
				? locale.bind(LOCALE_NS)
				: (key, fallback) => fallback ?? key;

			ctx.slots.inject('settings.section', () => ctx.slots.register({
				name: 'settings.section',
				id: 'zhijiang',
				order: 60,
				label: () => t('settings.title', '开物云')
			}, (props) => react.createElement(SettingsSection, { ...(props ?? {}), t })));
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.ConnectorBadge = ConnectorBadge;
		exports.SettingsSection = SettingsSection;
		exports.Panel = Panel;
		exports.badgeText = badgeText;
		return module.exports;
	}
});
