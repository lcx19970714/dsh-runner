// dsh-runner 的面板 UI 偏好（折叠状态）。
//
// 为什么放 Host：折叠状态是「用户对全部项目视图的偏好」，要跨会话、跨 Host 重启、
// 跨浏览器都一致；放 localStorage 只能记住单个浏览器。文件与 commands.json 同目录。
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizePath } from "./host-config.js";

export const UI_STATE_VERSION = 2;

/** 默认 UI 状态：全部展开、项目色自动分配（无覆盖）。 */
export function defaultUiState() {
  return {
    version: UI_STATE_VERSION,
    collapsedProjects: [],
    collapsedGlobal: false,
    projectColors: {}
  };
}

/** 项目颜色覆盖：只接受短标识（色板 id），键统一成规范路径。 */
function normalizeProjectColors(raw) {
  const colors = {};
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) return colors;
  for (const [rawKey, rawValue] of Object.entries(raw)) {
    if (typeof rawKey !== "string" || typeof rawValue !== "string") continue;
    const key = normalizePath(rawKey);
    const value = rawValue.trim();
    if (key === "" || value === "" || value.length > 32) continue;
    if (!/^[A-Za-z0-9_-]+$/.test(value)) continue;
    colors[key] = value;
  }
  return colors;
}

/** 归一化并去重折叠项目列表（路径统一成 host 的规范形式）。 */
export function normalizeUiState(raw) {
  const state = defaultUiState();
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) return state;
  if (Array.isArray(raw.collapsedProjects)) {
    const seen = new Set();
    for (const item of raw.collapsedProjects) {
      if (typeof item !== "string") continue;
      const key = normalizePath(item);
      if (key === "" || seen.has(key)) continue;
      seen.add(key);
      state.collapsedProjects.push(key);
    }
  }
  if (typeof raw.collapsedGlobal === "boolean") state.collapsedGlobal = raw.collapsedGlobal;
  state.projectColors = normalizeProjectColors(raw.projectColors);
  return state;
}

/**
 * 读取 UI 状态。
 * - 文件不存在 → 默认状态（首次使用）；
 * - JSON 损坏 / 类型不对 → 归一化后回到默认（只是 UI 偏好，不影响 commands.json 与进程）。
 */
export async function loadUiState(filePath) {
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (error !== null && error !== undefined && error.code === "ENOENT") return defaultUiState();
    throw new Error("读取 UI 状态失败：" + filePath + "：" + (error instanceof Error ? error.message : String(error)));
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return defaultUiState();
  }
  return normalizeUiState(parsed);
}

/** 原子写入 UI 状态（严格归一化后落盘，返回落盘内容）。 */
export async function saveUiState(filePath, raw) {
  const state = normalizeUiState(raw);
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = filePath + ".tmp";
  await writeFile(tempPath, JSON.stringify(state, null, 2) + "\n", "utf8");
  await rename(tempPath, filePath);
  return state;
}
