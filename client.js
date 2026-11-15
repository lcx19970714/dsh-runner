/* dsh-runner —— 客户端半体（浏览器侧，0.12.0）
 *
 * 功能总览：
 *   1) 左侧导航新增「运行」面板（sidebar.panellist + main 槽位）：
 *      当前项目的运行命令列表（启停重启、状态/端口/uptime/退出码）+ 实时日志 +
 *      端口诊断（未托管占用者可一键结束）；
 *   2) 输入框下方保留紧凑「▶ 运行」按钮（conversation.composer.dock）：
 *      按项目过滤的快捷菜单，只做启动/停止/重启，不再创建任何终端；
 *   3) 命令配置页（settings.section）：命令编辑器，直接调用 Host 的
 *      config/create|update|delete|reorder RPC；
 *   4) 插件详情页更新提示（plugins.detail.badge / plugins.detail.section）。
 *
 * 数据流（单一事实来源 = Host）：
 *   配置：config/*            —— 只从 Host RPC 读，内存 store + 订阅，无 localStorage
 *   UI：ui/get|ui/update     —— 折叠状态 + 上次查看的日志，Host 持久化到 ui-state.json
 *   进程：project/status|start|stop|restart|startAll|stopAll
 *   日志：project/log|log/clear（轮询 tail，客户端只展示）
 *   诊断：project/diagnose|killPort
 *
 * 所有 RPC 失败一律 throw（err.code / err.details 透传），界面显示 messageOf(error)。
 * 不依赖右侧栏 / 内置终端 / 终端 RPC；不再有终端创建、tail、项目页签注册表。
 */
