// dsh-deepseek-usage — browser half.
//
// 侧边栏底部用量卡片（注册进 `sidebar.footer.action` 槽位，独占一行，位于
// Cordis 面板按钮下方）。每 30 秒心跳一次：重算悬浮说明里的剩余时间并重新拉取
// 宿主路由 `/api/deepseek-usage`（见 lib/index.js），因此余额、档单价与峰谷指示灯
// 都随心跳更新，跨过峰谷切换点后最多滞后一次心跳；点击卡片任意位置可立即刷新；
// 还没拿到余额（宿主刚重启/接口刚起来）时按 QUICK_RETRY_MS 阶梯快速补几次请求，
// 卡片几秒内收敛。
// 两种形态：
//   · 侧边栏展开——完整卡片：余额（放大显示，符号随币种）或订阅制的 D 形仪表盘阵列
//     （5 小时 / 周 / 月并排，灰色弧是已用量、绿色弧是剩余量，剩余量在已用 ≥ 80%
//     时变红，周期徽章嵌在底部缺口里），加当前模型档单价（输入/输入缓存/输出，
//     图标 + 数字，位于卡片右下角）+ 计费区间指示灯（右上角，只有颜色；悬浮说明
//     给出距下次切换的剩余时间）。指示灯只在宿主给出计费区间时出现：DeepSeek 的
//     峰谷、其它 provider 的高峰/优惠时段；全天一价的模型只有单价行。
//   · 侧边栏折叠——36px 图标栏里只有计费区间指示灯（见下方 `if (!wide)` 分支）。
//
// 设计约束（用户只关心"我还能花多少、这会儿什么价"）：
//   · 插件的内部信息——取价路径、模型改名、放假日期来源——一律不出现在 UI 上
//     （历史上圆点的 title 里塞过这些，已删除）。
//   · 唯一的交互是「点击卡片刷新」；没有可切换的提示态。
//   · 只有余额类错误（未配置 Key / 余额接口或网络失败）才置空卡片说明原因。
//   · 档单价来自宿主的取价结果：宿主按 provider + 模型查 PRICE_TABLES（DeepSeek 只是
//     其中一条，见 lib/pricing.js）；表里没有的模型 known=false，单价行与指示灯整组
//     隐藏，卡片只留余额。
//   · 没有数据时不编数字：余额与单价显示「—」，而不是 0.00 / 0。
// 另外在设置面板注册一项「DeepSeek 用量」（`settings.section`）：provider 映射编辑器 +
// 其下方的 OAuth 令牌填写区，本来放在插件详情页/行配置页，现在统一收到设置页里。
// 样式仅使用 `--dsw-*` 主题变量（含兜底值），跟随明暗主题。
window.__ModuleLoader__.load({
	id: "@dougen/dsh-deepseek-usage",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo, useSyncExternalStore, memo } = react;
		const h = react.createElement;


		// ---- constants -------------------------------------------------
		// 卡片心跳：每 30 秒重算一次倒计时并重新取一次数（余额 + 当前档单价）。
		// 峰谷切换也因此不需要额外的检测逻辑——每次心跳都重新取数，切换后最多 30 秒翻正。
		const POLL_MS = 30 * 1000;
		// 刷新间隔（秒）：宿主配置 refreshSeconds 优先（随余额响应带回），
		// 本地再缓存一份，页面刚打开、首帧响应还没回来时也能沿用上次设置。
		const DEFAULT_REFRESH_SECONDS = 30;
		// 与宿主同口径：0.1–60 秒，保留一位小数（0.1 秒就是 100ms，别更短）。
		const MIN_REFRESH_SECONDS = 0.1;
		const MAX_REFRESH_SECONDS = 3600;
		const REFRESH_CACHE_KEY = "dsh-usage:refresh-seconds";
		// 底栏整体高度（固定值）：看板 = 总高 − 桌面区实测高度
		// 抽屉里每行放几个入口
		const DOCK_PER_ROW_KEY = "dsh-usage:dock-per-row";
		const DOCK_PER_ROW_DEFAULT = 3;
		function readPerRow() {
			try {
				const raw = typeof localStorage !== "undefined" ? localStorage.getItem(DOCK_PER_ROW_KEY) : null;
				const n = Number(raw);
				if (!Number.isFinite(n) || n <= 0) return DOCK_PER_ROW_DEFAULT;
				return Math.min(6, Math.max(1, Math.round(n)));
			} catch (e) {
				return DOCK_PER_ROW_DEFAULT;
			}
		}
		function writePerRow(value) {
			try {
				if (typeof localStorage !== "undefined") localStorage.setItem(DOCK_PER_ROW_KEY, String(value));
			} catch (e) { /* 隐私模式忽略 */ }
		}

		// 余额数字基准字号（右键数字可调）
		const AMOUNT_SIZE_KEY = "dsh-usage:amount-size";
		const AMOUNT_SIZE_DEFAULT = 34;
		const AMOUNT_SIZE_MIN = 12;
		const AMOUNT_SIZE_MAX = 72;
		function readAmountSize() {
			try {
				const raw = typeof localStorage !== "undefined" ? localStorage.getItem(AMOUNT_SIZE_KEY) : null;
				const n = Number(raw);
				if (!Number.isFinite(n) || n <= 0) return AMOUNT_SIZE_DEFAULT;
				return Math.min(AMOUNT_SIZE_MAX, Math.max(AMOUNT_SIZE_MIN, Math.round(n)));
			} catch (e) {
				return AMOUNT_SIZE_DEFAULT;
			}
		}
		function writeAmountSize(value) {
			try {
				if (typeof localStorage !== "undefined") localStorage.setItem(AMOUNT_SIZE_KEY, String(value));
			} catch (e) { /* 隐私模式忽略 */ }
		}

		const FOOTER_HEIGHT_KEY = "dsh-usage:footer-height";
		const FOOTER_HEIGHT_DEFAULT = 168;
		const FOOTER_HEIGHT_MIN = 28;
		const FOOTER_HEIGHT_MAX = 360;
		function readFooterHeight() {
			try {
				const raw = typeof localStorage !== "undefined" ? localStorage.getItem(FOOTER_HEIGHT_KEY) : null;
				const n = Number(raw);
				if (!Number.isFinite(n) || n <= 0) return FOOTER_HEIGHT_DEFAULT;
				return Math.min(FOOTER_HEIGHT_MAX, Math.max(FOOTER_HEIGHT_MIN, Math.round(n)));
			} catch (e) {
				return FOOTER_HEIGHT_DEFAULT;
			}
		}
		function writeFooterHeight(value) {
			try {
				if (typeof localStorage !== "undefined") localStorage.setItem(FOOTER_HEIGHT_KEY, String(value));
			} catch (e) { /* 隐私模式忽略 */ }
		}
		// 桌面区（另一个 slot 入口）把实测高度广播过来，看板据此让位
		const DRAWER_WIDTH = 208;
		const footerMetrics = {
			dockHeight: 0, listeners: new Set(),
			cardHeight: 0, cardListeners: new Set(),
			drawerOpen: false, drawerListeners: new Set(),
		};
		const footerSide = { side: readDockSide(), listeners: new Set() };

		function publishCardHeight(height) {
			const next = Math.max(0, Math.round(height));
			if (footerMetrics.cardHeight === next) return;
			footerMetrics.cardHeight = next;
			for (const listener of footerMetrics.cardListeners) listener(next);
		}
		function subscribeCardHeight(listener) {
			footerMetrics.cardListeners.add(listener);
			listener(footerMetrics.cardHeight);
			return () => footerMetrics.cardListeners.delete(listener);
		}
		const DOCK_SIDE_KEY = "dsh-usage:dock-side";
		function readDockSide() {
			try {
				const raw = typeof localStorage !== "undefined" ? localStorage.getItem(DOCK_SIDE_KEY) : null;
				return raw === "right" ? "right" : "left";
			} catch (e) {
				return "left";
			}
		}
		function writeDockSide(side) {
			try {
				if (typeof localStorage !== "undefined") localStorage.setItem(DOCK_SIDE_KEY, side);
			} catch (e) { /* 隐私模式忽略 */ }
		}
		function publishSide(side) {
			if (footerSide.side === side) return;
			footerSide.side = side;
			writeDockSide(side);
			for (const listener of footerSide.listeners) listener(side);
		}
		function subscribeSide(listener) {
			footerSide.listeners.add(listener);
			listener(footerSide.side);
			return () => footerSide.listeners.delete(listener);
		}

		function publishDrawerOpen(open) {
			if (footerMetrics.drawerOpen === open) return;
			footerMetrics.drawerOpen = open;
			for (const listener of footerMetrics.drawerListeners) listener(open);
		}
		function subscribeDrawerOpen(listener) {
			footerMetrics.drawerListeners.add(listener);
			listener(footerMetrics.drawerOpen);
			return () => footerMetrics.drawerListeners.delete(listener);
		}
		function publishDockHeight(height) {
			const next = Math.max(0, Math.round(height));
			if (footerMetrics.dockHeight === next) return;
			footerMetrics.dockHeight = next;
			for (const listener of footerMetrics.listeners) listener(next);
		}
		function subscribeDockHeight(listener) {
			footerMetrics.listeners.add(listener);
			listener(footerMetrics.dockHeight);
			return () => footerMetrics.listeners.delete(listener);
		}

		// 看板高度（拖拽调整）：全局一份，所有 provider 共用同一个高度。
		// 被代理的原入口：保持挂载但不可见（display:none 会让弹层锚点失效的插件改用可点击代理）
		function ensureDockStyle() {
			if (typeof document === "undefined") return;
			if (document.querySelector('style[data-usage-dock-style]') !== null) return;
			const tag = document.createElement("style");
			tag.dataset.usageDockStyle = "1";
			tag.textContent = '[data-usage-dock-hidden="1"]{display:none!important}'
				+ '[data-usage-dock-open="1"] > *:not([data-dock="usage"]):not([data-usage-dock]){display:none!important}';
			document.head.appendChild(tag);
		}

		/**
		 * 看板 / 收纳栏的上下顺序：像手机桌面那样长按拖动换位。
		 * 两块是同一槽位的两个入口（order 100/110），运行期改不了 order，
		 * 所以直接重排 DOM 兄弟节点，并把结果记进 localStorage。
		 * 交互：按住 420ms 进入拖动（先移动 >10px 会取消），拖过另一块中线即交换，松手保存。
		 */
		const BLOCK_ORDER_KEY = "dsh-usage:block-order";
		const blockRegistry = { card: null, dock: null };
		const blockBound = new WeakSet();
		function readBlockOrder() {
			try {
				const raw = typeof localStorage !== "undefined" ? localStorage.getItem(BLOCK_ORDER_KEY) : null;
				return raw === "dock-first" ? "dock-first" : "card-first";
			} catch (e) {
				return "card-first";
			}
		}
		function writeBlockOrder(value) {
			try {
				if (typeof localStorage !== "undefined") localStorage.setItem(BLOCK_ORDER_KEY, value);
			} catch (e) { /* 隐私模式忽略 */ }
		}
		function applyBlockOrder() {
			const card = blockRegistry.card;
			const dock = blockRegistry.dock;
			if (card === null || dock === null || !card.isConnected || !dock.isConnected) return;
			const parent = card.parentElement;
			if (parent === null || parent !== dock.parentElement) return;
			const dockFirst = readBlockOrder() === "dock-first";
			const first = dockFirst ? dock : card;
			const second = dockFirst ? card : dock;
			if (second.parentElement !== parent || first.nextElementSibling !== second) {
				parent.insertBefore(first, second);
			}
		}
		function persistBlockOrderFromDom() {
			const card = blockRegistry.card;
			const dock = blockRegistry.dock;
			if (card === null || dock === null || card.parentElement === null) return;
			const kids = Array.from(card.parentElement.children);
			const i = kids.indexOf(dock);
			const j = kids.indexOf(card);
			if (i < 0 || j < 0) return;
			writeBlockOrder(i < j ? "dock-first" : "card-first");
		}
		/**
		 * 拖动把手：只有右上角那个小圆点能发起换位（不再整块长按，
		 * 避免和底部调行高的手柄、以及卡片内容点击冲突）。
		 */
		/**
		 * 拖动把手的按下处理：小圆点上按住 ~250ms 后进入拖动，越过另一块中线即交换。
		 * 用 React 的 onPointerDown 直接绑（之前 ref + addEventListener 的方案在重渲染后
		 * 会丢监听，表现为"按了没反应"）。
		 */
		/** 两块（看板 / 收纳栏）交换位置时的 FLIP：另一块平滑滑过去，不是瞬移。 */
		function flipSwap(beforeMap, skipNode) {
			for (const entry of beforeMap.entries()) {
				const node = entry[0];
				const rect = entry[1];
				if (node === skipNode || !node.isConnected) continue;
				const now = node.getBoundingClientRect();
				const dy = rect.top - now.top;
				if (Math.abs(dy) < 1) continue;
				node.style.transition = "none";
				node.style.transform = "translateY(" + dy + "px)";
				requestAnimationFrame(() => {
					node.style.transition = "transform .22s cubic-bezier(.2,.8,.2,1)";
					node.style.transform = "";
				});
			}
		}

		function handlePointerDown(event, kind) {
			if (event.button !== 0) return;
			event.preventDefault();
			event.stopPropagation();
			const handle = event.currentTarget;
			const block = handle === null ? null : handle.closest(kind === "card" ? '[data-dock="usage"]' : "[data-usage-dock]");
			if (block === null) return;
			const startX = event.clientX;
			const startY = event.clientY;
			let dragging = false;
			const timer = window.setTimeout(() => {
				dragging = true;
				block.style.transition = "transform .12s ease, box-shadow .12s ease";
				block.style.transform = "scale(1.015)";
				block.style.boxShadow = "0 10px 24px rgba(0,0,0,.3)";
				block.style.opacity = "0.96";
				block.style.zIndex = "6";
				block.style.cursor = "grabbing";
			}, 250);
			let switched = false;
			const onMove = (moveEvent) => {
				// 长按后左右拖：把抽屉拖到看板的对面（左 ↔ 右互换），
				// 不再做上下换位（那是旧行为）。
				if (!dragging) return;
				moveEvent.preventDefault();
				const dx = moveEvent.clientX - startX;
				block.style.transition = "none";
				block.style.transform = "translateX(" + dx + "px) scale(1.01)";
				if (!switched && Math.abs(dx) > 40) {
					switched = true;
					// 翻转"谁在前台"：抽屉在前 ↔ 看板在前
					publishSide(footerSide.side === "right" ? "left" : "right");
				}
			};
			const onUp = () => {
				window.clearTimeout(timer);
				window.removeEventListener("pointermove", onMove, true);
				window.removeEventListener("pointerup", onUp, true);
				window.removeEventListener("pointercancel", onUp, true);
				block.style.transition = "transform .18s ease, box-shadow .18s ease";
				block.style.transform = "";
				block.style.boxShadow = "";
				block.style.opacity = "";
				block.style.zIndex = "";
				block.style.cursor = "";
				window.setTimeout(() => { block.style.transition = ""; }, 220);
				if (dragging && switched) writeDockSide(footerSide.side);
			};
			window.addEventListener("pointermove", onMove, true);
			window.addEventListener("pointerup", onUp, true);
			window.addEventListener("pointercancel", onUp, true);
		}

		function registerBlockNode(kind, node) {
			if (blockRegistry[kind] === node) return;
			blockRegistry[kind] = node;
			applyBlockOrder();
		}

		// 收纳篮（底栏磁贴框）的高度：与看板各自独立记忆
		// 用户自建的收纳栏：localStorage `dsh-usage:docks` = [{ id, entries: [label] }]
		const DOCKS_KEY = "dsh-usage:docks";
		function readDocks() {
			try {
				const raw = typeof localStorage !== "undefined" ? localStorage.getItem(DOCKS_KEY) : null;
				const parsed = raw === null ? null : JSON.parse(raw);
				if (!Array.isArray(parsed)) return [];
				return parsed
					.filter((dock) => dock !== null && typeof dock === "object")
					.map((dock, index) => ({
						id: typeof dock.id === "string" && dock.id !== "" ? dock.id : "dock-" + index,
						entries: Array.isArray(dock.entries) ? dock.entries.filter((x) => typeof x === "string") : [],
					}));
			} catch (e) {
				return [];
			}
		}
		function writeDocks(docks) {
			try {
				if (typeof localStorage !== "undefined") localStorage.setItem(DOCKS_KEY, JSON.stringify(docks));
			} catch (e) { /* 隐私模式忽略 */ }
		}

		// 手机桌面式槽位：slotIndex → 入口标签（"" 表示空格）
		const DOCK_SLOTS_KEY = "dsh-usage:dock-slots";
		function readDockSlots() {
			try {
				const raw = typeof localStorage !== "undefined" ? localStorage.getItem(DOCK_SLOTS_KEY) : null;
				const parsed = raw === null ? null : JSON.parse(raw);
				return Array.isArray(parsed) ? parsed.map((x) => (typeof x === "string" ? x : "")) : [];
			} catch (e) {
				return [];
			}
		}
		function writeDockSlots(slots) {
			try {
				if (typeof localStorage !== "undefined") localStorage.setItem(DOCK_SLOTS_KEY, JSON.stringify(slots));
			} catch (e) { /* 隐私模式忽略 */ }
		}

		// 收纳篮里各入口的自定义顺序（按标签存，插件增删后仍能对上）
		const DOCK_ORDER_KEY = "dsh-usage:dock-order";
		function readDockOrder() {
			try {
				const raw = typeof localStorage !== "undefined" ? localStorage.getItem(DOCK_ORDER_KEY) : null;
				const parsed = raw === null ? null : JSON.parse(raw);
				return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
			} catch (e) {
				return [];
			}
		}
		function writeDockOrder(labels) {
			try {
				if (typeof localStorage !== "undefined") localStorage.setItem(DOCK_ORDER_KEY, JSON.stringify(labels));
			} catch (e) { /* 隐私模式忽略 */ }
		}
		function dockRank(label, order) {
			const i = order.indexOf(label);
			return i < 0 ? 999 : i;
		}
		// 收纳篮规格（列 × 行），默认 3×3
		const DOCK_GRID_KEY = "dsh-usage:dock-grid";
		const DOCK_GRID_DEFAULT = { cols: 0, rows: 0 };
		function clampGridValue(value, fallback) {
			const n = Number(value);
			if (!Number.isFinite(n)) return fallback;
			// 0 = 自动（按侧栏宽度定列数）
			return Math.min(6, Math.max(0, Math.round(n)));
		}
		function readDockGrid() {
			try {
				const raw = typeof localStorage !== "undefined" ? localStorage.getItem(DOCK_GRID_KEY) : null;
				if (raw === null || raw === "") return { ...DOCK_GRID_DEFAULT };
				const parsed = JSON.parse(raw);
				return {
					cols: clampGridValue(parsed?.cols, DOCK_GRID_DEFAULT.cols),
					rows: clampGridValue(parsed?.rows, DOCK_GRID_DEFAULT.rows),
				};
			} catch (e) {
				return { ...DOCK_GRID_DEFAULT };
			}
		}
		function writeDockGrid(value) {
			try {
				if (typeof localStorage !== "undefined") localStorage.setItem(DOCK_GRID_KEY, JSON.stringify(value));
			} catch (e) { /* 隐私模式忽略 */ }
		}

		const DOCK_HEIGHT_KEY = "dsh-usage:dock-height";
		const DOCK_HEIGHT_BASE = 74;
		const DOCK_HEIGHT_MIN = 56;
		const DOCK_HEIGHT_MAX = 200;
		function readDockHeight() {
			try {
				const raw = typeof localStorage !== "undefined" ? localStorage.getItem(DOCK_HEIGHT_KEY) : null;
				const n = Number(raw);
				// 0 = 没手动设置过：由内容实际行数决定高度，避免 3×3 规格只有 3 个入口时
				// 撑出两大条空白（用户反馈"太空了"）。
				if (!Number.isFinite(n) || n <= 0) return 0;
				return Math.min(DOCK_HEIGHT_MAX, Math.max(DOCK_HEIGHT_MIN, Math.round(n)));
			} catch (e) {
				return DOCK_HEIGHT_BASE;
			}
		}
		function writeDockHeight(value) {
			try {
				if (typeof localStorage !== "undefined") localStorage.setItem(DOCK_HEIGHT_KEY, String(value));
			} catch (e) { /* 隐私模式忽略 */ }
		}

		const CARD_HEIGHT_KEY = "dsh-usage:card-height";
		const CARD_HEIGHT_MIN = 28;
		const CARD_HEIGHT_MAX = 240;
		function readCardHeight() {
			try {
				const raw = typeof localStorage !== "undefined" ? localStorage.getItem(CARD_HEIGHT_KEY) : null;
				const n = Number(raw);
				if (!Number.isFinite(n) || n <= 0) return CARD_MIN_HEIGHT;
				return Math.min(CARD_HEIGHT_MAX, Math.max(CARD_HEIGHT_MIN, Math.round(n)));
			} catch (e) {
				return CARD_MIN_HEIGHT;
			}
		}
		function writeCardHeight(value) {
			try {
				if (typeof localStorage !== "undefined") localStorage.setItem(CARD_HEIGHT_KEY, String(value));
			} catch (e) { /* 隐私模式写不进去，本次会话内仍生效 */ }
		}
		function clampRefresh(seconds) {
			const value = Number(seconds);
			if (!Number.isFinite(value)) return DEFAULT_REFRESH_SECONDS;
			const bounded = Math.min(MAX_REFRESH_SECONDS, Math.max(MIN_REFRESH_SECONDS, value));
			return Math.round(bounded * 10) / 10;
		}
		function readCachedRefresh() {
			try {
				const raw = typeof localStorage !== "undefined" ? localStorage.getItem(REFRESH_CACHE_KEY) : null;
				return raw === null || raw === "" ? DEFAULT_REFRESH_SECONDS : clampRefresh(raw);
			} catch (e) {
				return DEFAULT_REFRESH_SECONDS;
			}
		}
		function writeCachedRefresh(seconds) {
			try {
				if (typeof localStorage !== "undefined") localStorage.setItem(REFRESH_CACHE_KEY, String(clampRefresh(seconds)));
			} catch (e) { /* 隐私模式写不进去，忽略 */ }
		}

		// ---- 融合子面板：进度汇报（dsh-progress-reminder）------------------
		// 那个插件一个组件都没导出（grep "exports." 为空），只留了一个 POST 接口
		// `/progress-nudge/api/{status,config}`。所以面板本身在这里自建，
		// 数据全从接口取；插件没装时接口 404，整块自动不渲染，不会留空壳。
		const NUDGE_API = "/progress-nudge/api";
		const NUDGE_POLL_MS = 5000;
		async function nudgeCall(method, body) {
			try {
				const res = await fetch(NUDGE_API + "/" + method, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body ?? {}),
				});
				if (!res.ok) return null;
				const payload = await res.json();
				return payload && payload.ok === true ? (payload.value ?? null) : null;
			} catch (e) {
				return null;
			}
		}

		// 融合子面板的隔离层：进度面板自己出错（接口变了、字段缺了）时只丢这一行，
		// 余额看板必须活着。React 的渲染异常会把整个侧栏单元一起丢掉，
		// 所以这里必须显式兜住——之前「点一下看板就不见了」就是这么来的。
		class NudgeBoundary extends react.Component {
			constructor(props) {
				super(props);
				this.state = { failed: false };
			}
			static getDerivedStateFromError() {
				return { failed: true };
			}
			componentDidCatch(error) {
				if (typeof console !== "undefined" && console.warn) {
					console.warn("dsh-deepseek-usage: 进度汇报子面板已停用", error);
				}
			}
			render() {
				return this.state.failed ? null : this.props.children;
			}
		}

		/**
		 * 右键刷新按钮弹出的小面板：直接改自动刷新间隔（写回配置的 refreshSeconds）。
		 * 与设置页那块「刷新间隔」写的是同一个字段，这里只是把入口放到手边。
		 */
		function RefreshIntervalMenu(props) {
			const t = props.t;
			const face = props.face;
			const anchorPos = props.anchor;
			const [draft, setDraft] = useState(String(props.current));
			const [busy, setBusy] = useState(false);
			const [notice, setNotice] = useState("");
			const boxRef = useRef(null);

			useEffect(() => {
				const onDown = (event) => {
					if (boxRef.current !== null && boxRef.current.contains(event.target)) return;
					props.onClose();
				};
				const onKey = (event) => {
					if (event.key === "Escape") props.onClose();
				};
				document.addEventListener("pointerdown", onDown, true);
				document.addEventListener("keydown", onKey, true);
				return () => {
					document.removeEventListener("pointerdown", onDown, true);
					document.removeEventListener("keydown", onKey, true);
				};
			}, [props.onClose]);

			const save = async () => {
				if (face === undefined) {
					setNotice(t("refresh.menuUnavailable"));
					return;
				}
				const value = String(clampRefresh(draft));
				setBusy(true);
				try {
					const ok = await face.mutate([{ op: "set", path: ["refreshSeconds"], value }]);
					if (ok === false) {
						setNotice(t("refresh.saveFailed"));
						return;
					}
					writeCachedRefresh(value);
					props.onSaved(Number(value));
					props.onClose();
				} catch (e) {
					setNotice(t("refresh.saveFailed"));
				} finally {
					setBusy(false);
				}
			};

			const hintStyle = { margin: 0, fontSize: 11, lineHeight: "15px", color: C.sub };
			return h("div", {
				ref: boxRef,
				style: {
					position: "fixed",
					left: anchorPos.left,
					top: anchorPos.top,
					zIndex: 2147483000,
					width: 208,
					boxSizing: "border-box",
					display: "flex",
					flexDirection: "column",
					gap: 6,
					padding: 10,
					borderRadius: 10,
					border: "1px solid " + C.cardBorder,
					background: C.bg,
					color: C.label,
					boxShadow: "0 8px 28px rgba(0,0,0,.22)",
					cursor: "default",
				},
				onClick: (event) => event.stopPropagation(),
				onContextMenu: (event) => event.preventDefault(),
			},
				h("span", { style: { fontSize: 12, fontWeight: 600 } }, t("refresh.menuTitle")),
				h("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
					h("input", {
						type: "number",
						min: MIN_REFRESH_SECONDS,
						max: MAX_REFRESH_SECONDS,
						step: 0.1,
						value: draft,
						"aria-label": t("refresh.menuTitle"),
						onChange: (event) => setDraft(event.target.value),
						onKeyDown: (event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								save().catch(() => {});
							}
						},
						style: {
							boxSizing: "border-box",
							flex: "1 1 auto",
							minWidth: 0,
							height: 26,
							padding: "0 6px",
							borderRadius: 6,
							border: "1px solid " + C.cardBorder,
							background: "transparent",
							color: "inherit",
							font: "inherit",
							fontSize: 12,
						},
					}),
					h("span", { style: hintStyle }, t("refresh.seconds")),
					h("button", {
						type: "button",
						disabled: busy,
						onClick: () => { save().catch(() => {}); },
						style: {
							height: 26,
							padding: "0 9px",
							borderRadius: 6,
							border: "1px solid " + C.cardBorder,
							background: "transparent",
							color: "inherit",
							font: "inherit",
							fontSize: 12,
							cursor: "pointer",
							flex: "none",
						},
					}, busy ? t("add.saving") : t("refresh.save"))),
				notice !== "" ? h("span", { style: { ...hintStyle, color: C.err } }, notice) : null,
				h("span", { style: hintStyle }, t("refresh.menuHint")));
		}

