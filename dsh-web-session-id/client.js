/**
 * dsh web 的「ID」按钮（这个 bundle 的浏览器半边）。
 *
 * 需求：会话标题栏**右上角**一个按钮，点开**悬浮窗**看当前会话 id（带复制按钮）；
 * **不在会话里就不显示**；设置里能关掉这个按钮。
 *
 * 三个落点（都先查过 `Slots.listSubTree` 才写，不是猜的）：
 *   1. `conversation.session.header.utilities` —— "Right-aligned Session utilities"，
 *      **scope: session**：会话标题栏右侧那一排就是它，而且**没有会话时这一整片根本不渲染**，
 *      所以"不在会话里不显示"是槽位自带的性质，不需要自己判断。
 *      该槽位顶点：宿主自己的 `open-in-app`(-10)、`session-log-download`(0)，
 *      第三方 `dsh-watcher`(50) —— 我们取 20，插在"下载会话记录"与 watcher 之间。
 *   2. `settings.general.item` —— "One preference row inside the General section"，
 *      不需要单独页面的开关就放这里；这一行的**标签、当前值、写入都由自己画**（宿主只叠行）。
 *   3. 设置存 `localStorage`（**只影响这个浏览器**）。为什么不用别的：客户端 Service 目录里
 *      没有通用的偏好/存储服务（只有 layout/locale/sessions/slots/theme/timer/uiWorkspace/workspaces），
 *      而 `host.call` 是**动态包**（cordis_run）才有的通道，bundle 的浏览器半边拿不到。
 *      要彻底关掉（对所有浏览器）：设置 → 插件 里禁用这一行。
 *
 * 样式：只用主题 token，取值与写法照抄宿主自己的 `ConversationRoot` 样式
 * （`headerUtilities` 是 `flex + gap:8px`；行内小按钮＝透明底 + `--dsw-radius-md`
 * + hover `--dsw-alias-interactive-bg-hover`；`<style>` 作为组件子元素渲染，
 * 组件卸载即消失，不往 `document.head/body` 写东西）。
 * **不 require 任何 @deepseek-ai/* 包**：只 require('react')，其余走 ctx.get 的 Service。
 */