window.__ModuleLoader__.load({
  id: "dsh-runner",
  factory: (require) => {
    "use strict";

    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    // 只用基线共享模块 react；react-dom 仅用于把弹出菜单 portal 到 body（有则用，无则内联）。
    var react = require("react");
    var reactDom = null;
    try {
      reactDom = require("react-dom");
    } catch (_error) {
      reactDom = null;
    }
    var h = react.createElement;

    // =====================================================================
    // 一、常量
    // =====================================================================
    var PLUGIN_NAME = "dsh-runner";
    var PLUGIN_VERSION = "0.26.0";

    // 左侧导航面板 / main 面板的稳定 id。
    var PANEL_ID = "dsh-runner";
    var PANEL_LABEL = "运行";

    // 更新检查（GitHub Releases）；只提示不自动升级。
    var REPO_SLUG = "lcx19970714/dsh-runner";
    var INSTALL_SPEC = "github:" + REPO_SLUG;
    var UPGRADE_COMMAND = "dsh plugin --profile desktop add " + INSTALL_SPEC;
    var GITHUB_REPO_PAGE = "https://github.com/" + REPO_SLUG;
    var GITHUB_RELEASES_PAGE = GITHUB_REPO_PAGE + "/releases";
    var GITHUB_API_LATEST = "https://api.github.com/repos/" + REPO_SLUG + "/releases/latest";
    var GITHUB_RAW_PACKAGE = "https://raw.githubusercontent.com/" + REPO_SLUG + "/main/package.json";
    var UPDATE_CACHE_KEY = "dsh.limob-runner.update.v1";
    var UPDATE_TTL_MS = 10 * 60 * 1000;

    // Host RPC：POST /api/dsh-runner/<endpoint>，信封由 client.rpc.call 负责。
    var RPC_CHANNEL = "/api";
    var RPC_NAMESPACE = PLUGIN_NAME;

    // 轮询节奏与日志单次读取上限（与 SPEC 2.2 一致）。
    var STATUS_POLL_MS = 2000;
    var DIAGNOSE_POLL_MS = 6000;
    var LOG_POLL_MS = 1000;
    var LOG_MAX_BYTES = 65536;
    // 顶部 chip 悬停气泡：轮询要快，启动慢的服务才能看到“正在输出”的过程。
    var HEADER_LOG_POLL_MS = 700;
    var HEADER_LOG_MAX_CHARS = 20000;

    // apply(ctx) 时保存客户端根 Context；组件里按需取 DSH 服务。
    var runtimeCtx = null;
    // Host RPC 连接（connection 服务）。
    var hostConnection = null;

    // =====================================================================
    // 二、样式（factory 阶段注入一次，模块系统会随插件卸载清理）
    // =====================================================================
    var STYLE_ID = "dsh-limob-runner-css";
    var CSS = `
/* ============================================================================
 * dsh-runner 视觉系统（0.26.0）
 *
 * 设计原则：
 *  1. 只用 DSH 主题 token 推导表面/描边/文字色，深色与浅色同一套规则；
 *  2. 层级靠「留白 + 中性填充」表达，不靠彩色背景条和重描边；
 *  3. 状态色只用于状态（运行/失败/外部/警告），主按钮用品牌单色；
 *  4. 图标全部是 16 网格线性 SVG，不用文字符号当图标；
 *  5. 4px 间距节奏，控件尺寸统一（22/26/28px），焦点态、禁用态、加载态齐全。
 * ========================================================================== */

/* ---- 0. 令牌 ---- */
.dshRunnerPage,
.dshRunnerHeaderFloat,
.dshRunnerLogBubble,
.dshRunnerDialog,
.dshLimobCfgPage,
.dshLimobCfgModal,
.dshLimobRunDock,
.dshLimobRunMenu,
.dshLimobDetailSection {
  --drr-surface: var(--dsw-alias-bg-base);
  --drr-raised: color-mix(in srgb, var(--dsw-alias-label-primary) 4%, var(--dsw-alias-bg-base));
  --drr-fill-1: color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent);
  --drr-fill-2: color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent);
  --drr-fill-3: color-mix(in srgb, var(--dsw-alias-label-primary) 15%, transparent);
  --drr-line: var(--dsw-alias-border-l1);
  --drr-line-2: var(--dsw-alias-border-l2);
  --drr-line-3: var(--dsw-alias-border-l3);
  --drr-text: var(--dsw-alias-label-primary);
  --drr-text-2: var(--dsw-alias-label-secondary);
  --drr-text-3: var(--dsw-alias-label-tertiary);
  --drr-brand: var(--dsw-alias-brand-primary);
  --drr-on-brand: var(--dsw-alias-bg-base);
  --drr-ok: var(--dsw-alias-state-success-primary);
  --drr-warn: var(--dsw-alias-state-warn-primary);
  --drr-error: var(--dsw-alias-state-error-primary);
  --drr-idle: var(--dsw-alias-state-idle-primary);
  --drr-ok-ink: color-mix(in srgb, var(--drr-ok) 52%, var(--drr-text));
  --drr-warn-ink: color-mix(in srgb, var(--drr-warn) 55%, var(--drr-text));
  --drr-error-ink: color-mix(in srgb, var(--drr-error) 70%, var(--drr-text));
  --drr-r-xs: 6px;
  --drr-r-sm: 8px;
  --drr-r-md: 10px;
  --drr-r-lg: 14px;
  --drr-mono: ui-monospace, "SF Mono", "Cascadia Mono", "Segoe UI Mono", Consolas, "Liberation Mono", monospace;
  --drr-ease: cubic-bezier(.22, .61, .36, 1);
  --drr-ease-in-out: cubic-bezier(.4, 0, .2, 1);
  /* 阴影只声明一次：颜色随 color-scheme 走，浅色下更轻，深色下更深 */
  --drr-shadow-1: light-dark(rgba(15, 17, 21, .16), rgba(0, 0, 0, .55));
  --drr-shadow-2: light-dark(rgba(15, 17, 21, .09), rgba(0, 0, 0, .35));
  --drr-shadow-pop: 0 18px 44px -14px var(--drr-shadow-1), 0 4px 12px -6px var(--drr-shadow-2);
  --drr-shadow-sm: 0 1px 2px light-dark(rgba(15, 17, 21, .12), rgba(0, 0, 0, .25));
}

/* ---- 1. 通用交互底座 ---- */
.dshRunnerPage,
.dshRunnerDialog,
.dshLimobCfgPage,
.dshLimobRunDock,
.dshLimobDetailSection {
  font-family: inherit;
  -webkit-font-smoothing: antialiased;
  color: var(--drr-text);
}
.dshRunnerPage *,
.dshRunnerDialog *,
.dshLimobCfgPage *,
.dshLimobCfgModal *,
.dshLimobRunDock *,
.dshLimobRunMenu *,
.dshRunnerHeaderFloat *,
.dshRunnerLogBubble *,
.dshLimobDetailSection * { box-sizing: border-box; }

.dshRunnerPage ::selection,
.dshRunnerDialog ::selection,
.dshLimobCfgPage ::selection,
.dshLimobCfgModal ::selection,
.dshLimobRunMenu ::selection,
.dshRunnerLogBubble ::selection,
.dshLimobDetailSection ::selection {
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 22%, transparent);
}

/* 细滚动条，深浅主题都跟随文字色 */
.dshRunnerList,
.dshRunnerPre,
.dshLimobRunMenu,
.dshLimobCfgModal,
.dshRunnerDialog,
.dshRunnerLogBubbleBody,
.dshLimobTextarea,
.dshRunnerHeaderFloat { scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--drr-text) 20%, transparent) transparent; }
.dshRunnerList::-webkit-scrollbar,
.dshRunnerPre::-webkit-scrollbar,
.dshLimobRunMenu::-webkit-scrollbar,
.dshLimobCfgModal::-webkit-scrollbar,
.dshRunnerDialog::-webkit-scrollbar,
.dshRunnerLogBubbleBody::-webkit-scrollbar { width: 10px; height: 10px; }
.dshRunnerList::-webkit-scrollbar-thumb,
.dshRunnerPre::-webkit-scrollbar-thumb,
.dshLimobRunMenu::-webkit-scrollbar-thumb,
.dshLimobCfgModal::-webkit-scrollbar-thumb,
.dshRunnerDialog::-webkit-scrollbar-thumb,
.dshRunnerLogBubbleBody::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--drr-text) 18%, transparent);
  background-clip: content-box;
  border: 3px solid transparent;
  border-radius: 999px;
}
.dshRunnerList::-webkit-scrollbar-thumb:hover,
.dshRunnerPre::-webkit-scrollbar-thumb:hover,
.dshLimobRunMenu::-webkit-scrollbar-thumb:hover,
.dshLimobCfgModal::-webkit-scrollbar-thumb:hover,
.dshRunnerDialog::-webkit-scrollbar-thumb:hover { background: color-mix(in srgb, var(--drr-text) 30%, transparent); background-clip: content-box; }
.dshRunnerList::-webkit-scrollbar-track,
.dshRunnerPre::-webkit-scrollbar-track,
.dshLimobRunMenu::-webkit-scrollbar-track,
.dshLimobCfgModal::-webkit-scrollbar-track,
.dshRunnerDialog::-webkit-scrollbar-track { background: transparent; }

.dshRunnerPage button:focus-visible,
.dshRunnerDialog button:focus-visible,
.dshLimobCfgPage button:focus-visible,
.dshLimobCfgModal button:focus-visible,
.dshLimobRunDock button:focus-visible,
.dshLimobRunMenu button:focus-visible,
.dshRunnerHeaderFloat button:focus-visible,
.dshRunnerLogBubble button:focus-visible,
.dshLimobDetailSection a:focus-visible,
.dshRunnerDialog [tabindex]:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--drr-brand) 55%, transparent);
  outline-offset: 2px;
}

@keyframes drr-pop { from { opacity: 0; transform: translateY(4px) scale(.985); } to { opacity: 1; transform: none; } }
@keyframes drr-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes drr-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
@keyframes drr-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }

/* ---- 2. 按钮 ---- */
.dshLimobCfgBtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 28px;
  padding: 0 11px;
  border: 1px solid var(--drr-line-2);
  border-radius: var(--drr-r-sm);
  background: transparent;
  color: var(--drr-text);
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color .14s var(--drr-ease), border-color .14s var(--drr-ease), color .14s var(--drr-ease), opacity .14s var(--drr-ease);
}
.dshLimobCfgBtn > svg { width: 14px; height: 14px; flex: none; }
.dshLimobCfgBtn:hover:not([disabled]) { background: var(--drr-fill-1); }
.dshLimobCfgBtn:active:not([disabled]) { background: var(--drr-fill-2); }
.dshLimobCfgBtn[disabled] { opacity: .42; cursor: default; }
.dshLimobCfgBtnPrimary {
  border-color: transparent;
  background: var(--drr-brand);
  color: var(--drr-on-brand);
  font-weight: 600;
}
.dshLimobCfgBtnPrimary:hover:not([disabled]) { background: color-mix(in srgb, var(--drr-brand) 88%, transparent); }
.dshLimobCfgBtnPrimary:active:not([disabled]) { background: color-mix(in srgb, var(--drr-brand) 78%, transparent); }
.dshLimobCfgBtnDanger { border-color: color-mix(in srgb, var(--drr-error) 38%, transparent); color: var(--drr-error-ink); }
.dshLimobCfgBtnDanger:hover:not([disabled]) { background: color-mix(in srgb, var(--drr-error) 12%, transparent); }
.dshLimobCfgBtnDangerSolid { border-color: transparent; background: color-mix(in srgb, var(--drr-error) 80%, #000); color: #fff; font-weight: 600; }
.dshLimobCfgBtnDangerSolid:hover:not([disabled]) { background: color-mix(in srgb, var(--drr-error) 68%, #000); }
.dshLimobCfgBtnGhost { height: 26px; padding: 0 8px; border-color: transparent; color: var(--drr-text-2); }
.dshLimobCfgBtnGhost:hover:not([disabled]) { color: var(--drr-text); background: var(--drr-fill-1); }

.dshLimobIconBtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--drr-text-2);
  font: inherit;
  line-height: 1;
  cursor: pointer;
  transition: background-color .14s var(--drr-ease), color .14s var(--drr-ease), opacity .14s var(--drr-ease);
}
.dshLimobIconBtn > svg { width: 15px; height: 15px; }
.dshLimobIconBtn:hover:not([disabled]) { background: var(--drr-fill-1); color: var(--drr-text); }
.dshLimobIconBtn:active:not([disabled]) { background: var(--drr-fill-2); }
.dshLimobIconBtn[disabled] { opacity: .28; cursor: default; }
.dshLimobIconBtn[data-danger="true"]:hover:not([disabled]) { background: color-mix(in srgb, var(--drr-error) 14%, transparent); color: var(--drr-error-ink); }

.dshRunnerMiniBtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--drr-line-2);
  border-radius: 7px;
  background: transparent;
  color: var(--drr-text-2);
  font: inherit;
  font-size: 11px;
  font-weight: 500;
  line-height: 1;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color .14s var(--drr-ease), color .14s var(--drr-ease), border-color .14s var(--drr-ease), opacity .14s var(--drr-ease);
}
.dshRunnerMiniBtn > svg { width: 13px; height: 13px; flex: none; }
.dshRunnerMiniBtn:hover:not([disabled]) { background: var(--drr-fill-1); color: var(--drr-text); }
.dshRunnerMiniBtn[disabled] { opacity: .35; cursor: default; }
.dshRunnerMiniBtn[data-action="stop"]:hover:not([disabled]) { color: var(--drr-error-ink); background: color-mix(in srgb, var(--drr-error) 12%, transparent); border-color: color-mix(in srgb, var(--drr-error) 30%, transparent); }
.dshRunnerMiniBtn[data-action="adopt"]:hover:not([disabled]) { color: var(--drr-warn-ink); background: color-mix(in srgb, var(--drr-warn) 12%, transparent); border-color: color-mix(in srgb, var(--drr-warn) 32%, transparent); }

/* ---- 3. 标签 / 开关 / 表单控件 ---- */
.dshLimobTag {
  display: inline-flex;
  align-items: center;
  flex: none;
  height: 17px;
  padding: 0 6px;
  border: 1px solid var(--drr-line-2);
  border-radius: 999px;
  background: transparent;
  color: var(--drr-text-2);
  font-size: 10.5px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  max-width: 16em;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dshLimobTag[data-scope="project"] { background: var(--drr-fill-1); color: var(--drr-text-2); }
.dshLimobTag[data-current="true"] { border-color: transparent; background: var(--drr-fill-2); color: var(--drr-text); font-weight: 600; }

.dshLimobSwitch {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 11.5px;
  line-height: 16px;
  color: var(--drr-text-2);
  user-select: none;
  cursor: pointer;
  position: relative;
  white-space: nowrap;
}
.dshLimobSwitch input { position: absolute; opacity: 0; width: 1px; height: 1px; pointer-events: none; }
.dshLimobSwitchTrack {
  width: 36px;
  height: 20px;
  border-radius: 999px;
  background: var(--drr-fill-3);
  position: relative;
  flex: none;
  transition: background-color .16s var(--drr-ease);
}
.dshLimobSwitchTrack::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--drr-surface);
  box-shadow: var(--drr-shadow-sm);
  transition: transform .16s var(--drr-ease);
}
.dshLimobSwitch input:checked + .dshLimobSwitchTrack { background: var(--drr-brand); }
.dshLimobSwitch input:checked + .dshLimobSwitchTrack::after { transform: translateX(16px); background: var(--drr-on-brand); }
.dshLimobSwitch input:focus-visible + .dshLimobSwitchTrack { outline: 2px solid color-mix(in srgb, var(--drr-brand) 55%, transparent); outline-offset: 2px; }
.dshLimobSwitch:hover .dshLimobSwitchTrack { background: var(--drr-fill-3); }
.dshLimobSwitch:hover input:checked + .dshLimobSwitchTrack { background: color-mix(in srgb, var(--drr-brand) 88%, transparent); }

.dshLimobInput,
.dshLimobTextarea,
.dshLimobSelect {
  width: 100%;
  box-sizing: border-box;
  min-width: 0;
  border: 1px solid var(--drr-line-2);
  border-radius: var(--drr-r-sm);
  background: color-mix(in srgb, var(--drr-text) 3%, var(--drr-surface));
  color: var(--drr-text);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  padding: 5px 9px;
  transition: border-color .14s var(--drr-ease), box-shadow .14s var(--drr-ease), background-color .14s var(--drr-ease);
}
.dshLimobInput { height: 30px; }
.dshLimobTextarea {
  min-height: 66px;
  resize: vertical;
  font-family: var(--drr-mono);
  font-size: 11.5px;
  line-height: 17px;
  padding: 7px 9px;
}
.dshLimobInput::placeholder,
.dshLimobTextarea::placeholder { color: var(--drr-text-3); }
.dshLimobInput:hover,
.dshLimobTextarea:hover,
.dshLimobSelect:hover { border-color: var(--drr-line-3); }
.dshLimobInput:focus,
.dshLimobTextarea:focus,
.dshLimobSelect:focus {
  outline: none;
  border-color: color-mix(in srgb, var(--drr-brand) 55%, transparent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--drr-brand) 10%, transparent);
}
.dshLimobSelect { height: 30px; padding-right: 6px; }
.dshLimobCfgModal input[type="checkbox"],
.dshLimobCfgPage input[type="checkbox"] { accent-color: var(--drr-brand); }

.dshLimobSegment {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border: 0;
  border-radius: var(--drr-r-sm);
  background: var(--drr-fill-1);
  flex: none;
}
.dshLimobSegment button {
  border: 0;
  background: transparent;
  color: var(--drr-text-2);
  font: inherit;
  font-size: 11.5px;
  font-weight: 500;
  line-height: 1;
  height: 24px;
  padding: 0 11px;
  border-radius: 6px;
  cursor: pointer;
  transition: background-color .14s var(--drr-ease), color .14s var(--drr-ease);
}
.dshLimobSegment button:hover { color: var(--drr-text); }
.dshLimobSegment button[data-active="true"] { background: var(--drr-fill-3); color: var(--drr-text); font-weight: 600; }

.dshLimobLinkBtn {
  border: 0;
  background: transparent;
  color: var(--drr-brand);
  font: inherit;
  font-size: 11px;
  font-weight: 500;
  line-height: 16px;
  padding: 0;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
  text-decoration-color: color-mix(in srgb, var(--drr-brand) 35%, transparent);
}
.dshLimobLinkBtn:hover { text-decoration-color: currentColor; }

/* ---- 4. 输入框下方的「运行」按钮与快捷菜单 ---- */
.dshLimobRunDock { position: relative; display: flex; align-items: center; gap: 8px; min-width: 0; max-width: 100%; }
.dshLimobRunBtn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 9px 0 8px;
  border: 0;
  border-radius: var(--drr-r-sm);
  background: transparent;
  color: var(--drr-text-2);
  font: inherit;
  font-size: 11.5px;
  font-weight: 500;
  line-height: 1;
  cursor: pointer;
  white-space: nowrap;
  user-select: none;
  transition: background-color .14s var(--drr-ease), color .14s var(--drr-ease);
}
.dshLimobRunBtn > svg { width: 13px; height: 13px; flex: none; }
.dshLimobRunBtn:hover { background: var(--drr-fill-1); color: var(--drr-text); }
.dshLimobRunBtn:active { background: var(--drr-fill-2); }
.dshLimobRunBtn[data-busy="true"] { cursor: progress; color: var(--drr-text-3); }
.dshLimobRunStatus {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  font-size: 11px;
  line-height: 16px;
  color: var(--drr-text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dshLimobRunStatus[data-phase="error"] { color: var(--drr-error-ink); }

.dshLimobRunMenu {
  position: fixed;
  z-index: 1000;
  box-sizing: border-box;
  min-width: 300px;
  max-width: min(420px, 92vw);
  max-height: min(58vh, 520px);
  overflow: auto;
  padding: 7px;
  border: 0;
  border-radius: var(--drr-r-md);
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: var(--drr-shadow-pop);
  color: var(--drr-text);
  font-family: inherit;
  font-size: 12px;
  line-height: 18px;
  animation: drr-pop .16s var(--drr-ease);
}
.dshLimobRunMenuTitle {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 8px 7px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--drr-text);
  user-select: none;
  min-width: 0;
}
.dshLimobRunMenuTitle > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshLimobRunMenuTitle > span:last-child { font-weight: 400; font-size: 10.5px; color: var(--drr-text-3); font-family: var(--drr-mono); }
.dshLimobRunRow {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  box-sizing: border-box;
  padding: 7px 8px;
  border-radius: var(--drr-r-sm);
  min-width: 0;
  transition: background-color .12s var(--drr-ease);
}
.dshLimobRunRow:hover { background: var(--drr-fill-1); }
.dshLimobRunRowMain { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.dshLimobRunItemTitleLine { display: flex; align-items: center; gap: 6px; min-width: 0; }
.dshLimobRunItemTitleLine .dshRunnerDot { margin-top: 0; width: 6px; height: 6px; align-self: center; }
.dshLimobRunItemTitle { font-size: 12.5px; font-weight: 500; line-height: 17px; color: var(--drr-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.dshLimobRunItemState { font-family: inherit; color: var(--drr-text-3); }
.dshLimobRunItemState[data-status="running"] { color: var(--drr-ok-ink); }
.dshLimobRunItemState[data-status="starting"], .dshLimobRunItemState[data-status="stopping"], .dshLimobRunItemState[data-status="external"] { color: var(--drr-warn-ink); }
.dshLimobRunItemState[data-status="failed"], .dshLimobRunItemState[data-status="exited"] { color: var(--drr-error-ink); }
.dshLimobRunItemCmd { font-size: 11px; line-height: 14px; color: var(--drr-text-3); font-family: var(--drr-mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dshLimobRunRowActions { display: flex; align-items: center; gap: 1px; flex: none; }
.dshLimobRunRowActions .dshLimobIconBtn { width: 24px; height: 24px; border-radius: 6px; }
.dshLimobRunSep { height: 1px; margin: 6px 4px; background: var(--drr-line); }
.dshLimobRunHint { padding: 6px 8px 4px; font-size: 10.5px; line-height: 15px; color: var(--drr-text-3); user-select: none; }
.dshLimobRunEmpty { display: flex; flex-direction: column; gap: 6px; padding: 12px 10px; font-size: 11.5px; line-height: 17px; color: var(--drr-text-3); }

/* ---- 5. 设置页 / 配置编辑器 ---- */
.dshLimobCfgPage {
  display: flex;
  flex-direction: column;
  gap: 14px;
  width: 100%;
  max-width: 940px;
  padding: 18px 20px 28px;
  font-size: 12px;
  line-height: 18px;
  color: var(--drr-text);
}
.dshLimobPageHead { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 0 0 14px; border-bottom: 1px solid var(--drr-line); }
.dshLimobPageTitle { font-size: 15px; font-weight: 600; line-height: 21px; letter-spacing: -.01em; }
.dshLimobPageSub { margin-top: 3px; font-size: 11.5px; line-height: 16px; color: var(--drr-text-3); }
.dshLimobPageVersion { flex: none; padding-top: 3px; font-size: 10.5px; line-height: 16px; color: var(--drr-text-3); font-family: var(--drr-mono); }
.dshLimobCfg { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.dshLimobCfgToolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; min-width: 0; }
.dshLimobCfgStat { flex: 1 1 200px; min-width: 0; font-size: 11.5px; line-height: 16px; color: var(--drr-text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
.dshLimobCmdList {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--drr-line);
  border-radius: var(--drr-r-md);
  overflow: hidden;
  background: var(--drr-surface);
}
.dshLimobCmdRow {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 10px 10px 14px;
  border-bottom: 1px solid var(--drr-line);
  min-width: 0;
  transition: background-color .12s var(--drr-ease);
}
.dshLimobCmdRow:last-child { border-bottom: 0; }
.dshLimobCmdRow:hover { background: var(--drr-fill-1); }
.dshLimobCmdRow[data-disabled="true"] { opacity: .5; }
.dshLimobCmdMain { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; cursor: pointer; }
.dshLimobCmdTitleLine { display: flex; align-items: center; gap: 7px; min-width: 0; }
.dshLimobCmdTitle { font-size: 13px; font-weight: 500; line-height: 17px; color: var(--drr-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dshLimobCmdPreview { font-size: 11px; line-height: 14px; color: var(--drr-text-3); font-family: var(--drr-mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dshLimobCmdActions { display: flex; align-items: center; gap: 2px; flex: none; }
.dshLimobCmdActions .dshLimobIconBtn { width: 25px; height: 25px; }
.dshLimobCfgEmpty { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 30px 14px; text-align: center; font-size: 11.5px; line-height: 17px; color: var(--drr-text-3); }
.dshLimobCfgForm {
  display: flex;
  flex-direction: column;
  gap: 13px;
  padding: 16px;
  border: 1px solid var(--drr-line-2);
  border-radius: var(--drr-r-md);
  background: var(--drr-raised);
  animation: drr-pop .16s var(--drr-ease);
}
.dshLimobCfgFormTop { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.dshLimobCfgFormTitle { font-size: 13px; font-weight: 600; line-height: 18px; letter-spacing: -.005em; }
.dshLimobFormGrid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px 14px; }
.dshLimobFormField { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.dshLimobFormField[data-wide="true"] { grid-column: 1 / -1; }
.dshLimobFormField > span { font-size: 11px; line-height: 14px; font-weight: 500; color: var(--drr-text-2); }
.dshLimobFormRow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.dshLimobFormRow .dshLimobSelect { flex: 1 1 200px; }
.dshLimobFormFoot { position: sticky; bottom: 0; z-index: 2; display: flex; align-items: center; gap: 8px; justify-content: flex-end; min-height: 40px; margin: 0 -16px -16px; padding: 8px 16px 10px; border-top: 1px solid var(--drr-line); border-radius: 0 0 var(--drr-r-md) var(--drr-r-md); background: var(--drr-raised); }
.dshLimobFormError { margin-right: auto; color: var(--drr-error-ink); font-size: 11.5px; line-height: 16px; word-break: break-word; }
.dshLimobCfgError { color: var(--drr-error-ink); font-size: 11.5px; line-height: 16px; word-break: break-word; }
.dshLimobCfgNotice { display: inline-flex; align-items: center; gap: 6px; align-self: flex-start; padding: 5px 10px; border-radius: 999px; color: var(--drr-ok-ink); background: color-mix(in srgb, var(--drr-ok) 12%, transparent); font-size: 11.5px; line-height: 16px; animation: drr-fade .16s var(--drr-ease); }
.dshLimobFieldHint { font-size: 10.5px; line-height: 15px; color: var(--drr-text-3); }
.dshLimobDepList { display: flex; flex-wrap: wrap; gap: 6px; padding-top: 2px; }
.dshLimobDepItem {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  height: 26px;
  padding: 0 9px 0 6px;
  border: 1px solid var(--drr-line-2);
  border-radius: 999px;
  font-size: 11.5px;
  line-height: 1;
  color: var(--drr-text-2);
  cursor: pointer;
  transition: background-color .12s var(--drr-ease), border-color .12s var(--drr-ease), color .12s var(--drr-ease);
}
.dshLimobDepItem:hover { background: var(--drr-fill-1); color: var(--drr-text); }
.dshLimobDepItem:has(input:checked) { border-color: color-mix(in srgb, var(--drr-brand) 40%, transparent); background: color-mix(in srgb, var(--drr-brand) 10%, transparent); color: var(--drr-text); }
.dshLimobDepItem input { margin: 0; }
.dshLimobDepItem span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 命令配置弹窗 */
.dshLimobCfgModalBackdrop {
  pointer-events: auto;
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: color-mix(in srgb, #000 44%, transparent);
  animation: drr-fade .14s var(--drr-ease);
}
.dshLimobCfgModal {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: min(800px, 94vw);
  max-height: min(88vh, 860px);
  overflow: auto;
  border: 0;
  border-radius: var(--drr-r-lg);
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: var(--drr-shadow-pop);
  animation: drr-pop .18s var(--drr-ease);
}
.dshLimobCfgModalHead {
  position: sticky;
  top: 0;
  z-index: 3;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 13px 14px 13px 20px;
  border-bottom: 1px solid var(--drr-line);
  background: var(--dsw-alias-bg-layer-1);
}
.dshLimobCfgModalTitle { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.dshLimobCfgModalTitle > span:first-child { font-size: 13.5px; font-weight: 600; line-height: 19px; }
.dshLimobCfgModalTitle > span:last-child { font-size: 10.5px; line-height: 14px; color: var(--drr-text-3); }
.dshLimobCfgModalBody { padding: 16px 20px 20px; }

/* ---- 6. 运行面板 ---- */
.dshRunnerPage {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  min-height: 0;
  padding: 16px 18px 12px;
  font-size: 12px;
  line-height: 18px;
  color: var(--drr-text);
}
.dshRunnerHead { display: flex; align-items: flex-start; gap: 16px; flex: none; padding: 0 2px 13px; min-width: 0; }
.dshRunnerHeadMain { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
.dshRunnerTitle { font-size: 17px; font-weight: 600; line-height: 22px; letter-spacing: -.012em; color: var(--drr-text); }
.dshRunnerSub { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; min-width: 0; font-size: 11.5px; line-height: 16px; color: var(--drr-text-3); }
.dshRunnerProject { font-size: 11.5px; font-weight: 500; color: var(--drr-text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 32ch; }
.dshRunnerSepDot { width: 2px; height: 2px; border-radius: 50%; background: currentColor; opacity: .55; flex: none; }
.dshRunnerSummary { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
.dshRunnerSummaryDot { width: 6px; height: 6px; border-radius: 50%; background: var(--drr-idle); flex: none; }
.dshRunnerSummary[data-tone="running"] .dshRunnerSummaryDot { background: var(--drr-ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--drr-ok) 16%, transparent); }
.dshRunnerSummary[data-tone="failed"] .dshRunnerSummaryDot { background: var(--drr-error); }
.dshRunnerSummary[data-tone="external"] .dshRunnerSummaryDot { background: var(--drr-warn); }
.dshRunnerToolbar { display: flex; align-items: center; gap: 8px; flex: none; }
.dshRunnerBody { display: grid; grid-template-columns: minmax(300px, 43%) minmax(0, 1fr); gap: 16px; flex: 1; min-height: 0; }
@media (max-width: 900px) {
  .dshRunnerBody { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1.35fr) minmax(0, 1fr); }
  .dshRunnerList { padding-right: 2px; }
}

.dshRunnerList { display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: auto; padding: 0 6px 20px 2px; }
.dshRunnerSection { display: flex; flex-direction: column; gap: 1px; flex: none; min-width: 0; padding-top: 2px; }
.dshRunnerSection + .dshRunnerSection { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--drr-line); }
.dshRunnerSectionHead {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 6px 7px 2px;
  min-width: 0;
  background: var(--drr-surface);
}
.dshRunnerSectionToggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: var(--drr-r-xs);
  background: transparent;
  color: var(--drr-text-3);
  cursor: pointer;
  transition: background-color .12s var(--drr-ease), color .12s var(--drr-ease);
}
.dshRunnerSectionToggle > svg { width: 14px; height: 14px; transition: transform .16s var(--drr-ease); }
.dshRunnerSectionToggle[aria-expanded="false"] > svg { transform: rotate(-90deg); }
.dshRunnerSectionToggle:hover { background: var(--drr-fill-1); color: var(--drr-text); }
.dshRunnerColorSwatch {
  flex: none;
  width: 9px;
  height: 9px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  cursor: pointer;
  background: var(--drr-swatch, var(--drr-idle));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--drr-swatch, var(--drr-idle)) 18%, transparent);
  transition: box-shadow .14s var(--drr-ease), transform .14s var(--drr-ease);
}
.dshRunnerColorSwatch:hover { transform: scale(1.1); box-shadow: 0 0 0 4px color-mix(in srgb, var(--drr-swatch, var(--drr-idle)) 26%, transparent); }
.dshRunnerColorRow { display: flex; align-items: center; gap: 5px; padding: 4px 8px 8px; flex-wrap: wrap; }
.dshRunnerColorLabel { margin-right: 3px; font-size: 10.5px; line-height: 1; color: var(--drr-text-3); }
.dshRunnerColorChip { width: 16px; height: 16px; padding: 0; border: 0; border-radius: 50%; cursor: pointer; opacity: .9; transition: transform .14s var(--drr-ease), box-shadow .14s var(--drr-ease); }
.dshRunnerColorChip:hover { transform: scale(1.12); box-shadow: 0 0 0 2px var(--drr-surface), 0 0 0 3.5px currentColor; }
.dshRunnerColorAuto {
  height: 20px;
  margin-left: 2px;
  padding: 0 8px;
  border: 1px solid var(--drr-line-2);
  border-radius: 999px;
  background: transparent;
  color: var(--drr-text-2);
  font: inherit;
  font-size: 10.5px;
  line-height: 1;
  cursor: pointer;
}
.dshRunnerColorAuto:hover { background: var(--drr-fill-1); color: var(--drr-text); }
.dshRunnerSectionInfo { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1 1 auto; }
.dshRunnerSectionTitleLine { display: flex; align-items: center; gap: 6px; min-width: 0; }
.dshRunnerSectionTitle { font-size: 13px; font-weight: 600; line-height: 17px; color: var(--drr-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dshRunnerSectionPath { font-size: 11px; line-height: 14px; color: var(--drr-text-3); font-family: var(--drr-mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dshRunnerSectionCount {
  display: inline-flex;
  align-items: center;
  flex: none;
  height: 16px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--drr-fill-1);
  color: var(--drr-text-2);
  font-size: 10.5px;
  font-weight: 500;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.dshRunnerSectionCount[data-tone="active"] { background: color-mix(in srgb, var(--drr-ok) 14%, transparent); color: var(--drr-ok-ink); }
.dshRunnerSectionIssue {
  display: inline-flex;
  align-items: center;
  flex: none;
  height: 16px;
  padding: 0 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--drr-warn) 12%, transparent);
  color: var(--drr-warn-ink);
  font-size: 10.5px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
}
.dshRunnerSectionActions { display: flex; align-items: center; gap: 6px; flex: none; }
.dshRunnerSectionActions .dshLimobIconBtn { width: 26px; height: 26px; border-radius: 7px; color: var(--drr-text-2); }
.dshRunnerSectionActions .dshLimobIconBtn:hover:not([disabled]) { background: var(--drr-fill-1); color: var(--drr-text); }
.dshRunnerSectionEmpty { padding: 10px 6px 12px; font-size: 11px; line-height: 16px; color: var(--drr-text-3); }

.dshRunnerRow {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 9px 8px 9px 11px;
  border-bottom: 1px solid var(--drr-line);
  border-radius: 0;
  min-width: 0;
  cursor: pointer;
  transition: background-color .12s var(--drr-ease), box-shadow .12s var(--drr-ease);
}
.dshRunnerRow:last-child { border-bottom-color: transparent; }
.dshRunnerRow:hover { background: var(--drr-fill-1); }
.dshRunnerRow[data-selected="true"] { background: var(--drr-fill-2); border-radius: var(--drr-r-sm); box-shadow: inset 0 0 0 1px var(--drr-line-2); }
.dshRunnerRow[data-disabled="true"] { opacity: .5; }
.dshRunnerDot {
  flex: none;
  width: 7px;
  height: 7px;
  margin-top: 6px;
  border-radius: 50%;
  background: transparent;
  box-shadow: inset 0 0 0 1.5px var(--drr-idle);
  transition: background-color .16s var(--drr-ease), box-shadow .16s var(--drr-ease);
}
.dshRunnerDot[data-status="queued"] { background: var(--drr-text-3); box-shadow: none; }
.dshRunnerDot[data-status="starting"],
.dshRunnerDot[data-status="stopping"] { background: var(--drr-warn); box-shadow: 0 0 0 3px color-mix(in srgb, var(--drr-warn) 18%, transparent); animation: drr-pulse 1.6s ease-in-out infinite; }
.dshRunnerDot[data-status="external"] { background: var(--drr-warn); box-shadow: 0 0 0 3px color-mix(in srgb, var(--drr-warn) 18%, transparent); }
.dshRunnerDot[data-status="running"] { background: var(--drr-ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--drr-ok) 18%, transparent); }
.dshRunnerDot[data-status="failed"],
.dshRunnerDot[data-status="exited"] { background: var(--drr-error); box-shadow: 0 0 0 3px color-mix(in srgb, var(--drr-error) 16%, transparent); }
.dshRunnerRowMain { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
.dshRunnerRowTitle { display: flex; align-items: center; gap: 7px; min-width: 0; }
.dshRunnerRowTitleText { font-size: 13px; font-weight: 500; line-height: 17px; color: var(--drr-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.dshRunnerState {
  display: inline-flex;
  align-items: center;
  flex: none;
  height: 18px;
  padding: 0 7px;
  border-radius: 999px;
  background: var(--drr-fill-1);
  color: var(--drr-text-2);
  font-size: 10.5px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
}
.dshRunnerState[data-status="running"] { background: color-mix(in srgb, var(--drr-ok) 13%, transparent); color: var(--drr-ok-ink); }
.dshRunnerState[data-status="queued"] { color: var(--drr-text-2); }
.dshRunnerState[data-status="starting"],
.dshRunnerState[data-status="stopping"] { background: color-mix(in srgb, var(--drr-warn) 13%, transparent); color: var(--drr-warn-ink); }
.dshRunnerState[data-status="external"] { background: color-mix(in srgb, var(--drr-warn) 13%, transparent); color: var(--drr-warn-ink); }
.dshRunnerState[data-status="failed"],
.dshRunnerState[data-status="exited"] { background: color-mix(in srgb, var(--drr-error) 12%, transparent); color: var(--drr-error-ink); }
.dshRunnerRowMetaLine { display: flex; align-items: center; gap: 10px; min-width: 0; }
.dshRunnerRowCmd { flex: 1 1 auto; min-width: 0; font-family: var(--drr-mono); font-size: 11px; line-height: 15px; color: var(--drr-text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dshRunnerRowMeta { display: flex; align-items: center; gap: 6px; flex: none; min-width: 0; font-size: 11px; line-height: 14px; font-variant-numeric: tabular-nums; }
.dshRunnerStatusText { color: var(--drr-text-3); white-space: nowrap; }
.dshRunnerStatusText[data-status="external"] { color: var(--drr-warn-ink); }
.dshRunnerPort {
  display: inline-flex;
  align-items: center;
  flex: none;
  height: 16px;
  padding: 0 5px;
  border: 1px solid var(--drr-line-2);
  border-radius: 5px;
  color: var(--drr-text-2);
  font-family: var(--drr-mono);
  font-size: 10.5px;
  line-height: 1;
  white-space: nowrap;
}
.dshRunnerPortWarn { border-color: color-mix(in srgb, var(--drr-warn) 42%, transparent); background: color-mix(in srgb, var(--drr-warn) 10%, transparent); color: var(--drr-warn-ink); }
.dshRunnerRowActions { display: flex; align-items: center; gap: 6px; flex: none; align-self: center; }
.dshRunnerRowActions .dshLimobIconBtn { width: 24px; height: 24px; border-radius: 7px; }
.dshRunnerTagExternal {
  display: inline-flex;
  align-items: center;
  flex: none;
  height: 17px;
  padding: 0 6px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--drr-warn) 38%, transparent);
  background: color-mix(in srgb, var(--drr-warn) 10%, transparent);
  color: var(--drr-warn-ink);
  font-size: 10.5px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  max-width: 16em;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dshRunnerEmpty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 9px; padding: 44px 18px; text-align: center; color: var(--drr-text-3); }
.dshRunnerEmptyIcon { display: inline-flex; align-items: center; justify-content: center; width: 38px; height: 38px; border-radius: 12px; background: var(--drr-fill-1); color: var(--drr-text-3); }
.dshRunnerEmptyIcon > svg { width: 19px; height: 19px; }
.dshRunnerEmptyTitle { font-size: 12.5px; font-weight: 500; line-height: 18px; color: var(--drr-text-2); }
.dshRunnerEmptyHint { font-size: 11.5px; line-height: 17px; color: var(--drr-text-3); max-width: 34ch; }
.dshRunnerLoading { display: flex; flex-direction: column; gap: 8px; padding: 32px 18px; }
.dshRunnerLoadingLine { height: 10px; border-radius: 999px; background: linear-gradient(90deg, var(--drr-fill-1) 25%, var(--drr-fill-2) 50%, var(--drr-fill-1) 75%); background-size: 200% 100%; animation: drr-shimmer 1.4s linear infinite; }

/* ---- 7. 日志面板 ---- */
.dshRunnerLogPane {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  border: 1px solid var(--drr-line);
  border-radius: var(--drr-r-md);
  background: var(--drr-raised);
  overflow: hidden;
}
.dshRunnerLogHead { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 9px 8px 9px 12px; border-bottom: 1px solid var(--drr-line); min-width: 0; flex: none; }
.dshRunnerLogTitle { display: flex; align-items: center; gap: 7px; min-width: 0; flex: 0 1 auto; font-size: 13px; font-weight: 600; line-height: 17px; color: var(--drr-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dshRunnerLogTitle .dshRunnerDot { margin-top: 0; align-self: center; }
.dshRunnerLogTitle > span:not(.dshRunnerDot) { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshRunnerLogMeta { flex: none; font-size: 11px; line-height: 14px; color: var(--drr-text-3); white-space: nowrap; font-variant-numeric: tabular-nums; }
.dshRunnerLogMeta[data-path="true"] { flex: 0 1 auto; min-width: 0; max-width: 42%; font-family: var(--drr-mono); overflow: hidden; text-overflow: ellipsis; }
.dshRunnerLogTools { display: flex; align-items: center; gap: 1px; flex: none; margin-left: auto; }
.dshRunnerLogTools .dshLimobIconBtn { width: 25px; height: 25px; border-radius: 6px; }
.dshRunnerLogNote { display: flex; align-items: flex-start; gap: 7px; flex: 1 1 100%; min-width: 0; padding: 7px 9px; border-radius: var(--drr-r-xs); background: color-mix(in srgb, var(--drr-warn) 10%, transparent); color: var(--drr-warn-ink); font-size: 10.5px; line-height: 15px; white-space: normal; word-break: break-word; }
.dshRunnerLogNote > svg { flex: none; width: 13px; height: 13px; margin-top: 1px; }
.dshRunnerPre {
  flex: 1;
  min-height: 140px;
  margin: 0;
  padding: 12px 14px;
  overflow: auto;
  font-family: var(--drr-mono);
  font-size: 11.5px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--drr-text-2);
  background: color-mix(in srgb, var(--drr-text) 4%, transparent);
  user-select: text;
  tab-size: 2;
}
.dshRunnerLogEmpty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; flex: 1; min-height: 140px; padding: 24px 18px; text-align: center; background: color-mix(in srgb, var(--drr-text) 4%, transparent); color: var(--drr-text-3); }

/* ---- 8. 顶部 chip + 悬停日志气泡 ---- */
.dshRunnerHeaderFloat {
  position: fixed;
  transform: translate(-50%, -50%);
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  overflow: hidden;
  pointer-events: none;
  -webkit-app-region: no-drag;
}
.dshRunnerHeaderChip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: 0 1 auto;
  min-width: 0;
  height: 24px;
  padding: 0 8px;
  border: 0;
  border-radius: 999px;
  background: light-dark(color-mix(in srgb, var(--drr-chip, var(--drr-text)) 8%, transparent), color-mix(in srgb, var(--drr-chip, var(--drr-text)) 14%, transparent));
  box-shadow: inset 0 0 0 1px var(--drr-line-2);
  font-size: 11px;
  line-height: 1;
  white-space: nowrap;
  overflow: hidden;
  pointer-events: auto;
  -webkit-app-region: no-drag;
  transition: background-color .14s var(--drr-ease);
}
.dshRunnerHeaderChip:hover { background: light-dark(color-mix(in srgb, var(--drr-chip, var(--drr-text)) 12%, transparent), color-mix(in srgb, var(--drr-chip, var(--drr-text)) 22%, transparent)); }
.dshRunnerHeaderChip .dshRunnerDot { margin-top: 0; align-self: center; width: 6px; height: 6px; box-shadow: 0 0 0 2px color-mix(in srgb, var(--drr-chip, var(--drr-text)) 18%, transparent); }
.dshRunnerHeaderName { min-width: 0; font-weight: 500; color: var(--drr-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshRunnerHeaderState { flex: none; white-space: nowrap; color: var(--drr-text-2); font-size: 10.5px; font-variant-numeric: tabular-nums; }
.dshRunnerHeaderState[data-status="running"] { color: var(--drr-ok-ink); }
.dshRunnerHeaderState[data-status="queued"] { color: var(--drr-text-3); }
.dshRunnerHeaderState[data-status="starting"],
.dshRunnerHeaderState[data-status="stopping"] { color: var(--drr-warn-ink); }
.dshRunnerHeaderState[data-status="failed"],
.dshRunnerHeaderState[data-status="exited"] { color: var(--drr-error-ink); }
.dshRunnerHeaderActions { display: inline-flex; align-items: center; gap: 1px; flex: none; margin-left: 1px; -webkit-app-region: no-drag; }
.dshRunnerHeaderBtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--drr-text-2);
  font: inherit;
  font-size: 10px;
  line-height: 1;
  cursor: pointer;
  -webkit-app-region: no-drag;
  transition: background-color .12s var(--drr-ease), color .12s var(--drr-ease);
}
.dshRunnerHeaderBtn > svg { width: 10px; height: 10px; }
.dshRunnerHeaderBtn:hover { background: color-mix(in srgb, var(--drr-text) 14%, transparent); color: var(--drr-text); }
.dshRunnerHeaderBtn[data-action="stop"]:hover { color: var(--drr-error-ink); background: color-mix(in srgb, var(--drr-text) 12%, transparent); }
.dshRunnerHeaderBtn:disabled { opacity: .4; cursor: default; background: transparent; }

.dshRunnerLogBubble {
  position: fixed;
  z-index: 10001;
  display: flex;
  flex-direction: column;
  max-height: min(46vh, 380px);
  border: 0;
  border-radius: var(--drr-r-md);
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: var(--drr-shadow-pop);
  overflow: hidden;
  pointer-events: auto;
  -webkit-app-region: no-drag;
  font-size: 11.5px;
  line-height: 16px;
  color: var(--drr-text);
  text-align: left;
  animation: drr-pop .14s var(--drr-ease);
}
.dshRunnerLogBubbleHead { display: flex; align-items: center; gap: 7px; min-width: 0; flex: none; padding: 9px 11px; border-bottom: 1px solid var(--drr-line); white-space: nowrap; }
.dshRunnerLogBubbleHead .dshRunnerDot { margin-top: 0; align-self: center; }
.dshRunnerLogBubbleTitle { flex: 0 1 auto; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
.dshRunnerLogBubbleMeta { flex: 0 1 auto; min-width: 0; font-size: 10.5px; color: var(--drr-text-3); overflow: hidden; text-overflow: ellipsis; }
.dshRunnerLogBubbleLive { display: inline-flex; align-items: center; gap: 4px; margin-left: auto; flex: none; font-size: 10px; color: var(--drr-ok-ink); }
.dshRunnerLogBubbleLive::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: currentColor; box-shadow: 0 0 0 2px color-mix(in srgb, currentColor 18%, transparent); animation: drr-pulse 1.8s ease-in-out infinite; }
.dshRunnerLogBubbleLive[data-tone="error"] { color: var(--drr-error-ink); }
.dshRunnerLogBubbleBody {
  flex: 1 1 auto;
  min-height: 96px;
  max-height: min(42vh, 330px);
  margin: 0;
  padding: 10px 11px;
  overflow: auto;
  font-family: var(--drr-mono);
  font-size: 10.5px;
  line-height: 15px;
  white-space: pre-wrap;
  word-break: break-word;
  background: color-mix(in srgb, var(--drr-text) 4%, transparent);
  color: var(--drr-text-2);
  user-select: text;
}
.dshRunnerLogBubbleEmpty { padding: 18px 12px; font-size: 11px; line-height: 16px; color: var(--drr-text-3); }
.dshRunnerLogBubbleError { padding: 12px; font-size: 11px; line-height: 16px; color: var(--drr-error-ink); word-break: break-word; }

/* ---- 9. 错误条 / 端口冲突对话框 ---- */
.dshRunnerError {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  flex-wrap: wrap;
  flex: none;
  padding: 9px 11px;
  border: 1px solid color-mix(in srgb, var(--drr-error) 30%, transparent);
  border-radius: var(--drr-r-sm);
  background: color-mix(in srgb, var(--drr-error) 8%, transparent);
  color: var(--drr-error-ink);
  font-size: 11.5px;
  line-height: 16px;
}
.dshRunnerErrorIcon { flex: none; width: 14px; height: 14px; margin-top: 1px; }
.dshRunnerErrorText { flex: 1 1 220px; min-width: 0; word-break: break-word; }
.dshRunnerErrorDetail { flex: 0 0 100%; font-family: var(--drr-mono); font-size: 10.5px; line-height: 15px; color: var(--drr-text-2); word-break: break-word; opacity: .9; }
.dshRunnerDialogBackdrop {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: color-mix(in srgb, #000 44%, transparent);
  animation: drr-fade .14s var(--drr-ease);
}
.dshRunnerDialog {
  display: flex;
  flex-direction: column;
  gap: 14px;
  width: min(720px, 100%);
  max-height: min(84vh, 800px);
  overflow: auto;
  padding: 20px 22px;
  border: 0;
  border-radius: var(--drr-r-lg);
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: var(--drr-shadow-pop);
  animation: drr-pop .18s var(--drr-ease);
}
.dshRunnerDialogHead { display: flex; align-items: center; gap: 10px; font-size: 15px; font-weight: 600; line-height: 22px; letter-spacing: -.01em; }
.dshRunnerDialogIcon { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 28px; height: 28px; border-radius: 9px; background: color-mix(in srgb, var(--drr-warn) 14%, transparent); color: var(--drr-warn-ink); }
.dshRunnerDialogIcon > svg { width: 16px; height: 16px; }
.dshRunnerDialogSub { font-size: 11.5px; line-height: 17px; color: var(--drr-text-2); }
.dshRunnerDialogSub strong { color: var(--drr-text); font-weight: 600; }
.dshRunnerConflictEntry {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 11px 12px;
  border-radius: var(--drr-r-sm);
  background: var(--drr-fill-1);
  font-size: 11.5px;
  line-height: 16px;
}
.dshRunnerConflictHead { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; font-weight: 600; color: var(--drr-text); }
.dshRunnerConflictPort { font-family: var(--drr-mono); font-size: 11.5px; color: var(--drr-warn-ink); }
.dshRunnerConflictMeta { color: var(--drr-text-2); word-break: break-word; }
.dshRunnerConflictCode {
  padding: 7px 9px;
  border-radius: var(--drr-r-xs);
  background: color-mix(in srgb, var(--drr-text) 6%, transparent);
  color: var(--drr-text-2);
  font-family: var(--drr-mono);
  font-size: 10.5px;
  line-height: 15px;
  word-break: break-all;
  max-height: 56px;
  overflow: auto;
  user-select: text;
}
.dshRunnerConflictTag {
  display: inline-flex;
  align-items: center;
  flex: none;
  height: 17px;
  padding: 0 6px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--drr-warn) 34%, transparent);
  color: var(--drr-warn-ink);
  font-size: 10px;
  font-weight: 500;
  line-height: 1;
}
.dshRunnerDialogActions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; padding-top: 2px; }
.dshRunnerDialogError { padding: 8px 10px; border-radius: var(--drr-r-xs); background: color-mix(in srgb, var(--drr-error) 10%, transparent); color: var(--drr-error-ink); font-size: 11.5px; line-height: 16px; word-break: break-word; }
.dshRunnerDialogBusy { display: inline-flex; align-items: center; gap: 7px; font-size: 11.5px; color: var(--drr-text-2); }
.dshRunnerDialogBusy::before { content: ""; width: 10px; height: 10px; border-radius: 50%; border: 1.5px solid color-mix(in srgb, var(--drr-text) 25%, transparent); border-top-color: var(--drr-text); animation: drr-spin .7s linear infinite; }
@keyframes drr-spin { to { transform: rotate(360deg); } }

/* ---- 10. 插件详情页更新区 ---- */
.dshLimobUpdateBadge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  padding: 0 8px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--drr-warn) 34%, transparent);
  background: color-mix(in srgb, var(--drr-warn) 12%, transparent);
  color: var(--drr-warn-ink);
  font-size: 10.5px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
}
.dshLimobDetailSection {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 18px;
  border: 1px solid var(--drr-line);
  border-radius: var(--drr-r-md);
  background: var(--drr-surface);
  font-size: 12px;
  line-height: 18px;
}
.dshLimobDetailTitle { font-size: 13px; font-weight: 600; line-height: 18px; }
.dshLimobDetailMuted { color: var(--drr-text-3); }
.dshLimobDetailCode {
  display: block;
  padding: 9px 11px;
  border-radius: var(--drr-r-xs);
  background: color-mix(in srgb, var(--drr-text) 5%, transparent);
  font-family: var(--drr-mono);
  font-size: 11px;
  line-height: 16px;
  word-break: break-all;
  user-select: text;
}
.dshLimobDetailActions { display: flex; flex-wrap: wrap; gap: 8px; }
.dshLimobDetailBtn {
  display: inline-flex;
  align-items: center;
  height: 28px;
  padding: 0 11px;
  border: 1px solid var(--drr-line-2);
  border-radius: var(--drr-r-sm);
  background: transparent;
  color: var(--drr-text);
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  text-decoration: none;
  cursor: pointer;
  transition: background-color .14s var(--drr-ease), border-color .14s var(--drr-ease), opacity .14s var(--drr-ease);
}
.dshLimobDetailBtn:hover { background: var(--drr-fill-1); }
.dshLimobDetailBtn[disabled] { opacity: .55; cursor: default; }

/* ---- 11. 动效降级 ---- */
@media (prefers-reduced-motion: reduce) {
  .dshRunnerPage *,
  .dshRunnerDialog *,
  .dshLimobCfgPage *,
  .dshLimobCfgModal *,
  .dshLimobRunDock *,
  .dshLimobRunMenu *,
  .dshRunnerHeaderFloat *,
  .dshRunnerLogBubble * {
    animation-duration: .01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: .01ms !important;
  }
}
`;

    function ensureStyles() {
      if (typeof document === "undefined") return;
      if (document.getElementById(STYLE_ID) !== null) return;
      var style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    // factory 阶段注入，模块系统认领并在插件卸载时清理。
    ensureStyles();

    // =====================================================================
    // 三、通用小工具
    // =====================================================================
    function getService(ctx, name) {
      if (ctx === null || ctx === undefined) return undefined;
      try {
        return ctx.get(name);
      } catch (_error) {
        return undefined;
      }
    }

    function messageOf(error) {
      if (error === undefined || error === null) return "未知错误";
      if (typeof error === "string") return error;
      if (error.message) return String(error.message);
      return String(error);
    }

    function logPluginError(ctx, message, error) {
      if (ctx !== null && ctx !== undefined && ctx.logger !== undefined && ctx.logger !== null
        && typeof ctx.logger.error === "function") {
        ctx.logger.error("dsh-runner: " + message, error);
      } else if (typeof console !== "undefined") {
        console.error("dsh-runner: " + message, error);
      }
    }

    function copyTextToClipboard(text) {
      try {
        if (typeof navigator !== "undefined" && navigator.clipboard !== undefined
          && typeof navigator.clipboard.writeText === "function") {
          navigator.clipboard.writeText(text);
          return true;
        }
      } catch (_error) {
        /* 回退到 execCommand */
      }
      try {
        if (typeof document !== "undefined") {
          var area = document.createElement("textarea");
          area.value = text;
          area.style.position = "fixed";
          area.style.opacity = "0";
          document.body.appendChild(area);
          area.select();
          var copied = document.execCommand("copy");
          area.remove();
          return copied;
        }
      } catch (_error) {
        /* 复制失败由调用方提示 */
      }
      return false;
    }

    // =====================================================================
    // 四、版本比较与更新检查
    // =====================================================================
    function parseVersion(text) {
      var match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(text === undefined || text === null ? "" : text).trim());
      if (match === null) return null;
      return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        prerelease: match[4] === undefined ? [] : match[4].split(".")
      };
    }

    function compareVersions(left, right) {
      var a = parseVersion(left);
      var b = parseVersion(right);
      if (a === null || b === null) return 0;
      var coreA = [a.major, a.minor, a.patch];
      var coreB = [b.major, b.minor, b.patch];
      for (var i = 0; i < 3; i += 1) {
        if (coreA[i] !== coreB[i]) return coreA[i] > coreB[i] ? 1 : -1;
      }
      if (a.prerelease.length === 0 && b.prerelease.length > 0) return 1;
      if (a.prerelease.length > 0 && b.prerelease.length === 0) return -1;
      var length = Math.max(a.prerelease.length, b.prerelease.length);
      for (var j = 0; j < length; j += 1) {
        var partA = a.prerelease[j];
        var partB = b.prerelease[j];
        if (partA === undefined) return -1;
        if (partB === undefined) return 1;
        var numericA = /^\d+$/.test(partA);
        var numericB = /^\d+$/.test(partB);
        if (numericA && numericB) {
          if (Number(partA) !== Number(partB)) return Number(partA) > Number(partB) ? 1 : -1;
        } else if (numericA !== numericB) {
          return numericA ? -1 : 1;
        } else if (partA !== partB) {
          return partA > partB ? 1 : -1;
        }
      }
      return 0;
    }

    function stripVersionPrefix(text) {
      return String(text === undefined || text === null ? "" : text).trim().replace(/^v/i, "");
    }

    function readUpdateCache() {
      try {
        if (typeof localStorage === "undefined") return null;
        var raw = localStorage.getItem(UPDATE_CACHE_KEY);
        if (raw === null) return null;
        var value = JSON.parse(raw);
        if (value === null || typeof value !== "object") return null;
        if (typeof value.checkedAt !== "number" || typeof value.latestVersion !== "string") return null;
        return value;
      } catch (_error) {
        return null;
      }
    }

    function writeUpdateCache(value) {
      try {
        if (typeof localStorage === "undefined") return;
        localStorage.setItem(UPDATE_CACHE_KEY, JSON.stringify(value));
      } catch (_error) {
        /* 缓存写失败只影响下次是否重新请求 GitHub，忽略 */
      }
    }

    async function fetchLatestVersion() {
      if (typeof fetch !== "function") throw new Error("当前环境没有 fetch，无法检查更新");
      var controller = new AbortController();
      var timer = setTimeout(function () {
        controller.abort();
      }, 8000);
      try {
        var response = await fetch(GITHUB_API_LATEST + "?t=" + Date.now(), {
          headers: { Accept: "application/vnd.github+json" },
          signal: controller.signal,
          cache: "no-store"
        });
        if (response.ok) {
          var release = await response.json();
          var tag = release.tag_name || release.name;
          if (typeof tag === "string" && parseVersion(tag) !== null) {
            return { version: stripVersionPrefix(tag), url: release.html_url || GITHUB_RELEASES_PAGE };
          }
        }
        var packageResponse = await fetch(GITHUB_RAW_PACKAGE + "?t=" + Date.now(), {
          signal: controller.signal,
          cache: "no-store"
        });
        if (!packageResponse.ok) throw new Error("GitHub 返回 HTTP " + String(packageResponse.status));
        var manifest = await packageResponse.json();
        if (typeof manifest.version !== "string" || parseVersion(manifest.version) === null) {
          throw new Error("GitHub 上的 package.json 没有有效 version");
        }
        return { version: stripVersionPrefix(manifest.version), url: GITHUB_RELEASES_PAGE };
      } finally {
        clearTimeout(timer);
      }
    }

    async function checkForUpdate(force) {
      var cached = readUpdateCache();
      var now = Date.now();
      if (!force && cached !== null && cached.installedVersion === PLUGIN_VERSION
        && cached.phase === "ready" && now - cached.checkedAt < UPDATE_TTL_MS) {
        return cached;
      }
      try {
        var latest = await fetchLatestVersion();
        var result = {
          phase: "ready",
          installedVersion: PLUGIN_VERSION,
          latestVersion: latest.version,
          available: compareVersions(latest.version, PLUGIN_VERSION) > 0,
          releaseUrl: latest.url,
          checkedAt: now
        };
        writeUpdateCache(result);
        return result;
      } catch (error) {
        return {
          phase: "error",
          installedVersion: PLUGIN_VERSION,
          available: false,
          message: messageOf(error),
          releaseUrl: GITHUB_RELEASES_PAGE,
          checkedAt: now
        };
      }
    }

    var pendingUpdateCheck = null;
    function checkForUpdateShared(force) {
      if (!force && pendingUpdateCheck !== null) return pendingUpdateCheck;
      var promise = checkForUpdate(force);
      pendingUpdateCheck = promise;
      promise.then(function () {
        if (pendingUpdateCheck === promise) pendingUpdateCheck = null;
      }, function () {
        if (pendingUpdateCheck === promise) pendingUpdateCheck = null;
      });
      return promise;
    }

    function openPluginUpdatePage(ctx, releaseUrl, notify) {
      var navigation = getService(ctx, "pluginNavigation");
      if (navigation !== undefined && navigation !== null && typeof navigation.openBundle === "function") {
        try {
          navigation.openBundle(PLUGIN_NAME);
          return true;
        } catch (_error) {
          /* 回退到复制发布页地址 */
        }
      }
      var url = releaseUrl || GITHUB_RELEASES_PAGE;
      var copied = copyTextToClipboard(url);
      if (typeof notify === "function") {
        notify(copied ? ("更新说明地址已复制：" + url) : ("请手动打开更新说明：" + url));
      }
      return false;
    }

    // =====================================================================
    // 五、Host RPC（失败一律 throw，code/details 透传）
    // =====================================================================
    function connectionOf() {
      if (hostConnection !== null && hostConnection !== undefined) return hostConnection;
      // connection 服务可能比 apply 晚就绪：这里再取一次（不是数据兜底）。
      if (runtimeCtx !== null && runtimeCtx !== undefined) {
        try {
          var value = runtimeCtx.get("connection");
          if (value !== undefined && value !== null) {
            hostConnection = value;
            return value;
          }
        } catch (_error) {
          /* 没有 connection 服务：下面按「无连接」抛出明确错误 */
        }
      }
      return null;
    }

    function rpcError(code, message, details) {
      var error = new Error(message);
      error.code = code;
      error.details = details;
      return error;
    }

    /**
     * 调用 Host 半体注册的 RPC。
     * 成功返回 value；失败 throw（err.code / err.details 来自 Host 结构化错误）；无连接直接 throw。
     */
    async function rpc(endpoint, payload) {
      var connection = connectionOf();
      if (connection === null || connection.rpc === undefined || connection.rpc === null
        || typeof connection.rpc.call !== "function") {
        throw rpcError("no-connection", "Host 项目运行器不可用（RPC 未连接）", undefined);
      }
      var result;
      try {
        result = await connection.rpc.call(RPC_CHANNEL, RPC_NAMESPACE + "/" + endpoint, payload === undefined ? {} : payload);
      } catch (error) {
        throw rpcError(
          error !== null && error !== undefined && typeof error.code === "string" ? error.code : "rpc-failed",
          messageOf(error) + "（" + endpoint + "）",
          error !== null && error !== undefined ? error.details : undefined
        );
      }
      if (result === null || result === undefined || typeof result !== "object") {
        throw rpcError("rpc-failed", "Host RPC " + endpoint + " 没有返回结果", undefined);
      }
      if (result.ok !== true) {
        var info = result.error !== null && result.error !== undefined && typeof result.error === "object" ? result.error : {};
        throw rpcError(
          typeof info.code === "string" ? info.code : "rpc-failed",
          typeof info.message === "string" && info.message !== "" ? info.message : ("RPC 失败：" + endpoint),
          info.details
        );
      }
      return result.value;
    }

    // =====================================================================
    // 六、配置 store（内存 + 订阅；唯一数据来源是 Host）
    // =====================================================================
    var configState = null;
    var configLoaded = false;
    var configListeners = new Set();

    function getConfigSnapshot() {
      return configState;
    }

    function notifyConfig() {
      configListeners.forEach(function (listener) {
        try {
          listener();
        } catch (error) {
          logPluginError(runtimeCtx, "配置订阅回调异常", error);
        }
      });
    }

    function setConfigState(next) {
      configState = next;
      configLoaded = true;
      notifyConfig();
    }

    function subscribeConfig(listener) {
      configListeners.add(listener);
      return function () {
        configListeners.delete(listener);
      };
    }

    function useStoreFallback(subscribe, getSnapshot) {
      var pair = react.useState(getSnapshot());
      react.useEffect(function () {
        return subscribe(function () {
          pair[1](getSnapshot());
        });
      }, []);
      return pair[0];
    }

    function useConfig() {
      if (typeof react.useSyncExternalStore === "function") {
        return react.useSyncExternalStore(subscribeConfig, getConfigSnapshot, getConfigSnapshot);
      }
      return useStoreFallback(subscribeConfig, getConfigSnapshot);
    }

    /** 从 Host 读取最新配置并写入内存 store（返回 RPC 的整个 value）。 */
    async function loadConfig() {
      var value = await rpc("config/get", {});
      setConfigState(value !== null && value !== undefined && value.config !== undefined ? value.config : null);
      return value;
    }

    /**
     * 调 config/* 写接口：Host 返回的 config 就是唯一事实，直接覆盖 store；返回整个 value。
     * 失败由 rpc throw，调用方展示并保持 store 不变。
     */
    async function mutate(endpoint, payload) {
      var value = await rpc(endpoint, payload);
      if (value !== null && value !== undefined && value.config !== undefined) setConfigState(value.config);
      return value;
    }

    // 面板折叠偏好的模块级缓存：apply() 预取，页面切换时直接用缓存渲染，
    // 避免「先按默认全展开渲染一帧、再被 ui/get 的异步结果折叠」的闪烁。
    var uiStateCache = null;
    var uiStateLoadPromise = null;

    // 日志尾部缓存：切走再回来时先渲染上次的内容，再把轮询结果贴上去。
    // 只存最近看过的 8 条命令（每条最多 LOG_MAX_BYTES）：既覆盖来回切换，又不会无限吃内存。
    var logTailCache = new Map();
    var LOG_TAIL_CACHE_LIMIT = 8;

    function logTailKeyOf(projectPath, commandId) {
      return normalizePath(projectPath === undefined || projectPath === null ? "" : projectPath)
        + "|" + String(commandId);
    }

    function rememberLogTail(key, value) {
      if (logTailCache.has(key)) logTailCache.delete(key);
      logTailCache.set(key, value);
      while (logTailCache.size > LOG_TAIL_CACHE_LIMIT) {
        var oldest = logTailCache.keys().next();
        if (oldest.done === true) break;
        logTailCache.delete(oldest.value);
      }
    }

    /** 上次查看的日志：{ projectPath, commandId } 或 null（形状不对就当没记过）。 */
    function normalizeLastSelected(raw) {
      if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) return null;
      if (typeof raw.commandId !== "string" || raw.commandId.trim() === "") return null;
      return {
        projectPath: typeof raw.projectPath === "string" ? normalizePath(raw.projectPath) : "",
        commandId: raw.commandId.trim()
      };
    }

    function normalizeUiSnapshot(state) {
      var projectColors = {};
      if (state !== null && state !== undefined && state.projectColors !== null
        && typeof state.projectColors === "object" && !Array.isArray(state.projectColors)) {
        for (var key in state.projectColors) {
          if (!Object.prototype.hasOwnProperty.call(state.projectColors, key)) continue;
          if (typeof state.projectColors[key] === "string" && state.projectColors[key] !== "") {
            projectColors[normalizePath(key)] = state.projectColors[key];
          }
        }
      }
      return {
        collapsedProjects: state !== null && state !== undefined && Array.isArray(state.collapsedProjects) ? state.collapsedProjects : [],
        collapsedGlobal: state !== null && state !== undefined && state.collapsedGlobal === true,
        projectColors: projectColors,
        lastSelected: normalizeLastSelected(state !== null && state !== undefined ? state.lastSelected : undefined)
      };
    }

    function storeUiState(snapshot) {
      uiStateCache = normalizeUiSnapshot(snapshot);
      return uiStateCache;
    }

    function prefetchUiState() {
      if (uiStateCache !== null) return Promise.resolve(uiStateCache);
      if (uiStateLoadPromise !== null) return uiStateLoadPromise;
      uiStateLoadPromise = rpc("ui/get", {}).then(function (value) {
        return storeUiState(value !== null && value !== undefined ? value.uiState : undefined);
      }, function (error) {
        uiStateLoadPromise = null;
        throw error;
      });
      return uiStateLoadPromise;
    }

    function refreshUiState() {
      return rpc("ui/get", {}).then(function (value) {
        return storeUiState(value !== null && value !== undefined ? value.uiState : undefined);
      });
    }

    function commandsOf(config) {
      return config !== null && config !== undefined && Array.isArray(config.commands) ? config.commands : [];
    }

    function findCommandOf(config, commandId) {
      var commands = commandsOf(config);
      for (var i = 0; i < commands.length; i += 1) {
        if (commands[i] !== null && commands[i] !== undefined && commands[i].id === commandId) return commands[i];
      }
      return undefined;
    }

    function uiVisibleOf(config) {
      if (config === null || config === undefined || config.ui === null || config.ui === undefined) return true;
      return config.ui.visible !== false;
    }

    // =====================================================================
    // 七、纯函数（路径 / 状态 / 日志格式化）
    // =====================================================================
    function normalizePath(path) {
      return String(path === undefined || path === null ? "" : path)
        .trim()
        .replace(/\//g, "\\")
        .replace(/\\+$/g, "")
        .toLowerCase();
    }

    /** 命令是否属于当前项目：项目根目录相同，或当前项目位于该根目录之下。 */
    function commandMatchesProject(command, projectPath) {
      if (command === null || command === undefined || command.scope !== "project") return false;
      var root = normalizePath(command.projectRoot);
      var current = normalizePath(projectPath);
      if (root === "" || current === "") return false;
      return current === root || current.indexOf(root + "\\") === 0;
    }

    /** 当前项目应显示的命令：匹配项目的 project 命令 + 所有 global 命令。 */
    function visibleCommandsForProject(config, projectPath) {
      var list = [];
      var commands = commandsOf(config);
      for (var i = 0; i < commands.length; i += 1) {
        var command = commands[i];
        if (command === null || command === undefined) continue;
        if (command.scope === "global" || commandMatchesProject(command, projectPath)) list.push(command);
      }
      return list;
    }

    /** 某条命令的声明端口是否被「非托管」进程占用（按项目 + commandId 定位，用于显示外部运行中）。 */
    function externalOccupancyForCommand(entries, commandId, projectPath) {
      if (!Array.isArray(entries)) return undefined;
      var wantedPath = typeof projectPath === "string" && projectPath !== "" ? normalizePath(projectPath) : null;
      for (var i = 0; i < entries.length; i += 1) {
        var entry = entries[i];
        if (entry === null || entry === undefined) continue;
        if (entry.commandId !== commandId) continue;
        var processEntry = entry.kind === "process" && Array.isArray(entry.processes) && entry.processes.length > 0;
        if (entry.listening !== true && !processEntry) continue;
        if (entry.occupant === null || entry.occupant === undefined) continue;
        if (entry.occupant.managed === true) continue;
        if (wantedPath !== null && typeof entry.projectPath === "string" && normalizePath(entry.projectPath) !== wantedPath) continue;
        return entry;
      }
      return undefined;
    }

    /** 项目分组 key 是否在折叠列表里（路径统一规范）。 */
    function isProjectCollapsed(collapsedProjects, projectPath) {
      if (!Array.isArray(collapsedProjects)) return false;
      var key = normalizePath(projectPath);
      if (key === "") return false;
      for (var i = 0; i < collapsedProjects.length; i += 1) {
        if (normalizePath(collapsedProjects[i]) === key) return true;
      }
      return false;
    }

    /** 切换某项目分组的折叠状态，返回新的折叠列表（纯函数，持久化用）。 */
    function toggleCollapsedProject(collapsedProjects, projectPath) {
      var key = normalizePath(projectPath);
      var list = Array.isArray(collapsedProjects) ? collapsedProjects.slice() : [];
      if (key === "") return list;
      for (var i = 0; i < list.length; i += 1) {
        if (normalizePath(list[i]) === key) {
          list.splice(i, 1);
          return list;
        }
      }
      list.push(key);
      return list;
    }

    // 项目色板：按项目路径自动分配（稳定哈希），可在「运行」面板覆盖；覆盖值持久化在 Host ui-state。
    var PROJECT_COLOR_PALETTE = [
      { id: "blue", accent: "#3b82f6", tint: "rgba(59,130,246,.18)" },
      { id: "cyan", accent: "#06b6d4", tint: "rgba(6,182,212,.18)" },
      { id: "teal", accent: "#14b8a6", tint: "rgba(20,184,166,.18)" },
      { id: "green", accent: "#22c55e", tint: "rgba(34,197,94,.16)" },
      { id: "lime", accent: "#84cc16", tint: "rgba(132,204,22,.16)" },
      { id: "amber", accent: "#f59e0b", tint: "rgba(245,158,11,.18)" },
      { id: "orange", accent: "#f97316", tint: "rgba(249,115,22,.18)" },
      { id: "rose", accent: "#f43f5e", tint: "rgba(244,63,94,.16)" },
      { id: "pink", accent: "#ec4899", tint: "rgba(236,72,153,.16)" },
      { id: "violet", accent: "#8b5cf6", tint: "rgba(139,92,246,.18)" },
      { id: "indigo", accent: "#6366f1", tint: "rgba(99,102,241,.18)" },
      { id: "slate", accent: "#64748b", tint: "rgba(100,116,139,.18)" }
    ];

    /** 稳定哈希：同一项目永远分配同一自动颜色。 */
    function projectColorHash(text) {
      var hash = 2166136261;
      for (var i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      return hash >>> 0;
    }

    /** 项目颜色：用户覆盖优先，否则按路径哈希从色板取。 */
    function projectColorOf(projectPath, projectColors) {
      var key = normalizePath(projectPath);
      if (projectColors !== null && projectColors !== undefined && typeof projectColors === "object"
        && typeof projectColors[key] === "string" && projectColors[key] !== "") {
        var overrideId = projectColors[key];
        for (var i = 0; i < PROJECT_COLOR_PALETTE.length; i += 1) {
          if (PROJECT_COLOR_PALETTE[i].id === overrideId) return PROJECT_COLOR_PALETTE[i];
        }
      }
      if (key === "") return PROJECT_COLOR_PALETTE[0];
      return PROJECT_COLOR_PALETTE[projectColorHash(key) % PROJECT_COLOR_PALETTE.length];
    }

    function projectColorPalette() {
      return PROJECT_COLOR_PALETTE;
    }

    /**
     * 顶部 chip 的可执行动作。
     * - 外部占用（external）只读：结束进程属于破坏性操作，统一留在「运行」面板里做；
     * - 未运行 → 启动；运行中/启动中 → 停止 + 重启；停止中 → 只显示，不重复操作。
     */
    function headerActionsFor(status, hasRunner, external) {
      if (external === true) return { start: false, stop: false, restart: false };
      if (status === "queued") return { start: false, stop: true, restart: false };
      if (status === "running" || status === "starting") {
        return { start: false, stop: true, restart: hasRunner === true };
      }
      if (status === "stopping") return { start: false, stop: false, restart: false };
      return { start: true, stop: false, restart: false };
    }

    /**
     * 「运行」面板行内的三个动作（纯函数，便于离线断言）。
     * - 外部运行中（未接管）：接管（只改归属）+ 重启（确认后结束外部实例并改为托管启动）；
     * - 已接管的外部实例：停止 + 重启（重启天然会换成托管进程，之后有实时日志）；
     * - 普通托管：未运行 → 启动；运行中/启动中 → 停止 + 重启；停止中 → 只读。
     */
    function rowActionsFor(options) {
      var status = options !== null && options !== undefined && typeof options.status === "string" ? options.status : "idle";
      var hasRunner = options !== null && options !== undefined && options.hasRunner === true;
      var external = options !== null && options !== undefined && options.external === true;
      var canAct = options !== null && options !== undefined && options.canAct !== false;
      var disabled = options !== null && options !== undefined && options.disabled === true;
      var canStart = canAct && options !== null && options !== undefined && options.runnerOnly !== true;
      var active = status === "queued" || status === "starting" || status === "running" || status === "stopping";
      var needsHost = !hasRunner && external;
      if (disabled) return { adopt: false, start: false, stop: false, restart: false, label: "启动" };
      if (needsHost) {
        return {
          adopt: canStart && !active,
          start: false,
          stop: false,
          // 端到端「重启并接管」会结束外部进程，属破坏性动作：配置里还有这条命令才允许
          restart: canStart && status !== "stopping",
          label: "接管"
        };
      }
      return {
        adopt: false,
        start: canStart && !active,
        // 排队中/启动中/运行中都能停；停止中不再给「停止」（重复触发只会打断状态机）。
        stop: canAct && hasRunner && (status === "running" || status === "starting" || status === "queued"),
        restart: canStart && status !== "stopping" && status !== "queued",
        label: "启动"
      };
    }

    /**
     * 全局运行面板分组：project 命令按 projectRoot 分组；global 命令跟随当前项目（无当前项目时单列）。
     * 返回 [{ key, projectPath, global, commands }]，当前项目优先、其余按路径排序、全局最后。
     */
    function buildRunnerSections(config, currentProjectPath) {
      var commands = commandsOf(config);
      var sections = [];
      var byKey = {};
      var currentKey = typeof currentProjectPath === "string" && currentProjectPath !== "" ? normalizePath(currentProjectPath) : null;
      function sectionFor(pathValue) {
        var key = normalizePath(pathValue);
        if (byKey[key] === undefined) {
          var section = { key: key, projectPath: pathValue, global: false, commands: [] };
          byKey[key] = section;
          sections.push(section);
        }
        return byKey[key];
      }
      function globalSection() {
        if (byKey.__global__ === undefined) {
          var section = { key: "__global__", projectPath: undefined, global: true, commands: [] };
          byKey.__global__ = section;
          sections.push(section);
        }
        return byKey.__global__;
      }
      for (var i = 0; i < commands.length; i += 1) {
        var command = commands[i];
        if (command === null || command === undefined) continue;
        if (command.scope === "global") {
          if (currentKey !== null) sectionFor(currentProjectPath).commands.push(command);
          else globalSection().commands.push(command);
          continue;
        }
        var root = typeof command.projectRoot === "string" ? command.projectRoot.trim() : "";
        if (root === "") continue;
        sectionFor(root).commands.push(command);
      }
      sections.sort(function (left, right) {
        if (left.global !== right.global) return left.global ? 1 : -1;
        var leftCurrent = currentKey !== null && left.key === currentKey;
        var rightCurrent = currentKey !== null && right.key === currentKey;
        if (leftCurrent !== rightCurrent) return leftCurrent ? -1 : 1;
        if (left.key < right.key) return -1;
        if (left.key > right.key) return 1;
        return 0;
      });
      return sections;
    }

    function runnerStatusText(status) {
      if (status === "external") return "外部运行中";
      if (status === "queued") return "排队中";
      if (status === "starting") return "启动中";
      if (status === "running") return "运行中";
      if (status === "stopping") return "停止中";
      if (status === "stopped") return "已停止";
      if (status === "exited") return "已退出";
      if (status === "failed") return "启动失败";
      return "未运行";
    }

    /** 去掉 ANSI 转义（CSI 颜色/光标、OSC 标题/超链接），日志展示用。 */
    function stripAnsi(text) {
      var value = String(text === undefined || text === null ? "" : text);
      return value
        .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
        .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
        .replace(/\u001b[@-_]/g, "");
    }

    function pad2(value) {
      return (value < 10 ? "0" : "") + String(value);
    }

    /** 运行时长：0s / 1m 05s / 1h 02m。 */
    function formatUptime(ms) {
      var number = Number(ms);
      if (!Number.isFinite(number) || number < 0) return "—";
      var total = Math.floor(number / 1000);
      if (total >= 3600) return Math.floor(total / 3600) + "h " + pad2(Math.floor((total % 3600) / 60)) + "m";
      if (total >= 60) return Math.floor(total / 60) + "m " + pad2(total % 60) + "s";
      return total + "s";
    }

    /** 字节数：0 B / 512 B / 64.0 KB / 1.0 MB。 */
    function formatBytes(bytes) {
      var value = Number(bytes);
      if (!Number.isFinite(value) || value < 0) return "0 B";
      if (value < 1024) return Math.floor(value) + " B";
      if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KB";
      return (value / (1024 * 1024)).toFixed(1) + " MB";
    }

    /** 错误条里补充的结构化详情（端口冲突 / 依赖失败）。 */
    function errorDetailText(error) {
      if (error === null || error === undefined) return "";
      var details = error.details;
      if ((error.code === "port-conflict" || error.code === "port-mismatch")
        && details !== null && details !== undefined && Array.isArray(details.ports)) {
        var text = details.ports.map(function (item) {
          return "端口 " + String(item.port) + (item.occupant === undefined ? "" : " · " + occupantSummary(item.occupant));
        }).join("；");
        if (Array.isArray(details.actualPorts) && details.actualPorts.length > 0) {
          text += "；实际绑定：" + details.actualPorts.map(String).join("、");
        }
        return text;
      }
      if (error.code === "managed-port" && details !== null && details !== undefined && details.occupant !== undefined) {
        return "端口 " + String(details.port) + " 由托管命令占用：" + occupantSummary(details.occupant);
      }
      if (error.code === "port-changed" && details !== null && details !== undefined && details.occupant !== undefined) {
        return "端口 " + String(details.port) + " 已换成 " + occupantSummary(details.occupant);
      }
      if (error.code === "dependency-failed" && details !== null && details !== undefined && typeof details === "object") {
        return "依赖命令 " + String(details.commandId) + " 启动失败：" + String(details.message);
      }
      if (error.code === "ready-timeout" && details !== null && details !== undefined && typeof details === "object") {
        return "端口 " + String(details.port) + " 未在 " + String(details.timeoutMs) + "ms 内就绪";
      }
      if (details !== null && details !== undefined && typeof details === "object" && Object.keys(details).length > 0) {
        return JSON.stringify(details);
      }
      return "";
    }

    /** 占用者的简短描述：name（PID 1234）。 */
    function occupantSummary(occupant) {
      if (occupant === null || occupant === undefined) return "未知进程";
      var name = typeof occupant.name === "string" && occupant.name !== "" ? occupant.name : "进程";
      var suffix = typeof occupant.pid === "number" ? "（PID " + String(occupant.pid) + "）" : "";
      return name + suffix;
    }

    /** 父进程链：cmd.exe（123）← Code.exe（45，窗口：项目 - Visual Studio Code）；没有祖先时返回空串。 */
    function formatProcessChain(occupant) {
      if (occupant === null || occupant === undefined || !Array.isArray(occupant.ancestors)) return "";
      var parts = [];
      for (var i = 0; i < occupant.ancestors.length; i += 1) {
        var item = occupant.ancestors[i];
        if (item === null || item === undefined) continue;
        var name = typeof item.name === "string" && item.name !== "" ? item.name : "进程";
        var title = typeof item.windowTitle === "string" && item.windowTitle !== "" ? "，窗口：" + item.windowTitle : "";
        var pidText = typeof item.pid === "number" ? String(item.pid) : "?";
        parts.push(name + "（" + pidText + title + "）");
      }
      return parts.join(" ← ");
    }

    /** 子进程摘要：a.exe（12）、b.exe（34），最多 6 个；没有返回空串。 */
    function formatProcessChildren(occupant) {
      if (occupant === null || occupant === undefined || !Array.isArray(occupant.children)) return "";
      var parts = [];
      for (var i = 0; i < occupant.children.length && i < 6; i += 1) {
        var item = occupant.children[i];
        if (item === null || item === undefined) continue;
        var name = typeof item.name === "string" && item.name !== "" ? item.name : "进程";
        parts.push(name + (typeof item.pid === "number" ? "（" + String(item.pid) + "）" : ""));
      }
      if (occupant.children.length > 6) parts.push("…");
      return parts.join("、");
    }

    /** 是否是端口阻塞错误（port-conflict / port-mismatch，均带占用者列表）。 */
    function isPortBlockingError(error) {
      return error !== null && error !== undefined
        && (error.code === "port-conflict" || error.code === "port-mismatch")
        && error.details !== null && error.details !== undefined && Array.isArray(error.details.ports);
    }

    // =====================================================================
    // 八、会话 / 工作区 hooks
    // =====================================================================
    /** 从壳层 slots 提供的 hooks 里解析「当前会话 + 当前工作区路径」。 */
    function useActiveSession(hooks) {
      var sessions = hooks !== undefined && hooks !== null && typeof hooks.useSessions === "function"
        ? hooks.useSessions(function (state) { return state; })
        : undefined;
      var workspaces = hooks !== undefined && hooks !== null && typeof hooks.useWorkspaces === "function"
        ? hooks.useWorkspaces(function (state) { return state; })
        : undefined;
      var active = null;
      if (sessions !== undefined && sessions !== null && sessions.byId !== undefined && sessions.byId !== null) {
        var ids = Object.keys(sessions.byId);
        for (var i = 0; i < ids.length; i += 1) {
          var record = sessions.byId[ids[i]];
          if (record !== null && record !== undefined && record.retainedBy !== undefined
            && record.retainedBy !== null && (record.retainedBy.mainView || 0) > 0) {
            active = record;
            break;
          }
        }
      }
      var sessionId = active !== null ? (active.id || active.sessionId) : undefined;
      var projectPath = undefined;
      if (sessionId !== undefined && workspaces !== undefined && workspaces !== null
        && Array.isArray(workspaces.items)) {
        for (var j = 0; j < workspaces.items.length; j += 1) {
          var workspace = workspaces.items[j];
          if (workspace !== null && workspace !== undefined && Array.isArray(workspace.sessionIds)
            && workspace.sessionIds.indexOf(sessionId) !== -1) {
            projectPath = workspace.path;
            break;
          }
        }
      }
      if (projectPath === undefined && active !== null && typeof active.cwd === "string") {
        projectPath = active.cwd;
      }
      return {
        sessionId: sessionId,
        projectPath: projectPath,
        sessionTitle: active !== null ? active.title : undefined
      };
    }

    /** 由工作区快照反查某个会话所属工作区路径（composer 按钮用）。 */
    function useProjectPath(useWorkspaces, sessionId) {
      var workspaces = typeof useWorkspaces === "function" ? useWorkspaces(function (state) { return state; }) : undefined;
      if (sessionId === undefined || workspaces === undefined || workspaces === null || !Array.isArray(workspaces.items)) {
        return undefined;
      }
      for (var i = 0; i < workspaces.items.length; i += 1) {
        var workspace = workspaces.items[i];
        if (workspace !== null && workspace !== undefined && Array.isArray(workspace.sessionIds)
          && workspace.sessionIds.indexOf(sessionId) !== -1) {
          return workspace.path;
        }
      }
      return undefined;
    }

    // =====================================================================
    // 九、更新状态 hook 与插件详情页提示
    // =====================================================================
    function useUpdateStatus() {
      var pair = react.useState({ phase: "checking" });
      var state = pair[0];
      var setState = pair[1];
      react.useEffect(function () {
        var alive = true;
        var timer = setTimeout(function () {
          checkForUpdateShared(false).then(function (result) {
            if (alive) setState(result);
          });
        }, 900);
        return function () {
          alive = false;
          clearTimeout(timer);
        };
      }, []);
      return [state, setState];
    }

    function isOwnBundleSubject(subject) {
      return subject !== undefined && subject !== null && subject.kind === "bundle"
        && subject.pkg !== undefined && subject.pkg !== null && subject.pkg.name === PLUGIN_NAME;
    }

    /** 插件详情页标题旁：只有发现新版本时才显示。 */
    function LimobUpdateBadge(props) {
      if (!isOwnBundleSubject(props && props.subject)) return null;
      var pair = useUpdateStatus();
      var update = pair[0];
      if (update === undefined || update === null || !update.available) return null;
      return h("span", {
        className: "dshLimobUpdateBadge",
        title: "发现新版本 v" + update.latestVersion + "，打开本插件详情查看升级方式"
      }, "可更新 v" + update.latestVersion);
    }

    /** 插件详情页底部：版本、检查按钮、升级命令与发布页。 */
    function LimobUpdateSection(props) {
      var subject = props && props.subject;
      if (!isOwnBundleSubject(subject)) return null;
      var updatePair = useUpdateStatus();
      var update = updatePair[0];
      var setUpdate = updatePair[1];
      var copiedPair = react.useState(false);
      var copied = copiedPair[0];
      var setCopied = copiedPair[1];
      var installed = subject.pkg !== undefined && subject.pkg !== null && typeof subject.pkg.version === "string"
        ? subject.pkg.version
        : PLUGIN_VERSION;
      var checking = update !== undefined && update !== null && update.phase === "checking";
      var latest = update !== undefined && update !== null && typeof update.latestVersion === "string"
        ? ("v" + update.latestVersion)
        : (checking ? "检查中…" : "未知");
      var hint;
      if (update !== undefined && update !== null && update.phase === "error") {
        hint = "检查失败：" + update.message + "（不影响运行面板）";
      } else if (update !== undefined && update !== null && update.available) {
        hint = "发现新版本 v" + update.latestVersion + "，建议升级。";
      } else if (update !== undefined && update !== null && update.phase === "ready") {
        hint = "已是最新版本。";
      } else {
        hint = "正在检查 GitHub 更新…";
      }
      function handleCheckNow() {
        setUpdate({ phase: "checking" });
        checkForUpdateShared(true).then(function (result) {
          setUpdate(result);
        });
      }
      return h("section", { className: "dshLimobDetailSection" },
        h("div", { className: "dshLimobDetailTitle" }, "dsh-runner 更新"),
        h("div", { className: "dshLimobDetailMuted" }, "当前版本 v" + installed + " · GitHub 最新 " + latest),
        h("div", null, hint),
        h("div", { className: "dshLimobDetailMuted" },
          "升级方式：退出 DeepSeek Harness 后在 profile 目录执行下面的命令；或在「插件 → 添加插件」里粘贴 "
            + INSTALL_SPEC + " 重新安装（先卸载旧版）。"),
        h("code", { className: "dshLimobDetailCode" }, UPGRADE_COMMAND),
        h("div", { className: "dshLimobDetailActions" },
          h("button", { type: "button", className: "dshLimobDetailBtn", disabled: checking, onClick: handleCheckNow },
            checking ? "检查中…" : "检查更新"),
          h("button", {
            type: "button",
            className: "dshLimobDetailBtn",
            onClick: function () { setCopied(copyTextToClipboard(UPGRADE_COMMAND)); }
          }, copied ? "已复制" : "复制升级命令"),
          h("a", {
            className: "dshLimobDetailBtn",
            href: GITHUB_RELEASES_PAGE,
            target: "_blank",
            rel: "noreferrer"
          }, "打开发布页")));
    }

    // =====================================================================
    // 十、工作区选项 / 小图标
    // =====================================================================
    /** 从 useWorkspaces 快照里取出「项目选择器」选项（去重、保留标题）。 */
    function workspaceOptionsFrom(useWorkspaces) {
      var workspaces = typeof useWorkspaces === "function" ? useWorkspaces(function (state) { return state; }) : undefined;
      var items = workspaces !== undefined && workspaces !== null && Array.isArray(workspaces.items) ? workspaces.items : [];
      var seen = {};
      var options = [];
      for (var i = 0; i < items.length; i += 1) {
        var workspace = items[i];
        if (workspace === null || workspace === undefined || typeof workspace.path !== "string" || workspace.path === "") continue;
        var key = normalizePath(workspace.path);
        if (seen[key] === true) continue;
        seen[key] = true;
        var title = typeof workspace.title === "string" && workspace.title !== ""
          ? workspace.title
          : (workspace.path.split(/[\\/]/).filter(Boolean).pop() || workspace.path);
        options.push({ path: workspace.path, title: title });
      }
      return options;
    }

    /** 在项目选项里找路径对应的标题；找不到返回路径最后一段。 */
    function projectTitleOf(path, options) {
      if (path === undefined || path === null || path === "") return "未指定项目";
      var key = normalizePath(path);
      for (var i = 0; i < options.length; i += 1) {
        if (normalizePath(options[i].path) === key) return options[i].title;
      }
      var parts = String(path).split(/[\\/]/).filter(Boolean);
      return parts.length > 0 ? parts[parts.length - 1] : String(path);
    }

    /**
     * 插件图标集：统一 24 网格 / 2px 描边 / round 端点，只用 SVG，不用文字符号或 emoji。
     * 播放、停止是实心（媒体控件惯例），其余为线性图标；颜色一律 currentColor。
     */
    var LIMOB_ICONS = {
      play: { solid: true, paths: ["M8 4.8v14.4L20 12z"] },
      stop: { solid: true, paths: ["M8.2 6h7.6A2.2 2.2 0 0 1 18 8.2v7.6a2.2 2.2 0 0 1-2.2 2.2H8.2A2.2 2.2 0 0 1 6 15.8V8.2A2.2 2.2 0 0 1 8.2 6z"] },
      restart: { paths: ["M1 4v6h6", "M3.5 15a9 9 0 1 0 2.1-9.4L1 10"] },
      refresh: { paths: ["M23 4v6h-6", "M1 20v-6h6", "M3.5 9a9 9 0 0 1 14.9-3.4L23 10", "M1 14l4.6 4.4A9 9 0 0 0 20.5 15"] },
      chevron: { paths: ["M6 9l6 6 6-6"] },
      plus: { paths: ["M12 5v14", "M5 12h14"] },
      close: { paths: ["M6 6l12 12", "M18 6L6 18"] },
      trash: { paths: ["M3.5 6.5h17", "M8.5 6.5V4.8A1.8 1.8 0 0 1 10.3 3h3.4a1.8 1.8 0 0 1 1.8 1.8v1.7", "M6.2 6.5l.9 12a2 2 0 0 0 2 1.9h5.8a2 2 0 0 0 2-1.9l.9-12", "M10 10.5v6.5", "M14 10.5v6.5"] },
      edit: { paths: ["M17.4 3.6a2.2 2.2 0 0 1 3 3L8 19l-4 1 1-4z"] },
      up: { paths: ["M12 19V5", "M5.5 11.5 12 5l6.5 6.5"] },
      down: { paths: ["M12 5v14", "M18.5 12.5 12 19l-6.5-6.5"] },
      sliders: { paths: ["M4 8h3.5", "M11.5 8H20", "M4 16h8", "M16 16h4"], dots: [[9.5, 8], [14, 16]] },
      copy: { paths: ["M20 9h-8.5A2.5 2.5 0 0 0 9 11.5V20a2.5 2.5 0 0 0 2.5 2.5H20A2.5 2.5 0 0 0 22.5 20v-8.5A2.5 2.5 0 0 0 20 9z", "M5 15H4.5A2.5 2.5 0 0 1 2 12.5v-8A2.5 2.5 0 0 1 4.5 2h8A2.5 2.5 0 0 1 15 4.5V5"] },
      terminal: { paths: ["M4 17l6-6-6-6", "M12 19h8"] },
      alert: { paths: ["M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z", "M12 9v4", "M12 17h.01"] },
      check: { paths: ["M20 6 9 17l-5-5"] }
    };

    /** 取一个图标：limobIcon("play", 13)。未知名字返回 null（不渲染）。 */
    function limobIcon(name, size) {
      var spec = LIMOB_ICONS[name];
      if (spec === undefined) return null;
      var pixels = typeof size === "number" && size > 0 ? size : 15;
      var solid = spec.solid === true;
      var children = [];
      for (var i = 0; i < spec.paths.length; i += 1) {
        children.push(h("path", { key: "p" + String(i), d: spec.paths[i] }));
      }
      if (Array.isArray(spec.dots)) {
        for (var j = 0; j < spec.dots.length; j += 1) {
          children.push(h("circle", {
            key: "c" + String(j),
            cx: spec.dots[j][0],
            cy: spec.dots[j][1],
            r: 2.2,
            fill: "currentColor",
            stroke: "none"
          }));
        }
      }
      return h("svg", {
        width: pixels,
        height: pixels,
        viewBox: "0 0 24 24",
        "aria-hidden": "true",
        focusable: "false",
        fill: solid ? "currentColor" : "none",
        stroke: solid ? "currentColor" : "currentColor",
        "stroke-width": solid ? "1.2" : "2",
        "stroke-linecap": "round",
        "stroke-linejoin": "round"
      }, children);
    }

    /** 左侧导航「运行」面板图标：描边播放三角（props.size），与宿主图标同为线性风格。 */
    function RunnerPanelIcon(props) {
      var size = props !== undefined && props !== null && typeof props.size === "number" ? props.size : 16;
      return h("svg", {
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        "aria-hidden": "true",
        focusable: "false",
        fill: "none",
        stroke: "currentColor",
        "stroke-width": "1.8",
        "stroke-linecap": "round",
        "stroke-linejoin": "round"
      }, h("path", { d: "M8.5 4.8v14.4L20 12z" }));
    }

    // =====================================================================
    // 十一、配置编辑器（settings.section 与运行面板「管理命令」弹窗共用）
    // =====================================================================
    function emptyDraft(projectPath) {
      var hasProject = typeof projectPath === "string" && projectPath !== "";
      return {
        id: "",
        title: "",
        command: "",
        cwd: "",
        scope: hasProject ? "project" : "global",
        projectRoot: hasProject ? projectPath : "",
        enabled: true,
        envText: "",
        portsText: "",
        readyPortText: "",
        readyTimeoutText: "120000",
        dependsOn: []
      };
    }

    function draftFromCommand(command) {
      var env = command.env !== null && command.env !== undefined && typeof command.env === "object" ? command.env : {};
      var envLines = [];
      var envKeys = Object.keys(env);
      for (var i = 0; i < envKeys.length; i += 1) envLines.push(envKeys[i] + "=" + String(env[envKeys[i]]));
      var ports = Array.isArray(command.ports) ? command.ports : [];
      return {
        id: typeof command.id === "string" ? command.id : "",
        title: typeof command.title === "string" ? command.title : "",
        command: typeof command.command === "string" ? command.command : "",
        cwd: typeof command.cwd === "string" ? command.cwd : "",
        scope: command.scope === "project" ? "project" : "global",
        projectRoot: typeof command.projectRoot === "string" ? command.projectRoot : "",
        enabled: command.enabled !== false,
        envText: envLines.join("\n"),
        portsText: ports.join(", "),
        readyPortText: command.readyPort === null || command.readyPort === undefined ? "" : String(command.readyPort),
        readyTimeoutText: typeof command.readyTimeoutMs === "number" ? String(command.readyTimeoutMs) : "120000",
        dependsOn: Array.isArray(command.dependsOn) ? command.dependsOn.slice() : []
      };
    }

    /**
     * 把表单草稿转成 RPC 的 command/patch。
     * 只做「文本 → 结构」的输入解析（env 行、端口列表），语义校验交给 Host。
     */
    function parseDraft(draft) {
      var title = String(draft.title === undefined || draft.title === null ? "" : draft.title).trim();
      if (title === "") throw new Error("请填写命令名称");
      var command = String(draft.command === undefined || draft.command === null ? "" : draft.command).trim();
      if (command === "") throw new Error("请填写要执行的命令");
      var scope = draft.scope === "project" ? "project" : "global";
      var projectRoot = String(draft.projectRoot === undefined || draft.projectRoot === null ? "" : draft.projectRoot).trim();
      if (scope === "project" && projectRoot === "") throw new Error("「指定项目」必须选择或填写项目根目录");

      var env = {};
      var envLines = String(draft.envText === undefined || draft.envText === null ? "" : draft.envText).split(/\r?\n/);
      for (var i = 0; i < envLines.length; i += 1) {
        var line = envLines[i].trim();
        if (line === "" || line.charAt(0) === "#") continue;
        var matched = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
        if (matched === null) throw new Error("环境变量第 " + (i + 1) + " 行格式错误，应为 KEY=VALUE：" + line);
        env[matched[1]] = matched[2];
      }

      var ports = [];
      var portTexts = String(draft.portsText === undefined || draft.portsText === null ? "" : draft.portsText).split(/[,\s]+/);
      for (var j = 0; j < portTexts.length; j += 1) {
        var portText = portTexts[j].trim();
        if (portText === "") continue;
        var port = Number(portText);
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          throw new Error("端口必须是 0-65535 的整数：" + portText);
        }
        if (ports.indexOf(port) === -1) ports.push(port);
      }

      var readyPortText = String(draft.readyPortText === undefined || draft.readyPortText === null ? "" : draft.readyPortText).trim();
      var readyPort = null;
      if (readyPortText !== "") {
        var parsedReadyPort = Number(readyPortText);
        if (!Number.isInteger(parsedReadyPort) || parsedReadyPort < 0 || parsedReadyPort > 65535) {
          throw new Error("就绪端口必须是 0-65535 的整数：" + readyPortText);
        }
        readyPort = parsedReadyPort;
      }

      var readyTimeoutText = String(draft.readyTimeoutText === undefined || draft.readyTimeoutText === null ? "" : draft.readyTimeoutText).trim();
      var readyTimeoutMs = 120000;
      if (readyTimeoutText !== "") {
        var parsedTimeout = Number(readyTimeoutText);
        if (!Number.isInteger(parsedTimeout) || parsedTimeout < 1000 || parsedTimeout > 1800000) {
          throw new Error("就绪超时必须是不小于 1000 的整数毫秒（上限 1800000）");
        }
        readyTimeoutMs = parsedTimeout;
      }

      var dependsOn = [];
      if (Array.isArray(draft.dependsOn)) {
        for (var k = 0; k < draft.dependsOn.length; k += 1) {
          var dependency = draft.dependsOn[k];
          if (typeof dependency === "string" && dependency !== "" && dependsOn.indexOf(dependency) === -1) {
            dependsOn.push(dependency);
          }
        }
      }

      return {
        title: title,
        command: command,
        cwd: String(draft.cwd === undefined || draft.cwd === null ? "" : draft.cwd).trim(),
        scope: scope,
        projectRoot: scope === "project" ? projectRoot : "",
        enabled: draft.enabled !== false,
        env: env,
        ports: ports,
        readyPort: readyPort,
        readyTimeoutMs: readyTimeoutMs,
        dependsOn: dependsOn
      };
    }

    function ConfigEditor(props) {
      var config = useConfig();
      var currentProjectPath = props !== undefined ? props.currentProjectPath : undefined;
      var workspaces = props !== undefined && Array.isArray(props.workspaces) ? props.workspaces : [];

      var editingPair = react.useState(null);
      var editing = editingPair[0];
      var setEditing = editingPair[1];
      var busyPair = react.useState(false);
      var busy = busyPair[0];
      var setBusy = busyPair[1];
      var errorPair = react.useState("");
      var error = errorPair[0];
      var setError = errorPair[1];
      var noticePair = react.useState("");
      var notice = noticePair[0];
      var setNotice = noticePair[1];
      var deletePair = react.useState(null);
      var pendingDelete = deletePair[0];
      var setPendingDelete = deletePair[1];
      var projectCustomPair = react.useState(false);
      var projectCustom = projectCustomPair[0];
      var setProjectCustom = projectCustomPair[1];

      // 提示 3.5 秒后自动消失。
      react.useEffect(function () {
        if (notice === "") return undefined;
        var timer = setTimeout(function () {
          setNotice("");
        }, 3500);
        return function () {
          clearTimeout(timer);
        };
      }, [notice]);

      // 打开时从 Host 读一次最新配置（AI 可能刚通过 Tool 改过）。
      react.useEffect(function () {
        var alive = true;
        loadConfig().catch(function (loadError) {
          if (alive) setError(messageOf(loadError));
        });
        return function () {
          alive = false;
        };
      }, []);

      /** 项目选择器的选项：已注册工作区 + 当前工作区（若尚未注册，当前工作区排在最前）。 */
      function projectOptions() {
        var list = workspaces.slice();
        if (currentProjectPath !== undefined && currentProjectPath !== null && currentProjectPath !== "") {
          var exists = false;
          for (var i = 0; i < list.length; i += 1) {
            if (normalizePath(list[i].path) === normalizePath(currentProjectPath)) {
              exists = true;
              if (i > 0) {
                var moved = list.splice(i, 1)[0];
                list.unshift(moved);
              }
              break;
            }
          }
          if (!exists) list.unshift({ path: currentProjectPath, title: "当前工作区" });
        }
        return list;
      }

      function workspaceFor(path) {
        var list = projectOptions();
        for (var i = 0; i < list.length; i += 1) {
          if (normalizePath(list[i].path) === normalizePath(path)) return list[i];
        }
        return undefined;
      }

      function flash(text) {
        setNotice(text);
        setError("");
      }

      function startCreate() {
        setEditing(emptyDraft(currentProjectPath));
        setProjectCustom(false);
        setError("");
      }

      function startEdit(command) {
        var draft = draftFromCommand(command);
        setEditing(draft);
        setProjectCustom(draft.scope === "project" && draft.projectRoot !== "" && workspaceFor(draft.projectRoot) === undefined);
        setError("");
      }

      function updateDraft(field, value) {
        setEditing(function (previous) {
          if (previous === null || previous === undefined) return previous;
          var next = Object.assign({}, previous);
          next[field] = value;
          return next;
        });
      }

      function chooseScope(scope) {
        setEditing(function (previous) {
          if (previous === null || previous === undefined) return previous;
          var next = Object.assign({}, previous);
          next.scope = scope;
          if (scope === "project") {
            if (next.projectRoot === "") next.projectRoot = currentProjectPath !== undefined && currentProjectPath !== null ? currentProjectPath : "";
            if (next.cwd === "" && next.projectRoot !== "") next.cwd = next.projectRoot;
          }
          return next;
        });
        setProjectCustom(false);
      }

      function chooseProject(value) {
        if (value === "__custom__") {
          setProjectCustom(true);
          updateDraft("projectRoot", "");
          return;
        }
        setProjectCustom(false);
        setEditing(function (previous) {
          if (previous === null || previous === undefined) return previous;
          var next = Object.assign({}, previous);
          next.projectRoot = value;
          if (next.cwd === "") next.cwd = value;
          return next;
        });
      }

      function useProjectAsCwd() {
        setEditing(function (previous) {
          if (previous === null || previous === undefined || previous.projectRoot === "") return previous;
          var next = Object.assign({}, previous);
          next.cwd = next.projectRoot;
          return next;
        });
      }

      function toggleDependency(id) {
        setEditing(function (previous) {
          if (previous === null || previous === undefined) return previous;
          var next = Object.assign({}, previous);
          var list = Array.isArray(previous.dependsOn) ? previous.dependsOn.slice() : [];
          var index = list.indexOf(id);
          if (index === -1) list.push(id);
          else list.splice(index, 1);
          next.dependsOn = list;
          return next;
        });
      }

      async function saveDraft() {
        if (editing === null || editing === undefined || busy) return;
        setBusy(true);
        setError("");
        try {
          var payload = parseDraft(editing);
          if (editing.id === "") {
            var created = await mutate("config/create", { command: payload });
            flash("已创建：" + (created !== null && created !== undefined && created.command !== null
              && created.command !== undefined && typeof created.command.title === "string"
              ? created.command.title : payload.title));
          } else {
            var updated = await mutate("config/update", { id: editing.id, patch: payload });
            flash("已保存：" + (updated !== null && updated !== undefined && updated.command !== null
              && updated.command !== undefined && typeof updated.command.title === "string"
              ? updated.command.title : payload.title));
          }
          setEditing(null);
          setProjectCustom(false);
        } catch (saveError) {
          setError(messageOf(saveError));
        } finally {
          setBusy(false);
        }
      }

      async function removeCommand(id) {
        setBusy(true);
        setError("");
        try {
          await mutate("config/delete", { id: id });
          if (editing !== null && editing !== undefined && editing.id === id) setEditing(null);
          setPendingDelete(null);
          flash("已删除命令");
        } catch (deleteError) {
          setError(messageOf(deleteError));
        } finally {
          setBusy(false);
        }
      }

      async function moveCommand(index, delta) {
        if (busy) return;
        var commands = commandsOf(config);
        var target = index + delta;
        if (target < 0 || target >= commands.length) return;
        var ids = [];
        for (var i = 0; i < commands.length; i += 1) ids.push(commands[i].id);
        var moved = ids[index];
        ids[index] = ids[target];
        ids[target] = moved;
        setBusy(true);
        setError("");
        try {
          await mutate("config/reorder", { ids: ids });
        } catch (reorderError) {
          setError(messageOf(reorderError));
        } finally {
          setBusy(false);
        }
      }

      async function toggleEnabled(command) {
        if (busy) return;
        setBusy(true);
        setError("");
        try {
          await mutate("config/update", { id: command.id, patch: { enabled: command.enabled === false } });
        } catch (toggleError) {
          setError(messageOf(toggleError));
        } finally {
          setBusy(false);
        }
      }

      async function toggleVisible() {
        if (busy) return;
        var visible = !uiVisibleOf(config);
        setBusy(true);
        setError("");
        try {
          await mutate("config/ui", { visible: visible });
          flash(visible ? "已显示输入框下方的运行按钮" : "已隐藏输入框下方的运行按钮");
        } catch (visibleError) {
          setError(messageOf(visibleError));
        } finally {
          setBusy(false);
        }
      }

      var commands = commandsOf(config);
      var options = projectOptions();
      var projectCount = 0;
      for (var countIndex = 0; countIndex < commands.length; countIndex += 1) {
        if (commands[countIndex].scope === "project") projectCount += 1;
      }
      var currentWorkspace = currentProjectPath !== undefined && currentProjectPath !== null && currentProjectPath !== ""
        ? workspaceFor(currentProjectPath)
        : undefined;
      var statText = (configLoaded ? commands.length + " 条命令" : "正在读取 Host 配置…")
        + (projectCount > 0 ? " · " + projectCount + " 条项目级" : "")
        + (currentWorkspace !== undefined ? " · 当前 " + currentWorkspace.title : "");

      var selectedProject = editing !== null && editing !== undefined && editing.projectRoot !== ""
        ? workspaceFor(editing.projectRoot)
        : undefined;
      var projectSelectValue = projectCustom
        ? "__custom__"
        : (selectedProject !== undefined
          ? selectedProject.path
          : (editing !== null && editing !== undefined && editing.projectRoot !== ""
            ? "__custom__"
            : (options.length > 0 ? options[0].path : "__custom__")));

      // dependsOn 候选：同一项目（或当前项目）里已启用的其它命令。
      var depProjectPath = editing !== null && editing !== undefined && editing.scope === "project" && editing.projectRoot !== ""
        ? editing.projectRoot
        : currentProjectPath;
      var depCandidates = editing === null || editing === undefined ? [] : visibleCommandsForProject(config, depProjectPath).filter(function (command) {
        return command.id !== editing.id && command.enabled !== false;
      });

      var form = editing === null || editing === undefined ? null : h("div", { className: "dshLimobCfgForm" },
        h("div", { className: "dshLimobCfgFormTop" },
          h("span", { className: "dshLimobCfgFormTitle" }, editing.id === "" ? "新增命令" : "编辑命令"),
          h("button", {
            type: "button",
            className: "dshLimobIconBtn",
            title: "关闭",
            "aria-label": "关闭",
            onClick: function () { setEditing(null); setError(""); }
          }, limobIcon("close", 15))),
        h("div", { className: "dshLimobFormGrid" },
          h("label", { className: "dshLimobFormField" },
            h("span", null, "名称 *"),
            h("input", {
              className: "dshLimobInput",
              autoFocus: true,
              value: editing.title,
              placeholder: "例如：调试后端",
              onChange: function (event) { updateDraft("title", event.target.value); }
            })),
          h("label", { className: "dshLimobFormField" },
            h("span", null, "触发端口"),
            h("input", {
              className: "dshLimobInput",
              value: editing.portsText,
              placeholder: "8001, 5173",
              onChange: function (event) { updateDraft("portsText", event.target.value); }
            })),
          h("label", { className: "dshLimobFormField", "data-wide": "true" },
            h("span", null, "命令（PowerShell 固定文本）*"),
            h("textarea", {
              className: "dshLimobTextarea",
              value: editing.command,
              placeholder: "python -m uvicorn main:app --port 8001 --reload",
              onChange: function (event) { updateDraft("command", event.target.value); }
            })),
          h("label", { className: "dshLimobFormField", "data-wide": "true" },
            h("span", null, "工作目录（空 = 项目目录）"),
            h("div", { className: "dshLimobFormRow" },
              h("input", {
                className: "dshLimobInput",
                style: { flex: "1 1 220px" },
                value: editing.cwd,
                placeholder: "H:\\项目\\后端",
                onChange: function (event) { updateDraft("cwd", event.target.value); }
              }),
              editing.scope === "project" && editing.projectRoot !== ""
                ? h("button", { type: "button", className: "dshLimobLinkBtn", onClick: useProjectAsCwd }, "使用项目目录")
                : null)),
          h("div", { className: "dshLimobFormField", "data-wide": "true" },
            h("span", null, "作用域"),
            h("div", { className: "dshLimobFormRow" },
              h("div", { className: "dshLimobSegment" },
                h("button", {
                  type: "button",
                  "data-active": editing.scope === "global" ? "true" : "false",
                  onClick: function () { chooseScope("global"); }
                }, "所有项目"),
                h("button", {
                  type: "button",
                  "data-active": editing.scope === "project" ? "true" : "false",
                  onClick: function () { chooseScope("project"); }
                }, "指定项目")),
              editing.scope === "project"
                ? h("select", {
                    className: "dshLimobSelect",
                    value: projectSelectValue,
                    onChange: function (event) { chooseProject(event.target.value); }
                  },
                    options.map(function (option) {
                      return h("option", { key: option.path, value: option.path }, option.title + " · " + option.path);
                    }),
                    h("option", { value: "__custom__" }, "自定义路径…"))
                : h("span", { className: "dshLimobPageSub" }, "所有项目都会显示这条命令")),
            editing.scope === "project" && projectCustom
              ? h("input", {
                  className: "dshLimobInput",
                  style: { marginTop: "5px" },
                  value: editing.projectRoot,
                  placeholder: "项目根目录，例如 H:\\项目",
                  onChange: function (event) { updateDraft("projectRoot", event.target.value); }
                })
              : null,
            editing.scope === "project"
              ? h("span", { className: "dshLimobFieldHint" }, "只在该工作区的会话与运行面板里出现；下拉列表来自 DSH 已注册的工作区。")
              : null),
          h("label", { className: "dshLimobFormField", "data-wide": "true" },
            h("span", null, "环境变量（每行 KEY=VALUE）"),
            h("textarea", {
              className: "dshLimobTextarea",
              value: editing.envText,
              placeholder: "APP_ENV=dev\nAPP_PORT=8001",
              onChange: function (event) { updateDraft("envText", event.target.value); }
            })),
          h("label", { className: "dshLimobFormField" },
            h("span", null, "就绪端口（空 = 不等就绪）"),
            h("input", {
              className: "dshLimobInput",
              value: editing.readyPortText,
              placeholder: "8001",
              onChange: function (event) { updateDraft("readyPortText", event.target.value); }
            })),
          h("label", { className: "dshLimobFormField" },
            h("span", null, "就绪超时（毫秒，>=1000）"),
            h("input", {
              className: "dshLimobInput",
              value: editing.readyTimeoutText,
              placeholder: "120000",
              onChange: function (event) { updateDraft("readyTimeoutText", event.target.value); }
            })),
          h("div", { className: "dshLimobFormField", "data-wide": "true" },
            h("span", null, "依赖命令（先启动这些命令）"),
            depCandidates.length === 0
              ? h("span", { className: "dshLimobFieldHint" }, "当前项目没有可选的其它命令")
              : h("div", { className: "dshLimobDepList" },
                  depCandidates.map(function (command) {
                    return h("label", { key: command.id, className: "dshLimobDepItem" },
                      h("input", {
                        type: "checkbox",
                        checked: Array.isArray(editing.dependsOn) && editing.dependsOn.indexOf(command.id) !== -1,
                        onChange: function () { toggleDependency(command.id); }
                      }),
                      h("span", null, command.title));
                  }))),
          h("div", { className: "dshLimobFormRow", "data-wide": "true" },
            h("label", { className: "dshLimobSwitch" },
              h("input", {
                type: "checkbox",
                checked: editing.enabled,
                onChange: function (event) { updateDraft("enabled", event.target.checked); }
              }),
              h("span", { className: "dshLimobSwitchTrack" }),
              h("span", null, "启用")))),
        h("div", { className: "dshLimobFormFoot" },
          error !== "" ? h("span", { className: "dshLimobFormError" }, error) : null,
          h("button", {
            type: "button",
            className: "dshLimobCfgBtn dshLimobCfgBtnGhost",
            onClick: function () { setEditing(null); setError(""); }
          }, "取消"),
          h("button", {
            type: "button",
            className: "dshLimobCfgBtn dshLimobCfgBtnPrimary",
            disabled: busy,
            onClick: saveDraft
          }, busy ? "保存中…" : "保存")));

      var list = commands.length === 0
        ? h("div", { className: "dshLimobCmdList" },
            h("div", { className: "dshLimobCfgEmpty" },
              h("div", { className: "dshRunnerEmptyIcon" }, limobIcon(configLoaded ? "terminal" : "refresh", 18)),
              h("div", { className: "dshRunnerEmptyTitle" }, configLoaded ? "还没有命令" : "正在读取命令配置"),
              h("div", { className: "dshRunnerEmptyHint" },
                configLoaded ? "点右上角「新增」添加第一条，或让 AI 用 dsh_runner_config 创建。" : "稍候，Host 返回后会自动刷新。")))
        : h("div", { className: "dshLimobCmdList" },
            commands.map(function (command, index) {
              var projectLabel = command.scope === "project"
                ? "项目 · " + projectTitleOf(command.projectRoot, options)
                : "全局";
              var actions = pendingDelete === command.id
                ? [
                    h("button", {
                      key: "confirm",
                      type: "button",
                      className: "dshLimobCfgBtn dshLimobCfgBtnDanger",
                      disabled: busy,
                      onClick: function () { removeCommand(command.id); }
                    }, "确认删除"),
                    h("button", {
                      key: "cancel",
                      type: "button",
                      className: "dshLimobCfgBtn dshLimobCfgBtnGhost",
                      onClick: function () { setPendingDelete(null); }
                    }, "取消")
                  ]
                : [
                    h("label", { key: "enabled", className: "dshLimobSwitch", title: command.enabled ? "停用" : "启用" },
                      h("input", {
                        type: "checkbox",
                        checked: command.enabled !== false,
                        onChange: function () { toggleEnabled(command); }
                      }),
                      h("span", { className: "dshLimobSwitchTrack" })),
                    h("button", {
                      key: "up",
                      type: "button",
                      className: "dshLimobIconBtn",
                      title: "上移",
                      "aria-label": "上移 " + command.title,
                      disabled: index === 0 || busy,
                      onClick: function () { moveCommand(index, -1); }
                    }, limobIcon("up", 15)),
                    h("button", {
                      key: "down",
                      type: "button",
                      className: "dshLimobIconBtn",
                      title: "下移",
                      "aria-label": "下移 " + command.title,
                      disabled: index === commands.length - 1 || busy,
                      onClick: function () { moveCommand(index, 1); }
                    }, limobIcon("down", 15)),
                    h("button", {
                      key: "edit",
                      type: "button",
                      className: "dshLimobIconBtn",
                      title: "编辑",
                      "aria-label": "编辑 " + command.title,
                      onClick: function () { startEdit(command); }
                    }, limobIcon("edit", 15)),
                    h("button", {
                      key: "delete",
                      type: "button",
                      className: "dshLimobIconBtn",
                      "data-danger": "true",
                      title: "删除",
                      "aria-label": "删除 " + command.title,
                      onClick: function () { setPendingDelete(command.id); }
                    }, limobIcon("trash", 15))
                  ];
              return h("div", {
                key: command.id,
                className: "dshLimobCmdRow",
                "data-disabled": command.enabled === false ? "true" : "false"
              },
                h("div", {
                  className: "dshLimobCmdMain",
                  onClick: function () { startEdit(command); }
                },
                  h("div", { className: "dshLimobCmdTitleLine" },
                    h("span", { className: "dshLimobCmdTitle" }, command.title),
                    h("span", {
                      className: "dshLimobTag",
                      "data-scope": command.scope,
                      title: command.scope === "project" ? String(command.projectRoot) : "所有项目"
                    }, projectLabel),
                    command.enabled === false ? h("span", { className: "dshLimobTag" }, "已停用") : null),
                  h("div", { className: "dshLimobCmdPreview" }, String(command.command))),
                h("div", { className: "dshLimobCmdActions" }, actions));
            }));

      return h("div", { className: "dshLimobCfg" },
        h("div", { className: "dshLimobCfgToolbar" },
          h("span", { className: "dshLimobCfgStat", title: statText }, statText),
          h("label", { className: "dshLimobSwitch", title: "在输入框下方显示「运行」按钮" },
            h("input", { type: "checkbox", checked: uiVisibleOf(config), onChange: toggleVisible }),
            h("span", { className: "dshLimobSwitchTrack" }),
            h("span", null, "运行按钮")),
          h("button", {
            type: "button",
            className: "dshLimobCfgBtn dshLimobCfgBtnPrimary",
            "data-action": "create-command",
            disabled: busy,
            onClick: startCreate
          }, limobIcon("plus", 14), h("span", null, "新增"))),
        notice !== "" ? h("div", { className: "dshLimobCfgNotice", role: "status" }, limobIcon("check", 13), h("span", null, notice)) : null,
        form,
        list,
        error !== "" ? h("div", { className: "dshLimobCfgError", role: "alert" }, error) : null);
    }

    // =====================================================================
    // 十二、设置页 section（Settings 弹窗左侧新增一个 Tab）
    // =====================================================================
    function LimobSettingsSection(props) {
      var active = useActiveSession(props);
      var workspaces = workspaceOptionsFrom(props !== undefined ? props.useWorkspaces : undefined);
      return h("div", { className: "dshLimobCfgPage" },
        h("div", { className: "dshLimobPageHead" },
          h("div", null,
            h("div", { className: "dshLimobPageTitle" }, "dsh-runner"),
            h("div", { className: "dshLimobPageSub" }, "项目运行命令：左侧「运行」面板负责启停与日志，这里编辑命令")),
          h("span", { className: "dshLimobPageVersion" }, "v" + PLUGIN_VERSION)),
        h(ConfigEditor, {
          currentProjectPath: active.projectPath,
          workspaces: workspaces
        }));
    }

    // =====================================================================
    // 十三、运行面板（左侧导航「运行」+ main 槽位）
    // =====================================================================
    function RunnerPage(props) {
      var active = useActiveSession(props);
      var config = useConfig();
      var currentProjectPath = active !== null && active !== undefined
        && typeof active.projectPath === "string" && active.projectPath !== ""
        ? active.projectPath
        : undefined;
      var workspaceOptions = workspaceOptionsFrom(props !== undefined ? props.useWorkspaces : undefined);

      var runnersPair = react.useState([]);
      var runners = runnersPair[0];
      var setRunners = runnersPair[1];
      var diagnosePair = react.useState([]);
      var diagnose = diagnosePair[0];
      var setDiagnose = diagnosePair[1];
      // 首帧就用缓存里的「上次那条日志」：选中项和日志尾巴都同步取，
      // 这样切回面板时既不会先闪「请选择命令」，也不会先闪「暂无日志」。
      var restoredSelection = uiStateCache !== null && uiStateCache.lastSelected !== null
        && uiStateCache.lastSelected !== undefined
        ? { projectPath: uiStateCache.lastSelected.projectPath, commandId: uiStateCache.lastSelected.commandId }
        : null;
      var restoredTail = restoredSelection === null
        ? undefined
        : logTailCache.get(logTailKeyOf(restoredSelection.projectPath, restoredSelection.commandId));
      var selectedPair = react.useState(restoredSelection);
      var selected = selectedPair[0];
      var setSelected = selectedPair[1];
      var logPair = react.useState(restoredTail === undefined ? null : restoredTail);
      var logState = logPair[0];
      var setLogState = logPair[1];
      var errorPair = react.useState(null);
      var error = errorPair[0];
      var setError = errorPair[1];
      // 并发模型（0.25.0）：
      //   pending  —— 按命令（projectPath+commandId）记「这一行正在请求中」，只禁用这一行；
      //   flow     —— 面板级长流程（刷新 / 本组启动 / 本组停止 / 清空日志），只禁用面板级按钮。
      // 旧的单一 busy 会把所有行一起锁死，点「运行后端」时前端/官网都点不动。
      var pendingPair = react.useState({});
      var pending = pendingPair[0];
      var setPending = pendingPair[1];
      var flowPair = react.useState(null);
      var flow = flowPair[0];
      var setFlow = flowPair[1];
      var conflictPair = react.useState(null);
      var conflict = conflictPair[0];
      var setConflict = conflictPair[1];
      var conflictBusyPair = react.useState(false);
      var conflictBusy = conflictBusyPair[0];
      var setConflictBusy = conflictBusyPair[1];
      var conflictErrorPair = react.useState(null);
      var conflictError = conflictErrorPair[0];
      var setConflictError = conflictErrorPair[1];
      var editorPair = react.useState(false);
      var editorOpen = editorPair[0];
      var setEditorOpen = editorPair[1];
      var copiedPair = react.useState(false);
      var copied = copiedPair[0];
      var setCopied = copiedPair[1];
      var colorPickerPair = react.useState(null);
      var colorPicker = colorPickerPair[0];
      var setColorPicker = colorPickerPair[1];
      var uiStatePair = react.useState(uiStateCache);
      var uiState = uiStatePair[0];
      var setUiState = uiStatePair[1];
      var uiLoadedPair = react.useState(uiStateCache !== null);
      var uiLoaded = uiLoadedPair[0];
      var setUiLoaded = uiLoadedPair[1];
      var configReadyPair = react.useState(config !== null);
      var configReady = configReadyPair[0];
      var setConfigReady = configReadyPair[1];
      var uiStateRef = react.useRef(uiStateCache !== null ? uiStateCache : { collapsedProjects: [], collapsedGlobal: false, projectColors: {}, lastSelected: null });
      var uiSeqRef = react.useRef(0);
      function applyUiState(next) {
        var snapshot = storeUiState(next);
        uiStateRef.current = snapshot;
        setUiState(snapshot);
      }
      var logRef = react.useRef(null);
      var stickRef = react.useRef(true);

      // 日志自动滚到底部：只有用户停留在底部时才跟随，上滚后不强制。
      react.useEffect(function () {
        var pre = logRef.current;
        if (pre === null || pre === undefined) return;
        if (stickRef.current !== true) return;
        pre.scrollTop = pre.scrollHeight;
      }, [logState]);

      // 读配置 + 面板 UI 偏好（折叠状态由 Host 持久化，跨会话/重启保留）。
      react.useEffect(function () {
        var alive = true;
        loadConfig().then(function () {
          if (alive) setConfigReady(true);
        }, function (loadError) {
          if (alive) {
            setConfigReady(true);
            setError(loadError);
          }
        });
        if (uiStateCache !== null) {
          // 已有缓存：首帧就按记忆状态渲染；后台再校准一次（多客户端/其他窗口改过）。
          applyUiState(uiStateCache);
          setUiLoaded(true);
          refreshUiState().then(function (snapshot) {
            if (alive) applyUiState(snapshot);
          }, function () {
            // 后台校准失败不打断已展示的缓存；用户下次切换折叠时会重新持久化。
          });
        } else {
          prefetchUiState().then(function (snapshot) {
            if (!alive) return;
            applyUiState(snapshot);
            setUiLoaded(true);
          }, function (uiError) {
            if (!alive) return;
            setUiLoaded(true);
            setError(uiError);
          });
        }
        return function () {
          alive = false;
        };
      }, []);

      // 上次查看的日志（切走再回来、或重开 Host 都恢复到同一条命令）。
      // 恢复只在「当前没有选择」时做一次；记忆只在「真的换了命令」时写 Host，
      // 所以恢复动作本身不会产生写回，也不会把用户刚点的选择覆盖掉。
      react.useEffect(function () {
        if (!uiLoaded || !configReady) return;
        if (selected !== null && selected !== undefined) return;
        var last = uiStateRef.current.lastSelected;
        if (last === null || last === undefined) return;
        var allCommands = commandsOf(config);
        for (var index = 0; index < allCommands.length; index += 1) {
          if (allCommands[index].id === last.commandId) {
            setSelected({ projectPath: last.projectPath, commandId: last.commandId });
            return;
          }
        }
        // 命令已被删除：这条记忆失效，保持「未选择」；下次选择会覆盖它。
      }, [uiLoaded, configReady, config, selected]);

      react.useEffect(function () {
        if (!uiLoaded) return;
        if (selected === null || selected === undefined) return;
        var previous = uiStateRef.current;
        var pair = {
          projectPath: normalizePath(selected.projectPath === undefined || selected.projectPath === null ? "" : selected.projectPath),
          commandId: selected.commandId
        };
        var last = previous.lastSelected;
        if (last !== null && last !== undefined
          && last.commandId === pair.commandId
          && normalizePath(last.projectPath) === pair.projectPath) return;
        applyUiState({
          collapsedProjects: previous.collapsedProjects,
          collapsedGlobal: previous.collapsedGlobal,
          projectColors: previous.projectColors,
          lastSelected: pair
        });
        rpc("ui/update", { lastSelected: pair }).then(function (value) {
          var saved = value !== null && value !== undefined ? value.uiState : undefined;
          if (saved !== null && saved !== undefined) applyUiState(saved);
        }, function () {
          // 偏好写失败不影响日志查看：下一次选择会重试。
        });
      }, [selected, uiLoaded]);

      // 端口诊断：每 6 秒一次，覆盖所有项目的 project 命令（页面隐藏时跳过）。
      react.useEffect(function () {
        var alive = true;
        var timer = null;
        async function tickDiagnose() {
          if (!alive) return;
          if (typeof document !== "undefined" && document.visibilityState === "hidden") {
            timer = setTimeout(tickDiagnose, DIAGNOSE_POLL_MS);
            return;
          }
          try {
            var value = await rpc("project/diagnose", {});
            if (!alive) return;
            setDiagnose(value !== null && value !== undefined && Array.isArray(value.entries) ? value.entries : []);
          } catch (diagnoseError) {
            if (alive) setError(diagnoseError);
          }
          if (alive) timer = setTimeout(tickDiagnose, DIAGNOSE_POLL_MS);
        }
        tickDiagnose();
        return function () {
          alive = false;
          clearTimeout(timer);
        };
      }, []);

      // 进程状态：每 2000ms 轮询全部项目的 runner（页面卸载清理）。
      react.useEffect(function () {
        var alive = true;
        var timer = null;
        function schedule() {
          if (alive) timer = setTimeout(tick, STATUS_POLL_MS);
        }
        async function tick() {
          try {
            var value = await rpc("project/status", {});
            if (!alive) return;
            setRunners(value !== null && value !== undefined && Array.isArray(value.runners) ? value.runners : []);
          } catch (statusError) {
            if (alive) setError(statusError);
          }
          schedule();
        }
        tick();
        return function () {
          alive = false;
          clearTimeout(timer);
        };
      }, []);

      // 运行期失败是「状态」而不是异常：Host 把它落在 runner.error 上，这里按类型呈现。
      // 端口类（port-conflict / port-mismatch）直接打开原来的端口冲突对话框，其它进错误条；
      // 用 code+message 做签名去重，同一个错误不会每 2s 弹一次。
      var surfacedErrorsRef = react.useRef({});
      react.useEffect(function () {
        var seen = {};
        var conflictToShow = null;
        var firstFailure = null;
        for (var runnerIndex = 0; runnerIndex < runners.length; runnerIndex += 1) {
          var runner = runners[runnerIndex];
          if (runner === null || runner === undefined || typeof runner.commandId !== "string") continue;
          var failure = runner.error === null || runner.error === undefined ? null : runner.error;
          if (failure === null) continue;
          var runnerKey = compositeKey(runner.projectPath === undefined ? "" : runner.projectPath, runner.commandId);
          var signature = String(failure.code) + "|" + String(failure.message);
          seen[runnerKey] = signature;
          if (surfacedErrorsRef.current[runnerKey] === signature) continue;
          var details = failure.details === null || failure.details === undefined ? {} : failure.details;
          if ((failure.code === "port-conflict" || failure.code === "port-mismatch") && Array.isArray(details.ports)) {
            if (conflictToShow === null) conflictToShow = { runner: runner, failure: failure, details: details };
          } else if (firstFailure === null) {
            firstFailure = failure;
          }
        }
        surfacedErrorsRef.current = seen;
        if (conflictToShow !== null) {
          setConflict({
            projectPath: conflictToShow.runner.projectPath,
            commandId: conflictToShow.runner.commandId,
            action: "start",
            kind: conflictToShow.failure.code,
            ports: conflictToShow.details.ports,
            processes: [],
            actualPorts: Array.isArray(conflictToShow.details.actualPorts) ? conflictToShow.details.actualPorts : []
          });
          return;
        }
        if (firstFailure !== null) {
          setError(rpcError(String(firstFailure.code), String(firstFailure.message), firstFailure.details));
        }
      }, [runners]);

      // 选中的命令：每 1000ms 轮询 project/log（maxBytes 65536）。
      react.useEffect(function () {
        if (selected === null || selected === undefined) {
          setLogState(null);
          return undefined;
        }
        var alive = true;
        var timer = null;
        var projectPath = selected.projectPath;
        var commandId = selected.commandId;
        var cacheKey = logTailKeyOf(projectPath, commandId);
        var cachedTail = logTailCache.get(cacheKey);
        // 有缓存就先摆上来：首帧直接是上次那段日志，而不是「正在读取」或「暂无日志」
        setLogState(cachedTail === undefined ? null : cachedTail);
        stickRef.current = true;
        async function tick() {
          try {
            var value = await rpc("project/log", {
              projectPath: projectPath,
              commandId: commandId,
              maxBytes: LOG_MAX_BYTES
            });
            if (!alive) return;
            var nextLog = value !== null && value !== undefined ? value : { text: "", bytes: 0, truncated: false };
            rememberLogTail(cacheKey, nextLog);
            setLogState(nextLog);
          } catch (logError) {
            if (alive) setError(logError);
          }
          if (alive) timer = setTimeout(tick, LOG_POLL_MS);
        }
        tick();
        return function () {
          alive = false;
          clearTimeout(timer);
        };
      }, [selected]);

      async function toggleSection(section) {
        var seq = uiSeqRef.current + 1;
        uiSeqRef.current = seq;
        var previous = uiStateRef.current;
        var next;
        if (section.global === true) {
          next = {
            collapsedProjects: Array.isArray(previous.collapsedProjects) ? previous.collapsedProjects.slice() : [],
            collapsedGlobal: previous.collapsedGlobal !== true,
            projectColors: previous.projectColors !== undefined && previous.projectColors !== null ? previous.projectColors : {},
            lastSelected: previous.lastSelected === undefined ? null : previous.lastSelected
          };
        } else {
          next = {
            collapsedProjects: toggleCollapsedProject(previous.collapsedProjects, section.projectPath),
            collapsedGlobal: previous.collapsedGlobal === true,
            projectColors: previous.projectColors !== undefined && previous.projectColors !== null ? previous.projectColors : {},
            lastSelected: previous.lastSelected === undefined ? null : previous.lastSelected
          };
        }
        // 连续快速点击不同分组时：同步更新 ref，后一次请求会把前一次的折叠一起带上；
        // 只用「最新一次」的响应覆盖本地状态，避免慢响应回滚新状态。
        applyUiState(next);
        try {
          var value = await rpc("ui/update", {
            collapsedProjects: next.collapsedProjects,
            collapsedGlobal: next.collapsedGlobal,
            projectColors: next.projectColors
          });
          if (uiSeqRef.current !== seq) return;
          var saved = value !== null && value !== undefined ? value.uiState : undefined;
          if (saved !== null && saved !== undefined) {
            applyUiState({
              collapsedProjects: Array.isArray(saved.collapsedProjects) ? saved.collapsedProjects : next.collapsedProjects,
              collapsedGlobal: saved.collapsedGlobal === true,
              projectColors: saved.projectColors !== undefined && saved.projectColors !== null ? saved.projectColors : next.projectColors,
              lastSelected: saved.lastSelected === undefined ? next.lastSelected : saved.lastSelected
            });
          }
        } catch (uiError) {
          if (uiSeqRef.current === seq) applyUiState(previous);
          setError(uiError);
        }
      }

      async function setProjectColor(projectPath, colorId) {
        if (projectPath === undefined || projectPath === null || projectPath === "") return;
        var seq = uiSeqRef.current + 1;
        uiSeqRef.current = seq;
        var previous = uiStateRef.current;
        var previousColors = previous.projectColors !== undefined && previous.projectColors !== null ? previous.projectColors : {};
        var nextColors = {};
        for (var colorKey in previousColors) {
          if (Object.prototype.hasOwnProperty.call(previousColors, colorKey)) nextColors[colorKey] = previousColors[colorKey];
        }
        var normalizedKey = normalizePath(projectPath);
        if (colorId === null || colorId === undefined || colorId === "") delete nextColors[normalizedKey];
        else nextColors[normalizedKey] = String(colorId);
        var next = {
          collapsedProjects: Array.isArray(previous.collapsedProjects) ? previous.collapsedProjects.slice() : [],
          collapsedGlobal: previous.collapsedGlobal === true,
          projectColors: nextColors,
          lastSelected: previous.lastSelected === undefined ? null : previous.lastSelected
        };
        applyUiState(next);
        setColorPicker(null);
        try {
          var value = await rpc("ui/update", { projectColors: nextColors });
          if (uiSeqRef.current !== seq) return;
          var saved = value !== null && value !== undefined ? value.uiState : undefined;
          if (saved !== null && saved !== undefined) applyUiState(saved);
        } catch (uiError) {
          if (uiSeqRef.current === seq) applyUiState(previous);
          setError(uiError);
        }
      }

      async function refreshStatus() {
        var value = await rpc("project/status", {});
        setRunners(value !== null && value !== undefined && Array.isArray(value.runners) ? value.runners : []);
      }

      async function refreshDiagnose() {
        try {
          var value = await rpc("project/diagnose", {});
          setDiagnose(value !== null && value !== undefined && Array.isArray(value.entries) ? value.entries : []);
        } catch (diagnoseError) {
          setError(diagnoseError);
        }
      }

      /** 按命令维度加/清「这一行正在请求中」的标记（只锁这一行）。 */
      function setRowPending(projectPath, commandId, value) {
        var rowKey = compositeKey(projectPath === undefined ? "" : projectPath, commandId);
        setPending(function (current) {
          var next = Object.assign({}, current === null || current === undefined ? {} : current);
          if (value === true) next[rowKey] = true;
          else delete next[rowKey];
          return next;
        });
      }

      function isRowPending(projectPath, commandId) {
        return pending[compositeKey(projectPath === undefined ? "" : projectPath, commandId)] === true;
      }

      /** RPC 已经带回最新的 runners 列表，直接用，不再额外发一轮 status 请求。 */
      function applyRunners(value) {
        if (value !== null && value !== undefined && Array.isArray(value.runners)) setRunners(value.runners);
      }

      async function refresh() {
        if (flow !== null) return;
        setFlow("refresh");
        setError(null);
        try {
          await loadConfig();
          await refreshStatus();
          await refreshDiagnose();
        } catch (refreshError) {
          setError(refreshError);
        } finally {
          setFlow(null);
        }
      }

      /**
       * 行内动作：start / stop / restart。
       * Host 的 start 是「命令即返回」（实测 < 30ms），所以这里 await 的只是一次短请求；
       * queued -> starting -> running 的状态推进由 2s 状态轮询画出来，不需要在这里等。
       * 运行期失败不再走 catch：它落在 runner.error 上，由下面的错误观察 effect 统一呈现。
       */
      async function runAction(action, commandId, projectPath) {
        if (projectPath === undefined || projectPath === null || projectPath === "") return;
        if (isRowPending(projectPath, commandId)) return;
        setRowPending(projectPath, commandId, true);
        setError(null);
        try {
          var endpoint = action === "start" ? "project/start" : action === "stop" ? "project/stop" : "project/restart";
          var value = await rpc(endpoint, { projectPath: projectPath, commandId: commandId });
          applyRunners(value);
          if (action !== "stop") setSelected({ projectPath: projectPath, commandId: commandId });
        } catch (actionError) {
          setError(actionError);
        } finally {
          setRowPending(projectPath, commandId, false);
        }
      }

      /**
       * 接管：把外部运行中的实例纳入托管（只改归属，不结束进程），之后面板里就能停止/重启它。
       * 外部进程的 stdout 回放不了，日志区会明确说明；要实时日志就点「重启」。
       */
      async function runAdopt(commandId, projectPath, entry) {
        if (projectPath === undefined || projectPath === null || projectPath === "") return;
        if (isRowPending(projectPath, commandId)) return;
        setRowPending(projectPath, commandId, true);
        setError(null);
        try {
          var occupantPid = entry !== null && entry !== undefined && entry.occupant !== null && entry.occupant !== undefined
            && typeof entry.occupant.pid === "number" ? entry.occupant.pid : undefined;
          var value = await rpc("project/adopt", { projectPath: projectPath, commandId: commandId, pid: occupantPid });
          applyRunners(value);
          if (value !== null && value !== undefined && value.adopted === true) {
            setSelected({ projectPath: projectPath, commandId: commandId });
          }
        } catch (adoptError) {
          setError(adoptError);
        } finally {
          setRowPending(projectPath, commandId, false);
        }
      }

      /** 解除接管：只把实例移出托管，不结束进程（点错接管时用）。 */
      async function releaseAdopted(projectPath, commandId) {
        if (isRowPending(projectPath, commandId)) return;
        setRowPending(projectPath, commandId, true);
        setError(null);
        try {
          var value = await rpc("project/release", { projectPath: projectPath, commandId: commandId });
          applyRunners(value);
        } catch (releaseError) {
          setError(releaseError);
        } finally {
          setRowPending(projectPath, commandId, false);
        }
      }

      /** 本组启动：Host 按拓扑序全部入队后立即返回，界面马上变成一堆「排队中」。 */
      async function runStartAll(projectPath) {
        if (projectPath === undefined || projectPath === null || projectPath === "" || flow !== null) return;
        setFlow("startAll");
        setError(null);
        try {
          var value = await rpc("project/startAll", { projectPath: projectPath });
          applyRunners(value);
        } catch (startAllError) {
          setError(startAllError);
        } finally {
          setFlow(null);
        }
      }

      async function runStopAll(projectPath) {
        if (projectPath === undefined || projectPath === null || projectPath === "" || flow !== null) return;
        setFlow("stopAll");
        setError(null);
        try {
          var value = await rpc("project/stopAll", { projectPath: projectPath });
          applyRunners(value);
        } catch (stopAllError) {
          setError(stopAllError);
        } finally {
          setFlow(null);
        }
      }

      /**
       * 行内「重启」用的确认入口：把诊断到的外部实例摆进对话框。
       * - action="restart"：确认后结束外部实例并交给插件启动（takeOver），之后才有实时日志；
       * - action="start"：处理占用后重试启动。
       */
      function openExternalConflict(entry, commandId, projectPath, action) {
        if (entry === null || entry === undefined) return;
        var verb = action === "restart" ? "restart" : "start";
        var isProcess = entry.kind === "process";
        setError(null);
        setConflict({
          projectPath: typeof entry.projectPath === "string" && entry.projectPath !== "" ? entry.projectPath : projectPath,
          commandId: commandId,
          action: verb,
          kind: isProcess ? "process-conflict" : "port-conflict",
          takeOver: verb === "restart",
          ports: isProcess || !Number.isInteger(entry.port) ? [] : [{ port: entry.port, occupant: entry.occupant }],
          processes: isProcess && Array.isArray(entry.processes) ? entry.processes : [],
          actualPorts: []
        });
      }

      async function clearLog() {
        if (selected === null || selected === undefined || flow !== null) return;
        setFlow("logClear");
        setError(null);
        try {
          await rpc("project/log/clear", { projectPath: selected.projectPath, commandId: selected.commandId });
          var clearedLog = {
            text: "",
            bytes: 0,
            path: logState !== null && logState !== undefined && typeof logState.path === "string" ? logState.path : "",
            truncated: false
          };
          // 清空也是一次「新的已知内容」：写进缓存，切走再回来不会又显示旧的尾巴
          rememberLogTail(logTailKeyOf(selected.projectPath, selected.commandId), clearedLog);
          setLogState(clearedLog);
          stickRef.current = true;
        } catch (clearError) {
          setError(clearError);
        } finally {
          setFlow(null);
        }
      }

      function copyLog() {
        var text = logState !== null && logState !== undefined && typeof logState.text === "string" ? stripAnsi(logState.text) : "";
        setCopied(copyTextToClipboard(text));
      }

      function handleLogScroll(event) {
        var pre = event !== null && event !== undefined ? event.currentTarget : undefined;
        if (pre === null || pre === undefined) return;
        stickRef.current = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 32;
      }

      /**
       * 端口冲突确认后的处理：结束未托管进程 / 停止托管命令，然后自动重试启动。
       * killPort 带 expected pid：若这期间端口换了主人，Host 会拒绝并返回 port-changed，避免误杀。
       */
      async function resolveConflict() {
        if (conflict === null || conflict === undefined || conflictBusy) return;
        var projectPath = conflict.projectPath;
        setConflictBusy(true);
        setConflictError(null);
        try {
          // 「重启并接管」：Host 自己结束外部实例（端口占用者 + 归属该命令的进程），再按托管方式启动。
          if (conflict.takeOver === true) {
            var takenOver = await rpc("project/restart", { projectPath: projectPath, commandId: conflict.commandId, takeOver: true });
            applyRunners(takenOver);
            setSelected({ projectPath: projectPath, commandId: conflict.commandId });
            setConflict(null);
            return;
          }
          var items = Array.isArray(conflict.ports) ? conflict.ports : [];
          for (var i = 0; i < items.length; i += 1) {
            var item = items[i];
            if (item === null || item === undefined) continue;
            var occupant = item.occupant === null || item.occupant === undefined ? undefined : item.occupant;
            if (occupant !== undefined && occupant.managed === true && typeof occupant.runnerCommandId === "string") {
              await rpc("project/stop", { projectPath: projectPath, commandId: occupant.runnerCommandId });
            } else {
              await rpc("project/killPort", {
                projectPath: projectPath,
                port: item.port,
                pid: occupant !== undefined && typeof occupant.pid === "number" ? occupant.pid : undefined
              });
            }
          }
          if (conflict.action === "startAll") {
            // 本组启动现在是「全部入队」：重新入队即可；单条命令的失败会以 runner.error 呈现。
            var all = await rpc("project/startAll", { projectPath: projectPath });
            applyRunners(all);
            setConflict(null);
            return;
          }
          var endpoint = conflict.action === "restart" ? "project/restart" : "project/start";
          var retried = await rpc(endpoint, { projectPath: projectPath, commandId: conflict.commandId });
          applyRunners(retried);
          setSelected({ projectPath: projectPath, commandId: conflict.commandId });
          setConflict(null);
        } catch (actionError) {
          if (isPortBlockingError(actionError)) {
            setConflict({
              projectPath: conflict.projectPath,
              commandId: conflict.commandId,
              action: conflict.action,
              kind: actionError.code,
              ports: actionError.details.ports,
              actualPorts: Array.isArray(actionError.details.actualPorts) ? actionError.details.actualPorts : []
            });
            setConflictError(actionError);
          } else {
            setConflictError(actionError);
          }
        } finally {
          setConflictBusy(false);
        }
      }

      // ── 派生数据：全部项目的 runner / 命令分组 ────────────────────────────
      function compositeKey(projectPath, commandId) {
        return normalizePath(projectPath) + "\u0000" + String(commandId);
      }

      var runnerByKey = {};
      var runnersByCommandId = {};
      for (var runnerIndex = 0; runnerIndex < runners.length; runnerIndex += 1) {
        var runner = runners[runnerIndex];
        if (runner === null || runner === undefined || typeof runner.commandId !== "string") continue;
        if (typeof runner.projectPath === "string" && runner.projectPath !== "") {
          runnerByKey[compositeKey(runner.projectPath, runner.commandId)] = runner;
        }
        if (runnersByCommandId[runner.commandId] === undefined) runnersByCommandId[runner.commandId] = runner;
      }

      var configById = {};
      var allCommands = commandsOf(config);
      for (var configIndex = 0; configIndex < allCommands.length; configIndex += 1) {
        var configCommand = allCommands[configIndex];
        if (configCommand !== null && configCommand !== undefined && typeof configCommand.id === "string") {
          configById[configCommand.id] = configCommand;
        }
      }

      function runnerCommandOf(runner) {
        return {
          id: runner.commandId,
          title: typeof runner.title === "string" && runner.title !== "" ? runner.title : String(runner.commandId),
          command: typeof runner.command === "string" ? runner.command : "",
          cwd: typeof runner.cwd === "string" ? runner.cwd : "",
          scope: "project",
          projectRoot: runner.projectPath,
          enabled: true,
          env: {},
          ports: Array.isArray(runner.ports) ? runner.ports.slice() : [],
          readyPort: runner.readyPort === undefined ? null : runner.readyPort,
          readyTimeoutMs: runner.readyTimeoutMs,
          dependsOn: []
        };
      }

      function findRowRunner(command, projectPath) {
        if (projectPath === undefined || projectPath === null || projectPath === "") return undefined;
        var direct = runnerByKey[compositeKey(projectPath, command.id)];
        if (direct !== undefined) return direct;
        var candidate = runnersByCommandId[command.id];
        if (candidate !== undefined && command.scope !== "global"
          && commandMatchesProject(command, candidate.projectPath)) {
          return candidate;
        }
        return undefined;
      }

      function sectionKeyOfRunner(runner) {
        var command = configById[runner.commandId];
        if (command !== undefined && command.scope === "project") {
          var root = typeof command.projectRoot === "string" ? command.projectRoot.trim() : "";
          if (root !== "") return normalizePath(root);
        }
        return normalizePath(runner.projectPath);
      }

      var sections = buildRunnerSections(config, currentProjectPath);
      var sectionByKey = {};
      for (var sectionIndex = 0; sectionIndex < sections.length; sectionIndex += 1) {
        sectionByKey[sections[sectionIndex].key] = sections[sectionIndex];
      }
      // 运行中但配置里没有对应项目的（例如命令被删、或全局命令跑在别的项目），也给出分组。
      for (var extraIndex = 0; extraIndex < runners.length; extraIndex += 1) {
        var extraRunner = runners[extraIndex];
        if (extraRunner === null || extraRunner === undefined || typeof extraRunner.projectPath !== "string") continue;
        var extraKey = sectionKeyOfRunner(extraRunner);
        if (extraKey === "" || sectionByKey[extraKey] !== undefined) continue;
        var extraSection = { key: extraKey, projectPath: extraRunner.projectPath, global: false, commands: [] };
        sectionByKey[extraKey] = extraSection;
        sections.push(extraSection);
      }
      sections.sort(function (left, right) {
        if (left.global !== right.global) return left.global ? 1 : -1;
        var currentKey = typeof currentProjectPath === "string" && currentProjectPath !== "" ? normalizePath(currentProjectPath) : null;
        var leftCurrent = currentKey !== null && (left.key === currentKey || currentKey.indexOf(left.key + "\\") === 0);
        var rightCurrent = currentKey !== null && (right.key === currentKey || currentKey.indexOf(right.key + "\\") === 0);
        if (leftCurrent !== rightCurrent) return leftCurrent ? -1 : 1;
        if (left.key < right.key) return -1;
        if (left.key > right.key) return 1;
        return 0;
      });

      function rowsOfSection(section) {
        var rows = [];
        var targetPath = section.global === true ? undefined : section.projectPath;
        for (var commandIndex = 0; commandIndex < section.commands.length; commandIndex += 1) {
          var command = section.commands[commandIndex];
          rows.push({ command: command, projectPath: targetPath, runner: findRowRunner(command, targetPath) });
        }
        for (var runnerIndex2 = 0; runnerIndex2 < runners.length; runnerIndex2 += 1) {
          var running = runners[runnerIndex2];
          if (running === null || running === undefined) continue;
          if (sectionKeyOfRunner(running) !== section.key) continue;
          var covered = false;
          for (var rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
            if (rows[rowIndex].runner === running) {
              covered = true;
              break;
            }
          }
          if (covered) continue;
          var configured = configById[running.commandId];
          rows.push({
            command: configured !== undefined ? configured : runnerCommandOf(running),
            projectPath: running.projectPath,
            runner: running,
            runnerOnly: configured === undefined
          });
        }
        return rows;
      }

      function titleOfCommand(commandId) {
        var command = configById[commandId];
        if (command !== undefined && typeof command.title === "string") return command.title;
        var runner = runnersByCommandId[commandId];
        if (runner !== undefined && typeof runner.title === "string" && runner.title !== "") return runner.title;
        return commandId;
      }

      var runningTotal = 0;
      var failedTotal = 0;
      for (var totalIndex = 0; totalIndex < runners.length; totalIndex += 1) {
        var totalRunner = runners[totalIndex];
        if (totalRunner === null || totalRunner === undefined) continue;
        if (totalRunner.status === "running" || totalRunner.status === "starting" || totalRunner.status === "stopping") {
          runningTotal += 1;
        } else if (totalRunner.status === "failed" || totalRunner.status === "exited") {
          failedTotal += 1;
        }
      }
      var externalTotal = 0;
      for (var externalIndex = 0; externalIndex < diagnose.length; externalIndex += 1) {
        var externalEntry = diagnose[externalIndex];
        if (externalEntry === null || externalEntry === undefined) continue;
        if (externalEntry.occupant === null || externalEntry.occupant === undefined || externalEntry.occupant.managed === true) continue;
        var externalProcess = externalEntry.kind === "process" && Array.isArray(externalEntry.processes) && externalEntry.processes.length > 0;
        if (externalEntry.listening === true || externalProcess) externalTotal += 1;
      }
      var projectCount = 0;
      for (var projectIndex = 0; projectIndex < sections.length; projectIndex += 1) {
        if (sections[projectIndex].global !== true) projectCount += 1;
      }

      function summaryChip(tone, text, title) {
        return h("span", { className: "dshRunnerSummary", "data-tone": tone, title: title }, [
          h("span", { key: "dot", className: "dshRunnerSummaryDot" }),
          h("span", { key: "text" }, text)
        ]);
      }
      var summaryDots = [];
      if (runningTotal > 0) summaryDots.push(summaryChip("running", String(runningTotal) + " 运行中", String(runningTotal) + " 个命令正在运行或启动中"));
      if (failedTotal > 0) summaryDots.push(summaryChip("failed", String(failedTotal) + " 失败", String(failedTotal) + " 个命令启动失败或已退出"));
      if (externalTotal > 0) summaryDots.push(summaryChip("external", String(externalTotal) + " 外部", String(externalTotal) + " 个端口/进程由插件之外的实例占用"));

      var errorBar = error === null || error === undefined ? null : h("div", {
        className: "dshRunnerError",
        "data-dsh-runner-error": "1",
        role: "alert"
      },
        h("span", { className: "dshRunnerErrorIcon" }, limobIcon("alert", 14)),
        h("span", { className: "dshRunnerErrorText" }, "错误：" + messageOf(error)),
        h("button", {
          type: "button",
          className: "dshLimobCfgBtnGhost dshLimobCfgBtn",
          onClick: function () { setError(null); }
        }, "关闭"),
        errorDetailText(error) !== "" ? h("span", { className: "dshRunnerErrorDetail" }, errorDetailText(error)) : null);

      function renderRow(row) {
        var command = row.command;
        var projectPath = row.projectPath;
        var current = row.runner !== undefined ? row.runner : findRowRunner(command, projectPath);
        var hasRunner = current !== null && current !== undefined;
        var external = externalOccupancyForCommand(diagnose, command.id, projectPath);
        /** 已接管的外部实例：托管状态，但进程不是插件启动的（日志不能回放）。 */
        var adoptedExternal = hasRunner && current.external === true;
        var status = hasRunner && typeof current.status === "string"
          ? current.status
          : (external !== undefined ? "external" : "idle");
        var disabled = command.enabled === false;
        var rowBusy = isRowPending(projectPath, command.id);
        var canAct = projectPath !== undefined && projectPath !== null && projectPath !== "";
        var declaredPorts = Array.isArray(command.ports) ? command.ports : [];
        var actualPorts = current !== null && current !== undefined && Array.isArray(current.actualPorts)
          ? current.actualPorts
          : [];
        var extraPorts = actualPorts.filter(function (port) {
          return declaredPorts.indexOf(port) === -1;
        });
        var missingPorts = actualPorts.length > 0
          ? declaredPorts.filter(function (port) {
              return actualPorts.indexOf(port) === -1;
            })
          : [];
        var rowKey = compositeKey(projectPath === undefined ? "" : projectPath, command.id);
        var meta = [];
        if (current !== null && current !== undefined && current.status === "running" && typeof current.startedAt === "number") {
          meta.push(h("span", { key: "uptime", className: "dshRunnerStatusText" }, "运行 " + formatUptime(Date.now() - current.startedAt)));
        }
        if (current !== null && current !== undefined && (current.status === "exited" || current.status === "failed")
          && typeof current.exitCode === "number") {
          meta.push(h("span", { key: "exit", className: "dshRunnerStatusText" }, "退出码 " + current.exitCode));
        }
        if (!hasRunner && external !== undefined) {
          var externalOccupant = external.occupant;
          var externalText = "外部进程"
            + (externalOccupant !== undefined && typeof externalOccupant.pid === "number" ? " PID " + externalOccupant.pid : "")
            + (externalOccupant !== undefined && externalOccupant.related === true ? " · 疑似同项目旧实例" : "");
          meta.push(h("span", {
            key: "external",
            className: "dshRunnerStatusText",
            "data-status": "external",
            title: externalOccupant !== undefined && typeof externalOccupant.commandLine === "string" ? externalOccupant.commandLine : ""
          }, externalText));
          if (externalOccupant !== undefined && typeof externalOccupant.windowTitle === "string" && externalOccupant.windowTitle !== "") {
            meta.push(h("span", { key: "external-window", className: "dshRunnerStatusText", title: externalOccupant.windowTitle }, "窗口：" + externalOccupant.windowTitle));
          }
        }
        if (adoptedExternal && typeof current.pid === "number") {
          meta.push(h("span", {
            key: "adopted-pid",
            className: "dshRunnerStatusText",
            title: "这个进程是插件外部启动的，插件只接管了它的归属（可按 PID 停止/重启）"
          }, "外部 PID " + String(current.pid)));
        }
        var rowActions = rowActionsFor({
          status: status,
          hasRunner: hasRunner,
          external: external !== undefined,
          canAct: canAct,
          disabled: disabled,
          runnerOnly: row.runnerOnly === true
        });
        var showRestart = rowActions.restart === true && status !== "idle" && status !== "stopped";
        function rowButton(action, iconName, iconSize, label, title, enabled, handler) {
          return h("button", {
            type: "button",
            className: "dshRunnerMiniBtn",
            "data-action": action,
            title: title,
            "aria-label": label + "：" + String(command.title),
            disabled: rowBusy || enabled !== true,
            onClick: function (event) {
              event.stopPropagation();
              handler();
            }
          }, limobIcon(iconName, iconSize), h("span", null, label));
        }
        function rowIconButton(action, iconName, iconSize, label, title, enabled, handler) {
          return h("button", {
            type: "button",
            className: "dshLimobIconBtn",
            "data-action": action,
            title: title,
            "aria-label": label + "：" + String(command.title),
            disabled: rowBusy || enabled !== true,
            onClick: function (event) {
              event.stopPropagation();
              handler();
            }
          }, limobIcon(iconName, iconSize));
        }
        // 每行只保留「一个带文字的主操作 + 至多一个图标次要操作」，避免三连按钮的噪音。
        var primaryAction = null;
        var primaryIsRestart = false;
        if (rowActions.adopt) {
          primaryAction = rowButton("adopt", "play", 12, "接管", "把这个外部实例纳入托管（只改归属，不结束进程），之后就能在面板里停止/重启它", true, function () {
            runAdopt(command.id, projectPath, external);
          });
        } else if (rowActions.start) {
          primaryAction = rowButton("start", "play", 12, "启动", "启动命令", true, function () {
            runAction("start", command.id, projectPath);
          });
        } else if (rowActions.stop) {
          primaryAction = rowButton("stop", "stop", 10, "停止", "停止命令", true, function () {
            runAction("stop", command.id, projectPath);
          });
        } else if (showRestart) {
          primaryIsRestart = true;
          primaryAction = rowButton("restart", "restart", 13, "重启", "先停止再重新启动", true, function () {
            if (!hasRunner && external !== undefined) openExternalConflict(external, command.id, projectPath, "restart");
            else runAction("restart", command.id, projectPath);
          });
        }
        var secondaryAction = primaryAction !== null && showRestart && !primaryIsRestart
          ? rowIconButton("restart", "restart", 13, "重启", rowActions.adopt
              ? "结束当前外部实例，改由插件启动（之后可看实时日志）"
              : "先停止再重新启动", true, function () {
              if (!hasRunner && external !== undefined) openExternalConflict(external, command.id, projectPath, "restart");
              else runAction("restart", command.id, projectPath);
            })
          : null;
        return h("div", {
          key: rowKey,
          className: "dshRunnerRow",
          "data-command-id": command.id,
          "data-project-path": projectPath === undefined ? "" : projectPath,
          "data-status": status,
          "data-selected": selected !== null && selected !== undefined
            && selected.commandId === command.id
            && normalizePath(selected.projectPath) === normalizePath(projectPath) ? "true" : "false",
          "data-disabled": disabled ? "true" : "false",
          onClick: function () {
            if (canAct) setSelected({ projectPath: projectPath, commandId: command.id });
          }
        },
          h("span", { className: "dshRunnerDot", "data-status": status, title: runnerStatusText(status) }),
          h("div", { className: "dshRunnerRowMain" },
            h("div", { className: "dshRunnerRowTitle" },
              h("span", { className: "dshRunnerRowTitleText", title: String(command.title) }, String(command.title)),
              command.scope === "global" ? h("span", { className: "dshLimobTag" }, "全局") : null,
              disabled ? h("span", { className: "dshLimobTag" }, "已停用") : null,
              adoptedExternal
                ? h("span", {
                    className: "dshRunnerTagExternal",
                    title: "该实例不是本插件启动的，已纳入托管：可以停止/重启，但无法回放它的输出"
                  }, "外部接管")
                : null,
              h("span", { className: "dshRunnerState", "data-status": status }, runnerStatusText(status))),
            h("div", { className: "dshRunnerRowMetaLine" },
              h("span", { className: "dshRunnerRowCmd", title: String(command.command) }, String(command.command)),
              h("div", { className: "dshRunnerRowMeta" },
                declaredPorts.map(function (port) {
                  return h("span", { key: "declared-" + String(port), className: "dshRunnerPort", title: "声明端口 " + String(port) }, ":" + String(port));
                }),
                extraPorts.map(function (port) {
                  return h("span", {
                    key: "actual-" + String(port),
                    className: "dshRunnerPort dshRunnerPortWarn",
                    title: "实际监听端口（未在声明 ports 中）"
                  }, "实际 :" + String(port));
                }),
                missingPorts.map(function (port) {
                  return h("span", {
                    key: "missing-" + String(port),
                    className: "dshRunnerPort dshRunnerPortWarn",
                    title: "声明端口当前未被本命令的进程监听"
                  }, "未绑定 :" + String(port));
                }),
                meta))),
          h("div", { className: "dshRunnerRowActions" },
            primaryAction,
            secondaryAction));
      }

      function renderSection(section) {
        var rows = rowsOfSection(section);
        var runningCount = 0;
        var failedCount = 0;
        var externalCount = 0;
        for (var rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
          var rowItem = rows[rowIndex];
          if (rowItem.runner !== undefined) {
            runningCount += 1;
            if (rowItem.runner.status === "failed" || rowItem.runner.status === "exited") failedCount += 1;
          } else if (externalOccupancyForCommand(diagnose, rowItem.command.id, rowItem.projectPath) !== undefined) {
            externalCount += 1;
          }
        }
        var collapsed = section.global === true
          ? uiState.collapsedGlobal === true
          : isProjectCollapsed(uiState.collapsedProjects, section.projectPath);
        var sectionTitle = section.global === true
          ? "全局命令"
          : projectTitleOf(section.projectPath, workspaceOptions);
        var currentKey = typeof currentProjectPath === "string" && currentProjectPath !== "" ? normalizePath(currentProjectPath) : null;
        var isCurrent = section.global !== true && currentKey !== null
          && (normalizePath(section.projectPath) === currentKey
            || currentKey.indexOf(normalizePath(section.projectPath) + "\\") === 0);
        var sectionColor = projectColorOf(section.projectPath, uiState !== null && uiState !== undefined ? uiState.projectColors : undefined);
        return h("div", {
          key: section.key,
          className: "dshRunnerSection",
          "data-project-path": section.global === true ? "" : section.projectPath,
          "data-current": isCurrent ? "true" : "false",
          "data-collapsed": collapsed ? "true" : "false"
        },
          h("div", { className: "dshRunnerSectionHead" },
            h("button", {
              type: "button",
              className: "dshRunnerSectionToggle",
              "data-action": "toggle-section",
              "aria-expanded": collapsed ? "false" : "true",
              "aria-label": (collapsed ? "展开 " : "折叠 ") + sectionTitle,
              title: collapsed ? "展开该工作区" : "折叠该工作区",
              onClick: function () { toggleSection(section); }
            }, limobIcon("chevron", 14)),
            section.global === true ? null : h("button", {
              type: "button",
              className: "dshRunnerColorSwatch",
              "data-action": "project-color",
              "aria-label": "设置 " + sectionTitle + " 的项目颜色",
              title: "设置项目底色",
              style: { "--drr-swatch": sectionColor.accent, background: sectionColor.accent },
              onClick: function (event) {
                event.stopPropagation();
                setColorPicker(colorPicker === section.key ? null : section.key);
              }
            }),
            h("div", { className: "dshRunnerSectionInfo" },
              h("div", { className: "dshRunnerSectionTitleLine" },
                h("span", { className: "dshRunnerSectionTitle", title: section.projectPath === undefined ? "" : section.projectPath }, sectionTitle),
                isCurrent ? h("span", { className: "dshLimobTag", "data-current": "true", title: "当前会话所在项目" }, "当前") : null,
                h("span", {
                  className: "dshRunnerSectionCount",
                  "data-tone": runningCount > 0 ? "active" : "idle",
                  title: String(runningCount) + " 个运行中 / 共 " + String(rows.length) + " 条命令"
                }, String(runningCount) + " / " + String(rows.length)),
                externalCount > 0 ? h("span", { className: "dshRunnerSectionIssue", title: "有端口被插件之外的进程占用" }, "外部 " + String(externalCount)) : null,
                failedCount > 0 ? h("span", { className: "dshRunnerSectionIssue", title: "有命令启动失败或已退出" }, "异常 " + String(failedCount)) : null),
              h("span", { className: "dshRunnerSectionPath", title: section.projectPath === undefined ? "" : section.projectPath },
                section.projectPath === undefined ? "未选择项目会话" : section.projectPath)),
            section.global === true ? null : h("div", { className: "dshRunnerSectionActions" },
              h("button", {
                type: "button",
                className: "dshLimobIconBtn",
                "data-action": "start-all",
                title: "按依赖顺序启动本组全部命令",
                "aria-label": "启动 " + sectionTitle + " 的全部命令",
                disabled: flow !== null,
                onClick: function () { runStartAll(section.projectPath); }
              }, limobIcon("play", 14)),
              h("button", {
                type: "button",
                className: "dshLimobIconBtn",
                "data-action": "stop-all",
                title: "停止本组全部命令",
                "aria-label": "停止 " + sectionTitle + " 的全部命令",
                disabled: flow !== null,
                onClick: function () { runStopAll(section.projectPath); }
              }, limobIcon("stop", 13)))),
          section.global === true || colorPicker !== section.key ? null : h("div", { className: "dshRunnerColorRow" },
            h("span", { className: "dshRunnerColorLabel" }, "项目颜色"),
            projectColorPalette().map(function (color) {
              return h("button", {
                key: color.id,
                type: "button",
                className: "dshRunnerColorChip",
                "data-color": color.id,
                title: color.id,
                "aria-label": "使用 " + color.id + " 色",
                style: { background: color.accent, color: color.accent },
                onClick: function () { setProjectColor(section.projectPath, color.id); }
              });
            }),
            h("button", {
              type: "button",
              className: "dshRunnerColorAuto",
              title: "恢复按项目路径自动配色",
              onClick: function () { setProjectColor(section.projectPath, null); }
            }, "自动")),
          collapsed
            ? null
            : (rows.length === 0
              ? h("div", { className: "dshRunnerSectionEmpty" },
                  section.global === true ? "进入项目会话后可启动全局命令。" : "该项目暂无命令。")
              : rows.map(renderRow)));
      }

      var selectedCommand = selected === null || selected === undefined
        ? undefined
        : (configById[selected.commandId] !== undefined
          ? configById[selected.commandId]
          : (runnersByCommandId[selected.commandId] !== undefined ? runnerCommandOf(runnersByCommandId[selected.commandId]) : undefined));
      var selectedTitle = selected === null || selected === undefined
        ? ""
        : (selectedCommand !== undefined && typeof selectedCommand.title === "string" ? selectedCommand.title : String(selected.commandId));
      var selectedProjectPath = selected !== null && selected !== undefined && typeof selected.projectPath === "string" ? selected.projectPath : "";
      var logText = logState !== null && logState !== undefined && typeof logState.text === "string" ? stripAnsi(logState.text) : "";
      var logBytes = logState !== null && logState !== undefined && typeof logState.bytes === "number" ? logState.bytes : 0;
      var logTruncated = logState !== null && logState !== undefined && logState.truncated === true;
      // 「还没读到」和「读到了但是空」是两件事：前者说读取中，后者才说暂无日志
      var logPending = selected !== null && selected !== undefined && (logState === null || logState === undefined);
      var logMeta = formatBytes(logBytes) + (logTruncated ? " · 仅显示末尾 " + formatBytes(LOG_MAX_BYTES) : "");
      // 选中的命令是「外部接管」实例时，日志区必须说清楚：这段内容不是它的实时输出。
      var selectedRunner = selected === null || selected === undefined
        ? undefined
        : runnerByKey[compositeKey(selectedProjectPath, selected.commandId)];
      var selectedAdoptedExternal = selectedRunner !== undefined && selectedRunner.external === true;
      var selectedAdoptedPid = selectedAdoptedExternal && typeof selectedRunner.pid === "number" ? selectedRunner.pid : null;
      var selectedExternal = selected === null || selected === undefined
        ? undefined
        : (selectedRunner === undefined ? externalOccupancyForCommand(diagnose, selected.commandId, selectedProjectPath) : undefined);
      var selectedStatus = selected === null || selected === undefined
        ? "idle"
        : (selectedRunner !== undefined && typeof selectedRunner.status === "string"
          ? selectedRunner.status
          : (selectedExternal !== undefined ? "external" : "idle"));

      var logBody;
      if (selected === null || selected === undefined) {
        logBody = h("div", { className: "dshRunnerLogEmpty" },
          h("div", { className: "dshRunnerEmptyIcon" }, limobIcon("terminal", 19)),
          h("div", { className: "dshRunnerEmptyTitle" }, "选择一条命令查看日志"),
          h("div", { className: "dshRunnerEmptyHint" }, "点左侧任意命令行，这里会显示它的实时输出。"));
      } else if (logPending) {
        logBody = h("div", { className: "dshRunnerLogEmpty" },
          h("div", { className: "dshRunnerLoadingLine", style: { width: "140px" } }),
          h("div", { className: "dshRunnerEmptyHint" }, "正在读取日志…"));
      } else if (logText === "") {
        logBody = h("div", { className: "dshRunnerLogEmpty" },
          h("div", { className: "dshRunnerEmptyIcon" }, limobIcon("terminal", 19)),
          h("div", { className: "dshRunnerEmptyTitle" }, "还没有日志输出"),
          h("div", { className: "dshRunnerEmptyHint" }, "服务启动后打印的内容会实时出现在这里。"));
      } else {
        logBody = h("pre", {
          className: "dshRunnerPre",
          "data-dsh-runner-log": "1",
          ref: logRef,
          onScroll: handleLogScroll
        }, logText);
      }

      var logPane = h("div", { className: "dshRunnerLogPane" },
        h("div", { className: "dshRunnerLogHead" },
          h("span", { className: "dshRunnerLogTitle", title: selectedProjectPath === "" ? selectedTitle : selectedProjectPath },
            selected === null || selected === undefined ? null : h("span", { className: "dshRunnerDot", "data-status": selectedStatus }),
            h("span", null, selectedTitle === "" ? "日志" : selectedTitle)),
          selected === null || selected === undefined ? null : h("span", { className: "dshRunnerState", "data-status": selectedStatus }, runnerStatusText(selectedStatus)),
          selectedProjectPath === "" ? null : h("span", { className: "dshRunnerLogMeta", "data-path": "true", title: selectedProjectPath }, selectedProjectPath),
          selected === null || selected === undefined ? null : h("span", { className: "dshRunnerLogMeta" }, logMeta),
          h("div", { className: "dshRunnerLogTools" },
            selectedAdoptedExternal ? h("button", {
              type: "button",
              className: "dshRunnerMiniBtn",
              "data-action": "release-takeover",
              disabled: selected === null || selected === undefined || isRowPending(selectedProjectPath, selected.commandId),
              title: "不结束进程，只把这条命令移出托管；之后它重新显示为「外部运行中」",
              onClick: function () { releaseAdopted(selectedProjectPath, selected.commandId); }
            }, "取消接管") : null,
            h("button", {
              type: "button",
              className: "dshLimobIconBtn",
              title: copied ? "已复制到剪贴板" : "复制日志",
              "aria-label": "复制日志",
              disabled: logText === "" || copied,
              onClick: copyLog
            }, limobIcon(copied ? "check" : "copy", 14)),
            h("button", {
              type: "button",
              className: "dshLimobIconBtn",
              title: "清空这条命令的日志文件",
              "aria-label": "清空日志",
              disabled: selected === null || selected === undefined || flow !== null,
              onClick: clearLog
            }, limobIcon("trash", 14))),
          selectedAdoptedExternal ? h("div", { className: "dshRunnerLogNote", "data-external-log": "1" },
            limobIcon("alert", 13),
            h("span", null,
              "外部接管实例" + (selectedAdoptedPid === null ? "" : "（PID " + String(selectedAdoptedPid) + "）")
                + "：它不是插件启动的，输出无法回放，下面只是此前托管运行留下的日志。点「重启」改由插件启动后即可看实时日志。")) : null),
        logBody);

      function renderConflictEntry(item, index) {
        var occupant = item !== null && item !== undefined && item.occupant !== null && item.occupant !== undefined
          ? item.occupant
          : undefined;
        var windowTitle = occupant !== undefined && typeof occupant.windowTitle === "string" ? occupant.windowTitle : "";
        var commandLine = occupant !== undefined && typeof occupant.commandLine === "string" ? occupant.commandLine : "";
        var chain = formatProcessChain(occupant);
        var children = formatProcessChildren(occupant);
        var managed = occupant !== undefined && occupant.managed === true;
        return h("div", { key: "conflict-" + String(index), className: "dshRunnerConflictEntry", "data-port": item.port },
          h("div", { className: "dshRunnerConflictHead" },
            h("span", { className: "dshRunnerConflictPort" }, "端口 " + String(item.port)),
            h("span", null, occupantSummary(occupant)),
            h("span", { className: "dshRunnerConflictTag" }, managed ? "本插件托管" : "外部进程"),
            occupant !== undefined && occupant.related === true
              ? h("span", { className: "dshRunnerConflictTag" }, "疑似同项目旧实例")
              : null,
            windowTitle !== "" ? h("span", { className: "dshRunnerConflictTag", title: windowTitle }, "窗口：" + windowTitle) : null),
          managed && occupant !== undefined
            ? h("div", { className: "dshRunnerConflictMeta" },
                "该端口由已托管命令「" + String(occupant.runnerTitle === undefined ? occupant.runnerCommandId : occupant.runnerTitle) + "」占用，确认后将先停止该命令")
            : null,
          commandLine !== "" ? h("div", { className: "dshRunnerConflictCode", title: commandLine }, commandLine) : null,
          chain !== "" ? h("div", { className: "dshRunnerConflictMeta" }, "父进程链：" + chain) : null,
          children !== "" ? h("div", { className: "dshRunnerConflictMeta" }, "子进程：" + children) : null);
      }

      /** 进程型外部实例（没有端口可列，例如 Tauri 客户端）。 */
      function renderConflictProcess(item, index) {
        var name = item !== null && item !== undefined && typeof item.name === "string" && item.name !== "" ? item.name : "进程";
        var pid = item !== null && item !== undefined && typeof item.pid === "number" ? item.pid : null;
        var commandLine = item !== null && item !== undefined && typeof item.commandLine === "string" ? item.commandLine : "";
        return h("div", { key: "conflict-pid-" + String(index), className: "dshRunnerConflictEntry", "data-pid": pid === null ? "" : String(pid) },
          h("div", { className: "dshRunnerConflictHead" },
            h("span", { className: "dshRunnerConflictPort" }, "进程"),
            h("span", null, name + (pid === null ? "" : "（PID " + String(pid) + "）")),
            h("span", { className: "dshRunnerConflictTag" }, "外部进程")),
          commandLine !== "" ? h("div", { className: "dshRunnerConflictCode", title: commandLine }, commandLine) : null);
      }

      var conflictDialog = conflict === null || conflict === undefined ? null : h("div", {
        className: "dshRunnerDialogBackdrop",
        onMouseDown: function (event) {
          if (event.target === event.currentTarget && !conflictBusy) setConflict(null);
        }
      },
        h("div", { className: "dshRunnerDialog", "data-dsh-runner-conflict": "1" },
          h("div", { className: "dshRunnerDialogHead" },
            h("span", { className: "dshRunnerDialogIcon" }, limobIcon("alert", 16)),
            h("span", null, conflict.takeOver === true ? "外部实例正在运行" : "端口被占用")),
          h("div", { className: "dshRunnerDialogSub" },
            "项目 ",
            h("strong", null, String(conflict.projectPath === undefined ? "未知" : conflict.projectPath))),
          h("div", { className: "dshRunnerDialogSub" },
            conflict.takeOver === true
              ? "「" + titleOfCommand(conflict.commandId) + "」现在运行的是插件之外启动的实例。"
                + "确认后会结束它，再按托管方式重新启动——之后这个面板就能看实时日志、按端口/进程管理它。"
              : (conflict.kind === "port-mismatch"
                ? "「" + titleOfCommand(conflict.commandId) + "」未能绑定声明端口，本次启动已终止"
                  + (Array.isArray(conflict.actualPorts) && conflict.actualPorts.length > 0
                    ? "（实际绑定了 " + conflict.actualPorts.map(String).join("、") + "）"
                    : "")
                  + "。处理以下占用后可重试启动。"
                : "启动「" + titleOfCommand(conflict.commandId) + "」需要先处理以下端口占用。确认后会结束外部占用进程 / 停止对应托管命令，并自动重试启动。")),
          (Array.isArray(conflict.ports) ? conflict.ports : []).map(renderConflictEntry),
          (Array.isArray(conflict.processes) ? conflict.processes : []).map(renderConflictProcess),
          conflictError !== null ? h("div", { className: "dshRunnerDialogError", "data-dsh-runner-error": "1" },
            messageOf(conflictError) + (errorDetailText(conflictError) !== "" ? " · " + errorDetailText(conflictError) : "")) : null,
          conflictBusy
            ? h("div", { className: "dshRunnerDialogBusy" }, conflict.takeOver === true ? "正在结束外部实例并重启…" : "正在处理端口占用并重试启动…")
            : null,
          h("div", { className: "dshRunnerDialogActions" },
            h("button", {
              type: "button",
              className: "dshLimobCfgBtn",
              "data-action": "cancel-conflict",
              disabled: conflictBusy,
              onClick: function () { if (!conflictBusy) setConflict(null); }
            }, "取消"),
            h("button", {
              type: "button",
              className: "dshLimobCfgBtn dshLimobCfgBtnDangerSolid",
              "data-action": conflict.takeOver === true ? "takeover-restart" : "kill-and-start",
              disabled: conflictBusy,
              onClick: resolveConflict
            }, conflictBusy ? "处理中…" : (conflict.takeOver === true ? "结束外部实例并重启" : "结束占用进程并启动")))));

      var editorModal = !editorOpen ? null : h("div", {
        className: "dshLimobCfgModalBackdrop",
        onMouseDown: function (event) {
          if (event.target === event.currentTarget) setEditorOpen(false);
        }
      },
        h("div", { className: "dshLimobCfgModal", role: "dialog", "aria-modal": "true", "aria-label": "命令配置" },
          h("div", { className: "dshLimobCfgModalHead" },
            h("div", { className: "dshLimobCfgModalTitle" },
              h("span", null, "命令配置"),
              h("span", null, "dsh-runner · 新增、编辑、排序与启停")),
            h("button", {
              type: "button",
              className: "dshLimobIconBtn",
              title: "关闭",
              "aria-label": "关闭",
              onClick: function () { setEditorOpen(false); }
            }, limobIcon("close", 15))),
          h("div", { className: "dshLimobCfgModalBody" },
            h(ConfigEditor, {
              currentProjectPath: currentProjectPath,
              workspaces: workspaceOptions
            }))));

      return h("div", { className: "dshRunnerPage", "data-dsh-runner-page": "1" },
        h("div", { className: "dshRunnerHead" },
          h("div", { className: "dshRunnerHeadMain" },
            h("span", { className: "dshRunnerTitle" }, "运行"),
            h("div", { className: "dshRunnerSub" },
              h("span", { className: "dshRunnerProject" }, "全部项目"),
              h("span", { className: "dshRunnerSepDot" }),
              h("span", null, String(projectCount) + " 个项目"),
              summaryDots.length > 0 ? h("span", { className: "dshRunnerSepDot" }) : null,
              summaryDots)),
          h("div", { className: "dshRunnerToolbar" },
            h("button", {
              type: "button",
              className: "dshLimobCfgBtn dshLimobCfgBtnGhost",
              "data-action": "refresh",
              disabled: flow !== null,
              title: "重新读取命令配置与运行状态",
              onClick: refresh
            }, limobIcon("refresh", 14), h("span", null, flow === "refresh" ? "刷新中…" : "刷新")),
            h("button", {
              type: "button",
              className: "dshLimobCfgBtn",
              "data-action": "manage",
              title: "新增 / 编辑 / 排序 / 删除命令",
              onClick: function () { setEditorOpen(true); }
            }, limobIcon("sliders", 14), h("span", null, "管理命令")))),
        errorBar,
        h("div", { className: "dshRunnerBody" },
          !(uiLoaded && configReady)
            ? h("div", { className: "dshRunnerList", "data-dsh-runner-all": "1" },
                h("div", { className: "dshRunnerLoading", "aria-busy": "true" },
                  h("div", { className: "dshRunnerLoadingLine", style: { width: "48%" } }),
                  h("div", { className: "dshRunnerLoadingLine", style: { width: "72%" } }),
                  h("div", { className: "dshRunnerLoadingLine", style: { width: "58%" } }),
                  h("div", { className: "dshRunnerLoadingLine", style: { width: "66%" } }),
                  h("div", { className: "dshRunnerEmptyHint", style: { marginTop: "10px" } }, "正在读取运行面板状态…")))
            : (sections.length === 0
              ? h("div", { className: "dshRunnerList", "data-dsh-runner-all": "1" },
                  h("div", { className: "dshRunnerEmpty" },
                    h("div", { className: "dshRunnerEmptyIcon" }, limobIcon("terminal", 19)),
                    h("div", { className: "dshRunnerEmptyTitle" }, "还没有配置任何命令"),
                    h("div", { className: "dshRunnerEmptyHint" }, "点右上角「管理命令」新增，或在「设置 → dsh-runner」里编辑。")))
              : h("div", { className: "dshRunnerList", "data-dsh-runner-all": "1" }, sections.map(renderSection))),
          logPane),
        conflictDialog,
        editorModal);
    }

    // =====================================================================
    // 十四、会话标题栏（conversation.session.header.actions）
    // 当前项目命令的运行状态：居中显示「名称 + 状态」，不占用对话内容区。
    // =====================================================================
    function RunnerHeaderStatus(props) {
      var config = useConfig();
      var active = useActiveSession(props);
      var propSessionId = props !== undefined && props.sessionId !== undefined
        ? props.sessionId
        : (props !== undefined && props.session !== undefined && props.session !== null ? props.session.sessionId : undefined);
      var currentProjectPath = useProjectPath(props !== undefined ? props.useWorkspaces : undefined, propSessionId);
      if (currentProjectPath === undefined || currentProjectPath === null || currentProjectPath === "") {
        currentProjectPath = active !== null && active !== undefined && typeof active.projectPath === "string" && active.projectPath !== ""
          ? active.projectPath
          : undefined;
      }
      var hasProject = currentProjectPath !== undefined && currentProjectPath !== null && currentProjectPath !== "";
      var commands = hasProject ? visibleCommandsForProject(config, currentProjectPath) : [];
      var commandCount = commands.length;
      var runnersPair = react.useState([]);
      var runners = runnersPair[0];
      var setRunners = runnersPair[1];
      var diagnosePair = react.useState([]);
      var diagnoseEntries = diagnosePair[0];
      var setDiagnoseEntries = diagnosePair[1];
      var posPair = react.useState(null);
      var pos = posPair[0];
      var setPos = posPair[1];
      var actionKeyPair = react.useState(null);
      var actionKey = actionKeyPair[0];
      var setActionKey = actionKeyPair[1];
      var actionErrorPair = react.useState(null);
      var actionError = actionErrorPair[0];
      var setActionError = actionErrorPair[1];

      // ---- 悬停实时日志气泡：只读 project/log，打开期间 700ms 轮询一次 ----
      var hoverPair = react.useState(null);
      var hover = hoverPair[0];
      var setHover = hoverPair[1];
      var hoverLogPair = react.useState(null);
      var hoverLog = hoverLogPair[0];
      var setHoverLog = hoverLogPair[1];
      var hoverPosPair = react.useState(null);
      var hoverPos = hoverPosPair[0];
      var setHoverPos = hoverPosPair[1];
      var hoverCloseTimer = react.useRef(null);
      var hoverBodyRef = react.useRef(null);
      var hoverStickRef = react.useRef(true);

      function cancelHoverClose() {
        if (hoverCloseTimer.current !== null) {
          clearTimeout(hoverCloseTimer.current);
          hoverCloseTimer.current = null;
        }
      }

      function closeHoverLog() {
        cancelHoverClose();
        hoverStickRef.current = true;
        setHover(null);
        setHoverLog(null);
        setHoverPos(null);
      }

      function scheduleHoverClose() {
        cancelHoverClose();
        hoverCloseTimer.current = setTimeout(closeHoverLog, 300);
      }

      function openHoverLog(item, element) {
        cancelHoverClose();
        var rect = element !== null && element !== undefined && typeof element.getBoundingClientRect === "function"
          ? element.getBoundingClientRect()
          : null;
        var viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1280;
        var viewportHeight = typeof window !== "undefined" ? window.innerHeight : 800;
        var width = Math.max(280, Math.min(520, viewportWidth - 24));
        var left = rect === null ? 12 : rect.left + rect.width / 2 - width / 2;
        left = Math.max(12, Math.min(left, viewportWidth - width - 12));
        var top = rect === null ? 44 : rect.bottom + 8;
        if (top + 220 > viewportHeight) {
          top = Math.max(12, (rect === null ? 44 : rect.top) - 8 - Math.min(380, Math.max(96, viewportHeight * 0.48)));
        }
        hoverStickRef.current = true;
        setHoverLog(null);
        setHoverPos({ top: top, left: left, width: width });
        setHover({
          key: item.key,
          projectPath: item.projectPath,
          commandId: item.commandId,
          title: item.label !== undefined ? item.label : item.title,
          status: item.status,
          ports: Array.isArray(item.ports) ? item.ports : []
        });
      }

      function onHoverBodyScroll(event) {
        var element = event.currentTarget;
        hoverStickRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 28;
      }

      react.useEffect(function () {
        return function () {
          if (hoverCloseTimer.current !== null) {
            clearTimeout(hoverCloseTimer.current);
            hoverCloseTimer.current = null;
          }
        };
      }, []);

      // 悬停期间轮询该命令的日志尾部；离开 chip/气泡即停止。
      react.useEffect(function () {
        if (hover === null || hover === undefined) return undefined;
        var alive = true;
        var projectPath = hover.projectPath;
        var commandId = hover.commandId;
        async function readHoverLog() {
          if (projectPath === undefined || projectPath === null || projectPath === ""
            || typeof commandId !== "string" || commandId === "") {
            setHoverLog({ text: "", bytes: 0, error: "这条记录没有可读取的日志路径。" });
            return;
          }
          try {
            var value = await rpc("project/log", {
              projectPath: projectPath,
              commandId: commandId,
              maxBytes: LOG_MAX_BYTES
            });
            if (!alive) return;
            var raw = value !== null && value !== undefined && typeof value.text === "string" ? value.text : "";
            var bytes = value !== null && value !== undefined && typeof value.bytes === "number" ? value.bytes : 0;
            var text = stripAnsi(raw);
            if (text.length > HEADER_LOG_MAX_CHARS) {
              text = "…（仅显示最后 " + HEADER_LOG_MAX_CHARS + " 字符）\n" + text.slice(-HEADER_LOG_MAX_CHARS);
            }
            setHoverLog({ text: text, bytes: bytes, error: "" });
          } catch (error) {
            if (alive) setHoverLog({ text: "", bytes: 0, error: messageOf(error) });
          }
        }
        readHoverLog();
        var timer = setInterval(readHoverLog, HEADER_LOG_POLL_MS);
        return function () {
          alive = false;
          clearInterval(timer);
        };
      }, [hover !== null && hover !== undefined ? hover.key : ""]);

      // 实时滚动：默认贴底；用户手动上滚后不再强制拉回，回到底部后恢复跟随。
      react.useEffect(function () {
        var element = hoverBodyRef.current;
        if (element === null || element === undefined) return;
        if (hoverStickRef.current) element.scrollTop = element.scrollHeight;
      }, [hoverLog]);

      async function runHeaderAction(item, action) {
        if (item.projectPath === undefined || item.projectPath === null || item.projectPath === ""
          || typeof item.commandId !== "string" || item.commandId === "") return;
        setActionKey(item.key);
        setActionError(null);
        try {
          // 动作响应已带回最新 runners，不再额外发一轮 status。
          var value = await rpc("project/" + action, { projectPath: item.projectPath, commandId: item.commandId });
          if (value !== null && value !== undefined && Array.isArray(value.runners)) setRunners(value.runners);
        } catch (error) {
          var failedKey = item.key;
          setActionError({ key: failedKey, message: messageOf(error) });
          logPluginError(runtimeCtx, "顶部运行操作失败（" + action + "）", error);
          setTimeout(function () {
            setActionError(function (current) {
              return current !== null && current !== undefined && current.key === failedKey ? null : current;
            });
          }, 8000);
        } finally {
          setActionKey(null);
        }
      }

      // 状态轮询：当前项目有命令时显示这些命令；没有命令时显示所有项目正在运行的服务。
      react.useEffect(function () {
        if (!hasProject) {
          setRunners([]);
          setDiagnoseEntries([]);
          return undefined;
        }
        var alive = true;
        var timer = null;
        var tickCount = 0;
        function schedule() {
          if (alive) timer = setTimeout(tick, STATUS_POLL_MS);
        }
        async function tick() {
          tickCount += 1;
          try {
            var value = await rpc("project/status", {});
            if (!alive) return;
            setRunners(value !== null && value !== undefined && Array.isArray(value.runners) ? value.runners : []);
          } catch (statusError) {
            // 辅助展示失败：保留旧状态。
          }
          if (alive && tickCount % 3 === 1) {
            try {
              var diagnosed = await rpc("project/diagnose", {});
              if (alive) {
                setDiagnoseEntries(diagnosed !== null && diagnosed !== undefined && Array.isArray(diagnosed.entries) ? diagnosed.entries : []);
              }
            } catch (diagnoseError) {
              // 同上。
            }
          }
          schedule();
        }
        tick();
        return function () {
          alive = false;
          clearTimeout(timer);
        };
      }, [hasProject]);

      // 位置：优先放进窗口标题栏（Windows titleBarOverlay 的标题栏区）；
      // 网页端没有该区域时退回会话标题栏，仍然居中。
      react.useEffect(function () {
        var alive = true;
        var attempts = 0;
        var header = null;
        var observer = null;
        function measure() {
          if (!alive || typeof document === "undefined") return;
          var overlay = typeof navigator !== "undefined" ? navigator.windowControlsOverlay : undefined;
          if (overlay !== undefined && overlay !== null && overlay.visible === true
            && typeof overlay.getTitlebarAreaRect === "function") {
            var titleRect = overlay.getTitlebarAreaRect();
            if (titleRect.width > 0 && titleRect.height > 0) {
              var windowWidth = typeof window !== "undefined" ? window.innerWidth : titleRect.width;
              setPos({
                top: titleRect.y + titleRect.height / 2,
                left: windowWidth / 2,
                maxWidth: Math.max(240, Math.min(titleRect.width - 260, windowWidth - 300))
              });
              return;
            }
          }
          var element = document.querySelector("header[data-window-drag]");
          if (element === null) {
            if (attempts < 20) {
              attempts += 1;
              setTimeout(measure, 150);
            } else {
              setPos(null);
            }
            return;
          }
          if (header !== element) {
            header = element;
            if (observer !== null) observer.disconnect();
            if (typeof ResizeObserver !== "undefined") {
              observer = new ResizeObserver(measure);
              observer.observe(element);
            }
          }
          var rect = element.getBoundingClientRect();
          if (rect.width <= 0) {
            setPos(null);
            return;
          }
          setPos({
            top: rect.top + Math.min(25, Math.max(12, rect.height / 2)),
            left: rect.left + rect.width / 2,
            maxWidth: Math.max(240, rect.width - 240)
          });
        }
        measure();
        if (typeof window !== "undefined") window.addEventListener("resize", measure);
        var ticker = setInterval(measure, 1500);
        return function () {
          alive = false;
          clearInterval(ticker);
          if (observer !== null) observer.disconnect();
          if (typeof window !== "undefined") window.removeEventListener("resize", measure);
        };
      }, []);

      function shortProject(path) {
        if (typeof path !== "string" || path === "") return "";
        var parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
        return parts.length === 0 ? path : parts[parts.length - 1];
      }

      function sameProject(left, right) {
        return normalizePath(left) === normalizePath(right);
      }

      var configById = {};
      if (config !== null && config !== undefined && Array.isArray(config.commands)) {
        for (var configIndex = 0; configIndex < config.commands.length; configIndex += 1) {
          var configCommand = config.commands[configIndex];
          if (configCommand !== null && configCommand !== undefined && typeof configCommand.id === "string") {
            configById[configCommand.id] = configCommand;
          }
        }
      }

      function runnerFor(command) {
        for (var i = 0; i < runners.length; i += 1) {
          var runner = runners[i];
          if (runner === null || runner === undefined || runner.commandId !== command.id) continue;
          if (typeof runner.projectPath !== "string") continue;
          if (command.scope === "project" && !commandMatchesProject(command, runner.projectPath)) continue;
          if (command.scope !== "project" && hasProject && !sameProject(runner.projectPath, currentProjectPath)) continue;
          return runner;
        }
        return undefined;
      }

      function externalFor(command, projectPath) {
        for (var i = 0; i < diagnoseEntries.length; i += 1) {
          var entry = diagnoseEntries[i];
          if (entry === null || entry === undefined || entry.commandId !== command.id) continue;
          if (entry.listening !== true) continue;
          if (entry.occupant === null || entry.occupant === undefined) continue;
          if (entry.occupant.managed === true) continue;
          if (projectPath !== undefined && typeof entry.projectPath === "string" && !sameProject(entry.projectPath, projectPath)) continue;
          return entry;
        }
        return undefined;
      }

      var FAILED_CHIP_WINDOW_MS = 10 * 60 * 1000;
      var items = [];
      if (commandCount > 0) {
        for (var commandIndex = 0; commandIndex < commands.length; commandIndex += 1) {
          var command = commands[commandIndex];
          var commandRunner = runnerFor(command);
          var externalEntry = commandRunner === undefined ? externalFor(command, currentProjectPath) : undefined;
          var commandStatus = commandRunner !== undefined && typeof commandRunner.status === "string"
            ? commandRunner.status
            : (externalEntry !== undefined ? "external" : "idle");
          items.push({
            key: "cmd:" + command.id,
            title: String(command.title),
            projectPath: currentProjectPath,
            commandId: command.id,
            hasRunner: commandRunner !== undefined,
            external: false,
            status: commandStatus,
            ports: Array.isArray(command.ports) ? command.ports : []
          });
        }
      } else {
        // 当前项目没有命令：按「命令身份」(projectPath + commandId) 合并为一个实例，
        // 托管实例优先；同一身份不会再同时出现「运行中」和「外部运行中」。
        var instances = {};
        var orderedKeys = [];
        function addInstance(projectPath, commandId, title, status, ports, managed) {
          var identity = normalizePath(projectPath) + "\u0000" + commandId;
          var existing = instances[identity];
          if (existing !== undefined && existing.managed === true && managed !== true) return;
          if (existing === undefined) orderedKeys.push(identity);
          instances[identity] = {
            key: identity,
            title: title,
            projectPath: projectPath,
            commandId: commandId,
            hasRunner: managed === true,
            external: managed !== true,
            status: status,
            ports: ports,
            managed: managed === true
          };
        }
        for (var runnerIndex = 0; runnerIndex < runners.length; runnerIndex += 1) {
          var running = runners[runnerIndex];
          if (running === null || running === undefined) continue;
          var activeStatus = running.status === "queued" || running.status === "running"
            || running.status === "starting" || running.status === "stopping";
          var recentFailure = (running.status === "failed" || running.status === "exited")
            && typeof running.startedAt === "number" && Date.now() - running.startedAt < FAILED_CHIP_WINDOW_MS;
          if (!activeStatus && !recentFailure) continue;
          addInstance(
            running.projectPath,
            running.commandId,
            typeof running.title === "string" && running.title !== "" ? running.title : String(running.commandId),
            running.status,
            Array.isArray(running.ports) ? running.ports : [],
            true
          );
        }
        for (var entryIndex = 0; entryIndex < diagnoseEntries.length; entryIndex += 1) {
          var entry = diagnoseEntries[entryIndex];
          if (entry === null || entry === undefined) continue;
          if (entry.occupant === null || entry.occupant === undefined || entry.occupant.managed === true) continue;
          var isProcessEntry = entry.kind === "process" && Array.isArray(entry.processes) && entry.processes.length > 0;
          if (entry.listening !== true && !isProcessEntry) continue;
          addInstance(
            entry.projectPath,
            entry.commandId,
            typeof entry.title === "string" && entry.title !== "" ? entry.title : String(entry.commandId),
            "external",
            entry.listening === true ? [entry.port] : [],
            false
          );
        }
        items = orderedKeys.map(function (key) { return instances[key]; });
        // 同名命令跨项目时，用项目短名消歧（只在冲突时出现，不增加常驻长度）。
        var titleCounts = {};
        for (var titleIndex = 0; titleIndex < items.length; titleIndex += 1) {
          var titleKey = items[titleIndex].title;
          titleCounts[titleKey] = (titleCounts[titleKey] || 0) + 1;
        }
        for (var labelIndex = 0; labelIndex < items.length; labelIndex += 1) {
          var labelItem = items[labelIndex];
          if (titleCounts[labelItem.title] > 1) {
            var shortName = shortProject(labelItem.projectPath);
            labelItem.label = shortName === "" ? labelItem.title : labelItem.title + " · " + shortName;
          } else {
            labelItem.label = labelItem.title;
          }
        }
      }

      if (items.length === 0 || pos === null) return null;

      // 当前悬停的命令对应的最新条目（状态可能已从 starting 变成 running）。
      var hoverItem = null;
      if (hover !== null && hover !== undefined) {
        for (var focusIndex = 0; focusIndex < items.length; focusIndex += 1) {
          if (items[focusIndex].key === hover.key) {
            hoverItem = items[focusIndex];
            break;
          }
        }
      }

      var headerFloat = h("div", {
        className: "dshRunnerHeaderFloat",
        "data-dsh-runner-header": "1",
        style: {
          top: pos.top + "px",
          left: pos.left + "px",
          maxWidth: (typeof pos.maxWidth === "number" ? pos.maxWidth : 600) + "px"
        },
        "aria-label": "运行状态"
      },
        items.map(function (item) {
          var statusText = item.status === "external" ? "外部运行中" : runnerStatusText(item.status);
          var itemError = actionError !== null && actionError !== undefined && actionError.key === item.key ? actionError.message : "";
          var projectLabel = shortProject(item.projectPath);
          var projectColor = projectColorOf(item.projectPath, uiStateCache !== null && uiStateCache !== undefined ? uiStateCache.projectColors : undefined);
          var actions = headerActionsFor(item.status, item.hasRunner, item.external);
          var itemBusy = actionKey === item.key;
          var tooltip = (projectLabel === "" ? "" : projectLabel + " · ") + item.title + " · " + statusText
            + (item.ports.length > 0 ? " · 端口 " + item.ports.join("、") : "")
            + (itemError === "" ? "" : " · " + itemError);
          function actionButton(action, iconName, label, size) {
            return h("button", {
              type: "button",
              className: "dshRunnerHeaderBtn",
              "data-action": action,
              title: label,
              "aria-label": label + "：" + item.title,
              disabled: itemBusy,
              onClick: function (event) {
                event.stopPropagation();
                runHeaderAction(item, action);
              }
            }, itemBusy ? null : limobIcon(iconName, size));
          }
          return h("span", {
            key: item.key,
            className: "dshRunnerHeaderChip",
            "data-status": item.status,
            "data-busy": itemBusy ? "true" : "false",
            style: { "--drr-chip": projectColor.accent },
            "aria-label": tooltip,
            onMouseEnter: function (event) { openHoverLog(item, event.currentTarget); },
            onMouseLeave: scheduleHoverClose,
            onFocus: function (event) { openHoverLog(item, event.currentTarget); },
            onBlur: scheduleHoverClose
          },
            h("span", { className: "dshRunnerDot", "data-status": item.status }),
            h("span", { className: "dshRunnerHeaderName" }, item.label !== undefined ? item.label : item.title),
            h("span", {
              className: "dshRunnerHeaderState",
              "data-status": itemError === "" ? item.status : "failed"
            }, itemError === "" ? statusText : "失败"),
            h("span", { className: "dshRunnerHeaderActions" },
              actions.start ? actionButton("start", "play", "启动", 10) : null,
              actions.stop ? actionButton("stop", "stop", "停止", 9) : null,
              actions.restart ? actionButton("restart", "restart", "重启", 11) : null));
        }));

      if (hover === null || hover === undefined || hoverPos === null) return headerFloat;

      var shownItem = hoverItem !== null && hoverItem !== undefined ? hoverItem : hover;
      var shownStatus = shownItem.status === "external" ? "外部运行中" : runnerStatusText(shownItem.status);
      var shownProject = shortProject(shownItem.projectPath);
      var shownPorts = Array.isArray(shownItem.ports) ? shownItem.ports : [];
      var shownText = hoverLog !== null && hoverLog !== undefined && typeof hoverLog.text === "string" ? hoverLog.text : "";
      var shownError = hoverLog !== null && hoverLog !== undefined && typeof hoverLog.error === "string" ? hoverLog.error : "";
      var shownBytes = hoverLog !== null && hoverLog !== undefined && typeof hoverLog.bytes === "number" ? hoverLog.bytes : 0;
      var shownMeta = shownStatus
        + (shownPorts.length > 0 ? " · 端口 " + shownPorts.join("、") : "")
        + (shownBytes > 0 ? " · " + formatBytes(shownBytes) : "");

      var hoverBubble = h("div", {
        className: "dshRunnerLogBubble",
        "data-dsh-runner-log-bubble": "1",
        style: { top: hoverPos.top + "px", left: hoverPos.left + "px", width: hoverPos.width + "px" },
        onMouseEnter: cancelHoverClose,
        onMouseLeave: scheduleHoverClose
      },
        h("div", { className: "dshRunnerLogBubbleHead" },
          h("span", { className: "dshRunnerDot", "data-status": shownItem.status }),
          h("span", { className: "dshRunnerLogBubbleTitle" }, shownItem.label !== undefined ? shownItem.label : shownItem.title),
          h("span", { className: "dshRunnerLogBubbleMeta" }, shownMeta),
          h("span", { className: "dshRunnerLogBubbleLive", "data-tone": shownError === "" ? "live" : "error" }, shownError === "" ? "实时" : "失败")),
        shownError !== ""
          ? h("div", { className: "dshRunnerLogBubbleError" }, shownError)
          : (shownText === ""
            ? h("div", { className: "dshRunnerLogBubbleEmpty" },
                shownProject === "" ? "还没有日志输出（服务可能尚未打印任何内容）。" : "还没有日志输出（" + shownProject + " 的服务可能尚未打印任何内容）。")
            : h("pre", {
                className: "dshRunnerLogBubbleBody",
                ref: hoverBodyRef,
                onScroll: onHoverBodyScroll
              }, shownText)));

      return h("div", { className: "dshRunnerLogBubbleHost", style: { display: "contents" } }, headerFloat, hoverBubble);
    }

    // =====================================================================
    // 十五、输入框下方的「运行」按钮（conversation.composer.dock）
    // =====================================================================
    function LimobComposerButton(props) {
      var config = useConfig();
      var sessionId = props !== undefined && props.sessionId !== undefined
        ? props.sessionId
        : (props !== undefined && props.session !== undefined && props.session !== null ? props.session.sessionId : undefined);
      var projectPath = useProjectPath(props !== undefined ? props.useWorkspaces : undefined, sessionId);
      var hasProject = projectPath !== undefined && projectPath !== null && projectPath !== "";

      var menuPair = react.useState(false);
      var menuOpen = menuPair[0];
      var setMenuOpen = menuPair[1];
      var menuPosPair = react.useState(null);
      var menuPos = menuPosPair[0];
      var setMenuPos = menuPosPair[1];
      var busyPair = react.useState(null);
      var busy = busyPair[0];
      var setBusy = busyPair[1];
      var statusPair = react.useState(null);
      var status = statusPair[0];
      var setStatus = statusPair[1];
      var runnersPair = react.useState([]);
      var runners = runnersPair[0];
      var setRunners = runnersPair[1];
      var rootRef = react.useRef(null);
      var buttonRef = react.useRef(null);

      var commands = config !== null && config !== undefined && Array.isArray(config.commands)
        ? visibleCommandsForProject(config, projectPath).filter(function (command) {
            return command.enabled !== false;
          })
        : [];

      // 状态提示 6 秒后自动消失。
      react.useEffect(function () {
        if (status === null) return undefined;
        var timer = setTimeout(function () {
          setStatus(null);
        }, 6000);
        return function () {
          clearTimeout(timer);
        };
      }, [status]);

      // 点菜单外部 / Esc 关闭菜单。
      react.useEffect(function () {
        if (!menuOpen) return undefined;
        function onPointerDown(event) {
          var root = rootRef.current;
          var target = event.target;
          var inMenu = target !== null && target !== undefined && typeof target.closest === "function"
            && target.closest(".dshLimobRunMenu") !== null;
          if (!inMenu && root !== null && root !== undefined && !root.contains(target)) setMenuOpen(false);
        }
        function onKeyDown(event) {
          if (event.key === "Escape") setMenuOpen(false);
        }
        document.addEventListener("mousedown", onPointerDown);
        document.addEventListener("keydown", onKeyDown);
        return function () {
          document.removeEventListener("mousedown", onPointerDown);
          document.removeEventListener("keydown", onKeyDown);
        };
      }, [menuOpen]);

      async function refreshRunners() {
        if (!hasProject) {
          setRunners([]);
          return;
        }
        try {
          var value = await rpc("project/status", { projectPath: projectPath });
          setRunners(value !== null && value !== undefined && Array.isArray(value.runners) ? value.runners : []);
        } catch (statusError) {
          setStatus({ phase: "error", text: "读取进程状态失败：" + messageOf(statusError) });
        }
      }

      function toggleMenu() {
        if (!menuOpen) {
          // AI 可能刚改过配置，打开菜单先读一次 Host 配置。
          loadConfig().catch(function (loadError) {
            setStatus({ phase: "error", text: "读取配置失败：" + messageOf(loadError) });
          });
          refreshRunners();
          try {
            var rect = buttonRef.current !== null && buttonRef.current !== undefined
              ? buttonRef.current.getBoundingClientRect()
              : null;
            var width = typeof window !== "undefined" && typeof window.innerWidth === "number" ? window.innerWidth : 1280;
            var height = typeof window !== "undefined" && typeof window.innerHeight === "number" ? window.innerHeight : 800;
            if (rect !== null) {
              var menuWidth = Math.min(400, width - 16);
              var left = Math.min(Math.max(8, rect.left), Math.max(8, width - menuWidth - 8));
              setMenuPos({ left: left, bottom: height - rect.top + 8, maxHeight: Math.max(160, rect.top - 24) });
            } else {
              setMenuPos(null);
            }
          } catch (_error) {
            setMenuPos(null);
          }
        }
        setMenuOpen(!menuOpen);
      }

      async function runAction(action, command) {
        if (busy !== null) return;
        if (!hasProject) {
          setStatus({ phase: "error", text: "请先进入一个项目会话" });
          return;
        }
        var label = action === "start" ? "启动" : action === "stop" ? "停止" : "重启";
        setBusy(command.id);
        setStatus({ phase: "starting", text: "正在" + label + "：" + command.title });
        try {
          var endpoint = action === "start" ? "project/start" : action === "stop" ? "project/stop" : "project/restart";
          var value = await rpc(endpoint, { projectPath: projectPath, commandId: command.id });
          if (value !== null && value !== undefined && Array.isArray(value.runners)) setRunners(value.runners);
          setStatus({ phase: action === "stop" ? "idle" : "running", text: action === "stop" ? "已停止：" + command.title : "已提交：" + command.title });
        } catch (actionError) {
          setStatus({ phase: "error", text: label + "失败：" + messageOf(actionError) });
        } finally {
          setBusy(null);
        }
      }

      if (!uiVisibleOf(config)) return null;

      var runnerByCommand = {};
      for (var runnerIndex = 0; runnerIndex < runners.length; runnerIndex += 1) {
        var runner = runners[runnerIndex];
        if (runner !== null && runner !== undefined && typeof runner.commandId === "string") {
          runnerByCommand[runner.commandId] = runner;
        }
      }

      function renderMenuRow(command) {
        var current = runnerByCommand[command.id];
        var rowStatus = current !== null && current !== undefined && typeof current.status === "string" ? current.status : "idle";
        var rowActive = rowStatus === "queued" || rowStatus === "starting"
          || rowStatus === "running" || rowStatus === "stopping";
        function menuAction(action, iconName, size, label, disabled) {
          return h("button", {
            type: "button",
            className: "dshLimobIconBtn",
            "data-action": action,
            title: label + " " + command.title,
            "aria-label": label + " " + command.title,
            disabled: disabled,
            onClick: function () { runAction(action, command); }
          }, limobIcon(iconName, size));
        }
        return h("div", { key: command.id, className: "dshLimobRunRow" },
          h("span", { className: "dshLimobRunRowMain" },
            h("span", { className: "dshLimobRunItemTitleLine" },
              h("span", { className: "dshRunnerDot", "data-status": rowStatus }),
              h("span", { className: "dshLimobRunItemTitle" }, command.title)),
            h("span", { className: "dshLimobRunItemCmd" },
              h("span", { className: "dshLimobRunItemState", "data-status": rowStatus }, runnerStatusText(rowStatus)),
              " · " + String(command.command))),
          h("span", { className: "dshLimobRunRowActions" },
            menuAction("start", "play", 12, "启动", busy !== null || rowActive),
            menuAction("stop", "stop", 11, "停止", busy !== null || !rowActive),
            menuAction("restart", "restart", 13, "重启", busy !== null)));
      }

      var menuStyle = menuPos !== null
        ? {
            position: "fixed",
            left: menuPos.left + "px",
            bottom: menuPos.bottom + "px",
            top: "auto",
            right: "auto",
            maxHeight: menuPos.maxHeight + "px"
          }
        : { left: "0" };

      var menuElement = menuOpen
        ? h("div", { className: "dshLimobRunMenu", style: menuStyle, role: "menu" },
            h("div", { className: "dshLimobRunMenuTitle" },
              h("span", null, "运行命令"),
              h("span", null, hasProject ? String(projectPath) : "当前会话")),
            commands.length === 0
              ? h("div", { className: "dshLimobRunEmpty" },
                  h("span", { className: "dshRunnerEmptyIcon" }, limobIcon("terminal", 18)),
                  h("span", null, hasProject
                    ? "当前项目没有可用命令：到「设置 → dsh-runner」或左侧「运行 → 管理命令」里添加。"
                    : "请先进入一个项目会话。"))
              : commands.map(renderMenuRow),
            h("div", { className: "dshLimobRunSep" }),
            h("div", { className: "dshLimobRunHint" }, "完整面板见左侧「运行」"))
        : null;

      // 菜单 portal 到 body：避免输入框容器的 overflow / stacking context 裁切。
      var menu = menuElement;
      if (menuElement !== null && reactDom !== null && typeof reactDom.createPortal === "function"
        && typeof document !== "undefined" && document.body !== null) {
        menu = reactDom.createPortal(menuElement, document.body);
      }

      return h("div", { ref: rootRef, className: "dshLimobRunDock" },
        h("button", {
          ref: buttonRef,
          type: "button",
          className: "dshLimobRunBtn",
          "data-busy": busy !== null ? "true" : "false",
          "aria-haspopup": "menu",
          "aria-expanded": menuOpen ? "true" : "false",
          title: "项目运行：启动/停止/重启（完整面板见左侧「运行」）",
          "aria-label": "运行",
          onClick: function () {
            if (busy !== null) return;
            toggleMenu();
          }
        },
          limobIcon("play", 13),
          h("span", null, "运行")),
        status !== null ? h("span", {
          className: "dshLimobRunStatus",
          "data-phase": status.phase || "idle",
          title: status.text
        }, status.text) : null,
        menu);
    }

    // =====================================================================
    // 十五、注册
    // =====================================================================
    function registerSlot(ctx, slotName, options, component) {
      try {
        ctx.slots.inject(slotName, function () {
          return ctx.slots.register(options, component);
        });
      } catch (error) {
        logPluginError(ctx, "注册槽位失败（" + slotName + "）", error);
      }
    }

    function apply(ctx) {
      runtimeCtx = ctx;
      try {
        hostConnection = typeof ctx.get === "function" ? ctx.get("connection") : undefined;
      } catch (_error) {
        hostConnection = undefined;
      }
      // 预取折叠偏好：用户点开「运行」时直接按记忆状态渲染（不先展开再折叠）。
      void prefetchUiState().catch(function (error) {
        logPluginError(runtimeCtx, "读取运行面板折叠状态失败", error);
      });
      // 左侧导航「运行」入口（图标）+ 完整运行面板。
      registerSlot(ctx, "sidebar.panellist", {
        name: "sidebar.panellist",
        id: PANEL_ID,
        order: 20,
        label: PANEL_LABEL
      }, RunnerPanelIcon);
      registerSlot(ctx, "main", { name: "main", key: PANEL_ID }, RunnerPage);
      // 标题栏运行状态：走 frame 级 overlay（空会话也显示、不影响标题栏布局），按实测位置居中。
      registerSlot(ctx, "shell.overlay", {
        name: "shell.overlay",
        id: "dsh-runner-status",
        order: 40
      }, RunnerHeaderStatus);
      // 输入框下方紧凑「▶ 运行」按钮（只做启停重启，不创建终端）。
      registerSlot(ctx, "conversation.composer.dock", {
        name: "conversation.composer.dock",
        id: "dsh-runner-run",
        order: 40
      }, LimobComposerButton);
      // 设置弹窗左侧新增「dsh-runner」页（命令编辑器）。
      registerSlot(ctx, "settings.section", {
        name: "settings.section",
        id: PANEL_ID,
        order: 60,
        label: PLUGIN_NAME
      }, LimobSettingsSection);
      // 插件详情页更新提示。
      registerSlot(ctx, "plugins.detail.badge", {
        name: "plugins.detail.badge",
        id: "dsh-runner-update",
        order: 100
      }, LimobUpdateBadge);
      registerSlot(ctx, "plugins.detail.section", {
        name: "plugins.detail.section",
        id: "dsh-runner-update",
        order: 100
      }, LimobUpdateSection);
    }

    exports.name = PLUGIN_NAME;
    exports.inject = ["slots", "connection"];
    exports.apply = apply;

    // 仅给离线测试/CI 用的纯函数入口；DSH loader 只读 name/inject/apply。
    exports.__test = {
      stripAnsi: stripAnsi,
      formatUptime: formatUptime,
      formatBytes: formatBytes,
      commandMatchesProject: commandMatchesProject,
      visibleCommandsForProject: visibleCommandsForProject,
      runnerStatusText: runnerStatusText,
      externalOccupancyForCommand: externalOccupancyForCommand,
      buildRunnerSections: buildRunnerSections,
      isProjectCollapsed: isProjectCollapsed,
      projectColorOf: projectColorOf,
      headerActionsFor: headerActionsFor,
      rowActionsFor: rowActionsFor,
      toggleCollapsedProject: toggleCollapsedProject,
      occupantSummary: occupantSummary,
      formatProcessChain: formatProcessChain,
      formatProcessChildren: formatProcessChildren
    };

    return module.exports;
  }
});