/**
		 * 手机桌面式入口区：固定槽位网格（列 × 行），空格显示虚线占位，
		 * 入口可长按拖到任意槽位（含空格），顺序按槽位记在 dsh-usage:dock-slots。
		 *
		 * 视觉：不再有"收纳栏外框"，磁贴直接贴在看板下方；列数默认随侧栏宽度自适应。
		 */
		function FooterDock(props) {
			const lang = props.lang;
			const [items, setItems] = useState([]);
			const itemsRef = useRef(items);
			itemsRef.current = items;
			const [gridSpec, setGridSpec] = useState(() => readDockGrid());
			const [slots, setSlots] = useState(() => readDockSlots());
			const slotsRef = useRef(slots);
			slotsRef.current = slots;
			const [autoCols, setAutoCols] = useState(4);
			const [gridMenu, setGridMenu] = useState(null);
			const [colsDraft, setColsDraft] = useState("");
			const [rowsDraft, setRowsDraft] = useState("");
			// 右键空白 → 新建收纳栏（勾选入口）
			const [createMenu, setCreateMenu] = useState(null);
			const [picked, setPicked] = useState([]);
			const dockBoxRef = useRef(null);
			const tileDragRef = useRef(null);

			// ---- 入口发现（与之前一致：只收 footer 槽位的直接子节点）----
			useEffect(() => {
				const OUTLET = '[data-slot="sidebar.footer.action"]';
				const HIDE = "data-usage-dock-hidden";
				const collect = () => {
					const found = [];
					const seen = new Set();
					const seenLabels = new Set();
					const outlet = document.querySelector(OUTLET);
					if (outlet === null) return found;
					for (const node of Array.from(outlet.children)) {
						if (node === null || node.nodeType !== 1 || seen.has(node)) continue;
						if (node.hasAttribute("data-usage-dock") || node.hasAttribute("data-usage-dock-item")) continue;
						if (node.matches('[data-dock="usage"]')) continue;
						seen.add(node);
						const raw = node.getAttribute("aria-label") || node.getAttribute("title") || node.textContent || "";
						const label = String(raw).replace(/\s+/g, " ").trim().slice(0, 8);
						const icon = node.querySelector("svg, img");
						const clickable = node.matches("button, [role='button'], a")
							|| node.querySelector("button, [role='button'], a") !== null
							|| typeof node.onclick === "function";
						if (label === "" && icon === null) continue;
						if (label === "" && !clickable) continue;
						if (label !== "" && seenLabels.has(label)) continue;
						if (label !== "") seenLabels.add(label);
						let color = "";
						try {
							color = window.getComputedStyle(node).color || "";
						} catch {
							color = "";
						}
						found.push({ node, label, color });
					}
					return found;
				};
				let stopped = false;
				const hidden = new Set();
				const sync = () => {
					if (stopped || tileDragRef.current !== null) return;
					const found = collect();
					const live = new Set(found.map((item) => item.node));
					for (const node of hidden) {
						if (!live.has(node) && node.isConnected) {
							node.removeAttribute(HIDE);
							hidden.delete(node);
						}
					}
					for (const item of found) {
						if (!item.node.hasAttribute(HIDE)) item.node.setAttribute(HIDE, "1");
						hidden.add(item.node);
					}
					setItems((prev) => (prev.length === found.length
						&& prev.every((entry, i) => entry.node === found[i].node && entry.label === found[i].label)
						? prev : found));
				};
				sync();
				const observer = new MutationObserver(sync);
				const outlet = document.querySelector(OUTLET);
				if (outlet !== null) observer.observe(outlet, { childList: true });
				const timer = window.setInterval(sync, 2000);
				return () => {
					stopped = true;
					observer.disconnect();
					window.clearInterval(timer);
					for (const node of hidden) node.removeAttribute(HIDE);
				};
			}, [lang]);

			// ---- 自适应列数 ----
			useEffect(() => {
				const root = dockBoxRef.current;
				if (root === null || root === undefined) return undefined;
				const measure = () => {
					const rect = root.getBoundingClientRect();
					const width = rect.width;
					if (!Number.isFinite(width) || width <= 0) return;
					const next = Math.min(6, Math.max(2, Math.floor(width / 56)));
					setAutoCols((prev) => (prev === next ? prev : next));
					// ⚠️ 不广播高度：抽屉是 position:fixed，不占布局；一旦上报，
					// 卡片会按"总高 − 抽屉高"缩，而抽屉高又取自父容器（含卡片），
					// 形成反馈环，拖动时会上下抽搐（实测）。
					publishDockHeight(0);
				};
				measure();
				if (typeof ResizeObserver === "function") {
					const observer = new ResizeObserver(measure);
					observer.observe(root);
					return () => observer.disconnect();
				}
				window.addEventListener("resize", measure);
				return () => window.removeEventListener("resize", measure);
			}, [items.length]);

			const cols = gridSpec.cols > 0 ? gridSpec.cols : autoCols;
			const rows = gridSpec.rows > 0 ? gridSpec.rows : Math.max(2, Math.ceil(Math.max(items.length, 1) / cols));
			// 用户还没建收纳栏（slots 全空）时一格都不画：底栏只剩看板 + 一条空白
			const hasSlots = slots.some((value) => value !== "");
			const slotCount = hasSlots ? Math.min(36, Math.max(1, cols * rows)) : 0;

			// ---- 槽位与入口对齐：新入口填第一个空格、消失的入口清空槽位 ----
			useEffect(() => {
				setSlots((prev) => {
					const next = prev.slice(0, slotCount);
					while (next.length < slotCount) next.push("");
					const alive = new Set(items.map((item) => item.label).filter((label) => label !== ""));
					for (let i = 0; i < next.length; i += 1) {
						if (next[i] !== "" && !alive.has(next[i])) next[i] = "";
					}
					const same = prev.length === next.length && prev.every((value, i) => value === next[i]);
					return same ? prev : next;
				});
			}, [items, slotCount]);

			useEffect(() => { writeDockSlots(slots); }, [slots]);

			const labelToItem = new Map();
			for (const item of items) {
				if (item.label !== "" && !labelToItem.has(item.label)) labelToItem.set(item.label, item);
			}

			// ---- 右键空白：新建收纳栏 ----
			const openCreate = (event) => {
				event.preventDefault();
				event.stopPropagation();
				setPicked([]);
				setCreateMenu({
					left: Math.max(8, Math.min(event.clientX, (window.innerWidth || 320) - 204)),
					top: Math.max(8, Math.min(event.clientY, (window.innerHeight || 600) - 260)),
				});
			};
			const createDock = () => {
				const entries = picked.slice();
				if (entries.length === 0) { setCreateMenu(null); return; }
				const size = Math.min(36, Math.max(cols * rows, entries.length));
				const next = new Array(size).fill("");
				entries.forEach((label, index) => { if (index < size) next[index] = label; });
				setSlots(next);
				setCreateMenu(null);
			};
			const clearDock = () => setSlots([]);

			// ---- 拖动：抬起 → 跟手 → 落进目标槽位（可与空格互换）----
			const captureTileRects = () => {
				const map = new Map();
				const root = dockBoxRef.current;
				if (root === null || root === undefined) return map;
				for (const node of Array.from(root.querySelectorAll("[data-usage-dock-item]"))) {
					map.set(node, node.getBoundingClientRect());
				}
				return map;
			};
			const playTileFlip = (before) => {
				const root = dockBoxRef.current;
				if (root === null || root === undefined) return;
				for (const node of Array.from(root.querySelectorAll("[data-usage-dock-item]"))) {
					const prev = before.get(node);
					if (prev === undefined) continue;
					const now = node.getBoundingClientRect();
					const dx = prev.left - now.left;
					const dy = prev.top - now.top;
					if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
					node.style.transition = "none";
					node.style.transform = "translate(" + dx + "px, " + dy + "px)";
					requestAnimationFrame(() => {
						node.style.transition = "transform .2s cubic-bezier(.2,.8,.2,1)";
						node.style.transform = "";
					});
				}
			};

			const onTileDown = (event, slotIndex) => {
				if (event.button !== 0) return;
				const tile = event.currentTarget;
				if (tile === null) return;
				const startX = event.clientX;
				const startY = event.clientY;
				let dragging = false;
				tileDragRef.current = { index: slotIndex, dragging: false };
				const timer = window.setTimeout(() => {
					dragging = true;
					if (tileDragRef.current !== null) tileDragRef.current.dragging = true;
					tile.style.transition = "transform .12s ease, box-shadow .12s ease";
					tile.style.transform = "scale(1.1)";
					tile.style.boxShadow = "0 8px 18px rgba(0,0,0,.32)";
					tile.style.opacity = "0.95";
					tile.style.zIndex = "6";
					tile.style.position = "relative";
					tile.style.pointerEvents = "none";
				}, 300);
				const onMove = (moveEvent) => {
					if (!dragging) return;
					moveEvent.preventDefault();
					tile.style.transition = "none";
					tile.style.transform = "translate(" + (moveEvent.clientX - startX) + "px, " + (moveEvent.clientY - startY) + "px) scale(1.1)";
					const under = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
					const slotEl = under === null ? null : under.closest("[data-usage-slot-index]");
					if (slotEl === null) return;
					const target = Number(slotEl.getAttribute("data-usage-slot-index"));
					const state = tileDragRef.current;
					if (!Number.isFinite(target) || state === null || target === state.index) return;
					const before = captureTileRects();
					setSlots((prev) => {
						const next = prev.slice();
						const moved = next[state.index] ?? "";
						next[state.index] = next[target] ?? "";
						next[target] = moved;
						return next;
					});
					state.index = target;
					requestAnimationFrame(() => playTileFlip(before));
				};
				const onUp = () => {
					window.clearTimeout(timer);
					window.removeEventListener("pointermove", onMove, true);
					window.removeEventListener("pointerup", onUp, true);
					window.removeEventListener("pointercancel", onUp, true);
					tile.style.transition = "transform .16s ease, box-shadow .16s ease";
					tile.style.transform = "";
					tile.style.boxShadow = "";
					tile.style.opacity = "";
					tile.style.zIndex = "";
					tile.style.position = "";
					tile.style.pointerEvents = "";
					window.setTimeout(() => { tile.style.transition = ""; }, 200);
					const state = tileDragRef.current;
					tileDragRef.current = null;
					if (state !== null && state.dragging) {
						tile.dataset.justDragged = "1";
						window.setTimeout(() => { delete tile.dataset.justDragged; }, 300);
						writeDockSlots(slotsRef.current);
					}
				};
				window.addEventListener("pointermove", onMove, true);
				window.addEventListener("pointerup", onUp, true);
				window.addEventListener("pointercancel", onUp, true);
			};

			// ---- 规格面板 ----
			const openGridMenu = (e) => {
				e.stopPropagation();
				e.preventDefault();
				const rect = e.currentTarget.getBoundingClientRect();
				setColsDraft(String(gridSpec.cols));
				setRowsDraft(String(gridSpec.rows));
				setGridMenu({
					left: Math.max(8, Math.min(rect.right - 176, (window.innerWidth || 320) - 184)),
					top: Math.max(8, rect.top - 104),
				});
			};
			const applyGrid = () => {
				const next = {
					cols: clampGridValue(colsDraft, DOCK_GRID_DEFAULT.cols),
					rows: clampGridValue(rowsDraft, DOCK_GRID_DEFAULT.rows),
				};
				setGridSpec(next);
				writeDockGrid(next);
				setGridMenu(null);
			};

			// 没有可代理的入口就整块不渲染（避免留下一片虚线空格）
			// 底栏左侧贴边抽屉：默认只是一条 10px 的窄条（高度占满整个底栏），
			// 鼠标移上去向右滑出，露出全部入口。
			const [open, setOpen] = useState(false);
			const [box, setBox] = useState({ left: 0, top: 0, height: 0, width: 0 });
			useEffect(() => {
				const node = dockBoxRef.current;
				const parent = node === null || node === undefined ? null : node.parentElement;
				if (parent === null) return undefined;
				const measure = () => {
					const parentRect = parent.getBoundingClientRect();
					// 上下边界直接对齐看板本体（用它的实测 rect），不用父容器：
					// 父容器可能把别的子节点也算进去，窄条就会比看板短一截。
					const card = document.querySelector('[data-dock="usage"]');
					const cardRect = card === null ? null : card.getBoundingClientRect();
					setBox((prev) => {
						const next = {
							left: Math.round(parentRect.left),
							top: Math.round(cardRect === null ? parentRect.top : cardRect.top),
							height: Math.round(cardRect === null ? parentRect.height : cardRect.height),
							width: Math.round(parentRect.width),
						};
						return prev.left === next.left && prev.top === next.top && prev.height === next.height && prev.width === next.width ? prev : next;
					});
				};
				measure();
				window.addEventListener("resize", measure);
				window.addEventListener("scroll", measure, true);
				let observer = null;
				if (typeof ResizeObserver === "function") {
					observer = new ResizeObserver(measure);
					observer.observe(parent);
					const card = document.querySelector('[data-dock="usage"]');
					if (card !== null) observer.observe(card);
				}
				return () => {
					window.removeEventListener("resize", measure);
					window.removeEventListener("scroll", measure, true);
					if (observer !== null) observer.disconnect();
				};
			}, []);

			// 上下边界对齐看板：高度取看板广播值
			const [cardHeightSeen, setCardHeightSeen] = useState(0);
			// 每行几个入口 + 右下角的设置面板
			const [perRow, setPerRow] = useState(() => readPerRow());
			const [perRowMenu, setPerRowMenu] = useState(null);
			const [perRowDraft, setPerRowDraft] = useState("");
			const [dockSide, setDockSide] = useState(() => footerSide.side);
			useEffect(() => subscribeSide(setDockSide), []);
			useEffect(() => subscribeCardHeight(setCardHeightSeen), []);
			useEffect(() => { publishDrawerOpen(open); }, [open]);
			// 展开时给槽位容器打标记：用 CSS 把"不是我们的"子节点全部隐藏，
			// 否则某些插件（会话回收站）会把自己的按钮叠到抽屉上。
			useEffect(() => {
				const node = dockBoxRef.current;
				const parent = node === null || node === undefined ? null : node.parentElement;
				if (parent === null) return undefined;
				if (open) {
					parent.setAttribute("data-usage-dock-open", "1");
					parent.style.overflow = "hidden";
					// 逐个子节点隐藏（记录原 display，关闭时还原）：
					// 有些插件的按钮不在我们代理的节点上，CSS 选择器盖不住，会叠到抽屉上。
					for (const child of Array.from(parent.children)) {
						if (child.hasAttribute("data-usage-dock") || child.matches('[data-dock="usage"]')) continue;
						if (child.dataset.usageDockPrevDisplay === undefined) {
							child.dataset.usageDockPrevDisplay = child.style.display || "";
						}
						child.style.display = "none";
					}
				} else {
					parent.removeAttribute("data-usage-dock-open");
					parent.style.overflow = "";
					for (const child of Array.from(parent.children)) {
						if (child.dataset.usageDockPrevDisplay === undefined) continue;
						child.style.display = child.dataset.usageDockPrevDisplay;
						delete child.dataset.usageDockPrevDisplay;
					}
				}
				return () => {
					parent.removeAttribute("data-usage-dock-open");
					parent.style.overflow = "";
				};
			}, [open]);
			const drawerHeight = box.height > 0 ? box.height : (cardHeightSeen > 0 ? cardHeightSeen : 120);
			// 收起时只留 6px 的细边（往左贴满，不占视觉）
			// 展开时**不铺满**：右侧留 10px，让看板露出一条"突出部分"，
			// 与隐藏状态下抽屉在看板左侧露出 6px 对称。
			const openWidth = box.width > 0 ? Math.max(120, box.width - 10) : DRAWER_WIDTH;
			const effectiveOpen = open;
			const drawerWidth = effectiveOpen ? openWidth : 6;
			return h("div", {
				"data-usage-dock": "1",
				ref: (el) => { dockBoxRef.current = el; },
				onMouseEnter: () => setOpen(true),
				onMouseLeave: () => setOpen(false),
				style: {
					position: "fixed",
					left: box.left + 1,
					top: box.top,
					height: drawerHeight,
					width: drawerWidth,
					transition: "width .18s ease",
					overflow: "hidden",
					zIndex: 2147482000,
					boxSizing: "border-box",
					borderRadius: 10,
					border: "0.5px solid " + C.cardBorder,
					borderLeft: "none",
					background: effectiveOpen ? C.bg : "rgba(127,127,127,.12)",
					boxShadow: effectiveOpen ? "0 8px 24px rgba(0,0,0,.22)" : "none",
					display: "flex",
					flexDirection: "column",
					alignItems: effectiveOpen ? "stretch" : "center",
					justifyContent: "center",
					padding: effectiveOpen ? "6px 6px 6px 2px" : "0",
					cursor: effectiveOpen ? "default" : "pointer",
				},
			},
				// 窄条上的把手
				!effectiveOpen && h("div", {
					style: {
						flex: "1 1 auto",
						width: "100%",
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
					},
				}, h("span", {
					style: { width: 2, height: 22, borderRadius: 1, background: C.sub, opacity: 0.6 },
				})),
				effectiveOpen && h("div", {
					style: {
						display: "grid",
						gridTemplateColumns: "repeat(" + perRow + ", minmax(0, 1fr))",
						gap: 4,
						overflowY: "auto",
						minHeight: 0,
					},
				}, items.map((item) => h("button", {
					key: item.label,
					type: "button",
					title: item.label,
					onClick: (e) => {
						e.stopPropagation();
						if (item.node && typeof item.node.click === "function") item.node.click();
					},
					onContextMenu: (e) => e.stopPropagation(),
					style: {
						appearance: "none", border: "none", background: "transparent",
						color: item.color !== "" ? item.color : C.label,
						borderRadius: 8, padding: "3px 2px",
						display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
						gap: 1, minWidth: 0, cursor: "pointer", font: "inherit",
					},
				},
					h("span", {
						ref: (el) => {
							if (el === null || el.dataset.filled === "1") return;
							const source = item.node ? item.node.querySelector("svg, img") : null;
							if (source === null) return;
							const clone = source.cloneNode(true);
							if (String(clone.tagName).toLowerCase() === "svg") {
								clone.setAttribute("width", "16");
								clone.setAttribute("height", "16");
							}
							clone.style.width = "16px";
							clone.style.height = "16px";
							el.appendChild(clone);
							el.dataset.filled = "1";
						},
						style: { display: "flex", alignItems: "center", justifyContent: "center", height: 16 },
					}),
					h("span", {
						style: { fontSize: 9.5, lineHeight: "11px", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
					}, item.label)))),
				// 右下角：编辑"一行几个"
				effectiveOpen && h("button", {
					type: "button",
					title: lang === "zh" ? "每行显示几个" : "Items per row",
					onClick: (e) => {
						e.stopPropagation();
						const rect = e.currentTarget.getBoundingClientRect();
						setPerRowDraft(String(perRow));
						setPerRowMenu({
							left: Math.max(8, Math.min(rect.left - 120, (window.innerWidth || 320) - 150)),
							top: Math.max(8, rect.top - 84),
						});
					},
					onPointerDown: (e) => e.stopPropagation(),
					onContextMenu: (e) => e.stopPropagation(),
					style: {
						position: "absolute",
						right: 4,
						bottom: 4,
						width: 16,
						height: 16,
						padding: 0,
						border: "none",
						borderRadius: 4,
						background: "transparent",
						color: C.sub,
						cursor: "pointer",
						fontSize: 11,
						lineHeight: "16px",
					},
				}, "⊞"),
				perRowMenu !== null && h("div", {
					style: {
						position: "fixed",
						left: perRowMenu.left,
						top: perRowMenu.top,
						zIndex: 2147483000,
						width: 140,
						boxSizing: "border-box",
						padding: 8,
						borderRadius: 8,
						border: "1px solid " + C.cardBorder,
						background: C.bg,
						color: C.label,
						boxShadow: "0 8px 24px rgba(0,0,0,.22)",
						display: "flex",
						flexDirection: "column",
						gap: 6,
						fontSize: 11,
					},
					onClick: (e) => e.stopPropagation(),
					onContextMenu: (e) => { e.preventDefault(); e.stopPropagation(); },
				},
					h("span", { style: { fontWeight: 600 } }, lang === "zh" ? "一行几个" : "Per row"),
					h("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
						h("input", {
							type: "range", min: 1, max: 6, value: perRowDraft,
							onChange: (e) => setPerRowDraft(e.target.value),
							style: { flex: "1 1 auto", minWidth: 0 },
						}),
						h("input", {
							type: "number", min: 1, max: 6, value: perRowDraft,
							onChange: (e) => setPerRowDraft(e.target.value),
							style: { width: 40, height: 22, borderRadius: 5, border: "1px solid " + C.cardBorder, background: "transparent", color: "inherit", font: "inherit", padding: "0 4px" },
						})),
					h("div", { style: { display: "flex", gap: 6, justifyContent: "flex-end" } },
						h("button", {
							type: "button", onClick: () => setPerRowMenu(null),
							style: { height: 22, padding: "0 8px", borderRadius: 6, border: "1px solid " + C.cardBorder, background: "transparent", color: C.sub, font: "inherit", fontSize: 11, cursor: "pointer" },
						}, lang === "zh" ? "取消" : "Cancel"),
						h("button", {
							type: "button",
							onClick: () => {
								const next = Math.min(6, Math.max(1, Math.round(Number(perRowDraft) || DOCK_PER_ROW_DEFAULT)));
								setPerRow(next);
								writePerRow(next);
								setPerRowMenu(null);
							},
							style: { height: 22, padding: "0 8px", borderRadius: 6, border: "1px solid " + C.cardBorder, background: "transparent", color: C.label, font: "inherit", fontSize: 11, cursor: "pointer" },
						}, lang === "zh" ? "保存" : "Save"))));
		}

		function NudgeStrip(props) {
			const t = props.t;
			const lang = props.lang;
			const [status, setStatus] = useState(null);
			const [fetchedAt, setFetchedAt] = useState(0);
			const [anchor, setAnchor] = useState(null);
			const aliveRef = useRef(true);
			const load = useCallback(async () => {
				const value = await nudgeCall("status");
				if (!aliveRef.current) return;
				setStatus(value);
				if (value !== null) setFetchedAt(Date.now());
			}, []);
			useEffect(() => {
				aliveRef.current = true;
				load();
				const timer = setInterval(load, NUDGE_POLL_MS);
				return () => {
					aliveRef.current = false;
					clearInterval(timer);
				};
			}, [load]);
			if (status === null) return null;
			const u = nudgeText(lang);
			const live = status.live ?? null;
			const eff = status.effective ?? {};
			const enabled = status.enabled === true;
			const tariff = status.tariff !== undefined && status.tariff.enabled === true ? status.tariff : null;
			const pending = status.pending ?? null;
			const due = pending !== null && pending.due === true;
			const dotColor = enabled === false ? "#9aa0a6" : due ? "#e5533d" : live !== null && live.running === true ? "#2ea44f" : "#c8a020";
			const summary = live === null
				? u.idle
				: `${live.steps}/${eff.stepThreshold ?? "-"}${u.unitSteps} · ${Math.round(live.seconds)}/${eff.timeThresholdSeconds ?? "-"}${u.unitSeconds}`;
			const toggle = (e) => {
				e.stopPropagation();
				const rect = e.currentTarget.getBoundingClientRect();
				setAnchor((value) => (value === null
					? {
						// 先给个大致位置，真正的贴合交给面板里的量测纠偏：
						// 面板高度随内容变（有没有余额/峰谷/升级），预先算不准。
						left: Math.max(8, Math.min(rect.left, window.innerWidth - 272)),
						top: Math.min(rect.bottom + 6, window.innerHeight - 8),
					}
					: null));
			};
			return h(react.Fragment, null,
				h("div", {
					role: "button",
					tabIndex: 0,
					title: enabled === false ? u.pausedHint : u.hint,
					"data-dsh-nudge-strip": "1",
					onClick: toggle,
					onContextMenu: toggle,
					onMouseDown: (e) => e.stopPropagation(),
					style: {
						display: "flex",
						alignItems: "center",
						gap: 5,
						minWidth: 0,
						paddingRight: 30,
						cursor: "pointer",
						fontSize: 11,
						lineHeight: "15px",
						color: C.sub,
						fontVariantNumeric: "tabular-nums",
					},
				},
					h("span", {
						style: { width: 6, height: 6, borderRadius: 3, background: dotColor, flex: "0 0 auto" },
					}),
					h("span", {
						style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 },
					}, summary),
					tariff !== null
						? h("span", {
							className: "pn-tariff" + (tariff.offPeak ? " is-off" : " is-peak"),
							style: { flex: "0 0 auto" },
						}, tariff.label ?? "")
						: null),
				anchor !== null
					? h(NudgeDetail, {
						status,
						fetchedAt,
						anchor,
						u,
						reload: load,
						symbol: props.symbol,
						amount: props.amount,
						cyclePercent: props.cyclePercent,
						onRefresh: props.onRefresh,
						onClose: () => setAnchor(null),
					})
					: null);
		}

		// 进度汇报的详情面板：与 dsh-progress-reminder 原插件的侧栏面板同构
		// （同样的 pn-* 类名、同样的行/进度条/快捷参数/版本行），只是挂在
		// 余额看板的卡片上——左键切到它、右键直接开它。
		function NudgeDetail(props) {
			const status = props.status;
			const u = props.u;
			const reload = props.reload;
			const onClose = props.onClose;
			const anchor = props.anchor;
			const [now, setNow] = useState(() => Date.now());
			const [steps, setSteps] = useState("");
			const [secs, setSecs] = useState("");
			const [bal, setBal] = useState("");
			const syncedRef = useRef(false);
			const debounceRef = useRef(null);
			const boxRef = useRef(null);
			// 视口贴合：面板比视口高就内部滚动，贴边就整体平移回去。
			// 直接用 anchor 定位会溢出（侧栏卡片靠底时面板会跑出屏幕），
			// 所以渲染后量一次真实尺寸再纠偏，必要时才 setState 避免抖动。
			const [fit, setFit] = useState({ dx: 0, dy: 0, maxHeight: 0 });
			// ⚠️ 这里必须只量一次（外加 resize）：无依赖的 useLayoutEffect 里
			// setState 会「量→挪→再量」来回震荡，React 抛 Too many re-renders，
			// 整个侧栏单元被丢弃——用户看到的就是「点一下看板就不见了」。
			const measuredRef = useRef(false);
			useLayoutEffect(() => {
				const el = boxRef.current;
				if (el === null) return undefined;
				const measure = () => {
					const rect = el.getBoundingClientRect();
					const vw = window.innerWidth;
					const vh = window.innerHeight;
					const margin = 8;
					const maxHeight = Math.max(180, vh - margin * 2);
					let dx = 0;
					let dy = 0;
					if (rect.right > vw - margin) dx = Math.floor(vw - margin - rect.right);
					if (rect.left + dx < margin) dx += Math.ceil(margin - (rect.left + dx));
					if (rect.bottom > vh - margin) dy = Math.floor(vh - margin - rect.bottom);
					if (rect.top + dy < margin) dy += Math.ceil(margin - (rect.top + dy));
					setFit((prev) => (prev.dx === dx && prev.dy === dy && prev.maxHeight === maxHeight
						? prev
						: { dx, dy, maxHeight }));
				};
				if (!measuredRef.current) {
					measuredRef.current = true;
					measure();
				}
				window.addEventListener("resize", measure);
				return () => window.removeEventListener("resize", measure);
			}, []);
			useEffect(() => {
				const timer = window.setInterval(() => setNow(Date.now()), 1000);
				return () => window.clearInterval(timer);
			}, []);
			useEffect(() => {
				const close = (event) => {
					const target = event.target;
					if (boxRef.current !== null && boxRef.current.contains(target)) return;
					if (target !== null && typeof target.closest === "function" && target.closest("[data-dsh-nudge-strip]") !== null) return;
					onClose();
				};
				document.addEventListener("mousedown", close);
				return () => document.removeEventListener("mousedown", close);
			}, [onClose]);
			useEffect(() => {
				if (status === null || syncedRef.current) return;
				syncedRef.current = true;
				setSteps(String(status.effective.stepThreshold));
				setSecs(String(status.effective.timeThresholdSeconds));
				if (status.balance) setBal(String(status.balance.thresholdCny));
			}, [status]);
			const live = status?.live ?? null;
			const escalation = status?.escalation ?? null;
			const escalated = escalation?.enabled === true && escalation.active === true;
			const stepTarget = escalated ? escalation.stepThreshold : (status?.effective?.stepThreshold ?? 10);
			const timeTarget = escalated ? escalation.timeThresholdSeconds : (status?.effective?.timeThresholdSeconds ?? 120);
			const enabled = status?.enabled !== false;
			const running = enabled && live?.running === true;
			const drift = running && props.fetchedAt > 0 ? (now - props.fetchedAt) / 1000 : 0;
			const seconds = Math.max(0, Math.round((live?.seconds ?? 0) + drift));
			const idle = enabled && live !== null && live.running !== true && live.steps === 0;
			const apply = async (patch) => {
				const value = await nudgeCall("config", patch);
				if (value === null) return;
				await reload();
			};
			const commitLater = (patch) => {
				if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
				debounceRef.current = window.setTimeout(() => {
					debounceRef.current = null;
					void apply(patch);
				}, 350);
			};
			const clampNum = (value, min, max) => Math.min(max, Math.max(min, value));
			const percent = (value, max) => clampNum((value / Math.max(1, max)) * 100, 0, 100);
			const tariff = status?.tariff ?? null;
			const tariffOn = tariff !== null && tariff.enabled === true;
			// 余额行与父插件的卡片完全同源：直接吃这张卡片的 symbol/amount，
			// 不再读提醒插件快照里的 DeepSeek 官方余额（那是另一套币种与口径）。
			const symbolText = props.symbol === null || props.symbol === undefined ? "" : String(props.symbol);
			const amountText = props.amount === null || props.amount === undefined ? "—" : String(props.amount);
			const cyclePercent = typeof props.cyclePercent === "number" ? props.cyclePercent : null;
			const update = status?.update ?? null;
			const updateText = update === null ? "—" : (update.current ?? "—");
			const updateDetail = update === null
				? ""
				: update.enabled !== true
					? u.versionOff
					: update.status === "failed"
						? `${u.versionFailed}${update.error ? `（${update.error}）` : ""}`
						: update.status === "unknown"
							? u.versionChecking
							: update.available === true && update.latest
								? `${u.versionAvailable} → ${update.latest}`
								: u.versionLatest;
			const updateWarn = update !== null && update.enabled === true && (update.available === true || update.status === "failed");
			const beijing = (ms) => new Date(ms).toLocaleTimeString("zh-CN", {
				hour12: false,
				timeZone: "Asia/Shanghai",
				hour: "2-digit",
				minute: "2-digit",
			});
			const until = (ms) => {
				const left = Math.max(0, ms - Date.now());
				const mins = Math.round(left / 60000);
				return mins >= 60 ? `${Math.floor(mins / 60)} 小时 ${mins % 60} 分` : `${mins} 分`;
			};
			const panel = h("div", {
				ref: boxRef,
				className: "pn-pop",
				onClick: (e) => e.stopPropagation(),
				onMouseDown: (e) => e.stopPropagation(),
				onContextMenu: (e) => e.stopPropagation(),
				style: {
					position: "fixed",
					left: anchor.left + fit.dx,
					top: anchor.top + fit.dy,
					maxHeight: fit.maxHeight > 0 ? fit.maxHeight : "calc(100vh - 16px)",
					overflowY: "auto",
					overflowX: "hidden",
					boxSizing: "border-box",
				},
			},
				h("h4", null, u.panelTitle),
				h("div", { className: "pn-row" }, h("span", null, u.steps), h("span", null, `${live?.steps ?? 0} / ${stepTarget}`)),
				h("div", { className: "pn-bar" }, h("i", { style: { width: `${percent(live?.steps ?? 0, stepTarget)}%` } })),
				h("div", { className: "pn-row" }, h("span", null, u.elapsed), h("span", null, `${seconds} / ${timeTarget}${u.unitSeconds}`)),
				h("div", { className: "pn-bar" }, h("i", { style: { width: `${percent(seconds, timeTarget)}%` } })),
				h("div", { className: "pn-row" }, h("span", null, u.nudges), h("span", null, `${status?.stats?.nudges ?? 0} · ${u.spoken} ${status?.stats?.spoke ?? 0}`)),
				h("div", { className: "pn-row" },
					h("span", null, u.escalation),
					h("button", {
						type: "button",
						className: "pn-mini" + (escalation?.enabled === true ? " is-on" : ""),
						title: u.escalationHint,
						onClick: () => void apply({ escalationEnabled: escalation?.enabled !== true }),
					}, escalation?.enabled === true ? u.escalationOn : u.escalationOff)),
				h("div", { className: escalated ? "pn-sub is-warn" : "pn-sub" },
					escalation?.enabled !== true
						? u.escalationDisabled
						: escalated
							? `${u.escalationActive} ${escalation.level} · ${escalation.silentStreak} ${u.escalationStreak} → ${escalation.stepThreshold}${u.unitSteps} / ${escalation.timeThresholdSeconds}${u.unitSeconds}`
							: u.escalationIdle),
				h("div", { className: "pn-row" },
					h("span", null, u.balance),
					h("span", null,
						symbolText + amountText + " ",
						h("button", {
							type: "button",
							className: "pn-mini",
							title: u.refresh,
							onClick: () => {
								if (typeof props.onRefresh === "function") void props.onRefresh();
							},
						}, "↻"))),
				cyclePercent !== null
					? h("div", { className: "pn-sub" }, `${u.usedPercent} ${Math.round(cyclePercent * 10) / 10}%`)
					: null,
				tariffOn ? h("div", { className: "pn-row" },
					h("span", null, u.tariff),
					h("span", { className: tariff.offPeak ? "is-ok" : "pn-peak-text" },
						`${tariff.label}（${tariff.offPeak ? u.tariffOff : u.tariffPeak}）`)) : null,
				tariffOn ? h("div", { className: "pn-sub" }, `高峰：${tariff.peakHoursText}（北京时间）`) : null,
				tariffOn && tariff.nextChangeAt ? h("div", { className: "pn-sub" },
					`${u.tariffNext}：${beijing(tariff.nextChangeAt)} → ${tariff.nextLabel}（还有 ${until(tariff.nextChangeAt)}）`) : null,
				!enabled ? h("div", { className: "pn-status" }, u.paused) : null,
				enabled && idle ? h("div", { className: "pn-status" }, u.stopped) : null,
				status?.pending?.due === true
					? h("div", { className: "pn-status is-warn" }, `${u.overdue} ${status.pending.overSeconds}${u.unitSeconds} · ${u.waitStep}`)
					: null,
				status?.pending?.blocked === true ? h("div", { className: "pn-status" }, u.blocked) : null,
				h("div", { className: "pn-sep" }),
				h("div", { className: "pn-status" }, u.quickSettings),
				h("div", { className: "pn-field" },
					h("label", { htmlFor: "dsh-nudge-steps" }, u.stepLabel),
					h("input", {
						id: "dsh-nudge-steps",
						type: "number",
						min: 1,
						max: 10000,
						value: steps,
						onChange: (e) => {
							setSteps(e.target.value);
							const parsed = Number(e.target.value);
							if (Number.isFinite(parsed) && parsed >= 1) commitLater({ stepThreshold: clampNum(parsed, 1, 10000) });
						},
					})),
				h("div", { className: "pn-field" },
					h("label", { htmlFor: "dsh-nudge-secs" }, u.timeLabel),
					h("input", {
						id: "dsh-nudge-secs",
						type: "number",
						min: 5,
						max: 86400,
						value: secs,
						onChange: (e) => {
							setSecs(e.target.value);
							const parsed = Number(e.target.value);
							if (Number.isFinite(parsed) && parsed >= 5) commitLater({ timeThresholdSeconds: clampNum(parsed, 5, 86400) });
						},
					})),
				h("div", { className: "pn-field" },
					h("label", { htmlFor: "dsh-nudge-bal" }, `${u.balanceLabel}（${u.balanceUnit}）`),
					h("input", {
						id: "dsh-nudge-bal",
						type: "number",
						min: 0,
						step: "0.5",
						value: bal,
						disabled: status?.balance?.enabled === false,
						onChange: (e) => {
							setBal(e.target.value);
							const parsed = Number(e.target.value);
							if (Number.isFinite(parsed) && parsed >= 0) commitLater({ balanceThresholdCny: clampNum(parsed, 0, 100000) });
						},
					})),
				h("div", { className: "pn-sep" }),
				h("div", { className: "pn-row" },
					h("span", null, u.version),
					h("span", { className: updateWarn ? "is-warn" : "" },
						updateText + " ",
						h("button", {
							type: "button",
							className: "pn-mini",
							title: u.checkUpdate,
							onClick: async () => {
								await nudgeCall("update");
								await reload();
							},
						}, "↻"))),
				h("div", { className: updateWarn ? "pn-sub is-warn" : "pn-sub" }, updateDetail),
				h("div", { className: "pn-actions" },
					h("button", { type: "button", onClick: () => void apply({ enabled: !enabled }) }, enabled ? u.pause : u.resume),
					h("button", {
						type: "button",
						className: "danger",
						onClick: async () => {
							await nudgeCall("reset");
							syncedRef.current = false;
							await reload();
						},
					}, u.reset)));
			return panel;
		}

		// 详情面板文案：与 dsh-progress-reminder 的 ZH/EN 词典逐条一致。
		const NUDGE_TEXT = {
			zh: {
				idle: "进度汇报待命",
				hint: "点击/右键查看进度详情",
				pausedHint: "进度汇报已暂停，点击查看",
				panelTitle: "进度汇报",
				steps: "步数",
				elapsed: "距上次汇报",
				nudges: "已提醒",
				spoken: "已汇报",
				paused: "已暂停提醒（计时冻结）",
				stopped: "回合已结束，计时停止",
				resume: "恢复提醒",
				pause: "暂停提醒",
				stepLabel: "每多少步提醒一次",
				timeLabel: "间隔多少秒提醒一次",
				unitSteps: "步",
				unitSeconds: "秒",
				reset: "恢复默认",
				quickSettings: "参数（改完立即生效）",
				overdue: "已到期",
				waitStep: "等当前步骤结束后提醒",
				blocked: "已达上限，本回合不再提醒",
				balance: "可用余额",
				balanceRecharge: "充值",
				balanceBonus: "赠送",
				balanceOff: "未开启",
				balanceUnknown: "查询中…",
				balanceUnavailable: "不可用",
				balanceFailed: "查询失败",
				balanceLow: "余额不足",
				balanceLabel: "余额低于多少提醒",
				balanceUnit: "DeepSeek 官方余额，元",
				usedPercent: "已用",
				tariff: "时段",
				tariffPeak: "高峰·原价",
				tariffOff: "低谷·半价",
				tariffNext: "下一次切换",
				escalation: "增强提醒",
				escalationOn: "开",
				escalationOff: "关",
				escalationHint: "连续几次提醒都没换来汇报时，自动提高阈值并加重措辞；一旦汇报就复位",
				escalationIdle: "正常：按设定阈值提醒",
				escalationActive: "已升级",
				escalationDisabled: "关着：始终按固定阈值提醒",
				escalationStreak: "连续未汇报",
				version: "版本",
				versionLatest: "已是最新",
				versionAvailable: "可更新",
				versionChecking: "查询中…",
				versionFailed: "查询失败",
				versionOff: "未开启",
				checkUpdate: "查更新",
				refresh: "刷新",
			},
			en: {
				idle: "Nudge idle",
				hint: "Click or right-click for details",
				pausedHint: "Nudge paused — click for details",
				panelTitle: "Progress report",
				steps: "Steps",
				elapsed: "Since last report",
				nudges: "Nudges",
				spoken: "Reports",
				paused: "Nudges paused (clock frozen)",
				stopped: "Turn ended, clock stopped",
				resume: "Resume",
				pause: "Pause",
				stepLabel: "Remind every N steps",
				timeLabel: "Remind after N seconds",
				unitSteps: " steps",
				unitSeconds: "s",
				reset: "Reset to defaults",
				quickSettings: "Thresholds (applied live)",
				overdue: "Overdue",
				waitStep: "fires at the next step boundary",
				blocked: "Turn limit reached",
				balance: "Balance",
				balanceRecharge: "Top-up",
				balanceBonus: "Granted",
				balanceOff: "Off",
				balanceUnknown: "Checking…",
				balanceUnavailable: "Unavailable",
				balanceFailed: "Failed",
				balanceLow: "Low balance",
				balanceLabel: "Warn below",
				balanceUnit: "official DeepSeek balance, CNY",
				usedPercent: "Used",
				tariff: "Tariff",
				tariffPeak: "Peak",
				tariffOff: "Off-peak",
				tariffNext: "Next switch",
				escalation: "Escalation",
				escalationOn: "On",
				escalationOff: "Off",
				escalationHint: "Raise thresholds when nudges go unanswered; resets after a report",
				escalationIdle: "Normal: fixed thresholds",
				escalationActive: "Escalated",
				escalationDisabled: "Off: always fixed thresholds",
				escalationStreak: "unanswered",
				version: "Version",
				versionLatest: "Up to date",
				versionAvailable: "Update available",
				versionChecking: "Checking…",
				versionFailed: "Check failed",
				versionOff: "Off",
				checkUpdate: "Check",
				refresh: "Refresh",
			},
		};
		function nudgeText(lang) {
			return lang === "en" ? NUDGE_TEXT.en : NUDGE_TEXT.zh;
		}
		// 卡片里真正会变的只有"金额"和"已用百分比"两处文字。把它们拆成记忆组件：
		// 心跳回来时如果这两个值没变，React 连它们的渲染函数都不会再进一遍，
		// DOM 上也就只有变化的那个文本节点被替换——不会整卡重画。
		const AmountText = memo(function AmountText(props) {
			return h("span", { style: props.style }, props.text);
		});
		const CycleHint = memo(function CycleHint(props) {
			return h("span", { style: props.style }, (props.lang === "zh" ? "已用 " : "used ") + props.percent.toFixed(1) + "%");
		});

		const USAGE_PATH = "/api/deepseek-usage";
		/**
		 * 侧栏右键菜单选定的 provider（localStorage 持久化）。
		 * 只决定「卡片看哪一家」，不碰 agentDefaultModel：用户只是想看另一家的余额，
		 * 不该顺带把正在跑的模型换掉。空串＝跟随当前模型。
		 */
		const PRESET_PROVIDER_KEY = "dsh-usage:preset-provider";
		// 与宿主同口径：允许空格/中文；只挡控制字符。
		const PROVIDER_ID = /^[^\u0000-\u001f]{1,128}$/;
		function readPresetProvider() {
			try {
				const raw = window.localStorage.getItem(PRESET_PROVIDER_KEY);
				return typeof raw === "string" && PROVIDER_ID.test(raw) ? raw : "";
			} catch (e) {
				return "";
			}
		}
		/** 看板与设置页共用的「当前看的是哪家」变更事件。 */
		const PRESET_EVENT = "dsh-usage:preset-provider-changed";
		function writePresetProvider(id) {
			const next = typeof id === "string" && id !== "" ? id : "";
			try {
				if (next !== "") window.localStorage.setItem(PRESET_PROVIDER_KEY, next);
				else window.localStorage.removeItem(PRESET_PROVIDER_KEY);
			} catch (e) { /* 隐私模式写不进去：本次会话内仍然生效，只是刷新后回到跟随模型 */ }
			// 同一个页面里的看板与设置页都要跟着变：localStorage 的 storage 事件不派发给自己。
			try {
				window.dispatchEvent(new CustomEvent(PRESET_EVENT, { detail: { provider: next } }));
			} catch (e) { /* 老环境没有 CustomEvent：至少 localStorage 已写入 */ }
		}

		/**
		 * 侧栏卡片直接操作本插件配置：与设置页用的是同一个 configForms 控制器
		 * （按条目 id 取），所以卡片里加的提供商与设置页里加的完全等价。
		 */
		function useConfigFace(ctx) {
			const configForms = ctx === undefined || ctx === null
				? undefined
				: (typeof ctx.get === "function" ? ctx.get("configForms") : ctx.configForms);
			const form = configForms && typeof configForms.get === "function" ? configForms.get(CONFIG_ENTRY_ID) : undefined;
			const fallback = useMemo(() => ({
				subscribe: () => () => {},
				getSnapshot: () => ({ status: "unavailable", value: undefined, revision: 0, writable: false }),
			}), []);
			const store = form === undefined ? fallback : form;
			const subscribe = useCallback((notify) => store.subscribe(notify), [store]);
			const getSnapshot = useCallback(() => store.getSnapshot(), [store]);
			const snapshot = useSyncExternalStore(subscribe, getSnapshot);
			if (form === undefined) return undefined;
			return { state: snapshot, mutate: (ops, revision) => form.mutate(ops, revision) };
		}

		/** 配置里已有的自定义 provider 原始行（保存时要在它们后面追加，不能覆盖别人的字段）。 */
		function rawCustomRows(face) {
			const value = face && face.state ? face.state.value : undefined;
			const rows = value && Array.isArray(value.customProviders) ? value.customProviders : [];
			return rows.filter((row) => row && typeof row === "object");
		}

		/**
		 * 「加号」弹窗：在卡片里直接填一家提供商并写回配置，不必跳设置页。
		 * 字段与设置页那套一致，保存走 form.mutate 的 set customProviders。
		 */
		function AddProviderDialog(props) {
			const { t, face, onClose, onAdded } = props;
			const [form, setForm] = useState({
				provider: "",
				label: "",
				baseUrl: "",
				preset: "openai-billing",
				kind: "balance",
				apiKeyRef: "",
				currency: "",
				quota: "",
			});
			const [problem, setProblem] = useState("");
			const [saving, setSaving] = useState(false);

			useEffect(() => {
				const onKey = (e) => { if (e.key === "Escape") onClose(); };
				window.addEventListener("keydown", onKey, true);
				return () => window.removeEventListener("keydown", onKey, true);
			}, [onClose]);

			const set = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));

			const save = async () => {
				const provider = form.provider.trim();
				if (provider === "") { setProblem(t("add.needProvider")); return; }
				if (!/^https?:\/\/\S+/i.test(form.baseUrl.trim())) { setProblem(t("add.needBaseUrl")); return; }
				const rows = rawCustomRows(face);
				if (rows.some((row) => String(row.provider || "").trim().toLowerCase() === provider.toLowerCase())) {
					setProblem(t("add.dup"));
					return;
				}
				if (face === undefined) { setProblem(t("add.failed")); return; }
				setProblem("");
				setSaving(true);
				try {
					const row = { provider, baseUrl: form.baseUrl.trim(), preset: form.preset, kind: form.kind };
					if (form.label.trim() !== "") row.label = form.label.trim();
					if (form.apiKeyRef.trim() !== "") row.apiKeyRef = form.apiKeyRef.trim();
					if (form.currency.trim() !== "") row.currency = form.currency.trim();
					if (form.quota.trim() !== "") row.quota = form.quota.trim();
					const ok = await face.mutate(
						[{ op: "set", path: ["customProviders"], value: [...rows, row] }],
						face.state ? face.state.revision : undefined,
					);
					if (ok === false) { setProblem(t("add.failed")); return; }
					try {
						window.dispatchEvent(new Event("dsh-usage:config-updated"));
					} catch (e) { /* 事件发不出去也不影响已保存的配置 */ }
					onAdded(provider);
					onClose();
				} catch (e) {
					setProblem(t("add.failed"));
				} finally {
					setSaving(false);
				}
			};

			const fieldStyle = {
				boxSizing: "border-box",
				width: "100%",
				height: 28,
				padding: "0 8px",
				borderRadius: 6,
				border: "1px solid " + C.cardBorder,
				background: "transparent",
				color: C.label,
				font: "inherit",
				fontSize: 12,
			};
			const dialogButton = {
				boxSizing: "border-box",
				height: 28,
				padding: "0 12px",
				borderRadius: 6,
				border: "1px solid " + C.cardBorder,
				background: "transparent",
				color: C.label,
				font: "inherit",
				fontSize: 12,
				cursor: "pointer",
			};
			const cell = (labelKey, key, placeholder) => h("div", { style: { display: "flex", flexDirection: "column", gap: 3, minWidth: 0 } },
				h("span", { style: { fontSize: 11, color: C.sub } }, t(labelKey)),
				h("input", {
					style: fieldStyle,
					value: form[key],
					placeholder: placeholder || "",
					onChange: (e) => set(key, e.target.value),
				}));
			const select = (labelKey, key, options) => h("div", { style: { display: "flex", flexDirection: "column", gap: 3, minWidth: 0 } },
				h("span", { style: { fontSize: 11, color: C.sub } }, t(labelKey)),
				h("select", {
					style: { ...fieldStyle, padding: "0 4px" },
					value: form[key],
					onChange: (e) => set(key, e.target.value),
				}, options.map((option) => h("option", { key: option, value: option }, option))));

			return h("div", {
				style: {
					position: "fixed",
					inset: 0,
					zIndex: 2147483001,
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					padding: 12,
					background: "rgba(0,0,0,.38)",
				},
				onMouseDown: (e) => { if (e.target === e.currentTarget) onClose(); },
			},
				h("div", {
					style: {
						boxSizing: "border-box",
						width: "min(360px, 100%)",
						maxHeight: "86vh",
						overflowY: "auto",
						display: "flex",
						flexDirection: "column",
						gap: 8,
						padding: 14,
						borderRadius: 10,
						border: "1px solid " + C.cardBorder,
						background: C.bg,
						color: C.label,
						boxShadow: "0 10px 34px rgba(0,0,0,.28)",
						fontSize: 12,
					},
				},
					h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
						h("strong", { style: { fontSize: 13 } }, t("add.title")),
						h("button", {
							type: "button",
							style: { marginLeft: "auto", border: "none", background: "transparent", color: C.sub, cursor: "pointer", fontSize: 14 },
							onClick: onClose,
							"aria-label": t("add.cancel"),
						}, "×")),
					h("p", { style: { margin: 0, fontSize: 11, color: C.sub } }, t("add.intro")),
					cell("add.provider", "provider", "asnia"),
					cell("add.label", "label", "ASNIA 中转"),
					cell("add.baseUrl", "baseUrl", "https://ai.example.com"),
					h("div", { style: { display: "flex", gap: 8 } },
						h("div", { style: { flex: 1, minWidth: 0 } }, select("add.preset", "preset", CUSTOM_PRESET_OPTIONS)),
						h("div", { style: { flex: 1, minWidth: 0 } }, select("add.kind", "kind", CUSTOM_KIND_OPTIONS))),
					cell("add.apiKeyRef", "apiKeyRef", "EXAMPLE_API_KEY"),
					h("div", { style: { display: "flex", gap: 8 } },
						h("div", { style: { flex: 1, minWidth: 0 } }, cell("add.currency", "currency", "算粒")),
						h("div", { style: { flex: 1, minWidth: 0 } }, cell("add.quota", "quota", "25"))),
					h("p", { style: { margin: 0, fontSize: 11, color: C.sub } }, t("add.quotaHint")),
					problem !== "" ? h("p", { style: { margin: 0, fontSize: 11, color: C.err } }, problem) : null,
					h("div", { style: { display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 2 } },
						h("button", {
							type: "button",
							style: dialogButton,
							onClick: onClose,
						}, t("add.cancel")),
						h("button", {
							type: "button",
							style: { ...dialogButton, fontWeight: 600 },
							disabled: saving,
							onClick: () => { save().catch(() => {}); },
						}, saving ? t("add.saving") : t("add.save")))));
		}

		/** 右键「编辑配置」跳过来时要高亮的那一行：按 provider id 比对（大小写不敏感）。 */
		function rowStyleOf(base, provider, focusId) {
			const id = typeof provider === "string" ? provider.trim().toLowerCase() : "";
			if (focusId === "" || id !== focusId) return base;
			return { ...base, outline: "2px solid var(--dsw-alias-brand-primary, #4c8dff)", outlineOffset: 1 };
		}

		/**
		 * 监听「编辑配置」事件拿到要定位的 provider，并在渲染后把它滚到视野中间。
		 * 设置页两个编辑器（映射表 / 自定义提供商）各自用一份，谁有那一行谁就亮。
		 */
		function useProviderFocus() {
			const [focusId, setFocusId] = useState("");
			useEffect(() => {
				const onFocus = (e) => {
					const detail = e && e.detail;
					setFocusId(detail && typeof detail.provider === "string" ? detail.provider.toLowerCase() : "");
				};
				window.addEventListener("dsh-usage:edit-provider", onFocus);
				return () => window.removeEventListener("dsh-usage:edit-provider", onFocus);
			}, []);
			useEffect(() => {
				if (focusId === "") return;
				const node = document.getElementById("dsh-usage-provider-" + focusId);
				if (node && typeof node.scrollIntoView === "function") node.scrollIntoView({ block: "center", behavior: "smooth" });
			}, [focusId]);
			return focusId;
		}

		/**
		 * 卡片右键菜单。左键点一项＝卡片改看那一家的余额；右键那一项＝跳到设置页改它的配置。
		 * position:fixed 贴着鼠标，菜单不参与卡片布局（卡片只有 60px 高，撑不开）。
		 */
		function ProviderMenu(props) {
			const { menu, t, current, onChoose, onEdit, onClose } = props;
			useEffect(() => {
				const onDown = (e) => {
					const node = e && e.target;
					if (node && typeof node.closest === "function" && node.closest("[data-dsh-usage-menu]") !== null) return;
					onClose();
				};
				const onKey = (e) => { if (e.key === "Escape") onClose(); };
				window.addEventListener("mousedown", onDown, true);
				window.addEventListener("keydown", onKey, true);
				return () => {
					window.removeEventListener("mousedown", onDown, true);
					window.removeEventListener("keydown", onKey, true);
				};
			}, [onClose]);

			const rowBase = {
				display: "flex",
				alignItems: "center",
				gap: 6,
				padding: "5px 10px",
				borderRadius: 6,
				fontSize: 12,
				lineHeight: "16px",
				cursor: "pointer",
				whiteSpace: "nowrap",
				overflow: "hidden",
			};
			const items = [
				h("div", {
					key: "__follow",
					style: { ...rowBase, color: current === "" ? C.label : C.sub, fontWeight: current === "" ? 600 : 400 },
					onClick: () => onChoose(""),
				}, t("menu.follow")),
				h("div", { key: "__sep", style: { height: 1, margin: "4px 6px", background: C.track } }),
			];
			if (menu.loading) {
				items.push(h("div", { key: "__load", style: { ...rowBase, color: C.sub, cursor: "default" } }, t("menu.loading")));
			} else if (menu.items.length === 0) {
				items.push(h("div", { key: "__empty", style: { ...rowBase, color: C.sub, cursor: "default", whiteSpace: "normal" } }, t(menu.empty || "menu.empty")));
			} else {
				for (const item of menu.items) {
					const active = item.id === current;
					items.push(h("div", {
						key: item.id,
						style: {
							...rowBase,
							color: active ? C.label : C.sub,
							fontWeight: active ? 600 : 400,
							background: active ? C.track : "transparent",
						},
						title: t("menu.editHint"),
						onClick: () => onChoose(item.id),
						onContextMenu: (e) => {
							e.preventDefault();
							e.stopPropagation();
							onEdit(item.id);
						},
					},
						h("span", { style: { overflow: "hidden", textOverflow: "ellipsis" } }, item.displayName || item.id),
						h("span", { style: { flex: "none", color: C.sub, fontSize: 11 } }, item.kind === "usage" ? "usage" : item.kind === "oauth" ? "oauth" : "balance")));
				}
			}
			items.push(h("div", { key: "__sep2", style: { height: 1, margin: "4px 6px", background: C.track } }));
			items.push(h("div", {
				key: "__hint",
				style: { ...rowBase, color: C.sub, fontSize: 11, whiteSpace: "normal", cursor: "default" },
			}, t("menu.hint")));

			// 几何：菜单在鼠标下方放不下就翻到上方，高度吃满那一侧的可用空间并内部滚动。
			// 侧栏卡片贴着窗口底边，服务商一多菜单必然超出视口——固定 maxHeight 会在屏幕外
			// 截掉后半截（列表还滚不到），所以按鼠标位置现算。
			const vw = typeof window !== "undefined" ? window.innerWidth || 320 : 320;
			const vh = typeof window !== "undefined" ? window.innerHeight || 480 : 480;
			const GAP = 8;
			const spaceBelow = vh - menu.y - GAP;
			const spaceAbove = menu.y - GAP;
			const flipUp = spaceBelow < 180 && spaceAbove > spaceBelow;
			const maxHeight = Math.max(120, Math.min(300, flipUp ? spaceAbove : spaceBelow));
			const left = Math.max(4, Math.min(menu.x, vw - 276));

			return h("div", {
				"data-dsh-usage-menu": "1",
				style: {
					position: "fixed",
					left,
					...(flipUp ? { bottom: vh - menu.y } : { top: menu.y }),
					zIndex: 2147483000,
					minWidth: 172,
					maxWidth: 264,
					maxHeight,
					overflowY: "auto",
					overscrollBehavior: "contain",
					padding: 4,
					borderRadius: 8,
					border: "1px solid " + C.cardBorder,
					background: C.bg,
					color: C.label,
					boxShadow: "0 6px 20px rgba(0,0,0,.18)",
				},
			}, items);
		}
		// 放假日期：宿主路由（见 lib/index.js），浏览器启动时读一次，覆盖内置镜像表；
		// 读不到就继续用内置表（两边都是同一份国务院办公厅日期表）。
		const HOLIDAYS_PATH = "/api/deepseek-usage/holidays";
		// 常态卡片高度：上下 padding 8+12 + 金额行 minHeight 28 + 边框 2 = 50。
		// 无头 Chromium 实测常态卡片 50px，异常态用同一个 minHeight 兜住，侧边栏不跳动。
		// 卡片基准高度：余额字号放大后需要更多呼吸空间（原 50/60 都偏挤）。
		const CARD_MIN_HEIGHT = 112;
		// 卡片还没拿到余额时的快速重试节奏（宿主刚重启、接口刚起来、或本次请求失败）：
		// 让空卡片在几秒内收敛，而不必等满下一次心跳。
		const QUICK_RETRY_MS = [4000, 8000, 15000, 30000];
		// 宿主错误文案的长度上限：上游异常文本可能很长，卡片高度不应被它撑开。
		const ERROR_MAX_CHARS = 120;

		// ---- i18n（DSH locale 服务；zh 用中文词典，其它语言一律英文）----
		// 注意：卡片上的文字只在两处悬浮说明里——单价行（单位「每百万 token 价格」+ 三个
		// 档位 + 计费币种）与倒计时/指示灯（离贵/便宜的那档价还有多久）。指示灯本身没有
		// 可见文字、只有颜色；倒计时统一用英文单位（d/h/m）且不带前缀，中英界面完全一致
		// ——插件内部的取价路径等一概不进 UI。
		const NS = "dsh-deepseek-usage";
		const ZH = {
			"price.input": "输入",
			"price.cache": "输入缓存",
			"price.output": "输出",
			"price.perMillion": "每百万 token 价格",
			"currency.CNY": "元",
			"currency.USD": "美元",
			"hint.peak": "距离峰价还剩",
			"hint.idle": "距离谷价还剩",
			"hint.switching": "即将切换价格",
			"status.peak": "高峰时段",
			"status.idle": "空闲时段",
			"status.error": "余额读取失败",
			"status.unavailable": "该提供商不支持查询（可在设置页配接口）",
			"status.mapAction": "去映射",
			"card.label": "账户用量，点击刷新",
			"sidebar.label": "账户用量",
			"error.refresh": "刷新失败，请稍后重试",
			"accounts.window.5h": "5 小时",
			"accounts.window.7d": "7 天",
			"accounts.window.7d-opus": "Opus 7 天",
			"accounts.window.30d": "30 天",
			"accounts.window.cycle": "当前周期",
			"settings.nav": "DeepSeek 用量",
			"settings.title": "DeepSeek 用量",
			"settings.intro": "已添加的提供商会显示在侧栏看板的右键菜单里。这里只管理账户：映射本插件已支持的提供商，或用自定义 URL 接入中转站、自建网关。",
			"providers.title": "模型提供商",
			"providers.intro": "每项只占一行摘要：点「编辑」展开改配置，点「删除」移除。",
			"providers.watching": "看板显示这一家（单选）",
			"providers.watchingFollow": "跟随当前模型（不指定）",
			"providers.watchingGone": "这一项配置里已经没有了，看板会回落",
			"providers.empty": "还没有添加提供商。侧栏看板只会显示这里已添加的项，用下面的按钮添加。",
			"providers.edit": "编辑",
			"providers.cancel": "收起",
			"providers.remove": "删除",
			"providers.addAlias": "添加映射",
			"providers.addCustom": "添加自定义 URL",
			"providers.type": "类型",
			"providers.typeAlias": "映射已有提供商",
			"providers.typeCustom": "自定义 URL",
			"providers.saved": "已保存",
			"refresh.title": "刷新间隔",
			"refresh.intro": "侧栏看板隔多少秒重新取一次余额，可以填小数（0.1 秒起）。",
			"refresh.seconds": "秒",
			"refresh.save": "保存",
			"refresh.saved": "已保存",
			"refresh.saveFailed": "保存失败，请重试",
			"refresh.hint": "范围 0.1–3600 秒（保留一位小数），留空按 30 秒。每次刷新会打 1–2 个上游账单请求，中转站常有「5 小时 N 次」的额度限制：500 次/5 小时 ≈ 每 72 秒最多刷一次，建议 300 秒以上。",
			"providers.saveFailed": "保存失败，已刷新，请重试",
			"alias.title": "提供商映射",
			"alias.intro": "把第三方插件注册的 provider id 映射到本插件支持的提供商。映射只决定本插件用哪个账户口径查询，不改变 DSH 的模型路由。",
			"alias.empty": "还没有添加映射。只有能力表里的提供商可查。",
			"alias.provider": "provider id",
			"alias.providerPlaceholder": "例如 dsh-opencode-go",
			"alias.capability": "映射到",
			"alias.capabilityPlaceholder": "选择提供商",
			"alias.refs": "凭据引用（可选）",
			"alias.refsHint": "多个引用用逗号分隔。留空时先试该 provider 的派生引用，再试目标提供商的默认引用。",
			"alias.oauthHint": "保存映射后，下方会出现「订阅令牌」填写区；这里不需要凭据引用。",
			"alias.add": "添加映射",
			"alias.remove": "删除",
			"alias.save": "保存",
			"alias.saved": "已保存",
			"alias.saveFailed": "保存失败，已刷新，请重试",
			"alias.detected": "检测到但未识别",
			"alias.detectedHint": "这些路由没有内置的账户查询接口；选择要映射到的提供商后保存。",
			"alias.autoHint": "已按模型设置里的地址自动识别，点开只需确认接口路径即可。",
			"alias.providerRequired": "provider id 不能为空",
			"alias.duplicate": "provider id 重复",
			"alias.builtin": "该 id 已被内置支持，映射不会生效",
			"alias.capabilityRequired": "请选择要映射到的提供商",
			"alias.loading": "读取配置中…",
			"alias.readonly": "当前配置只读。",
			"alias.unavailable": "当前宿主不提供配置表单。",
			"alias.yamlHint": "可以在 profile 的 cordis.patch.yml 里手动配置 providerAliases；格式见 README。",
			"custom.title": "自定义 URL",
			"custom.intro": "内置能力表覆盖不到的提供商（中转站、自建网关）在这里按地址登记：本插件直接请求你填的 URL 读余额/用量，不猜端点、不按名字推断。",
			"custom.empty": "还没有自定义提供商。没有内置查询接口的 provider 在这一区登记后才能显示余额。",
			"custom.provider": "provider id",
			"custom.providerPlaceholder": "例如 asnia（与 DSH 里的 provider id 一致）",
			"custom.baseUrl": "接口地址",
			"custom.baseUrlPlaceholder": "https://ai.example.com",
			"custom.preset": "接口类型",
			"custom.preset.json": "通用 JSON（自己填路径）",
			"custom.preset.jichuanai": "济川AI（订阅/余额）",
			"custom.preset.newapi-account": "new-api 账号接口（余额+已用）",
			"custom.preset.newapi": "new-api / one-api 中转",
			"custom.preset.openaiBilling": "OpenAI 计费接口",
			"custom.preset.deepseek": "DeepSeek /user/balance",
			"custom.kind": "展示方式",
			"custom.kind.balance": "余额",
			"custom.kind.usage": "用量窗口",
			"custom.apiKeyRef": "凭据引用",
			"custom.subPath": "订阅接口路径（选订阅卡时用）",
			"custom.subTotalPath": "额度字段路径",
			"custom.subUsedPath": "已用字段路径（可留空）",
			"custom.subExpiresPath": "到期字段路径（可留空）",
			"custom.rawJsonHint": "「通用 JSON」= 不套厂商模板，直接按点路径取值（数组用 .0 或 [0]，如 data.0.balance）；字段不存在就显示无法解析，不会编数字。",
			"custom.accountType": "账户类型",
			"custom.accountType.auto": "自动",
			"custom.accountType.balance": "余额",
			"custom.accountType.subscription": "订阅卡",
			"custom.balancePath": "余额接口路径（选余额时用）",
			"custom.balanceTotalPath": "余额字段路径",
			"custom.apiKeyRefInvalid": "引用名或明文密钥都可以",
			"custom.apiKeyRefHint": "可填引用名（ASNIA_API_KEY）或直接粘贴密钥；留空则按 provider id 派生。",
			"custom.currency": "币种",
			"custom.quota": "总额度（可选）",
			"custom.quotaHint": "中转站只给「已用」时无法算剩余：填上站长给的额度后，卡片显示「剩余 = 额度 − 已用」；留空则显示已用，币种位写 USED。",
			"custom.pathHint": "通用 JSON 需要在 profile 的 cordis.patch.yml 里补 path / totalPath 等字段；预设类型不用填。",
			"custom.add": "添加自定义提供商",
			"custom.remove": "删除",
			"custom.save": "保存",
			"custom.saved": "已保存",
			"custom.saveFailed": "保存失败，已刷新，请重试",
			"custom.providerRequired": "provider id 不能为空",
			"custom.duplicate": "provider id 重复",
			"custom.baseUrlRequired": "接口地址必须以 http:// 或 https:// 开头",
			"token.title": "订阅令牌",
			"token.intro": "粘贴 Claude Code / Codex 的 OAuth 令牌后，侧边栏卡片即可显示订阅余量。令牌只保存在本机凭据里，不会离开这台机器。",
			"token.unavailable": "无法读取 OAuth 提供商列表。",
			"token.placeholder": "粘贴 OAuth 令牌",
			"token.accountPlaceholder": "账号 ID（可选，Codex 的 ChatGPT-Account-Id）",
			"token.save": "保存",
			"token.clear": "清除",
			"token.configured": "已填写",
			"token.missing": "未填写",
			"token.saved": "已保存",
			"token.cleared": "已清除",
			"token.failed": "保存失败",
			"token.source.claude": "在装有 Claude Code 的机器上运行 claude setup-token 之外的登录流程：从 ~/.claude/.credentials.json 的 claudeAiOauth.accessToken 复制（macOS 在钥匙串 Claude Code-credentials 里）。setup-token 产的令牌只能读 5 小时与 7 天两个窗口。",
			"token.source.codex": "从 ~/.codex/auth.json 的 tokens.access_token 复制，并把 tokens.account_id 填进账号 ID 一栏。",
			"nudge.idle": "进度汇报待命",
			"nudge.summary": "{steps}/{stepMax} 步 · {secs}/{secMax} 秒",
			"nudge.hint": "左键展开：改步数/时间阈值、暂停提醒",
			"nudge.pausedHint": "进度汇报已暂停，左键展开可继续",
			"nudge.stepThreshold": "步数阈值",
			"nudge.timeThreshold": "时间阈值（秒）",
			"nudge.stepsUnit": "步",
			"nudge.secondsUnit": "秒",
			"nudge.save": "保存",
			"nudge.pause": "暂停",
			"nudge.resume": "继续",
			"menu.follow": "跟随当前模型",
			"menu.loading": "读取提供商…",
			"menu.empty": "没有可选的提供商",
			"menu.hint": "左键切换查看 · 右键编辑该项配置",
			"menu.editHint": "右键编辑这一项的配置",
			"menu.noneAdded": "还没有添加提供商，点左上角加号添加",
			"add.open": "添加模型提供商",
			"card.refresh": "立即刷新（跳过缓存，打一次上游）",
			"stats.tokens": "累计 token",
			"stats.used": "已用",
			"stats.tokensShort": "token",
			"stats.callsShort": "调用",
			"stats.tip": "本机累计口径：token 为每次请求的 token 总和，调用为请求条数。中转站后台有自己的统计规则，需要登录态才能读到。",
			"stats.tipRelay": "中转站后台口径：直接从站点 /api/data/self 聚合（token_used 求和、count 求和），与面板「累计使用token数 / 累计调用次数」同源，10 分钟缓存。",
			"stats.calls": "累计调用",
			"stats.local": "本机口径（站点统计需登录，API key 读不到）",
			"refresh.menuTitle": "自动刷新间隔",
			"refresh.menuHint": "每次刷新会打 1 次上游账单接口（不占模型调用次数）。",
			"refresh.menuUnavailable": "当前宿主没有配置表单，请到设置页改。",
			"add.title": "添加模型提供商",
			"add.intro": "填完保存即写入本插件的配置，侧栏立刻可以切换到它。",
			"add.provider": "提供商 ID（与模型路由 id 一致，如 asnia）",
			"add.label": "显示名",
			"add.baseUrl": "接口地址（如 https://api.example.com）",
			"add.preset": "预设",
			"add.kind": "类型",
			"add.apiKeyRef": "凭据引用（如 ASNIA_API_KEY）",
			"add.currency": "币种/单位",
			"add.quota": "额度（可留空）",
			"add.quotaHint": "填了就把剩余算成 额度-已用",
			"add.save": "保存并切换",
			"add.saving": "保存中…",
			"add.cancel": "取消",
			"add.needProvider": "提供商 ID 必填",
			"add.dup": "这个提供商已经添加过了",
			"add.needBaseUrl": "接口地址必须是 http(s) 开头",
			"add.failed": "保存失败，检查插件配置是否可写",
			"add.ok": "已添加",
		};
		const EN = {
			"price.input": "Input",
			"price.cache": "Input cache",
			"price.output": "Output",
			"price.perMillion": "Price per 1M tokens",
			"currency.CNY": "CNY",
			"currency.USD": "USD",
			"hint.peak": "Peak pricing in",
			"hint.idle": "Off-peak pricing in",
			"hint.switching": "Price change imminent",
			"status.peak": "Peak hours",
			"status.idle": "Off-peak hours",
			"status.error": "Balance unavailable",
			"status.unavailable": "This provider has no query API",
			"status.mapAction": "Set up mapping",
			"card.label": "Account usage, click to refresh",
			"sidebar.label": "Account usage",
			"error.refresh": "Refresh failed, please try again.",
			"accounts.window.5h": "5-hour",
			"accounts.window.7d": "7-day",
			"accounts.window.7d-opus": "Opus 7-day",
			"accounts.window.30d": "30-day",
			"accounts.window.cycle": "Current cycle",
			"settings.nav": "DeepSeek Usage",
			"settings.title": "DeepSeek Usage",
			"settings.intro": "Added providers show up in the sidebar card's right-click menu. This page only manages accounts: map a provider this plugin already supports, or connect a relay / self-hosted gateway by custom URL.",
			"providers.title": "Model providers",
			"providers.intro": "Each provider takes one summary row: click Edit to change it, Remove to delete it.",
			"providers.watching": "Show this provider on the card (single choice)",
			"providers.watchingFollow": "Follow the current model (unspecified)",
			"providers.watchingGone": "This provider is no longer configured; the card falls back",
			"providers.empty": "No providers yet. The sidebar card lists only what is added here — use the buttons below.",
			"providers.edit": "Edit",
			"providers.cancel": "Collapse",
			"providers.remove": "Remove",
			"providers.addAlias": "Add mapping",
			"providers.addCustom": "Add custom URL",
			"providers.type": "Type",
			"providers.typeAlias": "Map an existing provider",
			"providers.typeCustom": "Custom URL",
			"providers.saved": "Saved",
			"refresh.title": "Refresh interval",
			"refresh.intro": "How often the sidebar card re-reads the balance, in seconds (decimals allowed, from 0.1).",
			"refresh.seconds": "seconds",
			"refresh.save": "Save",
			"refresh.saved": "Saved",
			"refresh.saveFailed": "Save failed, try again",
			"refresh.hint": "0.1–3600 seconds, one decimal; leave empty for 30. Each refresh makes 1–2 upstream billing calls; relays often cap calls (e.g. 500 per 5 hours => at most one refresh per ~72s, 300s+ recommended).",
			"providers.saveFailed": "Save failed — refreshed, try again",
			"alias.title": "Provider mappings",
			"alias.intro": "Map a provider id registered by a third-party plugin to a provider this plugin supports. A mapping only decides which account is queried; it does not change DSH's model routing.",
			"alias.empty": "No mappings yet. Only the built-in providers are queryable.",
			"alias.provider": "Provider id",
			"alias.providerPlaceholder": "e.g. dsh-opencode-go",
			"alias.capability": "Maps to",
			"alias.capabilityPlaceholder": "Choose a provider",
			"alias.refs": "Credential refs (optional)",
			"alias.refsHint": "Separate refs with commas. When empty, the route's derived ref is tried first, then the target provider's default refs.",
			"alias.oauthHint": "Save the mapping and a token field appears in the Subscription token section below; no credential refs here.",
			"alias.add": "Add mapping",
			"alias.remove": "Remove",
			"alias.save": "Save",
			"alias.saved": "Saved",
			"alias.saveFailed": "Could not save; reloaded, please retry",
			"alias.detected": "Detected, unrecognized",
			"alias.detectedHint": "These routes have no built-in account API. Choose a provider to map them to, then save.",
			"alias.autoHint": "Auto-detected from the model settings; open it to confirm the endpoint path.",
			"alias.providerRequired": "Provider id is required",
			"alias.duplicate": "Duplicate provider id",
			"alias.builtin": "This id is already supported natively; the mapping would not apply",
			"alias.capabilityRequired": "Choose a provider to map to",
			"alias.loading": "Reading configuration…",
			"alias.readonly": "This configuration is read-only.",
			"alias.unavailable": "This host does not provide a configuration form.",
			"alias.yamlHint": "You can configure providerAliases by hand in the profile's cordis.patch.yml; see the README for the format.",
			"custom.title": "Custom endpoints",
			"custom.intro": "Register providers the built-in capability table does not cover (resellers, self-hosted gateways): the plugin calls exactly the URL you enter to read balance or usage. No endpoint guessing, no inference from names.",
			"custom.empty": "No custom providers yet. A provider without a built-in account API shows numbers only after you register it here.",
			"custom.provider": "Provider id",
			"custom.providerPlaceholder": "e.g. asnia (must match the DSH provider id)",
			"custom.baseUrl": "Endpoint",
			"custom.baseUrlPlaceholder": "https://ai.example.com",
			"custom.preset": "Endpoint type",
			"custom.preset.json": "Generic JSON (paths in YAML)",
			"custom.preset.jichuanai": "JichuanAI (subscription/balance)",
			"custom.preset.newapi-account": "new-api account API (balance + used)",
			"custom.preset.newapi": "new-api / one-api relay",
			"custom.preset.openaiBilling": "OpenAI billing API",
			"custom.preset.deepseek": "DeepSeek /user/balance",
			"custom.kind": "Show as",
			"custom.kind.balance": "Balance",
			"custom.kind.usage": "Usage windows",
			"custom.apiKeyRef": "Credential ref",
			"custom.subPath": "Subscription endpoint (type=subscription)",
			"custom.subTotalPath": "Quota field path",
			"custom.subUsedPath": "Used field path (optional)",
			"custom.subExpiresPath": "Expiry field path (optional)",
			"custom.rawJsonHint": "Generic JSON = no vendor template; values are read by dot path (arrays via .0 or [0]). A missing field shows unparsable instead of inventing a number.",
			"custom.accountType": "Account type",
			"custom.accountType.auto": "Auto",
			"custom.accountType.balance": "Balance",
			"custom.accountType.subscription": "Subscription",
			"custom.balancePath": "Balance endpoint (used when type=balance)",
			"custom.balanceTotalPath": "Balance field path",
			"custom.apiKeyRefInvalid": "A ref name or the raw key both work",
			"custom.apiKeyRefHint": "Paste a ref name or the raw key; leave empty to derive it from the provider id.",
			"custom.currency": "Currency",
			"custom.quota": "Total quota (optional)",
			"custom.quotaHint": "When the relay only reports what you spent, remaining is unknowable: fill in the quota you were granted to show \"remaining = quota − used\"; leave it empty to show the amount spent with USED as the currency.",
			"custom.pathHint": "Generic JSON needs path / totalPath and friends in the profile's cordis.patch.yml; presets fill them in.",
			"custom.add": "Add custom provider",
			"custom.remove": "Remove",
			"custom.save": "Save",
			"custom.saved": "Saved",
			"custom.saveFailed": "Save failed; refreshed, try again",
			"custom.providerRequired": "Provider id is required",
			"custom.duplicate": "Duplicate provider id",
			"custom.baseUrlRequired": "Endpoint must start with http:// or https://",
			"token.title": "Subscription token",
			"token.intro": "Paste a Claude Code or Codex OAuth token and the sidebar card starts reporting subscription quota. The token stays in this machine's credential store and never leaves it.",
			"token.unavailable": "The OAuth provider list could not be read.",
			"token.placeholder": "Paste the OAuth token",
			"token.accountPlaceholder": "Account ID (optional, Codex's ChatGPT-Account-Id)",
			"token.save": "Save",
			"token.clear": "Clear",
			"token.configured": "Saved",
			"token.missing": "Not saved",
			"token.saved": "Saved",
			"token.cleared": "Cleared",
			"token.failed": "Could not save",
			"token.source.claude": "On a machine signed in to Claude Code, copy claudeAiOauth.accessToken from ~/.claude/.credentials.json (on macOS: the Claude Code-credentials keychain item). A claude setup-token token reads the 5-hour and 7-day windows only.",
			"token.source.codex": "Copy tokens.access_token from ~/.codex/auth.json and put tokens.account_id in the account ID field.",
			"nudge.idle": "Nudge idle",
			"nudge.summary": "{steps}/{stepMax} steps · {secs}/{secMax}s",
			"nudge.hint": "Click to edit thresholds or pause",
			"nudge.pausedHint": "Nudge paused — click to resume",
			"nudge.stepThreshold": "Step threshold",
			"nudge.timeThreshold": "Time threshold (s)",
			"nudge.stepsUnit": "steps",
			"nudge.secondsUnit": "s",
			"nudge.save": "Save",
			"nudge.pause": "Pause",
			"nudge.resume": "Resume",
			"menu.follow": "Follow current model",
			"menu.loading": "Loading providers…",
			"menu.empty": "No providers available",
			"menu.hint": "Click to switch · right-click to edit",
			"menu.editHint": "Right-click to edit this provider",
			"menu.noneAdded": "No provider added yet — click + on the card",
			"add.open": "Add model provider",
			"card.refresh": "Refresh now (skips cache, one upstream call)",
			"stats.tokens": "Tokens",
			"stats.used": "used",
			"stats.tokensShort": "token",
			"stats.callsShort": "calls",
			"stats.tip": "Local totals: tokens summed per request, calls = request count. The relay keeps its own stats behind a signed-in session.",
			"stats.tipRelay": "Relay panel figures, aggregated from /api/data/self (sum of token_used and count); same source as the site dashboard, cached 10 min.",
			"stats.calls": "Calls",
			"stats.local": "local machine only (relay stats need a signed-in session)",
			"refresh.menuTitle": "Auto refresh interval",
			"refresh.menuHint": "Each refresh makes one upstream billing call (not counted as model calls).",
			"refresh.menuUnavailable": "This host exposes no config form; use the settings page.",
			"add.title": "Add model provider",
			"add.intro": "Saving writes it into this plugin's config; the card can switch to it immediately.",
			"add.provider": "Provider ID (the route id, e.g. asnia)",
			"add.label": "Display name",
			"add.baseUrl": "Base URL (e.g. https://api.example.com)",
			"add.preset": "Preset",
			"add.kind": "Kind",
			"add.apiKeyRef": "Credential ref (e.g. ASNIA_API_KEY)",
			"add.currency": "Currency/unit",
			"add.quota": "Quota (optional)",
			"add.quotaHint": "With a quota the remaining is quota − used",
			"add.save": "Save & switch",
			"add.saving": "Saving…",
			"add.cancel": "Cancel",
			"add.needProvider": "Provider ID is required",
			"add.dup": "This provider is already added",
			"add.needBaseUrl": "Base URL must start with http(s)",
			"add.failed": "Could not save — check the plugin config is writable",
			"add.ok": "Added",
		};

		/**
		 * DSH 语言设置 → 本插件使用的语言：中文（zh、zh-CN、zh-Hans…）用中文，
		 * 其它任何语言一律英文。
		 */
		function uiLang(active) {
			return typeof active === "string" && active.trim().toLowerCase().startsWith("zh") ? "zh" : "en";
		}

		/** 没有 DSH locale 服务时的兜底：按浏览器语言走同一规则，取不到就是英文。 */
		function browserLang() {
			try {
				return uiLang(String(navigator.language || ""));
			} catch (e) {
				return "en";
			}
		}

		/** 指定语言的词典文案（词典里没有就原样返回 key）。 */
		function textOf(key, lang) {
			return (lang === "zh" ? ZH : EN)[key] || key;
		}

		/** 当前语言：优先读 DSH locale 快照，读不到用浏览器语言。 */
		function currentLang(ctx) {
			try {
				const locale = ctx && ctx.locale;
				if (locale && typeof locale.getSnapshot === "function") {
					return uiLang(locale.getSnapshot().active);
				}
			} catch (e) { /* locale 服务不可用，走浏览器语言 */ }
			return browserLang();
		}

		// locale 服务缺失时的回退快照：必须是同一个对象，否则 useSyncExternalStore
		// 会把每次渲染都当成快照变化，触发无限重渲染。
		const FALLBACK_LOCALE_SNAPSHOT = { active: browserLang(), locales: [], revision: 0 };

		// ---- 峰谷规则（必须与 lib/pricing.js 里 DeepSeek 快照的 schedule
		// （peakWindows / peakDays / holidays）与 HOLIDAY_RANGES 保持一致；浏览器侧
		// 无法 import 宿主模块，只能镜像。2026 年起官方口径：法定节假日全天、调休上班
		// 的周末都是空闲时段，所以放假日期必须一起镜像，否则中秋/国庆白天会被误显示成
		// 高峰价）----
		const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
		const PEAK_WINDOWS = [[9, 12], [14, 18]];
		const PEAK_WEEKDAYS_ONLY = true;
		/** 可能的切换时刻（北京时间整点）：高峰窗口的起止整点，nextChange 逐日枚举它们。 */
		const BOUNDARY_HOURS = [...new Set(PEAK_WINDOWS.flat())].sort((a, b) => a - b);
		// 放假日期（含起止，闭区间）：国务院办公厅 2026 年节假日安排。
		const HOLIDAY_RANGES = [
			['2026-01-01', '2026-01-03'],
			['2026-02-15', '2026-02-23'],
			['2026-04-04', '2026-04-06'],
			['2026-05-01', '2026-05-05'],
			['2026-06-19', '2026-06-21'],
			['2026-09-25', '2026-09-27'],
			['2026-10-01', '2026-10-07'],
		];
		const DAY_MS = 24 * 60 * 60 * 1000;

		/** 把 [起, 止] 闭区间展开成日期键集合（`yyyy-mm-dd`）。 */
		function expandHolidayRanges(ranges) {
			const set = new Set();
			for (const [from, to] of ranges) {
				if (typeof from !== "string" || typeof to !== "string") continue;
				if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) continue;
				const start = Date.parse(from + 'T00:00:00Z');
				const end = Date.parse(to + 'T00:00:00Z');
				if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
				// 解析结果必须与输入同一天，否则输入本身不是合法日期（已滚动到别的日子）。
				if (new Date(start).toISOString().slice(0, 10) !== from) continue;
				if (new Date(end).toISOString().slice(0, 10) !== to) continue;
				for (let t = start; t <= end; t += DAY_MS) set.add(new Date(t).toISOString().slice(0, 10));
			}
			return set;
		}

		/** 内置镜像表：宿主不可达时的兜底，也是 isPeak/nextChange 的缺省集合。 */
		const BUILTIN_HOLIDAY_DAYS = expandHolidayRanges(HOLIDAY_RANGES);

		/** 该时刻所在北京时间日历日是否为法定节假日（放假日期）。 */
		function isHoliday(ms, days) {
			return days.has(new Date(ms + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10));
		}

		/**
		 * 某时刻是否为高峰时段（按北京时间；节假日全天与周末恒为空闲）。与 lib/pricing.js 的 isPeak 等价。
		 * `days` 缺省用内置镜像表，与 lib/pricing.js 的 isPeak 同一口径。
		 */
		function isPeak(ms, days = BUILTIN_HOLIDAY_DAYS) {
			const now = Number.isFinite(ms) ? ms : Date.now();
			if (isHoliday(now, days)) return false;
			const d = new Date(now + SHANGHAI_OFFSET_MS);
			if (PEAK_WEEKDAYS_ONLY) {
				const dow = d.getUTCDay();
				if (dow === 0 || dow === 6) return false;
			}
			const h = d.getUTCHours();
			return PEAK_WINDOWS.some(([start, end]) => h >= start && h < end);
		}

		/**
		 * 距下一个计费时段边界的剩余时间；与 lib/pricing.js 的 nextChange 等价。
		 * 候选时刻是 PEAK_WINDOWS 起止整点落在各天的那些点，逐日枚举取第一个让 isPeak
		 * 翻转的，因此返回精确时刻（上限 32 天，覆盖春节长假 → 假期后首个工作日早晨）。
		 * 找不到切换点时 at 为 null——调用方据此显示「—」，不要当成"此刻在切换"。
		 * `days` 缺省用内置镜像表，与 lib/pricing.js 的 nextChange 同一口径。
		 */
		function nextChange(ms, days = BUILTIN_HOLIDAY_DAYS) {
			const now = Number.isFinite(ms) ? ms : Date.now();
			const current = isPeak(now, days);
			const hourMs = 60 * 60 * 1000;
			const dayStart = Date.parse(new Date(now + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10) + 'T00:00:00Z') - SHANGHAI_OFFSET_MS;
			for (let day = 0; day < 32; day += 1) {
				const base = dayStart + day * DAY_MS;
				for (const hour of BOUNDARY_HOURS) {
					const at = base + hour * hourMs;
					if (at <= now) continue;
					const peak = isPeak(at, days);
					if (peak !== current) return { peak, at, ms: at - now };
				}
			}
			return { peak: !current, at: null, ms: 0 };
		}

		/**
		 * 剩余毫秒 → 给人读的完整时长：`2 天 15 小时` / `5 小时 47 分钟` / `21 分钟`，
		 * 英文为 `2 days 15 hours` / `21 minutes`。不足 1 分钟返回 null，由调用方换成
		 * 「即将切换」一类整句——不拼一个 `0 分钟` 出来。
		 */
		function fmtDuration(ms, lang) {
			const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 60000));
			if (total === 0) return null;
			const days = Math.floor(total / 1440);
			const hours = Math.floor((total % 1440) / 60);
			const minutes = total % 60;
			if (lang === "en") {
				const unit = (v, word) => `${v} ${word}${v === 1 ? "" : "s"}`;
				if (days > 0) return `${unit(days, "day")} ${unit(hours, "hour")}`;
				if (hours > 0) return `${unit(hours, "hour")} ${unit(minutes, "minute")}`;
				return unit(minutes, "minute");
			}
			if (days > 0) return `${days} 天 ${hours} 小时`;
			if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
			return `${minutes} 分钟`;
		}

		/**
		 * 金额 → 两位小数字符串。
		 * null / undefined / 空串都表示"没有拿到"，显示「—」：Number(null) 是 0，
		 * 直接转换会把"读不到余额"显示成"余额 0 元"。
		 */
		/** token 数 → 人看的单位（3.80 亿 / 5420 万）。 */
		function formatTokens(value, lang) {
			const n = Number(value);
			if (!Number.isFinite(n) || n <= 0) return "—";
			if (lang === "zh") {
				if (n >= 1e8) return (n / 1e8).toFixed(2) + " 亿";
				if (n >= 1e4) return (n / 1e4).toFixed(1) + " 万";
				return String(Math.round(n));
			}
			if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
			if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
			if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
			return String(Math.round(n));
		}

		function money(value) {
			if (value === null || value === undefined || value === "") return "—";
			const n = Number(value);
			if (!Number.isFinite(n)) return "—";
			return n.toFixed(2);
		}

		/** 单价 → 去掉多余尾零的字符串；同样把"没有值"显示成「—」。 */
		function fmtPrice(value) {
			if (value === null || value === undefined || value === "") return "—";
			const n = Number(value);
			if (!Number.isFinite(n)) return "—";
			return String(parseFloat(n.toFixed(2)));
		}

		/** 币种 → 符号。未知币种显示代码本身（如 HKD 10.00），不假装成人民币。 */
		function currencySymbol(currency) {
			if (typeof currency !== "string" || currency === "") return "¥";
			const code = currency.trim().toUpperCase();
			if (code === "CNY" || code === "RMB") return "¥";
			if (code === "USD") return "$";
			if (code === "EUR") return "€";
			if (code === "JPY") return "¥";
			if (code === "GBP") return "£";
			return code + " ";
		}

		/**
		 * 账户读数 → 卡片金额行要显示的两截：符号 + 数值。
		 *
		 * 三种 kind：
		 *   · balance —— 币种符号 + 金额（`¥` / `$`，金额缺失时显示「—」）；
		 *   · usage / oauth —— 窗口标签 + 已用百分比。正常情况下卡片用
		 *     usageWindows() 给每个窗口画一个 D 形仪表盘，这里是窗口读不到数值时的
		 *     兜底（回退成最紧窗口或「—」）；
		 *   · 拿不到 —— 都是「—」，绝不显示 0.00 或 0%（那是"读到了 0"的意思）。
		 *
		 * @param kind     provider.kind
		 * @param account  { balance, usage }
		 * @param t        本地化函数（窗口标签需要它）
		 * @returns {{ symbol: string, value: string }}
		 */
		function accountLead(kind, account, t) {
			if (kind === "balance") {
				const balance = account && account.balance ? account.balance : null;
				return {
					symbol: currencySymbol(balance ? balance.currency : ""),
					value: money(balance ? balance.total : null),
				};
			}
			if (kind === "usage" || kind === "oauth") {
				const usage = account && account.usage ? account.usage : null;
				const windows = usage && Array.isArray(usage.windows) ? usage.windows : [];
				// 取已用百分比最高的窗口：它最先撞限，是用户最该看到的那个。
				let best = null;
				for (const w of windows) {
					if (!w || typeof w.percent !== "number" || !Number.isFinite(w.percent)) continue;
					if (best === null || w.percent > best.percent) best = w;
				}
				if (best === null) return { symbol: "", value: "—" };
				return {
					symbol: (t && t("accounts.window." + best.key)) || best.key,
					value: percentText(best.percent),
				};
			}
			return { symbol: "", value: "—" };
		}

		/**
		 * 百分比 → 整数字符串。null / 非数字是"没读到"，显示「—」而不是 0%
		 * （0% 是一个真实读数，含义完全相反）。
		 */
		function percentText(value) {
			if (value === null || value === undefined || value === "") return "—";
			const n = Number(value);
			if (!Number.isFinite(n)) return "—";
			return String(Math.round(n)) + "%";
		}

		// ---- 订阅用量窗口（一张卡片里同时显示多个档位）----
		/**
		 * 宿主的 usage.windows 已是归一后的 { key, percent, resetsAt }。这里只保留
		 * 数值有效的窗口，按固定顺序排列（5 小时 → 7 天 → Opus 7 天 → 30 天 →
		 * 当前周期），未知 key 殿后；百分比缺失的窗口不画——宁可不显示，也不画一条 0%。
		 */
		const WINDOW_ORDER = ["5h", "7d", "7d-opus", "30d", "cycle"];
		function usageWindows(account) {
			const usage = account && account.usage ? account.usage : null;
			const list = usage && Array.isArray(usage.windows) ? usage.windows : [];
			// 同 key 出现多次时保留已用百分比更高的那条（与宿主侧口径一致）。
			const byKey = new Map();
			for (const w of list) {
				if (!w || typeof w !== "object") continue;
				if (typeof w.percent !== "number" || !Number.isFinite(w.percent)) continue;
				const key = typeof w.key === "string" && w.key !== "" ? w.key : "cycle";
				const seen = byKey.get(key);
				if (seen !== undefined && seen.percent >= w.percent) continue;
				byKey.set(key, {
					key,
					percent: w.percent,
					resetsAt: typeof w.resetsAt === "number" && Number.isFinite(w.resetsAt) ? w.resetsAt : null,
				});
			}
			const rank = (key) => {
				const i = WINDOW_ORDER.indexOf(key);
				return i === -1 ? WINDOW_ORDER.length : i;
			};
			return [...byKey.values()].sort((a, b) => rank(a.key) - rank(b.key));
		}

		/** 窗口 key → 本地化标签；词典里没有的通用时长（如 `1h` / `3d`）按语言拼。 */
		function windowLabel(t, key, lang) {
			const translated = t("accounts.window." + key);
			if (translated !== "accounts.window." + key) return translated;
			const hours = /^(\d+)h$/.exec(key);
			if (hours !== null) return lang === "en" ? hours[1] + "-hour" : hours[1] + " 小时";
			const days = /^(\d+)d$/.exec(key);
			if (days !== null) return lang === "en" ? days[1] + "-day" : days[1] + " 天";
			return key;
		}

		/**
		 * 周期徽章上的短标签（嵌在仪表盘底部缺口里，宽度有限）：统一用英文缩写，
		 * 短且与语言无关——`5H` / `7D` / `1M` / `OPUS` / `CYCLE`。
		 * 未知 key 按通用时长折算（1h → 1H、3d → 3D），仍不认得就原样大写。
		 */
		function windowBadge(key) {
			const fixed = { '5h': '5H', '7d': '7D', '30d': '1M', '7d-opus': 'OPUS', cycle: 'CYCLE' };
			if (fixed[key] !== undefined) return fixed[key];
			const hours = /^(\d+)h$/.exec(key);
			if (hours !== null) return hours[1] + 'H';
			const days = /^(\d+)d$/.exec(key);
			if (days !== null) return days[1] + 'D';
			return String(key).toUpperCase();
		}

		/** 单个窗口的悬浮说明：已用百分比 + 距重置的剩余时间。 */
		function windowHint(w, t, lang) {
			const label = windowLabel(t, w.key, lang);
			const used = percentText(w.percent);
			const left = typeof w.resetsAt === "number" ? w.resetsAt - Date.now() : null;
			const span = left !== null && left > 0 ? fmtDuration(left, lang) : null;
			if (lang === "en") {
				return span !== null ? `${label}: ${used} used, resets in ${span}` : `${label}: ${used} used`;
			}
			if (span !== null) return `${label}：已用 ${used}，${span}后重置`;
			if (left !== null && left > 0) return `${label}：已用 ${used}，即将重置`;
			return `${label}：已用 ${used}`;
		}

		/** 用量比例（0–1，超出部分按满格画，不改写数字本身）。 */
		function usageRatio(percent) {
			return Math.max(0, Math.min(100, percent)) / 100;
		}

		/**
		 * 强调色的低饱和度版本：主题的 state 色直接上屏太亮眼（绿、黄尤甚），
		 * 统一按 55% 主题色 + 45% 中性灰混合——色相不变、饱和度约减半，
		 * 明暗两套主题都跟着变。指示灯与仪表盘弧共用这一组值，
		 * 同一语义只有一种颜色。
		 */
		const desaturate = (token) => `color-mix(in srgb, ${token} 55%, #808080)`;

		/**
		 * 剩余额度弧的颜色：已用不到 80% 是绿色；80% 及以上是红色，
		 * 提醒剩余额度已经不多。已用部分始终是灰色。
		 * 绿/红都取降低饱和度后的强调色——绿色与指示灯里的绿色是同一个值。
		 */
		function remainingColor(percent) {
			return percent >= 80 ? C.alert : C.idle;
		}

		// 主题变量（带兜底值）
		const C = {
			bg: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,.12))",
			// 卡片边框与侧边栏顶部「新会话」按钮同一套：0.5px、border-l3。
			cardBorder: "var(--dsw-alias-border-l3, rgba(127,127,127,.3))",
			track: "var(--dsw-alias-border-l1, rgba(127,127,127,.28))",
			label: "var(--dsw-alias-label-primary, #111)",
			sub: "var(--dsw-alias-label-secondary, rgba(0,0,0,.55))",
			// 错误文案保留主题错误色：它要表达"出问题了"，不做减饱和。
			err: "var(--dsw-alias-state-error-primary, rgb(200,40,40))",
			peak: desaturate("var(--dsw-alias-state-warn-primary, rgb(230,120,0))"),
			idle: desaturate("var(--dsw-alias-state-success-primary, rgb(34,160,80))"),
			// 剩余额度不足（已用 ≥80%）的弧色；错误文案仍用 err。
			alert: desaturate("var(--dsw-alias-state-error-primary, rgb(200,40,40))"),
			muted: "var(--dsw-alias-label-tertiary, rgba(0,0,0,.35))",
		};

		const svgBase = {
			width: 12,
			height: 12,
			viewBox: "0 0 24 24",
			fill: "none",
			stroke: "currentColor",
			strokeWidth: 2.2,
			strokeLinecap: "round",
			strokeLinejoin: "round",
			style: { flex: "none", display: "block" },
		};
		// 输入：右箭头指向右边界（→|，数据进入边界）
		const IconIn = () => h("svg", svgBase,
			h("path", { d: "M20 4v16" }),
			h("path", { d: "M20 12H6" }),
			h("path", { d: "M10 7l5 5-5 5" }));
		// 输出：左边界发出右箭头（|→，数据从边界流出）
		const IconOut = () => h("svg", svgBase,
			h("path", { d: "M4 4v16" }),
			h("path", { d: "M4 12h14" }),
			h("path", { d: "M14 7l5 5-5 5" }));
		// 缓存：闪电（缓存命中，快）
		const IconCache = () => h("svg", svgBase,
			h("path", { d: "M13 2 3 14h7l-1 8 10-12h-7l1-8z" }));

		// ---- the widget -------------------------------------------------
		function UsageCell(props) {
			const ctx = props.ctx;
			const wide = !!props.wide;
			const [data, setData] = useState(null);
			const [error, setError] = useState("");
			// 轮询间隔（秒）：以宿主配置为准，存本地一份做首帧兜底。
			const [refreshSeconds, setRefreshSeconds] = useState(() => readCachedRefresh());
			// 倒计时走字用的心跳：每 30 秒 bump 一次，渲染时按当前时刻重算剩余时间。
			const [tick, setTick] = useState(0);
			const [holidayRanges, setHolidayRanges] = useState(() => HOLIDAY_RANGES);
			// 放假日期表：组件实例自己的集合（不做成模块级可变对象——同一页面挂两个实例
			// 时会互相覆盖，峰谷判定会无声翻转）。
			const holidayDays = useMemo(() => expandHolidayRanges(holidayRanges), [holidayRanges]);
			const mounted = useRef(true);
			// 右键菜单选定看哪一家（空串＝跟随当前模型）；menu 为 null 时不渲染浮层。
			const [preset, setPreset] = useState(() => readPresetProvider());
			const [menu, setMenu] = useState(null);
			// 加号弹窗：在卡片里直接添加提供商（写回本插件配置，不跳设置页）。
			const [adding, setAdding] = useState(false);
			// 右键刷新按钮弹出的「自动刷新间隔」面板：{ left, top } 或 null。
			const [refreshMenu, setRefreshMenu] = useState(null);
			// 余额字号：右键金额数字弹出的小面板
			const [amountBase, setAmountBase] = useState(() => readAmountSize());
			const [amountMenu, setAmountMenu] = useState(null);
			const [amountDraft, setAmountDraft] = useState("");
			// 金额行的实测高度：字号按它来，空出来的空间才会被余额吃掉
			const balanceRowRef = useRef(null);
			const [rowHeight, setRowHeight] = useState(0);
			useEffect(() => {
				const node = balanceRowRef.current;
				if (node === null || node === undefined) return undefined;
				const measure = () => {
					const h = node.getBoundingClientRect().height;
					if (!Number.isFinite(h) || h <= 0) return;
					setRowHeight((prev) => (Math.abs(prev - h) < 1 ? prev : Math.round(h)));
				};
				measure();
				if (typeof ResizeObserver === "function") {
					const observer = new ResizeObserver(measure);
					observer.observe(node);
					return () => observer.disconnect();
				}
				window.addEventListener("resize", measure);
				return () => window.removeEventListener("resize", measure);
			}, []);

			const openAmountMenuAt = (rect) => {
				setAmountDraft(String(amountBase));
				setAmountMenu({
					left: Math.max(8, Math.min(rect.left, (window.innerWidth || 320) - 196)),
					top: Math.max(8, rect.top - 96),
				});
			};
			// 底栏整体固定高度：看板自动 = 总高 − 桌面区高度（桌面区高度由它自己上报）
			const [footerHeight, setFooterHeight] = useState(() => readFooterHeight());
			const [dockMeasured, setDockMeasured] = useState(() => footerMetrics.dockHeight);
			useEffect(() => subscribeDockHeight(setDockMeasured), []);
			const heightRef = useRef(footerHeight);
			heightRef.current = footerHeight;
			const cardHeight = Math.max(CARD_HEIGHT_MIN, footerHeight - dockMeasured);
			useEffect(() => { publishCardHeight(cardHeight); }, [cardHeight]);
			// 抽屉滑出时把看板往右挤（推挤而不是覆盖）
			const [drawerOpen, setDrawerOpen] = useState(false);
			const [dockSide, setDockSide] = useState(() => footerSide.side);
			useEffect(() => subscribeSide(setDockSide), []);
			useEffect(() => subscribeDrawerOpen(setDrawerOpen), []);
			const resizeRef = useRef(null);
			const onResizeDown = (e) => {
				e.preventDefault();
				e.stopPropagation();
				resizeRef.current = { y: e.clientY, h: heightRef.current };
				if (typeof e.currentTarget.setPointerCapture === "function") {
					try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 合成事件忽略 */ }
				}
			};
			const onResizeMove = (e) => {
				const drag = resizeRef.current;
				if (drag === null) return;
				const next = Math.min(FOOTER_HEIGHT_MAX, Math.max(FOOTER_HEIGHT_MIN, Math.round(drag.h + (e.clientY - drag.y))));
				if (next !== heightRef.current) {
					heightRef.current = next;
					setFooterHeight(next);
				}
			};
			const onResizeUp = () => {
				if (resizeRef.current === null) return;
				resizeRef.current = null;
				writeFooterHeight(heightRef.current);
			};
			const face = useConfigFace(ctx);
			// 请求序号：只有最后一次请求的结果可以写进 state。心跳、点击、设置事件
			// 会并发触发 load()，慢的旧响应回来得更晚，会把新数据盖掉。
			const requestSeq = useRef(0);
			// 上一次已经画出来的载荷签名：相同就不再 setData（避免每 N 秒整卡重画）。
			const snapshotRef = useRef("");
			// 当前是否有计费区间（决定心跳要不要每秒重算倒计时）。
			const hasWindowsRef = useRef(false);
			// 快速重试：阶梯下标 + 定时器（宿主刚起来、余额接口还没返回时，几秒后自己再看一眼）。
			const retryStep = useRef(0);
			const retryTimer = useRef(null);
			// 页面可见性：后台标签页不做心跳（宿主每次都会真打一次官方余额接口）。
			const visible = useRef(typeof document === "undefined" || document.visibilityState !== "hidden");
			const locale = ctx && ctx.locale;

			// 订阅语言变化（DSH locale 服务；不可用时按浏览器语言兜底）。
			const lcSnap = react.useSyncExternalStore(
				(cb) => (locale && typeof locale.subscribe === "function" ? locale.subscribe(cb) : () => {}),
				() => (locale && typeof locale.getSnapshot === "function" ? locale.getSnapshot() : FALLBACK_LOCALE_SNAPSHOT),
			);
			// 中文（zh / zh-*）用中文词典，其它语言一律英文。
			const lang = uiLang(lcSnap && lcSnap.active);
			// locale.bind(ns) 返回绑定命名空间的翻译函数；不可用时按语言取本地词典。
			const boundT = locale && typeof locale.bind === "function" ? locale.bind(NS) : null;
			const t = (key) => {
				try {
					if (boundT) {
						const v = boundT(key);
						if (typeof v === "string" && v !== key) return v;
					}
				} catch (e) { /* 词典不可用，回退本地词典 */ }
				return textOf(key, lang);
			};
			// 词典也放进 ref：load 的依赖保持稳定（不随语言重建心跳），
			// 但兜底文案仍能取到当前语言。
			const tRef = useRef(t);
			tRef.current = t;

			// 宿主还在后台忙（重启后首次余额、接口刚起来）时按 QUICK_RETRY_MS 阶梯补几次请求，
			// 让卡片几秒内收敛，不必等下一次心跳（POLL_MS）。失败同样按此节奏重试。
			// 判断依据只看"有没有拿到余额"，不依赖宿主内部字段。
			const cancelRetry = useCallback(() => {
				if (retryTimer.current !== null) {
					clearTimeout(retryTimer.current);
					retryTimer.current = null;
				}
			}, []);

			// 语言放进 ref：load 的身份不随语言变化，切中英文时不会重建心跳定时器、
			// 也不会让旧语言的在途请求回填到新语言的界面上。
			const langRef = useRef(lang);
			langRef.current = lang;

			// 选定的 provider 同样走 ref：load 的身份保持不变，切换后由下面的 effect 主动重取。
			const presetRef = useRef(preset);
			presetRef.current = preset;

			// 设置页里切了服务商 → 看板立刻跟着切（反之亦然）。
			useEffect(() => {
				const onPreset = (event) => {
					const next = event && event.detail && typeof event.detail.provider === "string" ? event.detail.provider : readPresetProvider();
					if (next !== presetRef.current) setPreset(next);
				};
				window.addEventListener(PRESET_EVENT, onPreset);
				return () => window.removeEventListener(PRESET_EVENT, onPreset);
			}, []);

			// loadRef 让下面两个回调可以互相引用而不必谁先声明。
			const loadRef = useRef(null);

			/** 按 QUICK_RETRY_MS 阶梯安排一次补请求（用 ref 记录进度；卸载时清理）。 */
			const scheduleRetry = useCallback(() => {
				if (!mounted.current) return;
				const delay = QUICK_RETRY_MS[retryStep.current];
				if (delay === undefined) return;
				retryStep.current += 1;
				cancelRetry();
				retryTimer.current = setTimeout(() => {
					retryTimer.current = null;
					const run = loadRef.current;
					if (run) run();
				}, delay);
			}, [cancelRetry]);

			const load = useCallback(async (options) => {
				const seq = ++requestSeq.current;
				try {
					const chosen = presetRef.current;
					const url = USAGE_PATH + "?lang=" + langRef.current
						+ (chosen === "" ? "" : "&provider=" + encodeURIComponent(chosen))
						// 手动刷新时带 nocache=1：宿主会清掉这一轮快照缓存，真的打一次上游，
						// 方便对照中转站后台的「累计调用次数」到底是谁在涨。
						+ (options !== undefined && options !== null && options.nocache === true ? "&nocache=1" : "");
					const res = await fetch(url, { cache: "no-store" });
					let body = null;
					try {
						body = await res.json();
					} catch (e) {
						body = null;
					}
					if (!res.ok || body === null || typeof body !== "object" || body.ok !== true) {
						// 失败原因优先用宿主给的文案（未配置 Key / 余额接口异常，用户看得懂）；
						// 拿不到就用一句人话兜底——不把 HTTP 状态码这类传输细节摆到卡片上。
						throw new Error(body && typeof body.message === "string" && body.message !== "" ? body.message : tRef.current("error.refresh"));
					}
					// 过期响应直接丢弃：晚到的旧结果不能盖掉新数据，也不能把刚填好的
					// 余额整个抹成错误态。
					if (!mounted.current || seq !== requestSeq.current) return;
					// 载荷没变就不 setData：定时器每 N 秒回来一次，但余额一分钟才动一分，
					// 无脑替换 state 只会让整张卡片重画一遍（看起来就是"闪"）。
					// next.ms 是相对剩余毫秒，每次都变，比较时只取切换时刻。
					const sig = JSON.stringify({
						provider: body.provider,
						balance: body.balance,
						usage: body.usage,
						tier: body.tier,
						pricing: body.pricing,
						peak: body.peak,
						nextAt: body.next ? body.next.at : null,
						errors: body.errors,
					});
					if (sig !== snapshotRef.current) {
						snapshotRef.current = sig;
						setData(body);
					}
					setError("");
					if (typeof body.refreshSeconds === "number") {
						const next = clampRefresh(body.refreshSeconds);
						setRefreshSeconds(next);
						writeCachedRefresh(next);
					}
					// 成功即取消待发的补请求并复位阶梯，否则上一次失败排下的定时器会
					// 在几秒后再打一发，可能把这份好数据换成错误态。
					cancelRetry();
					retryStep.current = 0;
				} catch (e) {
					if (!mounted.current || seq !== requestSeq.current) return;
					const message = e instanceof Error ? e.message : String(e);
					setError(message.length > ERROR_MAX_CHARS ? message.slice(0, ERROR_MAX_CHARS) + "…" : message);
					scheduleRetry();
				}
			}, [cancelRetry, scheduleRetry]);

			loadRef.current = load;

			/** 右键打开菜单：候选从 /accounts 现取（设置页可能刚改过配置）。 */
			const openMenu = useCallback(async (event) => {
				if (event && typeof event.preventDefault === "function") event.preventDefault();
				const vw = typeof window !== "undefined" ? window.innerWidth || 320 : 320;
				const x = Math.max(4, Math.min((event && event.clientX) || 0, vw - 276));
				// y 不做上钳：贴着鼠标，向上还是向下展开由 ProviderMenu 按剩余空间决定。
				const y = Math.max(4, (event && event.clientY) || 0);
				setMenu({ x, y, items: [], loading: true });
				try {
					const res = await fetch(ACCOUNTS_PATH, { cache: "no-store" });
					const body = await res.json().catch(() => null);
					const list = res.ok && body && body.ok === true && Array.isArray(body.catalog) ? body.catalog : [];
					// 只列"添加过的"：内置能力表里的那十几个只是"支持"，用户没添加就不该出现在菜单里。
					const added = res.ok && body && body.ok === true && Array.isArray(body.added)
						? body.added.map((id) => String(id).toLowerCase())
						: null;
					const items = added === null ? list : list.filter((item) => added.includes(String(item.id).toLowerCase()));
					const empty = added !== null && added.length === 0 ? "menu.noneAdded" : "menu.empty";
					if (mounted.current) setMenu({ x, y, items, loading: false, empty });
				} catch (e) {
					if (mounted.current) setMenu({ x, y, items: [], loading: false });
				}
			}, []);

			/** 左键选一家：写 localStorage 并立刻重取（不动默认模型）。 */
			const chooseProvider = useCallback((id) => {
				setMenu(null);
				writePresetProvider(id);
				setPreset(id);
			}, []);

			/** 右键某一项：跳到设置页改它的配置（自定义 URL 那一条就在同一页）。 */
			const editProvider = useCallback((id) => {
				setMenu(null);
				openUsageSettings(ctx);
				try {
					window.dispatchEvent(new CustomEvent("dsh-usage:edit-provider", { detail: { provider: id } }));
				} catch (e) { /* 老环境没有 CustomEvent 构造函数：设置页照常打开，只是不定位 */ }
			}, [ctx]);

			const closeMenu = useCallback(() => setMenu(null), []);

			// 视口变化后菜单的几何已经过期，直接关掉比错位停在那儿好。
			useEffect(() => {
				if (menu === null) return undefined;
				const onResize = () => setMenu(null);
				window.addEventListener("resize", onResize);
				return () => window.removeEventListener("resize", onResize);
			}, [menu]);

			// 语言切换后立刻按新语言重取一次：宿主返回的文案（余额/账户错误）要跟着
			// 换语言，不必等下一次心跳。用 ref 记录上一帧语言，挂载时不重复请求
			// （挂载 effect 已经 load 过），也不重建 30s 心跳定时器。
			// 右键切换 provider 后立刻重取：这一步与心跳无关，必须马上看到新的一家的数字。
			useEffect(() => {
				load().catch(() => {});
			}, [preset, load]);

			const prevLangRef = useRef(lang);
			useEffect(() => {
				if (prevLangRef.current === lang) return;
				prevLangRef.current = lang;
				load();
			}, [lang, load]);

			useEffect(() => {
				mounted.current = true;
				load();
				// 模型切换（写入 settings 触发 document-updated）时立即刷新，单价跟着变。
				let off = null;
				try {
					if (ctx && ctx.remote && typeof ctx.remote.$on === "function") {
						off = ctx.remote.$on("settings/document-updated", () => {
							load().catch(() => {});
						});
					}
				} catch (e) {
					off = null;
				}
				return () => {
					mounted.current = false;
					cancelRetry();
					try {
						if (typeof off === "function") off();
					} catch (e) { /* 忽略退订错误 */ }
				};
			}, [load, ctx, cancelRetry]);

			// ---- 放假日期表（宿主是唯一权威：启动时拉一次，只用于本地兜底计算）----
			// 浏览器侧必须镜像峰谷规则（无法 import 宿主模块），放假日期也就不该各写一份，
			// 否则放假那几天两边会算出不同结果。这里用组件自己的 holidayDays 集合，
			// 宿主返回的表覆盖内置镜像。
			useEffect(() => {
				let cancelled = false;
				(async () => {
					try {
						const res = await fetch(HOLIDAYS_PATH, { cache: "no-store" });
						let body = null;
						try { body = await res.json(); } catch (e) { body = null; }
						if (cancelled || !res.ok || !body || body.ok !== true) return;
						if (Array.isArray(body.ranges) && body.ranges.length > 0) setHolidayRanges(body.ranges);
					} catch (e) { /* 读不到就用内置表继续 */ }
				})();
				return () => { cancelled = true; };
			}, []);

			// 页面可见性：隐藏时停心跳，回到前台补一次。
			useEffect(() => {
				if (typeof document === "undefined") return;
				const onChange = () => {
					visible.current = document.visibilityState !== "hidden";
					if (visible.current) load().catch(() => {});
				};
				document.addEventListener("visibilitychange", onChange);
				return () => document.removeEventListener("visibilitychange", onChange);
			}, [load]);

			// 设置页保存映射后立即重取一次，不等到下一次心跳（否则看起来像没生效）。
			useEffect(() => {
				if (typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined;
				const onConfig = () => { load().catch(() => {}); };
				window.addEventListener("dsh-usage:config-updated", onConfig);
				return () => window.removeEventListener("dsh-usage:config-updated", onConfig);
			}, [load]);

			// 心跳：每 refreshSeconds 重算一次倒计时（setTick 触发重渲染）并重新取一次数。
			// 取数会带回最新的余额、峰谷状态与档单价，所以跨过峰谷切换点后单价与指示灯
			// 最多滞后一次心跳——不需要单独检测切换时刻。页面隐藏时不发请求。
			useEffect(() => {
				// 最小 100ms：浏览器对过密的定时器会做节流，再小也快不了，只会堆请求。
				const intervalMs = Math.max(100, Math.round(refreshSeconds * 1000));
				const timer = setInterval(() => {
					// tick 只服务于"距切换还有多久"的悬浮说明：订阅卡要每秒重算，
					// 余额卡没有倒计时，跳过重渲染——否则数字没变也会每秒重画一次。
					if (hasWindowsRef.current) setTick((v) => v + 1);
					if (!visible.current) return;
					load().catch(() => {});
				}, intervalMs);
				return () => clearInterval(timer);
			}, [load, refreshSeconds]);

			const tier = data && data.tier ? data.tier : null;
			// 当前 provider 的查询能力：balance 显示金额，usage/oauth 显示订阅窗口，
			// none 表示这个 provider 没有可查的接口（卡片置空说明原因）。
			const kind = data && data.provider && typeof data.provider.kind === "string" ? data.provider.kind : "balance";
			const lead = accountLead(kind, data, t);
			const symbol = lead.symbol;
			const amount = lead.value;
			// 订阅用量：把宿主返回的每个窗口都画出来（D 形仪表盘 + 周期徽章 + 百分比），
			// 同一张卡片里并列显示 5 小时 / 周 / 月等多个档位，而不是只显示最紧的
			// 那一个。窗口读不到数值时回退成下面的 accountLead 兜底行。
			const usageRows = kind === "usage" || kind === "oauth" ? usageWindows(data) : [];
			// 余额形态没有仪表盘，但接口带回的 cycle 百分比是"已用/额度"：
			// 顺手标在金额右边，否则只能看到剩余数字，看不出它是涨是跌。
			const cycleWindow = kind === "balance" && data && data.usage && Array.isArray(data.usage.windows)
				? data.usage.windows.find((w) => w && w.key === "cycle" && typeof w.percent === "number")
				: undefined;
			// 档单价：宿主已按 provider + 模型查过价格表，known=false 表示"这个模型的价格
			// 插件不知道"，单价行不渲染。数据还没到（tier 为 null）时同样不显示——宁可
			// 少显示，也不要显示 0。
			const priced = !!tier && tier.known !== false;
			// provider 身份：本地兜底算倒计时、以及旧宿主响应的兼容判断都要用。
			// provider 字段缺失是老宿主的响应，按 DeepSeek 处理。
			const providerId = data && data.provider && typeof data.provider.id === "string"
				? data.provider.id.trim().toLowerCase()
				: "";
			const officialProvider = providerId === "" || ["deepseek-official", "deepseek-account", "deepseek"].includes(providerId);
			// 分时段计费：DeepSeek 的峰谷、其它 provider 的高峰/优惠时段都折算成
			// tier.window（'peak' 贵的一侧 / 'idle' 便宜的一侧）；null 表示全天一价，
			// 卡片只画单价行，不画指示灯与倒计时。订阅制路由上的 DeepSeek 模型也会
			// 由宿主填入时段（单价仍然 known=false），所以这张卡片也能显示峰谷灯。
			//
			// tier.window 是新宿主才有的字段：**旧宿主**（宿主进程没重启、只刷新了页面）
			// 的响应里没有它。那种情况退回旧口径——DeepSeek 官方模型照旧带峰谷指示灯，
			// 否则"刷新页面后指示灯凭空消失"。
			const hasWindows = !!tier && (tier.window === undefined ? priced && officialProvider : !!tier.window);
			hasWindowsRef.current = hasWindows;
			// 卡片只显示"用户要的数字"：账户读数、当前档单价、状态圆点（悬浮给出
			// 距下次切换的剩余时间）。插件的内部信息（取价路径、模型改名）一律不进 UI，
			// 唯一的交互是点击卡片刷新。只有"账户类错误"（未配置密钥 / 接口或网络失败 /
			// 该 provider 没有可查接口）才把卡片置空并说明原因——否则读数是空的，
			// 用户无从判断。
			const errs = (Array.isArray(data && data.errors) ? data.errors : []).concat(error ? [error] : []);
			// 有读数就继续显示读数：一次请求超时/上游 502 不该把数字抽走再放回来，
			// 那才是"刷新时闪烁"的主因。数字变灰 + 悬浮说明里给原因，比整卡换掉稳。
			const hasReading = !!(
				data && (
					(data.balance && data.balance.total !== null && data.balance.total !== undefined)
					|| (data.usage && Array.isArray(data.usage.windows) && data.usage.windows.length > 0)
				)
			);
			const blanked = errs.length > 0 && !hasReading;
			const staleWithReading = errs.length > 0 && hasReading;
			// 每次渲染都以"当前时刻"求剩余时间；tick 每 30 秒 bump 一次触发这次重算。
			const nowMs = Date.now();
			const nextAt = (() => {
				const raw = data && data.next ? Number(data.next.at) : NaN;
				// 宿主给的切换时刻必须还在将来：旧响应或时钟漂移会让它落在过去，
				// 那样悬浮说明里的时长会卡在 switching。
				if (Number.isFinite(raw) && raw > nowMs) return raw;
				// 只有"有计费区间 + DeepSeek 官方口径"才在本地重算；其它 provider 的
				// 时段表只在宿主里，本地没有镜像，不做猜测。
				if (!hasWindows || !officialProvider) return null;
				const age = data && Number(data.updatedAt) > 0 ? Math.max(0, nowMs - Number(data.updatedAt)) : 0;
				const local = nextChange(nowMs - age, holidayDays);
				return local.at !== null && local.at > nowMs ? local.at : null;
			})();
			void tick; // tick 只用来触发重渲染，值本身不参与计算
			// 计费区间切换的悬浮说明：指示灯本身只有颜色，指针悬停时用一句完整的话
			// 讲清"离贵/便宜的那档价还有多久"。拿不到切换时刻时退化成当前区间名，
			// 不足 1 分钟时说"即将切换"，都不拼数字。
			const statusText = data && data.peak ? t("status.peak") : t("status.idle");
			const switchHint = (() => {
				if (!hasWindows) return statusText;
				if (nextAt === null) return statusText;
				const span = fmtDuration(nextAt - nowMs, lang);
				if (span === null) return t("hint.switching");
				return `${t(data && data.peak ? "hint.idle" : "hint.peak")} ${span}`;
			})();
			// 圆点本身用 SVG 画圆，不用 CSS 圆角：8px 盒子的 border-radius 在宿主
			// 渲染层会被画成"圆角方"（实测半径只有设定值的七八成），而同样尺寸的
			// SVG 圆是标准圆。颜色写进 style（color-mix() 在 presentation attribute
			// 上不如 CSS 属性可靠，仪表盘弧同理）。
			const dotColor = data ? (data.peak ? C.peak : C.idle) : C.muted;
			const dotCircle = (color) => h("svg", {
				width: 8,
				height: 8,
				viewBox: "0 0 8 8",
				style: { display: "block" },
				"aria-hidden": "true",
			}, h("circle", { cx: 4, cy: 4, r: 4, style: { fill: color } }));
			// 圆点只是 8×8 的定位盒子，自身不画任何东西（没有底色，也没有阴影）。
			const dot = {
				width: 8,
				height: 8,
				flex: "none",
			};
			// 区间指示灯：余额卡片放在金额行右侧；订阅卡片叠在右上角（仪表盘占满一行）。
			// 倒计时只放在悬浮说明里，不再占卡片的一行宽度。
			const scheduleDot = (style) => hasWindows && h("span", {
				style: { ...dot, ...style },
				title: switchHint,
				role: "img",
				"aria-label": statusText,
			}, dotCircle(dotColor));
			// 圆点自身不带说明（历史上 title 里塞过价格表路径等内部信息，已删除）；
			// 它只表达"现在是高峰还是空闲"，说明文字挂在外层那一组上（见 switchHint）。
			// 点击卡片：唯一动作 = 刷新。
			const onCardClick = () => {
				load().catch(() => {});
			};

			// 订阅用量形态下 symbol 是窗口标签（如「5 小时」），字号随正文，
			// 不再用 24px 的货币符号尺寸——标签比符号长，放大后会挤掉百分比。
			const usageLead = kind === "usage" || kind === "oauth";
			// 高度 → 字号比例（112px 为基准，最大 1.55 倍，最小 0.85 倍）
			const cardScale = Math.min(1.55, Math.max(0.68, cardHeight / CARD_MIN_HEIGHT));
			// 行高优先：余额行有多少高度就用多少（0.42 系数在 85px 行高时约等于原来 34px 字号）
			const amountPx = rowHeight > 0
				? Math.min(AMOUNT_SIZE_MAX, Math.max(14, Math.round(rowHeight * 0.42 * (amountBase / AMOUNT_SIZE_DEFAULT))))
				: Math.round(amountBase * cardScale);
			const amountLh = Math.round(amountPx * 1.15);
			const leadStyle = usageLead
				? { fontWeight: 600, fontSize: Math.round(12 * cardScale), color: C.sub, lineHeight: amountLh + "px", marginRight: 1, flex: "none", whiteSpace: "nowrap" }
				: { fontWeight: 700, fontSize: amountPx, color: C.label, lineHeight: amountLh + "px", marginRight: 3, flex: "none" };
			// tabular-nums：数字等宽，22.79 → 22.8 时不会左右抖一下。
			// useMemo 不只是省两次对象分配：金额/百分比是 memo 组件，props 里的
			// style 每次新建新对象就等于每次都"变了"，记忆化会失效。
			const amountStyle = useMemo(() => ({
				fontWeight: 700,
				fontSize: amountPx,
				color: C.label,
				lineHeight: amountLh + "px",
				// 金额是唯一不能省的东西：flex:0 0 auto 让它不参与收缩，
				// 空间不够时剪掉的是后面的「已用 x%」，而不是把数字变成「19...」。
				flex: "0 0 auto",
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap",
				fontVariantNumeric: "tabular-nums",
			}), [amountPx, amountLh]);
			const cycleHintStyle = useMemo(() => ({
				fontSize: 12,
				lineHeight: "14px",
				color: C.sub,
				whiteSpace: "nowrap",
				overflow: "hidden",
				textOverflow: "ellipsis",
				// 与金额一样不参与收缩：算过宽度（算粒+5 位数字+已用 23.5% ≈ 209px < 234px 可用），
				// 字号降到 11 之后放得下，就不要再让它被省略成「已用 2…」。
				flex: "0 0 auto",
				fontSize: 11,
				textOverflow: "clip",
				fontVariantNumeric: "tabular-nums",
			}), []);

			// 折叠态（图标栏）：内容宽 36px（侧边栏 56px − 折叠态左右各 10px 内边距），
			// 只容得下峰谷指示灯，没有外框也没有底色（直接坐在侧边栏背景上）。
			// 指示灯仍是"点击刷新"的落点。
			// 渲染条件：这个 provider 有可查的账户接口（kind 不是 none），或已经报了真错误。
			// 二者都不成立时这个栏里没有任何有意义的内容，整块不渲染。
			// 账户读不到时圆点用错误色——绿灯会被读成"一切正常"；但 `kind === 'none'`
			// 不是错误（插件本就不查它），那种情况用中性灰点。
			if (!wide) {
				if (kind === "none" && !blanked) return null;
				const failed = blanked && kind !== "none";
				const neutral = kind === "none";
				return h("div", {
					style: {
						boxSizing: "border-box",
						flex: "none",
						padding: "4px 8px",
						cursor: "pointer",
						display: "flex",
						flexDirection: "row",
						alignItems: "center",
						userSelect: "none",
					},
					role: "button",
					tabIndex: 0,
					"aria-label": t("card.label"),
					// 折叠态只有指示灯：说明挂在整块上，指到图标就出"离峰/谷价还有多久"。
					title: failed ? t("status.error") : (neutral ? t("status.unavailable") : switchHint),
					onClick: () => load().catch(() => {}),
					onKeyDown: (e) => {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							load().catch(() => {});
						}
					},
				}, h("span", {
					style: dot,
					role: "img",
					"aria-label": failed
						? t("status.error")
						: (neutral
							? t("status.unavailable")
							: statusText),
				}, dotCircle(failed ? C.err : (neutral ? C.muted : dotColor))));
			}

			// 只有"账户类错误"（未配置密钥 / 接口或网络失败 / 该 provider 没有可查
			// 接口）才走到这里：卡片置空、只显示原因文字，不画读数/单价/圆点/倒计时。
			// minHeight 兜住常态卡片高度（CARD_MIN_HEIGHT），侧边栏不跳动；
			// 文字多行时卡片自然变高。
			// 注意：这里不显示任何插件内部信息（取价路径、放假日期来源），历史上那批
			// 良性提示已随"去技术化"一起删除。
			// 折叠态（!wide）早在上面就返回了：它只有峰谷指示灯，没有文字空间。
			if (blanked) {
				// 配色分流：`kind === 'none'` 不是错误——本插件就没打算查这个提供商，
				// 用户的账户没有任何问题。把它标红会让人以为出故障了，所以用常规
				// 次要文字色陈述事实；只有真去查过并失败（网络/认证/形状不认）才用红色。
				const unsupported = kind === "none";
				const reasonStyle = {
					color: unsupported ? C.sub : C.err,
					fontSize: 12,
					lineHeight: "16px",
					whiteSpace: "pre-wrap",
					overflowWrap: "anywhere",
				};
				const cardStyle = {
					boxSizing: "border-box",
					flex: "1 1 100%",
					minWidth: 0,
					minHeight: CARD_MIN_HEIGHT,
					padding: "8px 10px",
					borderRadius: 10,
					border: "0.5px solid " + C.cardBorder,
					background: C.bg,
					color: C.label,
					userSelect: "none",
					display: "flex",
					flexDirection: "column",
					justifyContent: "center",
					gap: 3,
					marginTop: 4,
					fontSize: "12px",
					lineHeight: "15px",
				};
				// 不支持的路由可以现场去映射：原因下面给一个直达「DeepSeek 用量」设置页的
				// 按钮；宿主没有设置外壳（旧版本 / 未认证页面）时不渲染，避免死按钮。
				if (unsupported) {
					const canMap = canOpenUsageSettings(ctx);
					// ⚠️ 这张"没有读数"的卡片同样要能右键切换 provider：
					// 用户在设置里删掉/改错当前 provider 后会落到这里，没有菜单就等于被锁死。
					return h("div", {
						onContextMenu: openMenu,
						style: { ...cardStyle, gap: 6 },
					},
						h("div", {
							style: { ...reasonStyle, cursor: "pointer" },
							role: "button",
							tabIndex: 0,
							"aria-label": t("card.label"),
							onClick: onCardClick,
							onKeyDown: (e) => {
								if (e.key === "Enter" || e.key === " ") {
									e.preventDefault();
									onCardClick();
								}
							},
						}, errs.join(" | ")),
						canMap
							? h("button", {
								type: "button",
								style: {
									alignSelf: "flex-start",
									boxSizing: "border-box",
									height: 22,
									padding: "0 8px",
									borderRadius: 6,
									border: "0.5px solid " + C.cardBorder,
									background: "transparent",
									color: C.label,
									font: "inherit",
									fontSize: 11,
									lineHeight: "20px",
									cursor: "pointer",
								},
								onClick: (e) => {
									if (e && typeof e.stopPropagation === "function") e.stopPropagation();
									openUsageSettings(ctx);
								},
							}, t("status.mapAction"))
							: null,
menu !== null && h(ProviderMenu, {
							menu,
							t,
							current: preset !== "" ? preset : (data && typeof data.provider === "string" ? data.provider : ""),
							onChoose: chooseProvider,
							onEdit: editProvider,
							onClose: closeMenu,
						}),
					);
				}
				// 失败卡（例如"账户接口返回了无法解析的内容"）同样要能右键换 provider：
				// 配置填错时用户最需要的就是切走，而不是被锁在这张红卡上。
				return h("div", {
					onContextMenu: openMenu,
					style: { ...cardStyle, cursor: "pointer" },
					role: "button",
					tabIndex: 0,
					"aria-label": t("card.label"),
					onClick: onCardClick,
					onKeyDown: (e) => {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							onCardClick();
						}
					},
				},
					h("div", { style: reasonStyle }, errs.join(" | ")),
					menu !== null && h(ProviderMenu, {
						menu,
						t,
						current: preset !== "" ? preset : (data && typeof data.provider === "string" ? data.provider : ""),
						onChoose: chooseProvider,
						onEdit: editProvider,
						onClose: closeMenu,
					}));
			}

			// 单价组（图标 + 数字）：说明文字统一挂在下面的单价行上，命中区覆盖整行——鼠标
			// 落在数字上也出说明，不必精确指到那个小图标。
			const Price = (icon, value) =>
				h("span", { style: { display: "inline-flex", alignItems: "center", gap: 3, minWidth: 0, color: C.sub, whiteSpace: "nowrap" } },
					h("span", { style: { display: "inline-flex", alignItems: "center" }, "aria-hidden": "true" }, icon),
					h("span", { style: { fontWeight: 600 } }, fmtPrice(value)));

			// 单价行的悬浮说明：卡片上只有「图标 + 数字」，读不出单位也读不出三个档位分别
			// 指什么，所以整行共用一条 tooltip。单位是「每百万 tokens」，币种跟价格表走
			// （DeepSeek / Kimi 国内站 / MiniMax 国内站是人民币，Z.ai、OpenRouter 是美元）。
			// 原生 tooltip 不会自动折行，这里显式分两行：第一行讲单位，第二行给三个档位
			// ——侧边栏放不下时也不至于被拉成一长条。
			const priceCurrency = tier && typeof tier.currency === "string" && tier.currency !== "" ? tier.currency : "CNY";
			const priceUnitKey = "currency." + priceCurrency;
			const priceUnitText = t(priceUnitKey);
			const priceUnit = priceUnitText === priceUnitKey ? priceCurrency : priceUnitText;
			const priceTooltip = () => [
				t("price.perMillion"),
				[
					`${t("price.input")} ${fmtPrice(tier.input)} ${priceUnit}`,
					`${t("price.cache")} ${fmtPrice(tier.cacheRead)} ${priceUnit}`,
					`${t("price.output")} ${fmtPrice(tier.output)} ${priceUnit}`,
				].join(" / "),
			].join("\n");

			// 金额行：账户读数 + 右侧「倒计时 + 峰谷圆点」。
			// 倒计时与圆点放在同一个 flex 行里、alignItems:center，两者圆心必然重合；
			// 整组 alignSelf:flex-start + 负 margin，让圆点距卡片顶/右各 8px。
			// 两个反面做法都试过并实测过：
			//   · alignSelf:center → 圆点被压到卡片中线，不再是"右上角"；
			//   · paddingTop:6    → 金额行被撑高，卡片被撑大，圆点反而更靠下。
			// 金额行只放余额读数，在卡片内容区里竖向居中；单价行绝对定位在右下角，
			// 不再占据流式高度，因此金额能真正落在卡片竖直中线上。
			// 右侧留出单价行的宽度，长余额（¥1234567.89）用省略号截断，不会压到单价。
			// 有单价行时金额整体右移 10px，收窄它与右下角单价之间的空白。
			// 本机累计用量：与「已用 x%」并排成三行小字（用户要求的位置）。
			const local = data && typeof data.local === "object" ? data.local : null;
			// 站点口径（后台面板那两个数）优先；拿不到（未放 token / token 过期）就回落本机记账。
			const relay = data && data.relay && data.relay.ok === true ? data.relay : null;
			// 是否"自定义地址的 provider"（如 asnia 中转）：只有这类才有 baseUrl 可查站点统计。
			const customProvider = !!(data && data.provider && data.provider.via === "custom");
			// 只认站点口径：本机记账（.dshw-usage.json）没有 provider 字段，拆不出归属，
			// 显示在任意 provider 上都会张冠李戴（用户实测就是这么被误导的）。
			// 站点不提供累计统计时（例如济川AI 只有 /user/profile 的余额）就不显示这两行。
			const statTokens = relay !== null ? relay.tokens : null;
			const statCalls = relay !== null ? relay.calls : null;
			const statsTip = relay !== null ? t("stats.tipRelay") : t("stats.tip");
			// 订阅卡剩余天数（host 给的是 epoch ms，只有配了 expiresPath 的 provider 才有）
			const subDays = (() => {
				const at = data === null || data === undefined ? NaN : Number(data.expiresAt);
				if (!Number.isFinite(at) || at <= 0) return null;
				return Math.max(0, Math.ceil((at - Date.now()) / 86_400_000));
			})();
			// 账户类型标签：带 expiresAt 的是订阅卡（有到期日），否则按余额展示。
			const planKind = (() => {
				if (data === null || data === undefined) return null;
				const at = Number(data.expiresAt);
				if (Number.isFinite(at) && at > 0) return "subscription";
				if (data.balance && data.balance.total !== null && data.balance.total !== undefined) return "balance";
				return null;
			})();
			const planBadge = planKind === null
				? null
				: h("div", {
					style: {
						// 移到卡片右下角（脱离文档流），把整行高度让给余额数字
						position: "absolute",
						right: 6,
						bottom: 3,
						padding: "0 5px",
						border: "0.5px solid " + C.cardBorder,
						borderRadius: 99,
						fontSize: 9,
						lineHeight: "12px",
						color: C.sub,
						whiteSpace: "nowrap",
					},
				}, planKind === "subscription"
					? (lang === "zh" ? "订阅卡" : "Subscription")
					: (lang === "zh" ? "余额" : "Balance"));

			const sideColumn = h("div", {
				title: statsTip,
				style: {
					display: "flex",
					flexDirection: "column",
					alignItems: "flex-start",
					gap: 0,
					minWidth: 0,
					flex: "0 0 auto",
					fontSize: Math.round(9.5 * cardScale * 10) / 10,
					lineHeight: Math.round(12 * cardScale) + "px",
					color: C.sub,
					fontVariantNumeric: "tabular-nums",
					whiteSpace: "nowrap",
				},
			},
				cycleWindow
					? h("span", null, `${t("stats.used")} ${cycleWindow.percent.toFixed(1)}%`)
					: null,
				statTokens !== null
					? h("span", null, `${t("stats.tokensShort")} ${formatTokens(statTokens, lang)}`)
					: null,
				statCalls !== null
					? h("span", null, `${t("stats.callsShort")} ${statCalls}`)
					: null,
				subDays !== null
					? h("span", null, lang === "zh" ? `剩 ${subDays} 天` : `${subDays}d left`)
					: null);

			const balanceRow = h("div", {
				ref: balanceRowRef,
				style: {
					display: "flex",
					// 余额尽量靠左（左边只留 4px），垂直方向吃掉剩余高度居中；
					// 右边 26px 让位给加号/刷新两枚按钮。
					alignItems: "center",
					justifyContent: "flex-start",
					flex: "1 1 auto",
					minHeight: 42,
					minWidth: 0,
					gap: 5,
					paddingLeft: 4,
					paddingRight: 26,
				},
			},
				h("span", { style: leadStyle }, symbol),
				h("span", {
					// 右键金额数字 → 调字号（标记给卡片的统一分流用）
					"data-usage-amount": "1",
					onContextMenu: (e) => {
						e.preventDefault();
						e.stopPropagation();
						openAmountMenuAt(e.currentTarget.getBoundingClientRect());
					},
					style: { display: "flex", alignItems: "center", minWidth: 0 },
				}, h(AmountText, { style: amountStyle, text: amount })),
				sideColumn);

			// 订阅用量：每个窗口一个开口朝下的 D 形仪表盘。绿色弧是尚未使用的额度，
			// 灰色弧是已经用掉的部分；剩余额度在已用 ≥ 80% 时变红。周期缩写徽章嵌在
			// 底部缺口里，省掉单独一行标签。仪表盘按数量均分卡片宽度，竖向居中。
			const GAUGE = 45;
			const GAUGE_STROKE = 4;
			const GAUGE_RADIUS = (GAUGE - GAUGE_STROKE) / 2;
			const GAUGE_CIRC = 2 * Math.PI * GAUGE_RADIUS;
			// 保留底部 140° 的缺口放周期徽章；弧从缺口左端（160°）顺时针扫 220°。
			const GAUGE_SWEEP = 220 / 360;
			const GAUGE_ARC = GAUGE_CIRC * GAUGE_SWEEP;
			const GAUGE_START = 160;
			// 右上角指示灯占位：固定 16px。指示灯是否渲染取决于宿主有没有给计费区间
			// （数据加载前后、不同模型之间都会变），但让位宽度必须恒定，否则三个仪表盘
			// 会随指示灯的显隐左右移动、间距也变——这里始终保留 16px。
			const scheduleInset = 16;
			const usageGrid = h("div", {
				style: {
					display: "grid",
					gridTemplateColumns: "repeat(" + Math.max(1, usageRows.length) + ", minmax(0, 1fr))",
					justifyItems: "center",
					alignItems: "start",
					minWidth: 0,
					boxSizing: "border-box",
					paddingRight: scheduleInset,
				},
			}, usageRows.map((w) => {
				const hint = windowHint(w, t, lang);
				const ratio = usageRatio(w.percent);
				const usedLength = GAUGE_ARC * ratio;
				const restLength = GAUGE_ARC - usedLength;
				return h("div", {
					key: w.key,
					style: { position: "relative", width: GAUGE, height: GAUGE, flex: "none" },
					title: hint,
					role: "img",
					"aria-label": hint,
				},
					h("svg", {
						width: GAUGE,
						height: GAUGE,
						viewBox: "0 0 " + GAUGE + " " + GAUGE,
						style: { display: "block" },
						"aria-hidden": "true",
					},
						// 未使用（默认绿色；已用 ≥ 80% 时变红）：从已用部分的末端开始，
						// 画满剩余弧长。颜色写在 style 里：color-mix() 在 presentation
						// attribute 上的支持不如 CSS 属性稳妥。
						h("circle", {
							cx: GAUGE / 2,
							cy: GAUGE / 2,
							r: GAUGE_RADIUS,
							fill: "none",
							style: { stroke: remainingColor(w.percent) },
							strokeWidth: GAUGE_STROKE,
							strokeLinecap: ratio < 1 ? "round" : "butt",
							strokeDasharray: restLength + " " + GAUGE_CIRC,
							transform: "rotate(" + (GAUGE_START + 220 * ratio) + " " + GAUGE / 2 + " " + GAUGE / 2 + ")",
						}),
						// 已使用（灰色）：从起点顺时针覆盖已用比例。
						h("circle", {
							cx: GAUGE / 2,
							cy: GAUGE / 2,
							r: GAUGE_RADIUS,
							fill: "none",
							stroke: C.sub,
							strokeWidth: GAUGE_STROKE,
							// 0% 时用平头，否则圆头会在弧的起点画出一个"已经用了一点"的圆点。
							strokeLinecap: ratio > 0 ? "round" : "butt",
							strokeDasharray: usedLength + " " + GAUGE_CIRC,
							transform: "rotate(" + GAUGE_START + " " + GAUGE / 2 + " " + GAUGE / 2 + ")",
						})),
					// 弧内偏上的数字是「剩余量」而不是已用量（绿色/红色弧表示的也是剩余），
					// 去掉百分号、字号加大；完整的已用/剩余百分比与重置时间在悬浮说明里。
					// 用 HTML 而不是 SVG text，字体、字重与卡片其余数字完全一致。
					h("span", {
						style: {
							position: "absolute",
							inset: 0,
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							paddingBottom: 10,
							fontSize: 15,
							lineHeight: "15px",
							fontWeight: 700,
							color: C.label,
							fontVariantNumeric: "tabular-nums",
						},
					}, String(Math.round(Math.max(0, Math.min(100, 100 - w.percent))))),
					// 周期徽章：嵌在弧的底部缺口里，贴近弧端，减少中间的空档。
					// 底色与卡片一致，遮住徽章底下可能露出的弧端。
					h("span", {
						style: {
							position: "absolute",
							left: "50%",
							bottom: 5,
							transform: "translateX(-50%)",
							boxSizing: "border-box",
							maxWidth: "100%",
							padding: "0 4px",
							border: "1px solid " + C.track,
							borderRadius: 99,
							background: C.bg,
							fontSize: 10,
							lineHeight: "12px",
							fontWeight: 600,
							color: C.sub,
							whiteSpace: "nowrap",
							overflow: "hidden",
							textOverflow: "ellipsis",
						},
					}, windowBadge(w.key)));
			}));

			// 走到这里说明还没有任何读数：要么接口报错（blanked 分支已在上面返回红卡），
			// 要么根本没配好（无 provider / 无密钥）。画一张空卡只会显示 "undefined"，
			// 所以直接返回 null；但**失败卡已覆盖了全部错误路径**，用户仍能右键切走。

			return h("div", {
				// 侧栏 dock 插件（dsh-sidebar-dock）靠这个标记认出"这是用量看板"，
				// 好把它排成横跨三格；没有 dock 插件时这个属性没有任何副作用。
				"data-dock": "usage",
				ref: (el) => registerBlockNode("card", el),
				onContextMenu: (e) => {
					// 双保险：即使金额 span 自己的 handler 没生效，这里也能识别
					const hit = e.target && typeof e.target.closest === "function"
						? e.target.closest('[data-usage-amount="1"]')
						: null;
					if (hit !== null) {
						e.preventDefault();
						e.stopPropagation();
						openAmountMenuAt(hit.getBoundingClientRect());
						return;
					}
					openMenu(e);
				},
				role: "button",
				tabIndex: 0,
				"aria-label": t("card.label"),
				// 这一次没拿到新数：数字留着（压暗一点），原因挂在悬浮说明上。
				title: staleWithReading ? errs.join("\n") : undefined,
				style: {
					position: "relative",
					boxSizing: "border-box",
					// 不再用 flex-grow 抢底栏高度（和桌面区一起抢会把看板压扁），
					// 改为按自身高度固定 + 显式占满宽度。
					flex: "0 0 auto",
					// 左边界右移 10px（给窄条让位），展开时整体右移、左侧留出同样宽的一条缝隙
					width: "calc(100% - 7px)",
					marginLeft: 7,
					transform: drawerOpen ? "translateX(calc(100% - 10px))" : "none",
					pointerEvents: drawerOpen ? "none" : "auto",
					transition: "transform .18s ease",
					minWidth: 0,
					// 两种卡片同高（80px）。订阅卡的上内边距比下内边距多 9px，
					// 让仪表盘（弧 + 底部徽章）的视觉重心落在卡片中线上；余额卡上下各 6px。
					padding: usageRows.length > 0 ? "13px 10px 5px" : "7px 10px 3px",
					minHeight: cardHeight,
					borderRadius: 10,
					border: "0.5px solid " + C.cardBorder,
					background: C.bg,
					color: C.label,
					cursor: "pointer",
					userSelect: "none",
					overflow: "hidden",
					display: "flex",
					flexDirection: "column",
					justifyContent: "center",
					gap: 2,
					marginTop: 4,
					position: "relative",
					fontSize: "12px",
					lineHeight: "15px",
				},
				onClick: onCardClick,
				onKeyDown: (e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						onCardClick();
					}
				},
			},
				// 融合子面板：进度汇报（dsh-progress-reminder）的读数与开关。
				// 放在卡片内、加号的竖直中线之上——那插件自己的侧栏入口已关掉，
				// 这里是它唯一的面板，卡片因此变成「余额 + 进度」两行。
				// 子面板的余额行直接用父插件这张卡片的读数（同一个 provider、同一次取数），
				// 不再走提醒插件自己那套 DeepSeek 官方余额——两边币种/口径本来就不同。
				h(NudgeBoundary, null, h(NudgeStrip, {
					t,
					lang,
					symbol,
					amount,
					cyclePercent: cycleWindow ? cycleWindow.percent : null,
					onRefresh: load,
				})),
				// 右侧居中的加号：在这里直接添加提供商（弹窗表单，写完配置卡片即可切换过去）。
				h("button", {
					type: "button",
					title: t("add.open"),
					"aria-label": t("add.open"),
					onClick: (e) => {
						e.stopPropagation();
						setAdding(true);
					},
					onContextMenu: (e) => e.stopPropagation(),
					onMouseDown: (e) => e.stopPropagation(),
					style: {
						position: "absolute",
						top: -1,
						// 圆心对齐右上角圆角（半径 10）：22px 按钮取 -1，中心正好落在圆的圆心
						right: -1,

						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						width: 22,
						height: 22,
						padding: 0,
						border: "none",
						borderRadius: 6,
						background: "transparent",
						color: C.sub,
						cursor: "pointer",
						fontSize: 20,
						fontWeight: 500,
						lineHeight: "22px",
						textAlign: "center",
					},
				}, "+"),
				// 加号正下方的刷新按钮（同尺寸）：手动打一次上游，用于对照中转站后台的调用计数。
				h("button", {
					type: "button",
					title: t("card.refresh"),
					"aria-label": t("card.refresh"),
					onClick: (e) => {
						e.stopPropagation();
						load({ nocache: true }).catch(() => {});
					},
					onContextMenu: (e) => {
						// 右键 = 调自动刷新间隔：面板贴按钮左上展开，并钳在视口内。
						e.preventDefault();
						e.stopPropagation();
						const rect = e.currentTarget.getBoundingClientRect();
						const vw = window.innerWidth;
						const vh = window.innerHeight;
						setRefreshMenu({
							left: Math.max(8, Math.min(rect.right - 208, vw - 216)),
							top: Math.max(8, Math.min(rect.top - 6, vh - 132)),
						});
					},
					onMouseDown: (e) => e.stopPropagation(),
					style: {
						position: "absolute",
						// 依次排在加号正下方（22px 高，无缝隙）
						top: 22,
						// 圆心对齐右上角圆角（半径 10）：22px 按钮取 -1，中心正好落在圆的圆心
						right: -1,

						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						width: 22,
						height: 22,
						padding: 0,
						border: "none",
						borderRadius: 6,
						background: "transparent",
						color: C.sub,
						cursor: "pointer",
					},
				}, h("svg", {
					width: 14,
					height: 14,
					viewBox: "0 0 24 24",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 2,
					strokeLinecap: "round",
					strokeLinejoin: "round",
					"aria-hidden": "true",
				},
					h("path", { d: "M20.5 12a8.5 8.5 0 1 1-2.5-6" }),
					h("path", { d: "M20.5 3.5v5h-5" }))),
				// 账户类型（订阅卡 / 余额）标在金额上方
				// 余额形态画金额行；订阅形态画多窗口行（同一张卡片，不拆成多张）。
				usageRows.length > 0 ? usageGrid : balanceRow,
				// 区间指示灯：两种卡片都叠在同一位置（距卡片顶/右各 8px），
				// 位置只由卡片边框决定，不受金额行/仪表盘行高度影响。
				scheduleDot({ position: "absolute", top: 7, right: 7 }),
				// 单价行：当前档单价，绝对定位在卡片右下角。价格表里没有的模型
				// （known=false）整行不渲染——表外数字与它们的实际账单无关。
				// 订阅制不按 token 计价，即使命中了价格表也不显示单价行。
				// 绝对定位不参与卡片高度计算：金额行因此能在卡片里竖直居中，
				// 底部也不会空出比顶部更多的一截。
				// 用 flex-end 而不是 space-between：容器只有一个子元素时 space-between 会把它
				// 推到最左侧（0.6.0 的回归点）。
				refreshMenu !== null && h(RefreshIntervalMenu, {
					t,
					face,
					anchor: refreshMenu,
					current: refreshSeconds,
					onClose: () => setRefreshMenu(null),
					onSaved: (value) => {
						setRefreshSeconds(clampRefresh(value));
						if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
							window.dispatchEvent(new Event("dsh-usage:config-updated"));
						}
					},
				}),
				adding && h(AddProviderDialog, {
					t,
					face,
					onClose: () => setAdding(false),
					onAdded: (id) => {
						writePresetProvider(id);
						setPreset(id);
					},
				}),
				// 类型标签（订阅卡 / 余额）：绝对定位在右下角
				planBadge,
				// 底部拖拽手柄：鼠标移到卡片下边界显示 ns-resize，按住上下一拉就改高度。
				h("div", {
					title: lang === "zh" ? "拖动调整看板高度" : "Drag to resize",
					onPointerDown: onResizeDown,
					onPointerMove: onResizeMove,
					onPointerUp: onResizeUp,
					onPointerCancel: onResizeUp,
					onClick: (e) => e.stopPropagation(),
					onContextMenu: (e) => e.stopPropagation(),
					onMouseDown: (e) => e.stopPropagation(),
					style: {
						position: "absolute",
						left: 0,
						right: 0,
						bottom: 0,
						height: 9,
						cursor: "ns-resize",
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
					},
				}, h("span", {
					style: { width: 26, height: 3, borderRadius: 2, background: C.track, opacity: 0.85 },
				})),
						amountMenu !== null && h("div", {
					style: {
						position: "fixed",
						left: amountMenu.left,
						top: amountMenu.top,
						zIndex: 2147483000,
						width: 180,
						boxSizing: "border-box",
						padding: 8,
						borderRadius: 8,
						border: "1px solid " + C.cardBorder,
						background: C.bg,
						color: C.label,
						boxShadow: "0 8px 24px rgba(0,0,0,.22)",
						display: "flex",
						flexDirection: "column",
						gap: 6,
						fontSize: 11,
					},
					onClick: (e) => e.stopPropagation(),
					onContextMenu: (e) => { e.preventDefault(); e.stopPropagation(); },
				},
					h("span", { style: { fontWeight: 600 } }, lang === "zh" ? "余额字号" : "Amount font size"),
					h("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
						h("input", {
							type: "range", min: AMOUNT_SIZE_MIN, max: AMOUNT_SIZE_MAX, value: amountDraft,
							onChange: (e) => setAmountDraft(e.target.value),
							style: { flex: "1 1 auto", minWidth: 0 },
						}),
						h("input", {
							type: "number", min: AMOUNT_SIZE_MIN, max: AMOUNT_SIZE_MAX, value: amountDraft,
							onChange: (e) => setAmountDraft(e.target.value),
							style: { width: 48, height: 22, borderRadius: 5, border: "1px solid " + C.cardBorder, background: "transparent", color: "inherit", font: "inherit", padding: "0 4px" },
						})),
					h("div", { style: { display: "flex", gap: 6, justifyContent: "flex-end" } },
						h("button", {
							type: "button",
							onClick: () => { setAmountMenu(null); setAmountBase(AMOUNT_SIZE_DEFAULT); writeAmountSize(AMOUNT_SIZE_DEFAULT); },
							style: { height: 22, padding: "0 8px", borderRadius: 6, border: "1px solid " + C.cardBorder, background: "transparent", color: C.sub, font: "inherit", fontSize: 11, cursor: "pointer" },
						}, lang === "zh" ? "重置" : "Reset"),
						h("button", {
							type: "button",
							onClick: () => {
								const next = Math.min(AMOUNT_SIZE_MAX, Math.max(AMOUNT_SIZE_MIN, Math.round(Number(amountDraft) || AMOUNT_SIZE_DEFAULT)));
								setAmountBase(next);
								writeAmountSize(next);
								setAmountMenu(null);
							},
							style: { height: 22, padding: "0 8px", borderRadius: 6, border: "1px solid " + C.cardBorder, background: "transparent", color: C.label, font: "inherit", fontSize: 11, cursor: "pointer" },
						}, lang === "zh" ? "保存" : "Save"))),
				menu !== null && h(ProviderMenu, {
					menu,
					t,
					current: preset !== "" ? preset : (data && typeof data.provider === "string" ? data.provider : ""),
					onChoose: chooseProvider,
					onEdit: editProvider,
					onClose: closeMenu,
				}),
				priced && usageRows.length === 0 && h("span", {
					style: {
						position: "absolute",
						right: 9,
						bottom: 4,
						display: "flex",
						alignItems: "center",
						justifyContent: "flex-end",
						gap: 6,
						minWidth: 0,
					},
					title: priceTooltip(),
				},
					h("span", { style: { display: "inline-flex", alignItems: "center", gap: 5, flex: "none" } },
						Price(h(IconIn, null), tier.input),
						Price(h(IconCache, null), tier.cacheRead),
						Price(h(IconOut, null), tier.output))));

			// 兜底：真的什么都没有（首次加载慢、或宿主没给 provider）时也给一张薄卡，
			// 避免侧栏那一格突然消失、用户找不到入口。点一下就重试。
			if (!hasReading && usageRows.length === 0) {
				return h("div", {
					"data-dock": "usage",
					onContextMenu: openMenu,
					role: "button",
					tabIndex: 0,
					"aria-label": t("card.label"),
					title: errs.length > 0 ? errs.join("\n") : t("status.unavailable"),
					onClick: onCardClick,
					style: {
						position: "relative",
						boxSizing: "border-box",
						flex: "0 0 auto",
						width: "calc(100% - 7px)",
						marginLeft: 7,
						minHeight: CARD_MIN_HEIGHT,
						padding: "8px 10px",
						borderRadius: 10,
						border: "0.5px solid " + C.cardBorder,
						background: C.bg,
						color: C.err,
						display: "flex",
						alignItems: "center",
						fontSize: 12,
						lineHeight: "16px",
						cursor: "pointer",
						userSelect: "none",
					},
				},
					errs.length > 0 ? errs.join(" | ") : t("status.unavailable"),
					menu !== null && h(ProviderMenu, {
						menu,
						t,
						current: preset !== "" ? preset : (data && typeof data.provider === "string" ? data.provider : ""),
						onChoose: chooseProvider,
						onEdit: editProvider,
						onClose: closeMenu,
					}));
			}
		}

		// ---- 设置页：OAuth 订阅令牌 --------------------------------------
		// 渲染在设置面板「DeepSeek 用量」页里，紧跟在「提供商映射」编辑器之后。
		// 内容来自宿主的 GET /api/deepseek-usage/accounts：这个 DSH 检测到，或有映射目标
		// 指向 Claude Code / Codex 时才有对应条目；令牌经 POST /token 写入凭证服务，
		// 响应里永不回传，因此这里只显示"已填写 / 未填写"。
		const ACCOUNTS_PATH = "/api/deepseek-usage/accounts";
		const TOKEN_PATH = "/api/deepseek-usage/token";
		/**
		 * OAuth 提供商的令牌来源说明 key（token.source.<key>）。
		 * 按 provider 路由 id 映射：接口返回的是 `anthropic` / `openai-codex`，
		 * 词典里按刻意的短名命名（claude / codex）。`chatgpt-codex` 是第三方
		 * Codex 插件注册同一家订阅接口时用的路由 id，指向同一份令牌说明。
		 */
		const TOKEN_SOURCE_KEYS = { anthropic: "claude", "openai-codex": "codex", "chatgpt-codex": "codex" };

		function OAuthTokenSection(props) {
			const t = props.t;
			// null = 还在读；[] = 没有检测到 OAuth 路由（整块不渲染）；
			// failed = 宿主路由读不到（给出说明，而不是静默消失）。
			const [providers, setProviders] = useState(null);
			const [failed, setFailed] = useState(false);
			const [draft, setDraft] = useState({});
			const [accountDraft, setAccountDraft] = useState({});
			const [saving, setSaving] = useState("");
			const [notice, setNotice] = useState("");
			const mountedRef = useRef(true);

			useEffect(() => () => { mountedRef.current = false; }, []);

			const load = useCallback(async () => {
				try {
					const res = await fetch(ACCOUNTS_PATH, { cache: "no-store" });
					let body = null;
					try { body = await res.json(); } catch (e) { body = null; }
					if (!mountedRef.current) return;
					if (!res.ok || !body || body.ok !== true) {
						setFailed(true);
						return;
					}
					setFailed(false);
					setProviders(Array.isArray(body.oauth) ? body.oauth : []);
				} catch (e) {
					if (mountedRef.current) setFailed(true);
				}
			}, []);

			useEffect(() => { load().catch(() => {}); }, [load]);

			// 映射保存后宿主会把目标 OAuth 提供商带进 /accounts 的 oauth 列表：
			// 收到配置更新事件就重读，令牌框随即出现（或随映射删除而消失）。
			useEffect(() => {
				if (typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined;
				const onConfig = () => { load().catch(() => {}); };
				window.addEventListener("dsh-usage:config-updated", onConfig);
				return () => window.removeEventListener("dsh-usage:config-updated", onConfig);
			}, [load]);

			// 令牌保存/清除。`override` 用于清除：那时草稿还没清空，不能读 state
			// （setState 是异步的，读到的仍是旧值）。
			const submitToken = useCallback(async (provider, override) => {
				const token = override !== undefined ? override : (draft[provider] ?? "").trim();
				setSaving(provider);
				try {
					const payload = { provider, token };
					// Codex 的账号 ID 与令牌一并提交（缺了它上游可能拒绝请求）；
					// 清除时不带，宿主会连带 unset。
					const accountId = (accountDraft[provider] ?? "").trim();
					if (token !== "" && accountId !== "") payload.accountId = accountId;
					const res = await fetch(TOKEN_PATH, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(payload),
					});
					let body = null;
					try { body = await res.json(); } catch (e) { body = null; }
					if (!mountedRef.current) return;
					if (!res.ok || !body || body.ok !== true) {
						setNotice(t("token.failed"));
						return;
					}
					setNotice(body.configured ? t("token.saved") : t("token.cleared"));
					setDraft((d) => ({ ...d, [provider]: "" }));
					if (!body.configured) setAccountDraft((d) => ({ ...d, [provider]: "" }));
					await load();
				} catch (e) {
					if (mountedRef.current) setNotice(t("token.failed"));
				} finally {
					if (mountedRef.current) setSaving("");
				}
			}, [draft, accountDraft, t, load]);

			const hintStyle = {
				margin: 0,
				fontSize: 12,
				lineHeight: "18px",
				color: "var(--dsw-alias-label-tertiary, rgba(0,0,0,.45))",
			};
			const tagStyle = {
				flex: "none",
				borderRadius: "var(--dsw-radius-xs, 4px)",
				border: "1px solid var(--dsw-alias-border-l3, rgba(127,127,127,.35))",
				color: "var(--dsw-alias-label-secondary, rgba(0,0,0,.55))",
				padding: "0 4px",
				fontSize: 10,
				lineHeight: "14px",
			};
			const buttonStyle = {
				boxSizing: "border-box",
				borderRadius: "var(--dsw-radius-md, 6px)",
				border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.35))",
				background: "transparent",
				color: "inherit",
				font: "inherit",
				fontSize: 12,
				height: 26,
				padding: "0 10px",
				cursor: "pointer",
			};
			const inputStyle = {
				boxSizing: "border-box",
				width: "100%",
				minWidth: 0,
				borderRadius: "var(--dsw-radius-md, 6px)",
				border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.35))",
				background: "transparent",
				color: "inherit",
				font: "inherit",
				fontSize: 12,
				padding: "4px 8px",
			};
			const cardNameStyle = {
				fontWeight: 500,
				fontSize: 12,
				lineHeight: "16px",
				minWidth: 0,
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap",
			};

			// 没有检测到 OAuth 路由时没有可填的东西：整块不出现。
			if (!failed && (providers === null || providers.length === 0)) return null;

			return h("div", { style: { display: "flex", flexDirection: "column", gap: 10 } },
				h("h3", { style: { margin: 0, fontSize: 15, fontWeight: 600, lineHeight: "22px" } }, t("token.title")),
				h("p", { style: hintStyle }, t("token.intro")),
				failed
					? h("p", { style: hintStyle }, t("token.unavailable"))
					: null,
				notice ? h("p", { style: hintStyle }, notice) : null,
				providers === null || failed
					? null
					: providers.map((item) => {
						const sourceKey = TOKEN_SOURCE_KEYS[item.id] ?? item.id;
						return h("div", {
							key: item.id,
							style: {
								display: "flex",
								flexDirection: "column",
								gap: 6,
								padding: 10,
								borderRadius: "var(--dsw-radius-md, 6px)",
								border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.35))",
								background: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06))",
							},
						},
							h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
								h("span", { style: cardNameStyle }, item.displayName || item.id),
								h("span", { style: { ...tagStyle, marginLeft: "auto" } },
									item.configured ? t("token.configured") : t("token.missing")),
							),
							h("p", { style: hintStyle }, t("token.source." + sourceKey)),
							h("textarea", {
								style: { ...inputStyle, minHeight: 52, resize: "vertical", fontFamily: "inherit" },
								placeholder: t("token.placeholder"),
								value: draft[item.id] ?? "",
								onChange: (e) => setDraft((d) => ({ ...d, [item.id]: e.target.value })),
							}),
							item.id === "openai-codex"
								? h("input", {
									type: "text",
									style: inputStyle,
									placeholder: t("token.accountPlaceholder"),
									value: accountDraft[item.id] ?? "",
									onChange: (e) => setAccountDraft((d) => ({ ...d, [item.id]: e.target.value })),
								})
								: null,
							h("div", { style: { display: "flex", gap: 8 } },
								h("button", {
									type: "button",
									style: buttonStyle,
									disabled: saving === item.id,
									onClick: () => submitToken(item.id).catch(() => {}),
								}, t("token.save")),
								h("button", {
									type: "button",
									style: buttonStyle,
									disabled: saving === item.id,
									onClick: () => submitToken(item.id, "").catch(() => {}),
								}, t("token.clear")),
							),
						);
					}),
			);
		}

		// ---- 设置页：provider 映射 --------------------------------------
		// 设置面板的「DeepSeek 用量」页（`settings.section`）里只做两件事：把第三方插件
		// 注册的 provider id 映射到本插件支持的提供商，以及填写 OAuth 订阅令牌。
		// 不猜名字、不猜端点。映射保存写回 profile 里本插件条目的 config。
		const REF_TOKEN = /^[A-Za-z_][A-Za-z0-9_]*$/;

		/** 配置值 → 草稿行（refs 在界面上是一行逗号分隔的文本）。 */
		function aliasDraftOf(value) {
			const rows = value && Array.isArray(value.providerAliases) ? value.providerAliases : [];
			return rows.map((row) => ({
				provider: row && typeof row.provider === "string" ? row.provider : "",
				capability: row && typeof row.capability === "string" ? row.capability : "",
				refsText: row && Array.isArray(row.refs) ? row.refs.join(", ") : "",
			}));
		}

		/** 一行文本 → 凭据引用数组（非法 token 直接丢弃，与宿主侧的校验一致）。 */
		function parseRefs(text) {
			return String(text || "")
				.split(/[\s,]+/)
				.map((ref) => ref.trim())
				.filter((ref) => REF_TOKEN.test(ref));
		}

		/** 设置页的映射列表 + 添加/删除 + 保存。 */
		// ---- 设置页：模型提供商账户 --------------------------------------
		// 已保存的项只占一行摘要（provider + 查询口径），点「编辑」才展开表单；
		// 新增与编辑共用同一入口，页面里不再并排两套列表 —— 控件少一半。
		const CUSTOM_PRESET_OPTIONS = ["newapi", "newapi-account", "openai-billing", "deepseek-balance", "jichuanai", "json"];
		const CUSTOM_KIND_OPTIONS = ["balance", "usage"];
		const presetLabelKey = (id) => (id === "openai-billing"
			? "custom.preset.openaiBilling"
			: id === "deepseek-balance" ? "custom.preset.deepseek"
				: id === "jichuanai" ? "custom.preset.jichuanai" : "custom.preset." + id);

		/** 配置值 → 自定义 provider 草稿行。 */
		function customDraftOf(value) {
			const rows = value && Array.isArray(value.customProviders) ? value.customProviders : [];
			const text = (input) => (typeof input === "string" ? input : "");
			return rows.map((row) => ({
				provider: text(row && row.provider),
				baseUrl: text(row && row.baseUrl),
				preset: text(row && row.preset) || "newapi",
				kind: text(row && row.kind) || "balance",
				apiKeyRef: text(row && row.apiKeyRef),
				currency: text(row && row.currency),
				quota: row && row.quota !== undefined && row.quota !== null ? String(row.quota) : "",
				// 账户类型与"余额组"路径：切换余额/订阅卡时两套路径互不覆盖。
				accountType: text(row && row.accountType) || "auto",
				balancePath: text(row && row.balancePath),
				balanceTotalPath: text(row && row.balanceTotalPath),
				expiresPath: text(row && row.expiresPath),
				totalPath: text(row && row.totalPath),
				usedPath: text(row && row.usedPath),
				// 表单只画这几个字段；其余字段（label/pricing/scale/path…）原样带着走，
				// 保存时合并回去，避免编辑一次就把没露面的配置抹掉。
				extra: row && typeof row === "object" ? row : {},
			}));
		}

		const emptyAliasRow = () => ({ provider: "", capability: "", refsText: "" });
		const emptyCustomRow = () => ({
			provider: "",
			baseUrl: "",
			preset: "newapi",
			kind: "balance",
			apiKeyRef: "",
			currency: "CNY",
			quota: "",
			extra: {},
		});

		/** 设置页唯一的提供商区块：账户摘要列表 + 一个添加入口 + 就地编辑。 */
		function ProvidersSettings(props) {
			const t = props.t;
			const form = props.form;
			const state = form && form.state ? form.state : null;
			const revision = state ? state.revision : undefined;
			const status = state ? state.status : undefined;
			const [meta, setMeta] = useState(null);
			const [aliases, setAliases] = useState(() => aliasDraftOf(state && state.value));
			const [customs, setCustoms] = useState(() => customDraftOf(state && state.value));
			// 正在编辑的行：index < 0 表示新增（此时 type 可以在编辑器里切换）。
			const [editing, setEditing] = useState(null);
			const [problem, setProblem] = useState("");
			const [notice, setNotice] = useState("");
			const [saving, setSaving] = useState(false);
			const mountedRef = useRef(true);
			const focusId = useProviderFocus();
			// 看板当前显示的是哪一家（localStorage 里的选择，和卡片右键菜单同一份）。
			// 设置页必须能看见它：不然"看板没数字"时用户不知道卡片到底在查谁。
			const [watching, setWatching] = useState(() => readPresetProvider());
			useEffect(() => {
				const onPreset = () => setWatching(readPresetProvider());
				window.addEventListener(PRESET_EVENT, onPreset);
				window.addEventListener("storage", onPreset);
				return () => {
					window.removeEventListener(PRESET_EVENT, onPreset);
					window.removeEventListener("storage", onPreset);
				};
			}, []);

			useEffect(() => () => { mountedRef.current = false; }, []);

			// 配置更新（保存成功或在别处改过）时以配置为准重置，并收起编辑区。
			useEffect(() => {
				setAliases(aliasDraftOf(state && state.value));
				setCustoms(customDraftOf(state && state.value));
				setEditing(null);
				setProblem("");
			}, [revision, status]);

			// 能力表选项与「检测到但未识别」的候选都来自 /accounts（宿主只读本地状态）。
			useEffect(() => {
				let alive = true;
				fetch(ACCOUNTS_PATH, { cache: "no-store" })
					.then(async (res) => {
						let body = null;
						try { body = await res.json(); } catch (e) { body = null; }
						if (!alive || !res.ok || !body || body.ok !== true) return;
						setMeta({
							aliasable: Array.isArray(body.aliasable) ? body.aliasable : [],
							unmapped: Array.isArray(body.unmapped) ? body.unmapped : [],
						});
					})
					.catch(() => { /* 候选拿不到时仍可手填 */ });
				return () => { alive = false; };
			}, []);

			const aliasable = meta && Array.isArray(meta.aliasable) ? meta.aliasable : [];
			const aliasableIds = new Set(aliasable.map((item) => item.id));
			const readonly = state !== null && state.writable === false;
			const disabled = readonly || saving;

			const labelOf = (id) => {
				const hit = aliasable.find((item) => item.id === id);
				return hit && hit.displayName && hit.displayName !== hit.id ? hit.displayName + " (" + hit.id + ")" : id;
			};
			const kindOf = (id) => {
				const hit = aliasable.find((item) => item.id === id);
				return hit ? hit.kind : "";
			};

			/** 两份列表一次写回：一个 mutate 两个字段，避免半保存状态。 */
			const persist = async (nextAliases, nextCustoms) => {
				if (form === undefined) return false;
				setSaving(true);
				try {
					const aliasValue = nextAliases.map((row) => ({
						provider: String(row.provider).trim(),
						capability: row.capability,
						// OAuth 目标的令牌在「订阅令牌」区写入凭据服务，映射里不存引用。
						refs: kindOf(row.capability) === "oauth" ? [] : parseRefs(row.refsText),
					}));
					const customValue = nextCustoms.map((row) => {
						const base = row && typeof row.extra === "object" && row.extra !== null ? { ...row.extra } : {};
						delete base.extra;
						const out = {
							...base,
							provider: String(row.provider).trim(),
							baseUrl: String(row.baseUrl).trim(),
							preset: row.preset,
							kind: row.kind,
						};
						// 空字符串等于"这一项没配"：别把上游老值替换成空串，直接删掉键。
						const put = (key, value) => {
							if (value === "") delete out[key];
							else out[key] = value;
						};
						put("apiKeyRef", String(row.apiKeyRef).trim());
						put("currency", String(row.currency).trim());
						put("quota", String(row.quota).trim());
						put("accountType", String(row.accountType || "auto").trim());
						put("balancePath", String(row.balancePath || "").trim());
						put("balanceTotalPath", String(row.balanceTotalPath || "").trim());
						put("expiresPath", String(row.expiresPath || "").trim());
						put("totalPath", String(row.totalPath || "").trim());
						put("usedPath", String(row.usedPath || "").trim());
						return out;
					});
					const ok = await form.mutate([
						{ op: "set", path: ["providerAliases"], value: aliasValue },
						{ op: "set", path: ["customProviders"], value: customValue },
					]);
					if (mountedRef.current) setNotice(ok ? t("providers.saved") : t("providers.saveFailed"));
					// 让侧边栏卡片立即按新配置重取一次（volatile 配置就地更新，不重启宿主）。
					if (ok && typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
						window.dispatchEvent(new Event("dsh-usage:config-updated"));
					}
					return ok;
				} catch (e) {
					if (mountedRef.current) setNotice(t("providers.saveFailed"));
					return false;
				} finally {
					if (mountedRef.current) setSaving(false);
				}
			};

			/** 单行校验：空 id / 与另一行重名 / 已内置 / 缺目标 / 地址非法。 */
			const check = (type, index, row) => {
				const provider = String(row.provider || "").trim();
				const key = provider.toLowerCase();
				if (provider === "") return t("alias.providerRequired");
				const taken = [];
				aliases.forEach((item, i) => {
					if (!(type === "alias" && i === index)) taken.push(String(item.provider).trim().toLowerCase());
				});
				customs.forEach((item, i) => {
					if (!(type === "custom" && i === index)) taken.push(String(item.provider).trim().toLowerCase());
				});
				if (taken.indexOf(key) !== -1) return t("alias.duplicate");
				if (type === "alias") {
					if (aliasableIds.has(key)) return t("alias.builtin");
					if (String(row.capability || "") === "") return t("alias.capabilityRequired");
					return "";
				}
				if (!/^https?:\/\/\S+/i.test(String(row.baseUrl || "").trim())) return t("custom.baseUrlRequired");
				// 这一格两种填法都接受：引用名（ASNIA_API_KEY）或直接粘贴的明文密钥。
				// 明文会随配置写进 cordis.patch.yml —— 用户明确要求"复制密钥方便"，故不拦。
				return "";
			};

			const startEdit = (type, index, row) => {
				setProblem("");
				setNotice("");
				setEditing({ type, index, row: { ...row } });
			};
			const startNew = (type) => startEdit(type, -1, type === "custom" ? emptyCustomRow() : emptyAliasRow());
			const closeEdit = () => {
				setEditing(null);
				setProblem("");
			};

			const commit = async () => {
				if (editing === null || readonly) return;
				const message = check(editing.type, editing.index, editing.row);
				setProblem(message);
				if (message !== "") return;
				const row = { ...editing.row, provider: String(editing.row.provider).trim() };
				const nextAliases = editing.type === "alias"
					? (editing.index < 0 ? aliases.concat([row]) : aliases.map((item, i) => (i === editing.index ? row : item)))
					: aliases;
				const nextCustoms = editing.type === "custom"
					? (editing.index < 0 ? customs.concat([row]) : customs.map((item, i) => (i === editing.index ? row : item)))
					: customs;
				const ok = await persist(nextAliases, nextCustoms);
				if (!ok || !mountedRef.current) return;
				setAliases(nextAliases);
				setCustoms(nextCustoms);
				setEditing(null);
			};

			const drop = async (type, index) => {
				if (readonly) return;
				const nextAliases = type === "alias" ? aliases.filter((_, i) => i !== index) : aliases;
				const nextCustoms = type === "custom" ? customs.filter((_, i) => i !== index) : customs;
				const ok = await persist(nextAliases, nextCustoms);
				if (!ok || !mountedRef.current) return;
				setAliases(nextAliases);
				setCustoms(nextCustoms);
				if (editing !== null && editing.type === type && editing.index === index) setEditing(null);
			};

			const inputStyle = {
				boxSizing: "border-box",
				minWidth: 0,
				width: "100%",
				borderRadius: "var(--dsw-radius-md, 6px)",
				border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.35))",
				background: "transparent",
				color: "inherit",
				font: "inherit",
				fontSize: 12,
				height: 28,
				padding: "0 8px",
			};
			const buttonStyle = {
				boxSizing: "border-box",
				borderRadius: "var(--dsw-radius-md, 6px)",
				border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.35))",
				background: "transparent",
				color: "inherit",
				font: "inherit",
				fontSize: 12,
				height: 28,
				padding: "0 10px",
				cursor: "pointer",
			};
			const rowStyle = {
				display: "flex",
				flexWrap: "wrap",
				alignItems: "center",
				gap: 8,
				padding: 10,
				borderRadius: "var(--dsw-radius-md, 6px)",
				border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.28))",
				background: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06))",
			};
			const hintStyle = {
				margin: 0,
				fontSize: 12,
				lineHeight: "18px",
				color: "var(--dsw-alias-label-tertiary, rgba(0,0,0,.45))",
			};
			const problemStyle = { margin: 0, fontSize: 11, lineHeight: "16px", color: C.err };
			const mutedStyle = {
				fontSize: 12,
				lineHeight: "16px",
				color: "var(--dsw-alias-label-tertiary, rgba(0,0,0,.45))",
				minWidth: 0,
			};
			const fieldStyle = { display: "flex", flexDirection: "column", gap: 3, minWidth: 0, flex: "1 1 180px" };
			const captionStyle = { fontSize: 11, lineHeight: "14px", color: "var(--dsw-alias-label-tertiary, rgba(0,0,0,.45))" };
			const field = (label, node) => h("div", { style: fieldStyle },
				h("span", { style: captionStyle }, label),
				node);

			const editor = () => {
				if (editing === null) return null;
				const row = editing.row;
				const patch = (next) => setEditing({ ...editing, row: { ...editing.row, ...next } });
				const isNew = editing.index < 0;
				const fields = [];
				if (isNew) {
					fields.push(field(t("providers.type"), h("select", {
						style: inputStyle,
						"aria-label": t("providers.type"),
						value: editing.type,
						disabled,
						onChange: (e) => startNew(e.target.value),
					},
						h("option", { value: "alias" }, t("providers.typeAlias")),
						h("option", { value: "custom" }, t("providers.typeCustom")),
					)));
				}
				fields.push(field(t("alias.provider"), h("input", {
					type: "text",
					style: inputStyle,
					placeholder: t("alias.providerPlaceholder"),
					"aria-label": t("alias.provider"),
					value: row.provider,
					disabled,
					onChange: (e) => patch({ provider: e.target.value }),
				})));
				if (editing.type === "alias") {
					fields.push(field(t("alias.capability"), h("select", {
						style: inputStyle,
						"aria-label": t("alias.capability"),
						value: row.capability,
						disabled,
						onChange: (e) => patch({ capability: e.target.value }),
					},
						h("option", { value: "" }, t("alias.capabilityPlaceholder")),
						// 配置里已有的目标即使不在选项里也要显示，不能把值悄悄丢掉。
						(row.capability !== "" && !aliasableIds.has(row.capability)
							? [h("option", { key: row.capability, value: row.capability }, row.capability)]
							: []),
						aliasable.map((item) => h("option", { key: item.id, value: item.id }, labelOf(item.id))),
					)));
					fields.push(kindOf(row.capability) === "oauth"
						? h("p", { style: { ...hintStyle, flex: "1 1 220px" } }, t("alias.oauthHint"))
						: field(t("alias.refs"), h("input", {
							type: "text",
							style: inputStyle,
							placeholder: t("alias.refsHint"),
							"aria-label": t("alias.refs"),
							value: row.refsText,
							disabled,
							onChange: (e) => patch({ refsText: e.target.value }),
						})));
				} else {
					fields.push(field(t("custom.baseUrl"), h("input", {
						type: "text",
						style: inputStyle,
						placeholder: "https://relay.example.com",
						"aria-label": t("custom.baseUrl"),
						value: row.baseUrl,
						disabled,
						onChange: (e) => patch({ baseUrl: e.target.value }),
					})));
					fields.push(field(t("custom.preset"), h("select", {
						style: inputStyle,
						"aria-label": t("custom.preset"),
						value: row.preset,
						disabled,
						onChange: (e) => patch({ preset: e.target.value }),
					}, CUSTOM_PRESET_OPTIONS.map((id) => h("option", { key: id, value: id }, t(presetLabelKey(id)))))));
					fields.push(field(t("custom.kind"), h("select", {
						style: inputStyle,
						"aria-label": t("custom.kind"),
						value: row.kind,
						disabled,
						onChange: (e) => patch({ kind: e.target.value }),
					}, CUSTOM_KIND_OPTIONS.map((id) => h("option", { key: id, value: id }, t("custom.kind." + id))))));
					fields.push(field(t("custom.accountType"), h("select", {
						style: inputStyle,
						"aria-label": t("custom.accountType"),
						value: row.accountType || "auto",
						disabled,
						onChange: (e) => patch({ accountType: e.target.value }),
					},
						h("option", { value: "auto" }, t("custom.accountType.auto")),
						h("option", { value: "balance" }, t("custom.accountType.balance")),
						h("option", { value: "subscription" }, t("custom.accountType.subscription")))));
					fields.push(field(t("custom.subPath"), h("input", {
						type: "text", style: inputStyle, placeholder: "/api/v1/subscriptions",
						"aria-label": t("custom.subPath"),
						value: row.path || "", disabled,
						onChange: (e) => patch({ path: e.target.value }),
					})));
					fields.push(field(t("custom.subTotalPath"), h("input", {
						type: "text", style: inputStyle, placeholder: "data.0.group.weekly_limit_usd",
						"aria-label": t("custom.subTotalPath"),
						value: row.totalPath || "", disabled,
						onChange: (e) => patch({ totalPath: e.target.value }),
					})));
					fields.push(field(t("custom.subUsedPath"), h("input", {
						type: "text", style: inputStyle, placeholder: "data.0.weekly_usage_usd（可留空）",
						"aria-label": t("custom.subUsedPath"),
						value: row.usedPath || "", disabled,
						onChange: (e) => patch({ usedPath: e.target.value }),
					})));
					fields.push(field(t("custom.subExpiresPath"), h("input", {
						type: "text", style: inputStyle, placeholder: "data.0.expires_at（可留空）",
						"aria-label": t("custom.subExpiresPath"),
						value: row.expiresPath || "", disabled,
						onChange: (e) => patch({ expiresPath: e.target.value }),
					})));
					fields.push(field(t("custom.balancePath"), h("input", {
						type: "text", style: inputStyle, placeholder: "/api/v1/user/profile",
						"aria-label": t("custom.balancePath"),
						value: row.balancePath || "", disabled,
						onChange: (e) => patch({ balancePath: e.target.value }),
					})));
					fields.push(field(t("custom.balanceTotalPath"), h("input", {
						type: "text", style: inputStyle, placeholder: "data.balance",
						"aria-label": t("custom.balanceTotalPath"),
						value: row.balanceTotalPath || "", disabled,
						onChange: (e) => patch({ balanceTotalPath: e.target.value }),
					})));
					fields.push(field(t("custom.apiKeyRef"), h("input", {
						type: "text",
						style: inputStyle,
						placeholder: "ASNIA_API_KEY",
						"aria-label": t("custom.apiKeyRef"),
						value: row.apiKeyRef,
						disabled,
						onChange: (e) => patch({ apiKeyRef: e.target.value }),
					})));
					fields.push(field(t("custom.currency"), h("input", {
						type: "text",
						style: inputStyle,
						placeholder: "CNY",
						"aria-label": t("custom.currency"),
						value: row.currency,
						disabled,
						onChange: (e) => patch({ currency: e.target.value }),
					})));
					fields.push(field(t("custom.quota"), h("input", {
						type: "text",
						style: inputStyle,
						placeholder: t("custom.quotaHint"),
						"aria-label": t("custom.quota"),
						value: row.quota,
						disabled,
						onChange: (e) => patch({ quota: e.target.value }),
					})));
				}
				return h("div", {
					style: {
						display: "flex",
						flexDirection: "column",
						gap: 8,
						padding: 10,
						borderRadius: "var(--dsw-radius-md, 6px)",
						border: "1px dashed var(--dsw-alias-border-l1, rgba(127,127,127,.42))",
						background: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,.04))",
					},
				},
					h("div", { style: { display: "flex", flexWrap: "wrap", gap: 8 } }, fields),
					editing.type === "custom" ? h("p", { style: hintStyle }, t("custom.rawJsonHint")) : null,
					editing.type === "custom" ? h("p", { style: hintStyle }, t("custom.apiKeyRefHint")) : null,
					problem !== "" ? h("p", { style: problemStyle }, problem) : null,
					h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
						h("button", {
							type: "button",
							style: { ...buttonStyle, fontWeight: 600 },
							disabled,
							onClick: () => { commit().catch(() => {}); },
						}, saving ? t("custom.saving") : t("alias.save")),
						h("button", {
							type: "button",
							style: buttonStyle,
							disabled: saving,
							onClick: closeEdit,
						}, t("add.cancel"))));
			};

			/** 摘要里的一句话：映射写目标提供商，自定义 URL 写地址 / 接口 / 币种 / 额度。 */
			const summaryOf = (type, row) => {
				if (type === "alias") {
					return row.capability === "" ? t("alias.capabilityPlaceholder") : t("alias.capability") + " · " + labelOf(row.capability);
				}
				const typeLabel = row.accountType === "balance"
					? t("custom.accountType.balance")
					: row.accountType === "subscription" ? t("custom.accountType.subscription") : t("custom.accountType.auto");
				const bits = [typeLabel, String(row.baseUrl || "").trim()];
				if (row.preset) bits.push(t(presetLabelKey(row.preset)));
				if (String(row.currency || "").trim() !== "") bits.push(String(row.currency).trim());
				if (String(row.quota || "").trim() !== "") bits.push("≤ " + String(row.quota).trim());
				return bits.join(" · ");
			};

			const rowView = (type, row, index) => {
				const provider = String(row.provider || "").trim();
				const open = editing !== null && editing.type === type && editing.index === index;
				return h("div", {
					key: type + ":" + index,
					id: "dsh-usage-provider-" + provider.toLowerCase(),
					style: { ...rowStyleOf(rowStyle, provider, open ? provider : focusId), display: "flex", flexDirection: "column", gap: 8 },
				},
					h("div", { style: { display: "flex", alignItems: "center", gap: 8, minWidth: 0, flexWrap: "wrap" } },
						// 勾选＝看板在看这一家。单选语义：勾一个，其他自动取消。
						// 与看板右键菜单共用 writePresetProvider，双向同步。
						h("input", {
							type: "radio",
							name: "dsh-usage-watching",
							checked: watching === provider,
							disabled: disabled || provider === "",
							title: t("providers.watching"),
							"aria-label": t("providers.watching"),
							onChange: () => {
								setWatching(provider);
								writePresetProvider(provider);
							},
							style: { margin: 0, flex: "none", cursor: disabled ? "default" : "pointer" },
						}),
						h("span", { style: { fontSize: 12, fontWeight: 600 } }, provider === "" ? t("alias.providerRequired") : provider),
						h("span", { style: { ...mutedStyle, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, summaryOf(type, row)),
						h("span", { style: { marginLeft: "auto", display: "flex", gap: 6, flex: "none" } },
							h("button", {
								type: "button",
								style: { ...buttonStyle, height: 24, padding: "0 8px" },
								disabled,
								onClick: () => (open ? closeEdit() : startEdit(type, index, row)),
							}, open ? t("providers.cancel") : t("providers.edit")),
							h("button", {
								type: "button",
								style: { ...buttonStyle, height: 24, padding: "0 8px" },
								disabled,
								onClick: () => { drop(type, index).catch(() => {}); },
							}, t("providers.remove")))),
					open ? editor() : null);
			};

			const header = h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
				h("h3", { style: { margin: 0, fontSize: 15, fontWeight: 600, lineHeight: "22px" } }, t("providers.title")),
				notice ? h("span", { style: { ...mutedStyle, marginLeft: "auto" } }, notice) : null,
			);

			// 宿主没有交出配置表单（旧宿主、或该条目没被 settings 收录）：给出兜底说明。
			if (form === undefined) {
				return h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
					header,
					h("p", { style: hintStyle }, t("alias.unavailable")),
					h("p", { style: hintStyle }, t("alias.yamlHint")));
			}
			if (status === "loading") {
				return h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
					header,
					h("p", { style: hintStyle }, t("alias.loading")));
			}
			if (status === "unavailable") {
				return h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
					header,
					h("p", { style: hintStyle }, t("alias.unavailable")),
					h("p", { style: hintStyle }, t("alias.yamlHint")));
			}

			const total = aliases.length + customs.length;
			const detected = (meta && Array.isArray(meta.unmapped) ? meta.unmapped : [])
				.filter((item) => item && typeof item.id === "string")
				.filter((item) => !aliases.some((row) => String(row.provider).trim().toLowerCase() === item.id.toLowerCase()))
				.filter((item) => !customs.some((row) => String(row.provider).trim().toLowerCase() === item.id.toLowerCase()));

			return h("div", { style: { display: "flex", flexDirection: "column", gap: 10 } },
				header,
				h("p", { style: hintStyle }, t("providers.intro")),
				readonly ? h("p", { style: hintStyle }, t("alias.readonly")) : null,
				total === 0
					? h("p", { style: hintStyle }, t("providers.empty"))
					: h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
						aliases.map((row, index) => rowView("alias", row, index)),
						customs.map((row, index) => rowView("custom", row, index))),
				editing !== null && editing.index < 0 ? editor() : null,
				editing === null || editing.index >= 0
					? h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
						h("button", { type: "button", style: buttonStyle, disabled, onClick: () => startNew("alias") }, t("providers.addAlias")),
						h("button", { type: "button", style: buttonStyle, disabled, onClick: () => startNew("custom") }, t("providers.addCustom")))
					: null,
				detected.length > 0
					? h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
						h("p", { style: { ...hintStyle, fontWeight: 500, color: "var(--dsw-alias-label-secondary, rgba(0,0,0,.55))" } }, t("alias.detected")),
						h("p", { style: hintStyle }, t("alias.detectedHint")),
						h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
							detected.map((item) => h("button", {
								key: item.id,
								type: "button",
								title: item.auto ? t("alias.autoHint") : t("alias.detectedHint"),
								style: { ...buttonStyle, height: "auto", padding: "3px 8px" },
								disabled,
								// 自动识别到的路由直接开「自定义 URL」并带上 provider 与推测地址；
								// 没有地址的老路由仍走「映射」表单。
								onClick: () => (item.baseUrl
									? startEdit("custom", -1, {
										...emptyCustomRow(),
										provider: item.id,
										baseUrl: String(item.baseUrl).replace(/\/+$/, "").replace(/\/v1$/, ""),
										accountType: "auto",
									})
									: startEdit("alias", -1, { ...emptyAliasRow(), provider: item.id })),
							}, (item.displayName || item.id) + " · " + item.id + (item.auto ? "（自动识别）" : "")))))
					: null,
			);
		}

		/**
		 * 设置面板「DeepSeek 用量」页的配置体：上面是 provider 映射编辑器，下面是
		 * OAuth 令牌填写区。这个 slot 的 owner props 只有 close，不直接给配置表单，
		 * 所以从 `configForms` 服务按本条目 id 取同一个表单控制器；服务不可用时退回
		 * 手写 YAML 的说明。条目 id 来自本包的 cordis.patch.yml（insert 的 id）。
		 */
		/** 设置页：刷新间隔（秒）。空值表示跟随默认（30 秒），范围 5..3600。 */
		function RefreshSettings(props) {
			const t = props.t;
			const form = props.form;
			const state = form && form.state ? form.state : null;
			const revision = state ? state.revision : undefined;
			const status = state ? state.status : undefined;
			const current = state && state.value && state.value.refreshSeconds !== undefined && state.value.refreshSeconds !== null
				? String(state.value.refreshSeconds)
				: "";
			const [draft, setDraft] = useState(current);
			const [notice, setNotice] = useState("");
			const [saving, setSaving] = useState(false);
			const mountedRef = useRef(true);

			useEffect(() => () => { mountedRef.current = false; }, []);
			useEffect(() => { setDraft(current); }, [revision, status, current]);

			const readonly = state !== null && state.writable === false;
			const inputStyle = {
				boxSizing: "border-box",
				width: 96,
				borderRadius: "var(--dsw-radius-md, 6px)",
				border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.35))",
				background: "transparent",
				color: "inherit",
				font: "inherit",
				fontSize: 12,
				height: 28,
				padding: "0 8px",
			};
			const buttonStyle = {
				boxSizing: "border-box",
				borderRadius: "var(--dsw-radius-md, 6px)",
				border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.35))",
				background: "transparent",
				color: "inherit",
				font: "inherit",
				fontSize: 12,
				height: 28,
				padding: "0 10px",
				cursor: "pointer",
			};
			const hintStyle = {
				margin: 0,
				fontSize: 12,
				lineHeight: "18px",
				color: "var(--dsw-alias-label-tertiary, rgba(0,0,0,.45))",
			};

			const save = async () => {
				if (form === undefined || readonly) return;
				setSaving(true);
				try {
					const raw = String(draft).trim();
					const value = raw === "" ? "" : String(clampRefresh(raw));
					const ok = await form.mutate([{ op: "set", path: ["refreshSeconds"], value }]);
					if (mountedRef.current) {
						setNotice(ok ? t("refresh.saved") : t("refresh.saveFailed"));
						if (ok) setDraft(value);
					}
					if (ok && typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
						writeCachedRefresh(value === "" ? DEFAULT_REFRESH_SECONDS : value);
						window.dispatchEvent(new Event("dsh-usage:config-updated"));
					}
				} catch (e) {
					if (mountedRef.current) setNotice(t("refresh.saveFailed"));
				} finally {
					if (mountedRef.current) setSaving(false);
				}
			};

			if (form === undefined) return null;
			return h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
				h("h3", { style: { margin: 0, fontSize: 15, fontWeight: 600, lineHeight: "22px" } }, t("refresh.title")),
				h("p", { style: hintStyle }, t("refresh.intro")),
				h("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
					h("input", {
						type: "number",
						min: MIN_REFRESH_SECONDS,
						max: MAX_REFRESH_SECONDS,
						step: 0.1,
						style: inputStyle,
						"aria-label": t("refresh.title"),
						placeholder: String(DEFAULT_REFRESH_SECONDS),
						value: draft,
						disabled: readonly || saving,
						onChange: (e) => setDraft(e.target.value),
					}),
					h("span", { style: hintStyle }, t("refresh.seconds")),
					h("button", {
						type: "button",
						style: buttonStyle,
						disabled: readonly || saving,
						onClick: () => { save().catch(() => {}); },
					}, t("refresh.save")),
					notice ? h("span", { style: hintStyle }, notice) : null),
				h("p", { style: hintStyle }, t("refresh.hint")));
		}

		const CONFIG_ENTRY_ID = "deepseek-usage";

		function UsageConfigSection(props) {
			const t = props.t;
			const ctx = props.ctx;
			const configForms = ctx === undefined || ctx === null
				? undefined
				: (typeof ctx.get === "function" ? ctx.get("configForms") : ctx.configForms);
			const form = configForms && typeof configForms.get === "function"
				? configForms.get(CONFIG_ENTRY_ID)
				: undefined;

			// hooks 不能条件调用：没有表单时给一个永远「不可用」的只读 store。
			const fallback = useMemo(() => ({
				subscribe: () => () => {},
				getSnapshot: () => ({ status: "unavailable", value: undefined, revision: 0, writable: false }),
			}), []);
			const store = form === undefined ? fallback : form;
			const subscribe = useCallback((notify) => store.subscribe(notify), [store]);
			const getSnapshot = useCallback(() => store.getSnapshot(), [store]);
			const snapshot = useSyncExternalStore(subscribe, getSnapshot);
			const face = form === undefined
				? undefined
				: { state: snapshot, mutate: (ops, revision) => form.mutate(ops, revision) };
			return h("div", { style: { display: "flex", flexDirection: "column", gap: 16 } },
				h(ProvidersSettings, { t, form: face }),
				h(RefreshSettings, { t, form: face }),
				h(OAuthTokenSection, { t }),
			);
		}

		// 设置导航项：id 与位置（放在 Plugins 15 之后、Agent presets 20 之前）。
		const SETTINGS_SECTION_ID = "deepseek-usage";
		const SETTINGS_SECTION_ORDER = 16;
		const SETTINGS_HEADING_STYLE = { margin: 0, fontSize: 18, lineHeight: "26px", fontWeight: 600 };
		const SETTINGS_INTRO_STYLE = {
			margin: 0,
			fontSize: 13,
			lineHeight: "20px",
			color: "var(--dsw-alias-label-tertiary, rgba(0,0,0,.45))",
		};

		/** 设置面板里的「DeepSeek 用量」页：标题 + 说明 + 配置体。 */
		function UsageSettingsSection(props) {
			const t = props.t;
			return h("div", {
				style: {
					maxWidth: 760,
					color: "var(--dsw-alias-label-primary)",
					display: "flex",
					flexDirection: "column",
					gap: 16,
				},
			},
				h("h2", { style: SETTINGS_HEADING_STYLE }, t("settings.title")),
				h("p", { style: SETTINGS_INTRO_STYLE }, t("settings.intro")),
				h(UsageConfigSection, { t, ctx: props.ctx }),
			);
		}

		/**
		 * 设置外壳的共享实例：设置面板把「开/关 + 当前分区」的状态放在
		 * `sidebar.settings` 槽位注册项的 store 上，`create()` 返回的就是面板在用的
		 * 那个实例（settings-general 自己重写了 create，反复调用拿到的仍是同一个）。
		 * 槽位 ledger 的 entry 把 store 句柄放在 `entry.store`（options 是渲染侧擦除
		 * 过的空壳），老版本若把它投影在 options 里也一并兼容。宿主没有设置外壳时
		 * 返回 undefined。
		 */
		function settingsShellOf(ctx) {
			try {
				const slots = ctx && ctx.slots;
				if (!slots || typeof slots.entries !== "function") return undefined;
				for (const entry of slots.entries("sidebar.settings") || []) {
					const handle = entry && (entry.store || (entry.options ? entry.options.store : undefined));
					if (handle && typeof handle.create === "function") {
						const shell = handle.create();
						if (shell) return shell;
					}
				}
			} catch (e) { /* 宿主没有设置外壳 */ }
			return undefined;
		}

		/** 能否直接跳到「DeepSeek 用量」设置页（外壳存在且支持 openSection）。 */
		function canOpenUsageSettings(ctx) {
			const actions = settingsShellOf(ctx)?.actions;
			return !!(actions && typeof actions.openSection === "function");
		}

		/** 打开设置面板并切到「DeepSeek 用量」页；不可用时返回 false。 */
		function openUsageSettings(ctx) {
			try {
				const actions = settingsShellOf(ctx)?.actions;
				if (!actions || typeof actions.openSection !== "function") return false;
				actions.openSection(SETTINGS_SECTION_ID);
				return true;
			} catch (e) {
				return false;
			}
		}

		// ---- client plugin body -----------------------------------------
		const inject = ["slots", "remote", "locale"];

		function apply(ctx) {
			// 注册 i18n 词典（DSH locale 服务；不可用时组件回退中文）。
			// 用 ctx.effect 管理生命周期：插件卸载时词典随之撤销。
			try {
				if (ctx.effect && ctx.locale && typeof ctx.locale.register === "function") {
					ctx.effect(
						() => ctx.locale.register(NS, { zh: ZH, en: EN }),
						"dsh-deepseek-usage: dictionaries",
					);
				} else if (ctx.locale && typeof ctx.locale.register === "function") {
					ctx.locale.register(NS, { zh: ZH, en: EN });
				}
			} catch (e) { /* 词典注册失败不影响卡片 */ }
			// 注入本包样式：footerActions 换行（卡片独占一行）。
			const tagId = "dsh-deepseek-usage";
			if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css="${tagId}"]`) === null) {
				const style = document.createElement("style");
				style.dataset.plugin = "dsh-deepseek-usage";
				style.dataset.pluginCss = tagId;
				style.textContent = 'div[class*="footerActions"]{flex-wrap:wrap}';
				document.head.appendChild(style);
			}
			ensureDockStyle();
			// 磁贴框：同一槽位的第二个入口，order 比看板大 → 落在看板下方
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register(
				{ name: "sidebar.footer.action", id: "dsh-usage-dock", order: 110 },
				(props) => h(FooterDock, { lang: currentLang(ctx) }),
			));
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register(
				// label 用函数：每次求值时按当前 DSH 语言取，切换语言后不必重新注册槽位。
				{ name: "sidebar.footer.action", id: "dsh-usage", order: 100, label: () => textOf("sidebar.label", currentLang(ctx)) },
				(props) => h(NudgeBoundary, null, h(UsageCell, { wide: props.wide, ctx })),
			));
			// 设置面板的「DeepSeek 用量」页：provider 映射 + OAuth 订阅令牌。
			// 导航标题用 thunk，切换语言后重新求值；locale: NS 让页面拿到注入的 t。
			ctx.slots.inject("settings.section", () => ctx.slots.register(
				{
					name: "settings.section",
					id: SETTINGS_SECTION_ID,
					order: SETTINGS_SECTION_ORDER,
					label: () => textOf("settings.nav", currentLang(ctx)),
					locale: NS,
				},
				(props) => h(UsageSettingsSection, { t: props.t, ctx }),
			));
		}

		exports.apply = apply;
		exports.inject = inject;
		// 纯函数透出（供 test/client-layout.test.mjs 直接做确定性断言，不必模拟计时器）。
		exports.__internals = {
			nextChange,
			isPeak,
			money,
			fmtPrice,
			currencySymbol,
			expandHolidayRanges,
			isHoliday,
			accountLead,
			percentText,
			usageWindows,
			windowLabel,
			windowBadge,
			windowHint,
			usageRatio,
			remainingColor,
			aliasDraftOf,
			customDraftOf,
			parseRefs,
			uiLang,
		};
		return module.exports;
	}
});
