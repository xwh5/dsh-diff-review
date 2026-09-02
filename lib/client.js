window.__ModuleLoader__.load({
	id: "dsh-diff-review",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");

		// ── shared store ───────────────────────────────────────────────────
		const store = {
			files: null, loadingFiles: false,
			selected: null, detail: null, loadingDetail: false, error: null,
			currentSession: null,
			mode: "session", latestTurn: 0, turnData: null
		};
		const listeners = new Set();
		function setState(patch) {
			Object.assign(store, patch);
			listeners.forEach((fn) => fn());
		}
		function useStore(selector) {
			const [v, setV] = React.useState(() => selector(store));
			React.useEffect(() => {
				const fn = () => setV(selector(store));
				listeners.add(fn);
				return () => listeners.delete(fn);
			}, []);
			return v;
		}

		// ── fetch sequencing: every async load stamps a token; a stale response
		// (previous session / superseded file) is dropped instead of clobbering the UI
		let reqSeq = 0

		// ── host data via HTTP routes ──────────────────────────────────────
		function apiSummary(session) { return fetch("/diff-review/summary?session=" + encodeURIComponent(session)).then((r) => r.json()); }
		function apiFile(session, path) { return fetch("/diff-review/file?session=" + encodeURIComponent(session) + "&path=" + encodeURIComponent(path)).then((r) => r.json()); }
		function apiClear(session) { return fetch("/diff-review/clear?session=" + encodeURIComponent(session), { method: "POST" }).then((r) => r.json()); }
		function apiRevert(session, path, op) {
			return fetch("/diff-review/revert?session=" + encodeURIComponent(session), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path: path, op: op === undefined ? null : op })
			}).then((r) => r.json());
		}
		function apiTurn(session, turn) {
			return fetch("/diff-review/turn?session=" + encodeURIComponent(session) + "&turn=" + encodeURIComponent(String(turn))).then((r) => r.json());
		}

		function loadSummary() {
			const session = store.currentSession;
			if (!session) return;
			const seq = ++reqSeq;
			setState({ loadingFiles: true, error: null });
			apiSummary(session).then((v) => {
				if (seq !== reqSeq || store.currentSession !== session) return;
				setState({ files: (v && v.files) || [], latestTurn: (v && typeof v.latestTurn === "number") ? v.latestTurn : 0, loadingFiles: false });
				if (store.mode === "latest") loadLatest();
			}).catch((e) => {
				if (seq !== reqSeq || store.currentSession !== session) return;
				setState({ error: String((e && e.message) || e), loadingFiles: false });
			});
		}
		// Latest-turn view: files + sections for the most recent recorded turn.
		function loadLatest() {
			const session = store.currentSession;
			const turn = store.latestTurn;
			if (!session || turn == null) { setState({ turnData: null }); return; }
			const seq = ++reqSeq;
			apiTurn(session, turn).then((v) => {
				if (seq !== reqSeq || store.currentSession !== session) return;
				setState({ turnData: (v && v.files) ? v : null });
			}).catch(() => {
				if (seq !== reqSeq || store.currentSession !== session) return;
				setState({ turnData: null });
			});
		}
		function setMode(mode) {
			setState({ mode: mode, selected: null, detail: null });
			if (mode === "latest") loadLatest();
		}
		// Select a file: latest mode shows the turn payload's inline sections.
		function selectFile(f) {
			if (store.mode === "latest") {
				setState({
					selected: f.path,
					detail: { path: f.path, sections: (f && f.sections) || [], revertible: !!(f && f.revertible) },
					loadingDetail: false,
					error: null
				});
			} else {
				loadDetail(f.path);
			}
		}
		function loadDetail(path) {
			const session = store.currentSession;
			if (!session) return;
			const seq = ++reqSeq;
			setState({ selected: path, detail: null, loadingDetail: true, error: null });
			apiFile(session, path).then((v) => {
				if (seq !== reqSeq || store.currentSession !== session || store.selected !== path) return;
				setState({ detail: v, loadingDetail: false });
			}).catch((e) => {
				if (seq !== reqSeq || store.currentSession !== session) return;
				setState({ error: String((e && e.message) || e), loadingDetail: false });
			});
		}
		function refresh() {
			loadSummary();
			if (store.mode === "latest") { loadLatest(); return; }
			if (store.selected) loadDetail(store.selected);
		}
		function refreshFromServer() {
			const session = store.currentSession;
			if (!session) return;
			const seq = ++reqSeq;
			apiSummary(session).then((v) => {
				if (seq !== reqSeq || store.currentSession !== session) return;
				const next = (v && v.files) || [];
				const latestTurn = (v && typeof v.latestTurn === "number") ? v.latestTurn : 0;
				const cur = store.files;
				const hadFiles = cur !== null;
				const curList = cur || [];
				let changed = !hadFiles || next.length !== curList.length;
				if (!changed && hadFiles) {
					for (let i = 0; i < next.length; i++) {
						const a = next[i];
						const b = curList[i];
						if (!b || a.path !== b.path || a.lastTime !== b.lastTime || a.ops !== b.ops) { changed = true; break; }
					}
				}
				if (changed || latestTurn !== store.latestTurn) {
					setState({ files: next, latestTurn: latestTurn, loadingFiles: false });
					if (store.mode === "latest") loadLatest();
				} else if (!hadFiles) {
					setState({ files: [], loadingFiles: false });
				}
			}).catch(() => {});
		}

		function connectEvents() {
			const es = new EventSource("/diff-review/events");
			es.onopen = () => {
				// 重连后重新同步，避免重连期间丢失的变更造成角标/列表不一致
				if (store.currentSession) refreshFromServer();
			};
			es.onmessage = (e) => {
				let matches = true;
				try {
					const d = JSON.parse(e.data);
					if (d && d.session) matches = d.session === store.currentSession;
				} catch (err) {}
				if (matches) refreshFromServer();
			};
			es.onerror = () => {
				// EventSource 会自动重连，onopen 时会重新同步
			};
			return () => es.close();
		}

		function fmtTime(t) {
			if (!t) return "";
			const d = new Date(t);
			const p = (x) => String(x).padStart(2, "0");
			return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
		}

		// ── ErrorBoundary: 隔离单个 diff/section 的渲染异常，避免整页白屏 ──
		class ErrorBoundary extends React.Component {
			constructor(props) { super(props); this.state = { hasError: false, error: null }; }
			static getDerivedStateFromError(error) { return { hasError: true, error }; }
			componentDidCatch(error, info) { try { console.error("[dsh-diff-review] render error:", error, info); } catch (e) {} }
			render() {
				if (this.state.hasError) {
					return React.createElement("div", { className: "drv-empty", style: { color: "#cf222e", textAlign: "left", padding: "12px" } },
						React.createElement("div", { style: { fontWeight: 600 } }, "该区块渲染失败，已降级为纯文本"),
						React.createElement("pre", { style: { whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: "11px", opacity: 0.8, marginTop: "6px" } }, String(this.state.error && this.state.error.message || this.state.error)),
						this.props.fallback || null);
				}
				return this.props.children;
			}
		}

		// ── diff2html local loading ──────────────────────────────────────────
		let diff2htmlReady = false;
		function loadDiff2Html() {
			if (diff2htmlReady || window.Diff2Html) { diff2htmlReady = true; return; }
			const base = "/dsh-diff-review/vendor";
			// CSS
			if (!document.querySelector('link[href*="diff2html"]')) {
				const link = document.createElement("link");
				link.rel = "stylesheet";
				link.href = base + "/diff2html.min.css";
				document.head.appendChild(link);
			}
			// JS core
			if (!document.querySelector('script[src*="diff2html.min.js"]')) {
				const s1 = document.createElement("script");
				s1.src = base + "/diff2html.min.js";
				s1.onload = () => { diff2htmlReady = true; };
				document.head.appendChild(s1);
			}
			// JS UI (syntax highlight)
			if (!document.querySelector('script[src*="diff2html-ui.min.js"]')) {
				const s2 = document.createElement("script");
				s2.src = base + "/diff2html-ui.min.js";
				document.head.appendChild(s2);
			}
		}

		// ── convert hunks to unified diff format for diff2html ─────────────
		function hunksToUnifiedDiff(hunks, filePath) {
			filePath = filePath || "file";
			// Calculate line numbers for @@ header
			let oldStart = 1, oldLines = 0, newStart = 1, newLines = 0;
			let inHunk = false;
			for (const h of hunks) {
				if (h.type === "ctx") {
					if (!inHunk) { oldStart = h.a || 1; newStart = h.b || 1; inHunk = true; }
					oldLines++; newLines++;
				} else if (h.type === "del") {
					if (!inHunk) { oldStart = h.a || 1; newStart = (h.b || 1); inHunk = true; }
					oldLines++;
				} else if (h.type === "add") {
					if (!inHunk) { oldStart = (h.a || 1); newStart = h.b || 1; inHunk = true; }
					newLines++;
				}
			}
			// Build unified diff with proper headers
			const lines = [];
			lines.push("diff --git a/" + filePath + " b/" + filePath);
			lines.push("index 0000000..0000001");
			lines.push("--- a/" + filePath);
			lines.push("+++ b/" + filePath);
			lines.push("@@ -" + oldStart + "," + oldLines + " +" + newStart + "," + newLines + " @@");
			for (const h of hunks) {
				if (h.type === "ctx") {
					lines.push(" " + h.text);
				} else if (h.type === "del") {
					lines.push("-" + h.text);
				} else if (h.type === "add") {
					lines.push("+" + h.text);
				}
			}
			return lines.join("\n");
		}

		// ── diff2html renderer component ───────────────────────────────────
		function Diff2HtmlBlock({ hunks, filePath }) {
			const ref = React.useRef(null);
			const [failed, setFailed] = React.useState(false);
			const [theme, setTheme] = React.useState(detectDshTheme());
			// Watch for theme changes
			React.useEffect(() => {
				const updateTheme = () => setTheme(detectDshTheme());
				const observer = new MutationObserver(updateTheme);
				observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
				observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
				if (window.matchMedia) {
					window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', updateTheme);
				}
				return () => {
					observer.disconnect();
					if (window.matchMedia) {
						window.matchMedia('(prefers-color-scheme: dark)').removeEventListener('change', updateTheme);
					}
				};
			}, []);
			// Render diff when theme or content changes
			React.useEffect(() => {
				if (!ref.current || failed) return;
				if (!window.Diff2Html) {
					loadDiff2Html();
					const check = setInterval(() => {
						if (window.Diff2Html && ref.current) {
							clearInterval(check);
							const ok = renderDiff(ref.current, hunks, filePath, theme);
							if (!ok) setFailed(true);
						}
					}, 100);
					const timeout = setTimeout(() => { clearInterval(check); setFailed(true); }, 8000);
					return () => { clearInterval(check); clearTimeout(timeout); };
				}
				const ok = renderDiff(ref.current, hunks, filePath, theme);
				if (!ok) setFailed(true);
			}, [hunks, filePath, failed, theme]);
			if (failed) {
				return React.createElement("div", { className: "drv-section-body" },
					hunks.map((h, i) => React.createElement(Line, { key: i, h })));
			}
			return React.createElement("div", { ref, className: "drv-diff2html" });
		}
		// Detect DSH theme: prefer the real color-scheme DSH writes to
		// documentElement.style (set at boot and on appearance change); fall back
		// to class/data-attr, then OS preference.
		function detectDshTheme() {
			try {
				const cs = document.documentElement.style.colorScheme
					|| getComputedStyle(document.documentElement).colorScheme;
				if (cs === 'dark') return 'dark';
				if (cs === 'light') return 'light';
			} catch (e) {}
			if (document.documentElement.classList.contains('dsw-dark')) return 'dark';
			if (document.documentElement.getAttribute('data-theme') === 'dark') return 'dark';
			if (document.body.classList.contains('dark')) return 'dark';
			if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
			return 'light';
		}

		function renderDiff(el, hunks, filePath, theme) {
			try {
				const diffStr = hunksToUnifiedDiff(hunks, filePath);
				if (!diffStr || hunks.length === 0) return false;
				theme = theme || detectDshTheme();
				if (window.Diff2HtmlUI) {
					el.innerHTML = "";
					const ui = new window.Diff2HtmlUI(el, diffStr, {
						outputFormat: "side-by-side",
						matching: "lines",
						drawFileList: false,
						syncScroll: { target: true, container: true },
						colorScheme: theme
					});
					ui.draw();
					ui.highlightCode();
					return true;
				} else if (window.Diff2Html) {
					el.innerHTML = window.Diff2Html.html(diffStr, {
						outputFormat: "side-by-side",
						matching: "lines",
						drawFileList: false,
						colorScheme: theme
					});
					return true;
				}
				return false;
			} catch (e) {
				console.error("[dsh-diff-review] diff2html render error:", e);
				el.innerHTML = '<pre style="color:red">Diff render error: ' + String(e) + '</pre>';
				return false;
			}
		}

		// ── diff line rendering (fallback) ─────────────────────────────────
		function Line({ h }) {
			let cls;
			if (h.type === "add") cls = "drv-add";
			else if (h.type === "del") cls = "drv-del";
			else cls = "drv-ctx";
			return React.createElement("div", { className: "drv-line " + cls },
				React.createElement("span", { className: "drv-gutter" }, h.a != null ? String(h.a) : ""),
				React.createElement("span", { className: "drv-gutter drv-gutter-sign" }, h.type === "add" ? "+" : h.type === "del" ? "−" : " "),
				React.createElement("span", { className: "drv-gutter" }, h.b != null ? String(h.b) : ""),
				React.createElement("span", { className: "drv-text" }, h.text));
		}

		function Section({ section, onRevert, busy, filePath }) {
			const kindLabel = section.kind === "edit" ? "编辑" : "写入";
			const cls = section.kind === "edit" ? "drv-badge-edit" : "drv-badge-new";
			// Use diff2html for edit sections, fallback for write
			const useDiff2Html = section.kind === "edit" && section.hunks && section.hunks.length > 0;
			const body = useDiff2Html
				? React.createElement(ErrorBoundary, { fallback: React.createElement("div", { className: "drv-section-body" }, section.hunks.map((h, i) => React.createElement(Line, { key: i, h }))) },
					React.createElement(Diff2HtmlBlock, { hunks: section.hunks, filePath }))
				: section.hunks.map((h, i) => React.createElement(Line, { key: i, h }));
			return React.createElement(ErrorBoundary, null,
				React.createElement("div", { className: "drv-section" },
					React.createElement("div", { className: "drv-section-head" },
						React.createElement("span", { className: "drv-badge " + cls }, kindLabel),
						React.createElement("span", { className: "drv-section-label" }, section.kind === "edit" ? "修改对比 · side-by-side" : "文件内容 · 完整写入"),
						section.truncated ? React.createElement("span", { className: "drv-section-time" }, "内容过长已截断") : null,
						React.createElement("span", { className: "drv-header-spacer" }),
						React.createElement("span", { className: "drv-section-time" }, fmtTime(section.at)),
						section.canUndo ? React.createElement("button", {
							className: "drv-btn drv-btn-revert",
							title: "撤回该项修改：文件恢复到该项修改之前的内容，其后无冲突的修改保留",
							disabled: busy,
							onClick: () => onRevert(section.opIndex)
						}, "撤回此项") : null),
					React.createElement("div", { className: "drv-section-body" }, body)));
		}

		function Detail({ onRevert, onRevertAll, busy }) {
			const selected = useStore((s) => s.selected);
			const detail = useStore((s) => s.detail);
			const loading = useStore((s) => s.loadingDetail);
			const error = useStore((s) => s.error);
			if (loading) return React.createElement("div", { className: "drv-empty" }, "加载中…");
			if (error) return React.createElement("div", { className: "drv-empty" }, "出错：" + error);
			if (!selected) return React.createElement("div", { className: "drv-empty" }, "在左侧选择文件查看修改对比");
			if (!detail || !detail.sections || detail.sections.length === 0) return React.createElement("div", { className: "drv-empty" }, "该文件没有可展示的修改");
			return React.createElement("div", null,
				React.createElement("div", { className: "drv-detail-toolbar" },
					React.createElement("span", { className: "drv-detail-path", title: detail.path }, detail.path),
					React.createElement("span", { className: "drv-header-spacer" }),
					React.createElement("button", {
						className: "drv-btn drv-btn-revert drv-btn-danger",
						title: "撤回该文件的全部修改：恢复到本次会话首次修改之前的内容（会话中新建的文件将被删除）",
						disabled: busy || detail.revertible !== true,
						onClick: onRevertAll
					}, "撤回全部修改")),
				detail.sections.map((sec, i) => React.createElement(Section, { key: i, section: sec, onRevert: onRevert, busy: busy, filePath: detail.path })));
		}

		function FileList() {
			const mode = useStore((s) => s.mode);
			const files = useStore((s) => s.files);
			const turnData = useStore((s) => s.turnData);
			const selected = useStore((s) => s.selected);
			const loading = useStore((s) => s.loadingFiles);
			const latestTurn = useStore((s) => s.latestTurn);
			const list = mode === "latest" ? (turnData && turnData.files) || [] : (files || []);
			if (loading) return React.createElement("div", { className: "drv-empty" }, "加载中…");
			if (!list || list.length === 0) {
				if (mode === "latest") {
					const hint = !latestTurn
						? "当前会话暂无已记录的轮次，或最新一轮未产生文件修改"
						: "第 " + latestTurn + " 轮未产生文件修改";
					return React.createElement("div", { className: "drv-empty" },
						React.createElement("div", null, hint),
						React.createElement("div", { style: { marginTop: "8px", fontSize: "12px", opacity: 0.7 } }, "可切换到「此会话」查看全部变更"));
				}
				return React.createElement("div", { className: "drv-empty" }, "暂无修改记录");
			}
			const fileRow = (f) => {
				const cls = "drv-file" + (f.path === selected ? " drv-selected" : "");
				return React.createElement("button", {
					key: f.path || f.name, className: cls,
					title: f.path,
					onClick: () => selectFile(f)
				},
					React.createElement("span", { className: "drv-file-top" },
						React.createElement("span", { className: "drv-file-name" }, f.name)),
					React.createElement("span", { className: "drv-file-meta" },
						(f.writes > 0 ? "写×" + f.writes + " " : "") + (f.edits > 0 ? "改×" + f.edits : ""),
						React.createElement("span", { className: "drv-file-add" }, "+" + f.added),
						React.createElement("span", { className: "drv-file-del" }, "−" + f.removed)));
			};
			return React.createElement("div", { className: "drv-filelist-inner" }, list.map(fileRow));
		}

		function SessionProbe(props) {
			React.useEffect(() => {
				if (props.sessionId && store.currentSession !== props.sessionId) {
					reqSeq++; // 丢弃上一个会话仍在途的请求
					setState({ currentSession: props.sessionId, files: null, selected: null, detail: null, mode: "session", turnData: null, latestTurn: 0, error: null, loadingFiles: true });
					refreshFromServer();
				}
			}, [props.sessionId]);
			return null;
		}

		function TabLabel() {
			const files = useStore((s) => s.files);
			const count = files ? files.length : 0;
			return React.createElement("span", { className: "drv-tab-label" },
				React.createElement("span", null, "审查"),
				count > 0 ? React.createElement("span", {
					className: "drv-tab-badge"
				}, String(count)) : null);
		}

		// ── per-turn review card. Registers into the turnTail chain under its
		// OWN cell name, so the native deliverables chips keep their cell and
		// their click-to-preview behavior untouched.
		function TurnReview({ matched, sessionId }) {
			const turnNo = matched && matched.turn;
			const [data, setData] = React.useState(null);
			const [expanded, setExpanded] = React.useState(null);
			const [busy, setBusy] = React.useState(false);
			React.useEffect(() => {
				let alive = true;
				setData(null);
				if (sessionId && turnNo != null) {
					apiTurn(sessionId, turnNo).then((v) => {
						if (alive) setData(v);
					}).catch(() => {
						if (alive) setData(null);
					});
				}
				return () => { alive = false; };
			}, [sessionId, turnNo]);
			if (!data || !data.files || data.files.length === 0) return null;
			const revertOp = (filePath, opIndex) => {
				if (!sessionId || !filePath) return;
				if (!window.confirm("确定撤回该项修改？此操作会直接改写磁盘上的文件，且不可撤销。")) return;
				setBusy(true);
				apiRevert(sessionId, filePath, opIndex).then((v) => {
					if (v && v.ok) {
						apiTurn(sessionId, turnNo).then((nv) => { if (nv) setData(nv); }).catch(() => {});
						refreshFromServer();
					} else {
						window.alert("撤回失败：" + ((v && v.error) || "未知错误"));
					}
				}).catch((e) => {
					window.alert("撤回失败：" + String((e && e.message) || e));
				}).finally(() => setBusy(false));
			};
			return React.createElement("div", { className: "drv-turn" },
				React.createElement("div", { className: "drv-turn-head" },
					React.createElement("span", { className: "drv-turn-title" }, "本轮变更审查"),
					React.createElement("span", { className: "drv-count" }, data.files.length + " 个文件"),
					React.createElement("span", { className: "drv-header-spacer" }),
					React.createElement("span", { className: "drv-turn-hint" }, "会话累计变更见「审查」标签")),
				data.files.map((f) => {
					const open = expanded === f.path;
					return React.createElement("div", { key: f.path, className: "drv-turn-file" },
						React.createElement("button", {
							type: "button",
							className: "drv-turn-file-head",
							onClick: () => setExpanded(open ? null : f.path)
						},
							React.createElement("span", { className: "drv-turn-chevron" }, open ? "▾" : "▸"),
							React.createElement("span", { className: "drv-turn-file-name" }, f.name),
							React.createElement("span", { className: "drv-file-meta" },
								(f.writes > 0 ? "写×" + f.writes + " " : "") + (f.edits > 0 ? "改×" + f.edits : ""),
								React.createElement("span", { className: "drv-turn-add" }, "+" + f.added),
								React.createElement("span", { className: "drv-turn-del" }, "−" + f.removed))),
						open ? React.createElement("div", { className: "drv-turn-file-body" },
							f.sections.map((sec, i) => React.createElement(Section, {
								key: i, section: sec,
								onRevert: (opIndex) => revertOp(f.path, opIndex),
								busy: busy,
								filePath: f.path
							}))) : null);
				}));
		}

		function ReviewView(props) {
			React.useEffect(() => {
				if (props.sessionId) {
					if (store.currentSession !== props.sessionId) {
						reqSeq++;
						setState({ currentSession: props.sessionId, files: null, selected: null, detail: null, mode: "session", turnData: null, latestTurn: 0, error: null, loadingFiles: true });
					}
					loadSummary();
				}
			}, [props.sessionId]);
			const mode = useStore((s) => s.mode);
			const turnData = useStore((s) => s.turnData);
			const files = useStore((s) => s.files);
			const latestTurn = useStore((s) => s.latestTurn);
			const count = mode === "latest" ? (((turnData && turnData.files) || []).length) : ((files || []).length);
			const [busy, setBusy] = React.useState(false);
			const [notice, setNotice] = React.useState(null);
			const noticeTimer = React.useRef(null);
			const showNotice = (msg) => {
				setNotice(msg);
				if (noticeTimer.current) clearTimeout(noticeTimer.current);
				noticeTimer.current = setTimeout(() => setNotice(null), 4000);
			};
			React.useEffect(() => () => { if (noticeTimer.current) clearTimeout(noticeTimer.current); }, []);
			const doRevert = (op) => {
				const session = store.currentSession;
				const path = store.selected;
				if (!session || !path) return;
				const what = op === null ? "该文件的全部修改" : "该项修改";
				if (!window.confirm("确定撤回" + what + "？此操作会直接改写磁盘上的文件，且不可撤销。")) return;
				setBusy(true);
				apiRevert(session, path, op).then((v) => {
					if (v && v.ok) {
						showNotice(v.message || "已撤回");
						if (op === null) setState({ selected: null, detail: null });
						refresh();
					} else {
						window.alert("撤回失败：" + ((v && v.error) || "未知错误"));
					}
				}).catch((e) => {
					window.alert("撤回失败：" + String((e && e.message) || e));
				}).finally(() => setBusy(false));
			};
			const revertOp = (opIndex) => doRevert(opIndex);
			const revertAll = () => doRevert(null);
			return React.createElement("div", { className: "drv-view" },
				React.createElement("div", { className: "drv-view-header" },
					React.createElement("span", { className: "drv-title" }, "修改审查"),
					React.createElement("span", { className: "drv-count" }, (mode === "latest" ? "最新一轮" + (latestTurn ? " · 第 " + latestTurn + " 轮 · " : " · ") : "") + count + " 个文件"),
					React.createElement("div", { className: "drv-mode", role: "group" },
						React.createElement("button", {
							className: "drv-mode-btn" + (mode === "session" ? " drv-mode-active" : ""),
							onClick: () => setMode("session")
						}, "此会话"),
						React.createElement("button", {
							className: "drv-mode-btn" + (mode === "latest" ? " drv-mode-active" : ""),
							onClick: () => setMode("latest")
						}, "最新一轮")),
					React.createElement("span", { className: "drv-header-spacer" }),
					notice ? React.createElement("span", { className: "drv-notice" }, notice) : null,
					React.createElement("button", { className: "drv-btn", title: "刷新", onClick: refresh }, "↻"),
					React.createElement("button", {
						className: "drv-btn", title: "清空记录",
						onClick: () => { apiClear(store.currentSession).then(() => { setState({ files: [], detail: null, selected: null, turnData: null, latestTurn: 0 }); }); }
					}, "清空")),
				React.createElement("div", { className: "drv-view-body" },
					React.createElement("div", { className: "drv-filelist" }, React.createElement(FileList, null)),
					React.createElement("div", { className: "drv-detail" }, React.createElement(Detail, { onRevert: revertOp, onRevertAll: revertAll, busy: busy }))));
		}

		// ── plugin ─────────────────────────────────────────────────────────
		const inject = ["slots"];
		const CSS = `
.drv-view { flex:1 1 0; min-height:0; overflow:hidden; display:flex; flex-direction:column; font-size:13px; color:var(--dsw-alias-label-primary, inherit); }
.drv-view-header { display:flex; align-items:center; gap:10px; padding:10px 14px; border-bottom:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25)); flex-wrap:wrap; }
.drv-title { font-weight:600; font-size:13px; }
.drv-count { opacity:0.65; font-size:12px; }
.drv-header-spacer { flex:1; }
.drv-btn { border:none; background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.12)); color:inherit; cursor:pointer; border-radius:6px; padding:4px 10px; font-size:12px; font-family:inherit; line-height:18px; transition:background .12s; }
.drv-btn:hover { filter:brightness(1.15); }
.drv-view-body { flex:1 1 0; display:flex; min-height:0; margin:0 14px 14px; border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25)); border-radius:10px; overflow:hidden; }
/* ── file list ─────────────────────────────────────────────────────── */
.drv-filelist { width:248px; flex-shrink:0; border-right:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25)); overflow:auto; overscroll-behavior:contain; padding:6px; box-sizing:border-box; }
.drv-filelist-inner { display:flex; flex-direction:column; gap:2px; }
.drv-file { display:flex; flex-direction:column; align-items:stretch; gap:2px; width:100%; padding:6px 10px; cursor:pointer; border:none; background:transparent; color:inherit; text-align:left; font-family:inherit; font-size:12.5px; border-radius:8px; transition:background .12s; }
.drv-file:hover { background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.12)); }
.drv-file.drv-selected { background:rgba(80,120,255,0.16); }
.drv-file-top { display:flex; align-items:center; gap:6px; min-width:0; }
.drv-file-name { font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.drv-file-meta { display:flex; align-items:center; gap:8px; font-size:11px; opacity:0.7; white-space:nowrap; }
.drv-file-add { color:#1a7f37; opacity:1; }
.drv-file-del { color:#cf222e; opacity:1; }
/* ── detail pane ───────────────────────────────────────────────────── */
.drv-detail { flex:1 1 0; min-width:0; overflow:auto; overscroll-behavior:contain; padding:12px; }
.drv-detail-toolbar { display:flex; align-items:center; gap:8px; margin-bottom:10px; }
.drv-detail-path { font-size:12px; opacity:0.75; word-break:break-all; font-family:var(--ds-font-family-code, ui-monospace, monospace); }
.drv-section { margin-bottom:12px; border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3)); border-radius:8px; overflow:hidden; }
.drv-section-head { padding:7px 12px; font-weight:500; background:var(--dsw-alias-surface-2, rgba(128,128,128,0.08)); display:flex; gap:8px; align-items:center; min-height:32px; box-sizing:border-box; }
.drv-section-label { font-weight:400; opacity:0.75; font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.drv-section-time { font-weight:400; opacity:0.6; font-size:11px; white-space:nowrap; }
.drv-badge { display:inline-block; padding:1px 8px; border-radius:9px; font-size:10px; font-weight:600; flex-shrink:0; }
.drv-badge-new { background:rgba(46,160,67,0.18); color:#1a7f37; }
.drv-badge-edit { background:rgba(9,105,218,0.14); color:#0969da; }
.drv-btn-revert { font-size:11px; padding:3px 10px; flex-shrink:0; }
.drv-btn-danger { color:#cf222e; }
/* Wide side-by-side tables scroll horizontally inside their section instead
   of stretching the detail pane past its scrollbar. */
.drv-section-body { overflow-x:auto; overscroll-behavior-x:contain; max-width:100%; }
.drv-empty { padding:32px 24px; text-align:center; opacity:0.55; }
.drv-notice { font-size:12px; color:#1a7f37; background:rgba(46,160,67,0.15); border-radius:6px; padding:3px 8px; }
.drv-mode { display:flex; gap:4px; }
.drv-mode-btn { border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); background:transparent; color:inherit; cursor:pointer; border-radius:6px; padding:3px 10px; font-size:11px; font-family:inherit; line-height:16px; transition:background .12s; }
.drv-mode-btn:hover { background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.12)); }
.drv-mode-btn.drv-mode-active { background:rgba(80,120,255,0.22); border-color:rgba(80,120,255,0.55); }
.drv-tab-label { display:inline-flex; align-items:center; gap:6px; }
.drv-tab-badge { display:inline-block; border-radius:8px; padding:0 5px; font-size:10px; line-height:14px; font-weight:600; min-width:16px; text-align:center; background:#4493f8; color:#ffffff; }
/* ── per-turn review card (turnTail chain cell) ─────────────────── */
.drv-turn { margin-top:10px; border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25)); border-radius:8px; padding:8px 12px; font-size:12px; background:var(--dsw-alias-surface-1, transparent); }
.drv-turn-head { display:flex; align-items:center; gap:8px; padding:0 0 4px; }
.drv-turn-title { font-weight:600; font-size:12.5px; }
.drv-turn-hint { font-size:11px; opacity:0.55; }
.drv-turn-file { border-top:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.15)); }
.drv-turn-file-head { display:flex; align-items:center; gap:8px; width:100%; padding:6px 0; border:none; background:transparent; color:inherit; cursor:pointer; font-family:inherit; font-size:12px; text-align:left; }
.drv-turn-file-head:hover .drv-turn-file-name { text-decoration:underline; }
.drv-turn-file-name { font-weight:500; word-break:break-all; flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.drv-turn-file-meta { flex-shrink:0; }
.drv-turn-chevron { opacity:0.55; flex-shrink:0; }
.drv-turn-file-body { padding:2px 0 8px; overflow-x:auto; }
.drv-turn-file-body .drv-section { margin-bottom:8px; }
.drv-turn-add { color:#1a7f37; }
.drv-turn-del { color:#cf222e; }
/* ── fallback plain-line renderer ─────────────────────────────────── */
.drv-line { display:flex; font-family:var(--ds-font-family-code, ui-monospace,SFMono-Regular,Menlo,Consolas,monospace); font-size:12px; line-height:1.55; }
.drv-gutter { flex:0 0 42px; text-align:right; padding:0 6px; user-select:none; color:var(--dsw-alias-label-tertiary, #57606a); }
.drv-gutter-sign { flex:0 0 18px; text-align:center; padding:0 2px; }
.drv-text { flex:1; padding:0 6px; white-space:pre-wrap; word-break:break-word; }
.drv-add { background:#e6ffec; color:#1a7f37; }
.drv-del { background:#ffebe9; color:#cf222e; }
/* ── diff2html overrides for DSH theme ──────────────────────────── */
.drv-diff2html { font-size:12px; color:inherit; }
.drv-diff2html .d2h-wrapper { margin:0; border:none; }
.drv-diff2html .d2h-file-header { display:none; }
.drv-diff2html .d2h-file-diff { border:none; background:transparent; }
.drv-diff2html .d2h-code-linenumber,
.drv-diff2html .d2h-code-side-linenumber { border:none !important; font-size:11px; color:var(--dsw-alias-label-tertiary, #57606a); }
.drv-diff2html .d2h-code-side-line,
.drv-diff2html .d2h-code-line { font-family:var(--ds-font-family-code, ui-monospace,SFMono-Regular,Menlo,Consolas,monospace); font-size:12px; line-height:1.5; }
.drv-section-body .d2h-files-diff,
.drv-section-body .d2h-file-side-diff { background:transparent !important; }
.drv-diff2html table { border-collapse:collapse; }
.drv-diff2html td { padding:0; vertical-align:top; }
/* ── dark theme (DSH class / data-theme / OS preference) ─────────── */
@media (prefers-color-scheme: dark) {
  .drv-add { background:#0f2e1f; color:#56d364; }
  .drv-del { background:#3c1618; color:#f85149; }
}
.dsw-dark .drv-add, :root[data-theme="dark"] .drv-add { background:#0f2e1f; color:#56d364; }
.dsw-dark .drv-del, :root[data-theme="dark"] .drv-del { background:#3c1618; color:#f85149; }
.dsw-dark .drv-badge-new { background:rgba(46,160,67,0.22); color:#56d364; }
.dsw-dark .drv-badge-edit { background:rgba(56,139,253,0.2); color:#58a6ff; }
.dsw-dark .drv-file-add { color:#56d364; }
.dsw-dark .drv-file-del { color:#f85149; }
.dsw-dark .drv-turn-add { color:#56d364; }
.dsw-dark .drv-turn-del { color:#f85149; }
.dsw-dark .drv-btn-danger { color:#f85149; }
.dsw-dark .drv-notice { color:#56d364; background:rgba(46,160,67,0.18); }
`;
		function apply(ctx) {
			ctx.effect(() => {
				const el = document.createElement("style");
				el.textContent = CSS;
				document.head.appendChild(el);
				return () => el.remove();
			}, "diff-review: styles");
			// ⚠️ diff2html 改为懒加载：仅在真正渲染 diff 时按需加载（Diff2HtmlBlock 内处理），
			//    启动时不再往 <head> 注入 ~1MB 脚本，避免阻塞主线程、干扰 DSH composer 状态机。
			refreshFromServer();
			ctx.effect(connectEvents, "diff-review: live events");
			ctx.slots.inject("conversation.view", () => ctx.slots.register(
				{ name: "conversation.view", id: "review", order: 5, label: () => React.createElement(TabLabel, null) },
				(props) => React.createElement(ReviewView, props)));
			ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register(
				{ name: "conversation.session.header.actions", id: "diff-review-session", order: 100 },
				(props) => React.createElement(SessionProbe, props)));
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