window.__ModuleLoader__.load({
	id: '@local/dsh-web-session-id',
	factory(require) {
		const React = require('react')
		const h = React.createElement

		const NS = 'dsh-web-session-id'
		const STORAGE_KEY = 'dsh-web-session-id:hidden'
		const SLOT_UTILITIES = 'conversation.session.header.utilities'
		const SLOT_SETTINGS = 'settings.general.item'

		/** 文案：中英各一份，注册进 locale 的 `dsh-web-session-id` 命名空间。 */
		const TEXT = {
			zh: {
				button: 'ID',
				buttonTitle: '当前会话 ID：点开可看完整 id 并复制',
				panelTitle: '当前会话 ID',
				copy: '复制',
				copied: '已复制',
				copyFailed: '复制失败：请选中上面的 id，再按 Ctrl/⌘ + C。',
				hide: '隐藏这个按钮',
				hideTitle: '不再显示（设置 → 通用 →「会话 ID 按钮」里可以重新打开）',
				rowTitle: '会话 ID 按钮',
				rowDesc: '在会话标题栏右上角显示「ID」按钮：点开悬浮窗可看当前会话 id 并复制。关掉后按钮不再显示。',
				rowOn: '显示中',
				rowOff: '已关闭',
				rowAria: '在标题栏显示会话 ID 按钮',
			},
			en: {
				button: 'ID',
				buttonTitle: 'Current session ID: open to view and copy',
				panelTitle: 'Current session ID',
				copy: 'Copy',
				copied: 'Copied',
				copyFailed: 'Copy failed: select the id above and press Ctrl/⌘ + C.',
				hide: 'Hide this button',
				hideTitle: 'Hide it (turn it back on in Settings → General → “Session ID button”)',
				rowTitle: 'Session ID button',
				rowDesc:
					'Show an “ID” button at the top-right of the session header; it opens a panel with the current session id and a copy button. Turn it off to hide the button.',
				rowOn: 'Shown',
				rowOff: 'Hidden',
				rowAria: 'Show the session ID button in the header',
			},
		}

		// ── 设置：按钮是否隐藏（localStorage，默认显示） ────────────────────────
		const listeners = new Set()
		let hidden = readHidden()

		function readHidden() {
			try {
				return window.localStorage.getItem(STORAGE_KEY) === '1'
			} catch {
				return false
			}
		}

		function writeHidden(value) {
			try {
				if (value) window.localStorage.setItem(STORAGE_KEY, '1')
				else window.localStorage.removeItem(STORAGE_KEY)
			} catch {
				// 隐私模式等禁用 storage：不影响本次会话内的开关
			}
		}

		function setHidden(value) {
			hidden = Boolean(value)
			writeHidden(hidden)
			for (const listener of [...listeners]) {
				try {
					listener()
				} catch {
					// 单个订阅者出错不影响其它订阅者
				}
			}
		}

		/** 订阅"是否隐藏"并返回当前值（改设置时按钮立即消失/出现）。 */
		function useHidden() {
			const [, bump] = React.useState(0)
			React.useEffect(() => {
				const listener = () => bump((n) => n + 1)
				listeners.add(listener)
				return () => {
					listeners.delete(listener)
				}
			}, [])
			return hidden
		}

		/** 复制到剪贴板：先 Clipboard API，失败退到"选中 + execCommand"。 */
		async function copyText(text, element) {
			try {
				if (navigator?.clipboard?.writeText) {
					await navigator.clipboard.writeText(text)
					return true
				}
			} catch {
				// 落到底下兜底
			}
			try {
				const selection = window.getSelection?.()
				if (selection && element) {
					const range = document.createRange()
					range.selectNodeContents(element)
					selection.removeAllRanges()
					selection.addRange(range)
				}
				return typeof document.execCommand === 'function' ? document.execCommand('copy') : false
			} catch {
				return false
			}
		}

		// ── 样式：只用主题 token，类名统一 `dsw-sid-` 前缀 ──────────────────────
		const CSS = `
.dsw-sid-root{position:relative;display:inline-flex;align-items:center}
.dsw-sid-button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;min-width:26px;height:26px;padding:0 7px;border:none;border-radius:var(--dsw-radius-md,6px);background:transparent;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font:600 11px/1 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;letter-spacing:.06em;cursor:pointer}
.dsw-sid-button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary)}
.dsw-sid-button[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary)}
.dsw-sid-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsw-sid-pop{position:absolute;top:calc(100% + 6px);right:0;z-index:30;display:flex;flex-direction:column;gap:8px;box-sizing:border-box;width:max-content;max-width:min(420px,72vw);padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:0 8px 24px rgba(0,0,0,.18);font:12px/1.6 ui-sans-serif,system-ui,sans-serif;text-align:left}
.dsw-sid-label{color:var(--dsw-alias-label-secondary);font-size:11px}
.dsw-sid-id{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;word-break:break-all;user-select:all}
.dsw-sid-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px}
.dsw-sid-status{color:var(--dsw-alias-state-success-primary);font-size:11px;margin-right:auto}
.dsw-sid-note{color:var(--dsw-alias-state-warn-primary);font-size:11px}
.dsw-sid-copy{height:26px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,6px);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:500 12px/1 ui-sans-serif,system-ui,sans-serif;cursor:pointer}
.dsw-sid-copy:hover{border-color:var(--dsw-alias-brand-primary)}
.dsw-sid-copy:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsw-sid-hide{padding:0;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font:500 12px/1 ui-sans-serif,system-ui,sans-serif;cursor:pointer;text-decoration:underline;text-underline-offset:2px}
.dsw-sid-hide:hover{color:var(--dsw-alias-label-primary)}
.dsw-sid-hide:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsw-sid-row{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:10px 0}
.dsw-sid-rowText{display:flex;flex-direction:column;gap:3px;min-width:0}
.dsw-sid-rowTitle{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500}
.dsw-sid-rowDesc{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}
.dsw-sid-switch{position:relative;flex:none;width:36px;height:20px;margin-top:2px;padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-2);cursor:pointer;transition:background .12s ease,border-color .12s ease}
.dsw-sid-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.dsw-sid-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dsw-sid-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-label-secondary);transition:transform .12s ease,background .12s ease}
.dsw-sid-switch[aria-checked="true"] .dsw-sid-knob{transform:translateX(16px);background:var(--dsw-alias-bg-base)}
`

		function StyleTag() {
			return h('style', { dangerouslySetInnerHTML: { __html: CSS } })
		}

		return {
			inject: ['slots'],
			apply(ctx) {
				// ── 文案：locale 是**可选** Service（没有就退回内置中文/英文） ────
				const t = (() => {
					let translate = null
					try {
						const locale = ctx.get('locale')
						if (locale && typeof locale.register === 'function' && typeof locale.bind === 'function') {
							const snapshot = typeof locale.getLocale === 'function' ? locale.getLocale() : null
							const ids = Array.isArray(snapshot?.locales) ? snapshot.locales.map((item) => item.id) : []
							for (const id of ids.length > 0 ? ids : ['zh-CN', 'en']) {
								try {
									const dispose = locale.register(NS, id, /^zh/i.test(String(id)) ? TEXT.zh : TEXT.en)
									// 注册是 effect：插件卸载时把字典一起摘掉。
									ctx.effect(() => () => {
										try {
											dispose?.()
										} catch {
											// 卸载失败忽略
										}
									})
								} catch {
									// 该 (ns, locale) 已被占：直接用兜底文案
								}
							}
							translate = locale.bind(NS)
						}
					} catch {
						translate = null
					}
					return (key, fallback) => {
						if (typeof translate !== 'function') return fallback
						try {
							const value = translate(key)
							return typeof value === 'string' && value && value !== key ? value : fallback
						} catch {
							return fallback
						}
					}
				})()

				/** 语言切换后重渲染（文案走 bind 的翻译函数，调用时才读当前语言）。 */
				function useLocaleTick() {
					const [, bump] = React.useState(0)
					React.useEffect(() => {
						let locale = null
						try {
							locale = ctx.get('locale')
						} catch {
							locale = null
						}
						if (!locale || typeof locale.subscribe !== 'function') return undefined
						return locale.subscribe(() => bump((n) => n + 1))
					}, [])
				}

				// ── 标题栏右上角那个「ID」按钮 ────────────────────────────────
				function SessionIdButton(props) {
					const hiddenNow = useHidden()
					useLocaleTick()
					const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
					const [open, setOpen] = React.useState(false)
					const [copied, setCopied] = React.useState(false)
					const [failed, setFailed] = React.useState(false)
					const rootRef = React.useRef(null)
					const idRef = React.useRef(null)

					// 点外面 / Esc 关掉悬浮窗（挂 document，卸载时一定摘掉）。
					React.useEffect(() => {
						if (!open) return undefined
						const onPointerDown = (event) => {
							const root = rootRef.current
							if (root && event.target instanceof Node && root.contains(event.target)) return
							setOpen(false)
						}
						const onKeyDown = (event) => {
							if (event.key === 'Escape') setOpen(false)
						}
						document.addEventListener('mousedown', onPointerDown, true)
						document.addEventListener('keydown', onKeyDown)
						return () => {
							document.removeEventListener('mousedown', onPointerDown, true)
							document.removeEventListener('keydown', onKeyDown)
						}
					}, [open])

					// 槽位是 session 作用域，拿不到会话就什么都不画（与"不在会话不显示"一致）。
					if (hiddenNow || !sessionId) return null

					const onCopy = () => {
						void copyText(sessionId, idRef.current).then((ok) => {
							setCopied(ok)
							setFailed(!ok)
						})
					}

					return h(
						'div',
						{ className: 'dsw-sid-root', ref: rootRef, 'data-session-id-button': '' },
						h(StyleTag, { key: 'style' }),
						h(
							'button',
							{
								key: 'button',
								type: 'button',
								className: 'dsw-sid-button',
								title: t('buttonTitle', 'Current session ID'),
								'aria-label': t('buttonTitle', 'Current session ID'),
								'aria-expanded': open ? 'true' : 'false',
								onClick: () => {
									setCopied(false)
									setFailed(false)
									setOpen((value) => !value)
								},
							},
							t('button', 'ID'),
						),
						!open
							? null
							: h(
									'div',
									{
										key: 'pop',
										className: 'dsw-sid-pop',
										role: 'dialog',
										'aria-label': t('panelTitle', 'Current session ID'),
									},
									h('div', { className: 'dsw-sid-label' }, t('panelTitle', 'Current session ID')),
									h('code', { className: 'dsw-sid-id', ref: idRef }, sessionId),
									h(
										'div',
										{ className: 'dsw-sid-actions' },
										failed ? h('span', { className: 'dsw-sid-note' }, t('copyFailed', 'Copy failed')) : null,
										copied ? h('span', { className: 'dsw-sid-status' }, t('copied', 'Copied')) : null,
										// 就地关掉（写的就是设置里那一份状态）：省得为了关它再去翻设置页。
										h(
											'button',
											{
												type: 'button',
												className: 'dsw-sid-hide',
												title: t('hideTitle', 'Hide it (Settings → General)'),
												onClick: () => setHidden(true),
											},
											t('hide', 'Hide this button'),
										),
										h('button', { type: 'button', className: 'dsw-sid-copy', onClick: onCopy }, t('copy', 'Copy')),
									),
								),
					)
				}

				// ── 设置 → 通用 里那一行开关 ──────────────────────────────────
				function SessionIdSettingRow() {
					const hiddenNow = useHidden()
					useLocaleTick()
					const shown = !hiddenNow
					return h(
						'div',
						{ className: 'dsw-sid-row', 'data-session-id-setting': '' },
						h(StyleTag, { key: 'style' }),
						h(
							'div',
							{ key: 'text', className: 'dsw-sid-rowText' },
							h('div', { className: 'dsw-sid-rowTitle' }, t('rowTitle', 'Session ID button')),
							h('div', { className: 'dsw-sid-rowDesc' }, t('rowDesc', 'Show an ID button in the session header.')),
						),
						h(
							'button',
							{
								key: 'switch',
								type: 'button',
								role: 'switch',
								className: 'dsw-sid-switch',
								'aria-checked': shown ? 'true' : 'false',
								'aria-label': t('rowAria', 'Show the session ID button'),
								title: shown ? t('rowOn', 'Shown') : t('rowOff', 'Hidden'),
								onClick: () => setHidden(shown),
							},
							h('span', { className: 'dsw-sid-knob', 'aria-hidden': 'true' }),
						),
					)
				}

				// 标题栏右侧那一排（没有会话时整个槽位都不渲染 → 天然"不在会话就不显示"）。
				ctx.slots.inject(SLOT_UTILITIES, () =>
					ctx.slots.register({ name: SLOT_UTILITIES, id: 'session-id', order: 20, label: t('button', 'ID') }, SessionIdButton),
				)

				// 设置 → 通用：一行开关（含自己的标签与当前值）。
				ctx.slots.inject(SLOT_SETTINGS, () =>
					ctx.slots.register({ name: SLOT_SETTINGS, id: 'session-id', order: 25 }, SessionIdSettingRow),
				)
			},
		}
	},
})
