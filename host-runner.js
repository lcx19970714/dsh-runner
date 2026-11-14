// dsh-runner 的「项目级」后台进程管理（SPEC 第 2.3 / 3 节）。
//
// 第一性原理（本文件遵守的不变量）：
//   1. 进程归属项目，不归属会话：key = 规范化项目路径 + 命令 id，与 Session 无关。
//   2. Host 是进程状态的唯一事实来源。状态机只前进：
//        starting -> running -> stopping -> stopped | exited | failed
//      stop() 在返回前必须让状态离开 running 并落盘，UI 不需要靠猜/等 exit 事件。
//   3. 子进程的 stdout/stderr 直接写日志文件（继承 fd），不经过 Host 转发：
//      Host 退出/重载不会破坏日志，也没有管道背压。
//   4. 进程生命周期 = Host lifetime，但状态跨 Host 重启：启动时读 state 文件对账，
//      校验 pid + 命令行标记后接管仍在运行的项目进程；
//      校验不通过（进程没了 / pid 被复用）的记录直接丢弃，绝不误杀别的进程。
//   5. 插件卸载不杀进程：项目级后台任务不应该因为 UI/插件重载而中断。
//      停止只通过 stop / stopProject 显式触发。
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { accessSync, closeSync, openSync, statSync, writeSync } from "node:fs";
import { appendFile, mkdir, open as openFile, readFile, rename, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const STATE_VERSION = 2;
const ACTIVE_STATUSES = new Set(["starting", "running", "stopping"]);
const DEFAULT_READY_TIMEOUT_MS = 120000;
const READY_POLL_MS = 150;
const STOP_GRACEFUL_WAIT_MS = 2000;
const STOP_TIMEOUT_MS = 4000;
const ADOPTED_REFRESH_MS = 1500;
const PORT_FALLBACK_GRACE_MS = 3000;
/** 停止/结束后等端口真正释放的上限：Windows 上监听 socket 关闭比进程退出略晚。 */
const PORT_RELEASE_TIMEOUT_MS = 6000;
const MARKER_PREFIX = "dsh-runner-";
const MAX_PORT = 65535;
const LOG_DEFAULT_MAX_BYTES = 65536;
const LOG_MIN_MAX_BYTES = 1024;
const LOG_MAX_MAX_BYTES = 1048576;

let cachedShellPath;

/** 运行器结构化错误：code/details 直接被 RPC 层透传给 Client。 */
export class RunnerError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "RunnerError";
    this.code = code;
    this.details = details === undefined || details === null ? {} : details;
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error === undefined || error === null ? "" : error);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 优先 pwsh，退回 Windows PowerShell；结果在进程内缓存。 */
function resolvePowerShell() {
  if (cachedShellPath !== undefined) return cachedShellPath;
  try {
    const result = spawnSync("where.exe", ["pwsh.exe"], { encoding: "utf8", windowsHide: true });
    if (result.status === 0 && typeof result.stdout === "string") {
      const line = result.stdout.split(/\r?\n/).map((item) => item.trim()).find((item) => item !== "");
      if (line !== undefined) {
        cachedShellPath = line;
        return cachedShellPath;
      }
    }
  } catch (error) {
    // where.exe 不存在时退回 powershell.exe；这里不是吞错，是明确的降级路径。
  }
  cachedShellPath = "powershell.exe";
  return cachedShellPath;
}

function safeFilePart(value) {
  return String(value === undefined || value === null ? "" : value).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "value";
}

function escapePowerShell(value) {
  return String(value).replace(/'/g, "''");
}

/** 项目路径的规范形态：去空白、统一反斜杠、去尾部斜杠、小写（只用于比较/哈希）。 */
export function normalizeProjectPath(value) {
  return String(value === undefined || value === null ? "" : value)
    .trim()
    .replace(/\//g, "\\")
    .replace(/\\+$/g, "")
    .toLowerCase();
}

export function samePath(left, right) {
  const a = normalizeProjectPath(left);
  const b = normalizeProjectPath(right);
  return a !== "" && a === b;
}

/** 命令的 projectRoot 是否覆盖给定项目路径（global 命令永远匹配）。 */
export function commandMatchesProject(command, projectPath) {
  if (command === null || command === undefined || typeof command !== "object") return false;
  if (command.scope === "global") return true;
  if (command.scope !== "project") return false;
  const root = normalizeProjectPath(command.projectRoot);
  const current = normalizeProjectPath(projectPath);
  if (root === "" || current === "") return false;
  return current === root || current.indexOf(root + "\\") === 0;
}

function projectHash(projectPath) {
  return createHash("sha1").update(normalizeProjectPath(projectPath)).digest("hex").slice(0, 12);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isActive(record) {
  return record !== undefined && record !== null && ACTIVE_STATUSES.has(record.status);
}

/**
 * 命令行标记：写进 PowerShell 脚本的第一个语句，进程表里可见。
 * 用于 Host 重启接管时确认「这个 pid 确实是我们上次启动的那个进程」，避免 pid 复用误杀。
 */
function createMarker(key) {
  const digest = createHash("sha1")
    .update(String(key))
    .update("|")
    .update(String(Date.now()))
    .update("|")
    .update(randomBytes(8).toString("hex"))
    .digest("hex")
    .slice(0, 16);
  return MARKER_PREFIX + digest;
}

/** 组装实际执行的 PowerShell 脚本（单行）。 */
function buildCommandText(command, cwd, marker) {
  const parts = [
    "$null = '" + escapePowerShell(marker) + "'",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "$OutputEncoding = [Console]::OutputEncoding",
    "chcp 65001 | Out-Null"
  ];
  if (typeof cwd === "string" && cwd.trim() !== "") {
    parts.push("Set-Location -LiteralPath '" + escapePowerShell(cwd.trim()) + "'");
  }
  parts.push(String(command.command));
  return parts.join("; ");
}

/** 日志追加失败不影响进程状态（日志只是可观测性），因此显式忽略，原因见本注释。 */
function appendLogLine(logPath, line) {
  if (typeof logPath !== "string" || logPath === "") return Promise.resolve();
  return appendFile(logPath, line, "utf8").catch(() => {
    // 忽略：日志文件被外部删除/占用时不应改变进程状态机。
  });
}

/** TCP 探测：只用于「声明端口可连接」确认；监听归属由进程树校验负责。 */
function connectOnce(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: host, port: port, timeout: timeoutMs });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/** 同时尝试 IPv4/IPv6 回环：声明端口可能只绑在其中一个地址族上。 */
async function canConnectAny(port) {
  if (await connectOnce("127.0.0.1", port, 300)) return true;
  return connectOnce("::1", port, 300);
}

/** 轻量进程树：pid -> {parentPid, name}；启动轮询/所有权校验用（不取命令行/窗口）。 */
function queryProcessTree() {
  if (process.platform !== "win32") {
    const map = new Map();
    const result = spawnSync("ps", ["-eo", "pid=,ppid=,comm="], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    if (result.error !== undefined && result.error !== null) throw result.error;
    for (const line of String(result.stdout === undefined || result.stdout === null ? "" : result.stdout).split(/\r?\n/)) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(line);
      if (match === null) continue;
      map.set(Number(match[1]), { parentPid: Number(match[2]), name: match[3] });
    }
    return map;
  }
  const script = [
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "$OutputEncoding = [Console]::OutputEncoding",
    "$procs = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name",
    "if ($null -eq $procs) { throw 'Get-CimInstance Win32_Process 返回空' }",
    "$rows = foreach ($p in $procs) { [pscustomobject]@{ pid = [int]$p.ProcessId; ppid = [int]$p.ParentProcessId; name = [string]$p.Name } }",
    "ConvertTo-Json -InputObject @($rows) -Depth 3 -Compress"
  ].join("\n");
  const result = spawnSync(resolvePowerShell(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 20000,
    maxBuffer: 4 * 1024 * 1024
  });
  if (result.error !== undefined && result.error !== null) throw result.error;
  if (typeof result.stdout !== "string") throw new Error("无法读取 Windows 进程树");
  const text = result.stdout.trim();
  if (text === "") throw new Error("Windows 进程树为空");
  let rows;
  try {
    rows = JSON.parse(text);
  } catch (error) {
    throw new Error("解析 Windows 进程树失败：" + messageOf(error));
  }
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : [rows]) {
    if (row === null || typeof row !== "object") continue;
    const pid = Number(row.pid);
    if (!Number.isFinite(pid)) continue;
    map.set(pid, {
      parentPid: Number.isFinite(Number(row.ppid)) ? Number(row.ppid) : 0,
      name: typeof row.name === "string" ? row.name : ""
    });
  }
  return map;
}

/**
 * 全地址族 TCP 监听表（IPv4 + IPv6）：
 *   byPort: port -> Set<pid>
 *   byPid:  pid  -> Set<port>
 * 只用 netstat/ss 的结果，不依赖 connect 是否成功（服务可能只绑一个地址族）。
 */
function queryTcpListeners() {
  const byPort = new Map();
  const byPid = new Map();
  const add = (port, pid) => {
    if (!Number.isInteger(port) || !Number.isInteger(pid) || pid <= 0) return;
    let pids = byPort.get(port);
    if (pids === undefined) {
      pids = new Set();
      byPort.set(port, pids);
    }
    pids.add(pid);
    let ports = byPid.get(pid);
    if (ports === undefined) {
      ports = new Set();
      byPid.set(pid, ports);
    }
    ports.add(port);
  };
  if (process.platform === "win32") {
    const result = spawnSync("netstat.exe", ["-ano"], { encoding: "utf8", windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    if (result.error !== undefined && result.error !== null) throw result.error;
    if (result.status !== 0) throw new Error("netstat 读取端口失败（exit " + String(result.status) + "）");
    if (typeof result.stdout !== "string") throw new Error("netstat 没有输出");
    for (const line of result.stdout.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length !== 5) continue;
      if (parts[0] !== "TCP" || parts[3] !== "LISTENING") continue;
      const separator = parts[1].lastIndexOf(":");
      if (separator <= 0) continue;
      add(Number(parts[1].slice(separator + 1)), Number(parts[4]));
    }
    return { byPort: byPort, byPid: byPid };
  }
  const result = spawnSync("ss", ["-ltnpH"], { encoding: "utf8", windowsHide: true, timeout: 15000 });
  if (result.error !== undefined && result.error !== null) throw result.error;
  for (const line of String(result.stdout === undefined || result.stdout === null ? "" : result.stdout).split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const separator = parts[3].lastIndexOf(":");
    if (separator <= 0) continue;
    const pidMatch = /pid=(\d+)/.exec(line);
    if (pidMatch !== null) add(Number(parts[3].slice(separator + 1)), Number(pidMatch[1]));
  }
  return { byPort: byPort, byPid: byPid };
}

/** 从 rootPid 向下收集整棵进程树（含 root）。 */
function collectTreePids(rootPid, tree) {
  const result = new Set();
  if (!Number.isInteger(rootPid) || rootPid <= 0) return result;
  const childrenByParent = new Map();
  for (const [pid, info] of tree) {
    const list = childrenByParent.get(info.parentPid);
    if (list === undefined) childrenByParent.set(info.parentPid, [pid]);
    else list.push(pid);
  }
  result.add(rootPid);
  const queue = [rootPid];
  while (queue.length > 0) {
    const current = queue.shift();
    const children = childrenByParent.get(current);
    if (children === undefined) continue;
    for (const child of children) {
      if (result.has(child)) continue;
      result.add(child);
      queue.push(child);
    }
  }
  return result;
}

/** 进程树实际监听的端口（用于「声明端口是否真的由我启动的进程监听」）。 */
function treeListeningPorts(rootPid, tree, listeners) {
  const pids = collectTreePids(rootPid, tree);
  const ports = [];
  for (const pid of pids) {
    const set = listeners.byPid.get(pid);
    if (set === undefined) continue;
    for (const port of set) if (ports.indexOf(port) === -1) ports.push(port);
  }
  return { pids: pids, ports: ports };
}

/** 端口占用者是否疑似同一项目的旧实例（命令行里出现项目根/命令 cwd）。 */
function occupantText(occupant) {
  if (occupant === null || occupant === undefined) return "未知进程";
  const name = typeof occupant.name === "string" && occupant.name !== "" ? occupant.name : "进程";
  return typeof occupant.pid === "number" ? name + "（PID " + String(occupant.pid) + "）" : name;
}

function markOccupantRelated(occupant, projectPath, cwd) {
  const line = normalizeProjectPath(occupant.commandLine);
  const root = normalizeProjectPath(projectPath);
  const workdir = normalizeProjectPath(cwd);
  occupant.related = (root !== "" && line.indexOf(root) !== -1)
    || (workdir !== "" && line.indexOf(workdir) !== -1);
  return occupant;
}

/**
 * 读取指定 pid 的进程信息：pid -> {name, createdAt, commandLine}。
 * createdAt 用于「外部接管」的身份校验（pid 会被复用，创建时间不会）。
 * 进程不存在时不会出现在结果里；读取失败时抛错（调用方必须保守处理）。
 */
function queryProcessTable(pids) {
  const ids = Array.from(new Set(pids.filter((pid) => typeof pid === "number" && Number.isFinite(pid) && pid > 0)));
  if (ids.length === 0) return new Map();
  if (process.platform !== "win32") {
    const map = new Map();
    for (const pid of ids) {
      try {
        process.kill(pid, 0);
        map.set(pid, { name: "", createdAt: "", commandLine: "" });
      } catch (error) {
        // 进程不存在：不加入结果表。
      }
    }
    return map;
  }
  const filter = ids.map((pid) => "ProcessId=" + String(pid)).join(" OR ");
  // createdAt 必须排在 commandLine 之前：命令行里可能有 "|"，创建时间是固定格式不会有。
  const script = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; "
    + "Get-CimInstance Win32_Process -Filter \"" + filter + "\" | ForEach-Object { \"$($_.ProcessId)|$($_.Name)|$(if ($_.CreationDate) { $_.CreationDate.ToString('o') } else { '' })|$($_.CommandLine)\" }";
  const result = spawnSync(resolvePowerShell(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000
  });
  if (result.error !== undefined && result.error !== null) throw result.error;
  if (typeof result.stdout !== "string") throw new Error("无法读取 Windows 进程表");
  const map = new Map();
  for (const line of result.stdout.split(/\r?\n/)) {
    const first = line.indexOf("|");
    if (first <= 0) continue;
    const second = line.indexOf("|", first + 1);
    if (second === -1) continue;
    const third = line.indexOf("|", second + 1);
    if (third === -1) continue;
    const pid = Number(line.slice(0, first).trim());
    if (!Number.isFinite(pid)) continue;
    map.set(pid, {
      name: line.slice(first + 1, second),
      createdAt: line.slice(second + 1, third),
      commandLine: line.slice(third + 1)
    });
  }
  return map;
}

/**
 * 一次查询整张进程表：pid -> {parentPid, name, commandLine, executablePath, createdAt, windowTitle}。
 * 用于端口诊断/端口冲突的「进程树归属」判定与占用者展示。
 * 窗口标题取自主窗口（MainWindowTitle）：Electron/IDE 这类应用足以让用户认出是哪个程序；
 * 纯控制台进程通常没有主窗口，windowTitle 为空。
 */
function queryProcessSnapshot() {
  if (process.platform !== "win32") {
    const map = new Map();
    const result = spawnSync("ps", ["-eo", "pid=,ppid=,comm=,args="], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    if (result.error !== undefined && result.error !== null) throw result.error;
    for (const line of String(result.stdout === undefined || result.stdout === null ? "" : result.stdout).split(/\r?\n/)) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line);
      if (match === null) continue;
      map.set(Number(match[1]), {
        pid: Number(match[1]),
        parentPid: Number(match[2]),
        name: match[3],
        commandLine: match[4],
        executablePath: "",
        createdAt: "",
        windowTitle: ""
      });
    }
    return map;
  }
  const script = [
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "$OutputEncoding = [Console]::OutputEncoding",
    "$procs = Get-CimInstance Win32_Process",
    "if ($null -eq $procs) { throw 'Get-CimInstance Win32_Process 返回空' }",
    "$wins = @{}",
    "foreach ($item in (Get-Process -ErrorAction SilentlyContinue)) {",
    "  try { $title = $item.MainWindowTitle; if ($title) { $wins[[int]$item.Id] = [string]$title } } catch { }",
    "}",
    "$rows = foreach ($p in $procs) {",
    "  $procId = [int]$p.ProcessId",
    "  [pscustomobject]@{",
    "    pid = $procId",
    "    ppid = [int]$p.ParentProcessId",
    "    name = [string]$p.Name",
    "    exe = [string]$p.ExecutablePath",
    "    created = if ($p.CreationDate) { $p.CreationDate.ToString('o') } else { '' }",
    "    cmd = [string]$p.CommandLine",
    "    win = if ($wins.ContainsKey($procId)) { [string]$wins[$procId] } else { '' }",
    "  }",
    "}",
    "ConvertTo-Json -InputObject @($rows) -Depth 3 -Compress"
  ].join("\n");
  const result = spawnSync(resolvePowerShell(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 20000,
    maxBuffer: 8 * 1024 * 1024
  });
  if (result.error !== undefined && result.error !== null) throw result.error;
  if (typeof result.stdout !== "string") throw new Error("无法读取 Windows 进程表");
  const text = result.stdout.trim();
  if (text === "") throw new Error("Windows 进程表为空");
  let rows;
  try {
    rows = JSON.parse(text);
  } catch (error) {
    throw new Error("解析 Windows 进程表失败：" + messageOf(error));
  }
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : [rows]) {
    if (row === null || typeof row !== "object") continue;
    const pid = Number(row.pid);
    if (!Number.isFinite(pid)) continue;
    map.set(pid, {
      pid: pid,
      parentPid: Number.isFinite(Number(row.ppid)) ? Number(row.ppid) : 0,
      name: typeof row.name === "string" ? row.name : "",
      commandLine: typeof row.cmd === "string" ? row.cmd : "",
      executablePath: typeof row.exe === "string" ? row.exe : "",
      createdAt: typeof row.created === "string" ? row.created : "",
      windowTitle: typeof row.win === "string" ? row.win : ""
    });
  }
  return map;
}

/**
 * 把一个 pid 描述成用户可读的占用者：
 * 基础信息 + 主窗口标题 + 父进程链（最多 6 层）+ 直接子进程（最多 10 个）。
 */
function describeOccupant(pid, snapshot) {
  const info = snapshot.get(pid);
  const occupant = {
    pid: pid,
    name: info !== undefined && typeof info.name === "string" ? info.name : "",
    executablePath: info !== undefined && typeof info.executablePath === "string" ? info.executablePath : "",
    commandLine: info !== undefined && typeof info.commandLine === "string" ? info.commandLine : "",
    startedAt: info !== undefined && typeof info.createdAt === "string" ? info.createdAt : "",
    windowTitle: info !== undefined && typeof info.windowTitle === "string" ? info.windowTitle : "",
    ancestors: [],
    children: []
  };
  const seen = new Set([pid]);
  let current = info !== undefined ? info.parentPid : undefined;
  for (let depth = 0; depth < 6 && Number.isInteger(current) && current > 0 && !seen.has(current); depth += 1) {
    const parent = snapshot.get(current);
    if (parent === undefined) break;
    occupant.ancestors.push({
      pid: current,
      name: parent.name,
      commandLine: parent.commandLine,
      windowTitle: parent.windowTitle
    });
    seen.add(current);
    current = parent.parentPid;
  }
  for (const entry of snapshot.values()) {
    if (entry.parentPid !== pid) continue;
    if (occupant.children.length >= 10) break;
    occupant.children.push({
      pid: entry.pid,
      name: entry.name,
      commandLine: entry.commandLine,
      windowTitle: entry.windowTitle
    });
  }
  return occupant;
}

/**
 * 外部接管的身份校验：pid 存在 + 创建时间一致（±2s）。
 * 外部进程不是本插件启动的，命令行里没有 marker，只能用「pid + 创建时间」代替，
 * 这样 pid 被系统复用时不会误杀别的进程。
 */
function isSameProcess(expected, info) {
  if (info === undefined || info === null) return false;
  const wanted = expected !== null && expected !== undefined && typeof expected.pidCreatedAt === "string" ? expected.pidCreatedAt : "";
  const actual = typeof info.createdAt === "string" ? info.createdAt : "";
  if (wanted === "" || actual === "") return true;
  const left = Date.parse(wanted);
  const right = Date.parse(actual);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return true;
  return Math.abs(left - right) <= 2000;
}

/**
 * state 条目是否可用：
 * - 插件自己启动的实例必须带 marker + logPath（命令行标记用于跳过 pid 复用）；
 * - 外部接管的实例没有 marker，靠 pid + pidCreatedAt 校验，logPath 只用于展示历史日志。
 */
function isStateEntry(entry) {
  const usable = entry !== null && typeof entry === "object"
    && typeof entry.pid === "number" && Number.isFinite(entry.pid) && entry.pid > 0
    && typeof entry.projectPath === "string" && entry.projectPath !== ""
    && typeof entry.commandId === "string" && entry.commandId !== "";
  if (!usable) return false;
  if (entry.external === true) return true;
  return typeof entry.marker === "string" && entry.marker !== ""
    && typeof entry.logPath === "string" && entry.logPath !== "";
}

/** 按 dependsOn 做拓扑排序（只排 selected 内部的依赖，selected 之外的由 start 递归处理）。 */
function orderCommandsByDependencies(selected, allCommands) {
  const selectedIds = new Set(selected.map((command) => command.id));
  const byId = new Map();
  for (const command of allCommands) {
    if (command !== null && typeof command === "object" && typeof command.id === "string") byId.set(command.id, command);
  }
  const visited = new Set();
  const order = [];
  const visit = (command, stack) => {
    if (visited.has(command.id) || stack.has(command.id)) return;
    stack.add(command.id);
    for (const dependencyId of Array.isArray(command.dependsOn) ? command.dependsOn : []) {
      if (!selectedIds.has(dependencyId)) continue;
      const dependency = byId.get(dependencyId);
      if (dependency !== undefined) visit(dependency, stack);
    }
    stack.delete(command.id);
    visited.add(command.id);
    order.push(command);
  };
  for (const command of selected) visit(command, new Set());
  return order;
}

/**
 * 把「可执行文件位于命令 cwd 之下」的进程归属到该命令。
 * 用于识别没有声明端口、或根进程已退出但进程仍活的实例（例如 Tauri 客户端）。
 * 最长 cwd 优先；已被托管进程树占用的 pid 不计入。
 */
export function attributeProjectProcesses(commands, snapshot, managedPids, scopedProjectPath) {
  const targets = [];
  for (const command of commands) {
    if (command === null || typeof command !== "object") continue;
    if (command.scope !== "project") continue;
    const root = typeof command.projectRoot === "string" ? command.projectRoot.trim() : "";
    const cwd = typeof command.cwd === "string" && command.cwd.trim() !== "" ? command.cwd.trim() : root;
    if (root === "" || cwd === "") continue;
    if (scopedProjectPath !== undefined && !commandMatchesProject(command, scopedProjectPath)) continue;
    targets.push({
      command: command,
      projectPath: root,
      cwdKey: normalizeProjectPath(cwd)
    });
  }
  if (targets.length === 0) return [];
  targets.sort((left, right) => right.cwdKey.length - left.cwdKey.length);
  const buckets = new Map();
  for (const [pid, info] of snapshot) {
    if (pid === process.pid) continue;
    if (managedPids !== null && managedPids !== undefined && managedPids.has(pid)) continue;
    const exe = normalizeProjectPath(info.executablePath);
    if (exe === "") continue;
    let matched;
    for (const target of targets) {
      if (exe === target.cwdKey || exe.indexOf(target.cwdKey + "\\") === 0) {
        matched = target;
        break;
      }
    }
    if (matched === undefined) continue;
    const bucketKey = normalizeProjectPath(matched.projectPath) + "\u0000" + matched.command.id;
    let bucket = buckets.get(bucketKey);
    if (bucket === undefined) {
      bucket = { command: matched.command, projectPath: matched.projectPath, processes: [] };
      buckets.set(bucketKey, bucket);
    }
    bucket.processes.push({
      pid: pid,
      name: info.name,
      executablePath: info.executablePath,
      commandLine: info.commandLine,
      createdAt: info.createdAt
    });
  }
  return [...buckets.values()];
}

/** 一个项目路径下，一个命令最多一个进程；状态跨 Host 重启保留。 */
export class ProjectRunnerService {
  constructor(options = {}) {
    this.logDir = options.logDir || path.join(os.homedir(), ".dsh", "dsh-runner", "logs");
    this.statePath = options.statePath || path.join(path.dirname(this.logDir), "runner-state.json");
    this.logger = options.logger;
    this.records = new Map();
    this.persistQueue = Promise.resolve();
    this.initPromise = null;
    this.lastRefreshAt = 0;
  }

  key(projectPath, commandId) {
    return normalizeProjectPath(projectPath) + "::" + String(commandId);
  }

  /** 幂等初始化：对账上次 Host 留下的状态。RPC / Tool 使用前必须 await。 */
  init() {
    if (this.initPromise === null) this.initPromise = this.reconcile();
    return this.initPromise;
  }

  async reconcile() {
    const entries = await this.readStateEntries();
    const candidates = entries.filter(isStateEntry);
    if (candidates.length === 0) {
      await this.persist();
      return;
    }
    let table;
    try {
      table = queryProcessTable(candidates.map((entry) => entry.pid));
    } catch (error) {
      // 读不到进程表时保守处理：不接管、不改写 state 文件（留待下次启动再试）。
      this.reportError("无法校验上次的后台进程，跳过接管", error);
      return;
    }
    const dead = [];
    for (const entry of candidates) {
      const processInfo = table.get(entry.pid);
      const alive = entry.external === true
        ? isSameProcess(entry, processInfo)
        : (processInfo !== undefined
          && (process.platform !== "win32" || processInfo.commandLine.indexOf(entry.marker) !== -1));
      if (!alive) {
        dead.push(entry);
        if (processInfo === undefined) {
          await appendLogLine(entry.logPath, "\r\n[dsh-runner] 上次记录的后台进程已结束（Host 重启时发现）\r\n");
        }
        continue;
      }
      const key = typeof entry.key === "string" && entry.key !== "" ? entry.key.replaceAll("\u0000", "::") : this.key(entry.projectPath, entry.commandId);
      if (this.records.has(key)) continue;
      const readyPort = Number.isInteger(entry.readyPort) ? entry.readyPort : null;
      const ready = readyPort === null ? null : await canConnectAny(readyPort);
      this.records.set(key, {
        key: key,
        projectPath: String(entry.projectPath),
        commandId: String(entry.commandId),
        title: typeof entry.title === "string" && entry.title !== "" ? entry.title : String(entry.commandId),
        command: typeof entry.command === "string" ? entry.command : "",
        cwd: typeof entry.cwd === "string" ? entry.cwd : "",
        ports: Array.isArray(entry.ports) ? entry.ports.filter((port) => Number.isInteger(port)) : [],
        readyPort: readyPort,
        readyTimeoutMs: Number.isInteger(entry.readyTimeoutMs) ? entry.readyTimeoutMs : DEFAULT_READY_TIMEOUT_MS,
        logPath: entry.logPath,
        marker: typeof entry.marker === "string" ? entry.marker : "",
        pid: entry.pid,
        pidCreatedAt: typeof entry.pidCreatedAt === "string" ? entry.pidCreatedAt : "",
        startedAt: typeof entry.startedAt === "number" ? entry.startedAt : Date.now(),
        status: "running",
        ready: ready,
        actualPorts: [],
        exitCode: undefined,
        stopRequested: false,
        adopted: true,
        adoptedAt: typeof entry.adoptedAt === "number" ? entry.adoptedAt : undefined,
        external: entry.external === true,
        child: null,
        treePids: Array.isArray(entry.treePids) ? entry.treePids.filter((pid) => Number.isInteger(pid)) : [],
        finished: false
      });
    }

    // 根进程已死、但上次记录的进程树仍有存活子进程（Host 崩溃/被杀时常见）：
    // 按 pid + 创建时间校验后清理，避免它们继续占端口、被误判成外部实例。
    const withTree = dead.filter((entry) => Array.isArray(entry.treePids) && entry.treePids.length > 0);
    if (withTree.length > 0) {
      let snapshot;
      try {
        snapshot = queryProcessSnapshot();
      } catch (error) {
        this.reportError("无法读取进程表，跳过上次残留清理", error);
      }
      if (snapshot !== undefined) {
        for (const entry of withTree) {
          const startedAt = typeof entry.startedAt === "number" ? entry.startedAt : 0;
          for (const pid of entry.treePids) {
            if (!Number.isInteger(pid) || pid === process.pid) continue;
            const info = snapshot.get(pid);
            if (info === undefined) continue;
            const created = typeof info.createdAt === "string" ? Date.parse(info.createdAt) : Number.NaN;
            if (Number.isFinite(created) && startedAt > 0 && created + 2000 < startedAt) continue;
            this.killProcess(pid, true);
          }
        }
      }
    }
    await this.persist();
  }

  async readStateEntries() {
    try {
      const text = await readFile(this.statePath, "utf8");
      const parsed = JSON.parse(text);
      if (parsed !== null && typeof parsed === "object" && Array.isArray(parsed.runners)) return parsed.runners;
      return [];
    } catch (error) {
      if (error !== null && error !== undefined && error.code === "ENOENT") return [];
      this.reportError("无法读取 runner 状态文件，本次不接管历史进程", error);
      return [];
    }
  }

  /** 接管进程的存活刷新：确认已退出的接管进程并落状态。 */
  async refresh() {
    const active = [];
    for (const record of this.records.values()) {
      if (isActive(record)) active.push(record);
    }
    if (active.length === 0) return;
    const now = Date.now();
    if (now - this.lastRefreshAt < ADOPTED_REFRESH_MS) return;
    this.lastRefreshAt = now;

    // 实际监听端口：一次 netstat + 一次进程树查询，供所有活跃记录复用。
    let listeners;
    let tree;
    try {
      listeners = queryTcpListeners();
      tree = queryProcessTree();
    } catch (error) {
      this.reportError("无法刷新进程与端口状态", error);
      return;
    }
    let treeChanged = false;
    for (const record of active) {
      const actual = treeListeningPorts(record.pid, tree, listeners).ports.sort((left, right) => left - right);
      record.actualPorts = actual;
      const treePids = [...collectTreePids(record.pid, tree)].sort((left, right) => left - right);
      if (JSON.stringify(Array.isArray(record.treePids) ? record.treePids : []) !== JSON.stringify(treePids)) {
        record.treePids = treePids;
        treeChanged = true;
      }
    }
    if (treeChanged) await this.persist();

    // 接管进程的存活校验（pid + 命令行标记）。
    const adopted = active.filter((record) => record.adopted === true && record.status === "running");
    if (adopted.length === 0) return;
    let table;
    try {
      table = queryProcessTable(adopted.map((record) => record.pid));
    } catch (error) {
      this.reportError("无法校验接管进程状态", error);
      return;
    }
    for (const record of adopted) {
      const processInfo = table.get(record.pid);
      // 外部接管：命令行里没有 marker，只能用 pid + 创建时间校验身份。
      const alive = record.external === true
        ? isSameProcess(record, processInfo)
        : (processInfo !== undefined
          && (process.platform !== "win32" || processInfo.commandLine.indexOf(record.marker) !== -1));
      if (alive) continue;
      await this.finish(
        record,
        "exited",
        undefined,
        undefined,
        record.external === true ? "外部实例已结束（插件外被关闭）" : "接管进程已结束（Host 重启后检测）"
      );
    }
  }

  /**
   * 启动命令；dependsOn 会先递归启动（每个依赖都等到 running/ready）。
   * options.commands 是完整命令列表（用于解析依赖）。
   */
  async start(command, projectPath, options = {}) {
    if (command === null || command === undefined || typeof command !== "object") {
      throw new RunnerError("bad-request", "start 需要命令对象", {});
    }
    if (typeof projectPath !== "string" || projectPath.trim() === "") {
      throw new RunnerError("bad-request", "项目级运行需要项目路径", {});
    }
    await this.init();
    const commands = Array.isArray(options.commands) ? options.commands : [];
    return this.startWithDependencies(command, projectPath.trim(), commands, new Set());
  }

  async startWithDependencies(command, projectPath, commands, chain) {
    if (chain.has(command.id)) {
      throw new RunnerError(
        "dependency-failed",
        "dependsOn 存在环：" + Array.from(chain).concat([command.id]).join(" -> "),
        { commandId: command.id }
      );
    }
    chain.add(command.id);
    try {
      const dependencies = Array.isArray(command.dependsOn) ? command.dependsOn : [];
      for (const dependencyId of dependencies) {
        const dependency = commands.find((item) => item !== null && typeof item === "object" && item.id === dependencyId);
        try {
          if (dependency === undefined) throw new Error("依赖命令不存在或不在当前配置里");
          await this.ensureDependency(dependency, projectPath, commands, chain);
        } catch (error) {
          throw new RunnerError(
            "dependency-failed",
            "依赖「" + (dependency === undefined ? dependencyId : dependency.title) + "」启动失败：" + messageOf(error),
            { commandId: dependencyId, message: messageOf(error) }
          );
        }
      }
      return await this.startCommand(command, projectPath);
    } finally {
      chain.delete(command.id);
    }
  }

  async ensureDependency(dependency, projectPath, commands, chain) {
    if (dependency.enabled === false) throw new Error("依赖命令已停用");
    const record = this.records.get(this.key(projectPath, dependency.id));
    if (record !== undefined && isActive(record)) {
      if (record.status === "running") return;
      if (record.status === "starting") {
        const timeout = (Number.isInteger(record.readyTimeoutMs) ? record.readyTimeoutMs : DEFAULT_READY_TIMEOUT_MS) + 5000;
        if (await this.waitForRunning(record, timeout)) return;
        throw new Error("依赖命令未在超时内就绪（状态 " + record.status + "）");
      }
      // stopping：等它停完再重新启动。
      await this.waitExit(record, STOP_TIMEOUT_MS + 1000);
      if (isActive(record)) throw new Error("依赖命令仍在停止中");
    }
    const started = await this.startWithDependencies(dependency, projectPath, commands, chain);
    if (started.status !== "running") throw new Error("依赖命令启动后状态为 " + started.status);
  }

  async waitForRunning(record, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!isActive(record)) return false;
      if (record.status === "running") return true;
      await sleep(100);
    }
    return record.status === "running";
  }

  async startCommand(command, projectPath) {
    const key = this.key(projectPath, command.id);
    const previous = this.records.get(key);
    if (previous !== undefined && isActive(previous)) {
      if (previous.status !== "stopping") return this.snapshot(previous);
      await this.waitExit(previous, STOP_TIMEOUT_MS + 1000);
      if (isActive(previous)) throw new RunnerError("internal", "上一个进程仍在停止中，请稍后再试", { commandId: command.id });
    }

    const effectiveCwd = this.effectiveCwd(command, projectPath);
    try {
      accessSync(effectiveCwd);
    } catch (error) {
      throw new RunnerError("spawn-failed", "工作目录不存在：" + effectiveCwd, { cwd: effectiveCwd });
    }

    await this.assertPortsFree(command);

    const dir = path.join(this.logDir, projectHash(projectPath));
    await mkdir(dir, { recursive: true });
    const logPath = path.join(dir, safeFilePart(command.id) + ".log");
    const marker = createMarker(key);
    const shell = resolvePowerShell();
    const env = Object.assign({}, process.env, isPlainObject(command.env) ? command.env : {});
    const ports = Array.isArray(command.ports) ? command.ports.filter((port) => Number.isInteger(port)) : [];
    const readyPort = Number.isInteger(command.readyPort) ? command.readyPort : null;
    const readyTimeoutMs = Number.isInteger(command.readyTimeoutMs) ? command.readyTimeoutMs : DEFAULT_READY_TIMEOUT_MS;
    const logFd = openSync(logPath, "a");
    let child;
    try {
      writeSync(logFd, "\r\n[dsh-runner] " + new Date().toLocaleString() + " 启动：" + command.title + "（" + projectPath + "）\r\n");
      child = spawn(shell, ["-NoLogo", "-NoProfile", "-Command", buildCommandText(command, effectiveCwd, marker)], {
        cwd: effectiveCwd,
        env: env,
        windowsHide: true,
        stdio: ["ignore", logFd, logFd]
      });
    } catch (error) {
      throw new RunnerError("spawn-failed", "启动进程失败：" + messageOf(error), {});
    } finally {
      closeSync(logFd);
    }

    const record = {
      key: key,
      projectPath: projectPath,
      commandId: command.id,
      title: command.title,
      command: command.command,
      cwd: effectiveCwd,
      ports: ports,
      readyPort: readyPort,
      readyTimeoutMs: readyTimeoutMs,
      logPath: logPath,
      marker: marker,
      pid: child.pid,
      startedAt: Date.now(),
      status: "starting",
      ready: ports.length === 0 ? null : false,
      actualPorts: [],
      exitCode: undefined,
      stopRequested: false,
      adopted: false,
      child: child,
      finished: false
    };
    record.exited = new Promise((resolve) => {
      record.resolveExited = resolve;
    });
    this.records.set(key, record);

    child.on("error", (error) => {
      void this.finish(record, "failed", undefined, undefined, "启动失败：" + messageOf(error));
    });
    child.on("exit", (code, signal) => {
      const exitCode = typeof code === "number" ? code : undefined;
      const status = record.stopRequested === true ? "stopped" : (record.status === "starting" ? "failed" : "exited");
      void this.finish(record, status, exitCode, signal === undefined || signal === null ? undefined : signal);
    });

    await this.persist();

    // 端口契约：声明了 ports，就必须由「本次启动的进程树」持有；声明了 readyPort 还要可连接。
    // 未声明任何端口 = 没有契约，直接 running；实际端口由 refresh() 观测。
    if (ports.length === 0) {
      if (record.status === "starting") {
        record.status = "running";
        await this.persist();
      }
      return this.snapshot(record);
    }

    const contract = await this.waitForPortContract(record);
    if (contract.status === "ready") {
      if (record.status === "starting") {
        record.status = "running";
        record.ready = true;
        record.actualPorts = contract.actualPorts;
        await this.persist();
      }
      return this.snapshot(record);
    }
    if (contract.status === "aborted") {
      throw new RunnerError(
        "spawn-failed",
        "命令在端口就绪前退出" + (record.exitCode === undefined ? "" : "（code=" + String(record.exitCode) + "）"),
        { ports: ports, exitCode: record.exitCode }
      );
    }

    const actualText = contract.actualPorts.length === 0
      ? "未监听任何端口"
      : contract.actualPorts.map((port) => String(port)).join("、");
    if (contract.status === "mismatch") {
      const first = contract.conflicts.length > 0 ? contract.conflicts[0] : undefined;
      const ownerText = first !== undefined && first.occupant !== undefined
        ? "；占用者：" + occupantText(first.occupant)
        : "";
      const targetText = contract.conflicts.length === 0
        ? ports.map((port) => String(port)).join("、")
        : contract.conflicts.map((item) => String(item.port)).join("、");
      await this.failSpawned(record, "声明端口 " + targetText + " 未由本进程监听（实际：" + actualText + "），已结束本次启动");
      throw new RunnerError(
        "port-mismatch",
        "本命令未绑定声明端口 " + targetText + "（实际：" + actualText + "）" + ownerText + "，已终止本次启动",
        { ports: contract.conflicts, actualPorts: contract.actualPorts }
      );
    }

    await this.failSpawned(record, "声明端口 " + ports.map((port) => String(port)).join("、") + " 在 " + String(record.readyTimeoutMs) + "ms 内未由本进程监听，已结束本次启动");
    throw new RunnerError(
      "ready-timeout",
      "端口 " + ports.map((port) => String(port)).join("、") + " 在 " + String(record.readyTimeoutMs) + "ms 内未就绪",
      { ports: ports, timeoutMs: record.readyTimeoutMs }
    );
  }

  /**
   * 端口契约校验：等「本进程树」真正持有全部声明端口。
   * - readyPort 存在时，还要求该端口可连接（IPv4/IPv6 任一）；
   * - 进程树开始监听后，若声明端口被外部进程占用、或声明端口迟迟未被本进程监听：
   *   判定 port-mismatch（拒绝静默降级到其它端口）。
   * 返回 { status: "ready"|"mismatch"|"timeout"|"aborted", actualPorts, conflicts? }。
   */
  async waitForPortContract(record) {
    const declared = record.ports.slice();
    const deadline = Date.now() + record.readyTimeoutMs;
    let firstListenAt;
    while (Date.now() < deadline) {
      if (record.finished === true || record.status !== "starting") {
        return { status: "aborted", actualPorts: record.actualPorts };
      }
      let listeners;
      let tree;
      try {
        listeners = queryTcpListeners();
        tree = queryProcessTree();
      } catch (error) {
        // 校验依赖系统进程/端口表；读不到就继续重试，超时后按 ready-timeout 失败，绝不当作成功。
        await sleep(READY_POLL_MS);
        continue;
      }
      const treePorts = treeListeningPorts(record.pid, tree, listeners);
      const actual = treePorts.ports.slice().sort((left, right) => left - right);
      record.actualPorts = actual;
      if (actual.length > 0 && firstListenAt === undefined) firstListenAt = Date.now();
      const ownedAll = declared.every((port) => actual.indexOf(port) !== -1);
      if (ownedAll) {
        const target = record.readyPort === null ? declared[0] : record.readyPort;
        if (await canConnectAny(target)) {
          if (record.finished === true || record.status !== "starting") {
            return { status: "aborted", actualPorts: actual };
          }
          return { status: "ready", actualPorts: actual };
        }
      }
      // 声明端口被「外部进程」占用，而本进程已经开始监听其它端口：立即判定降级。
      const externallyBlocked = [];
      for (const port of declared) {
        if (actual.indexOf(port) !== -1) continue;
        const owners = listeners.byPort.get(port);
        if (owners === undefined) continue;
        let ownedByTree = false;
        for (const ownerPid of owners) {
          if (treePorts.pids.has(ownerPid)) {
            ownedByTree = true;
            break;
          }
        }
        if (!ownedByTree) externallyBlocked.push(port);
      }
      const graceExpired = firstListenAt !== undefined && Date.now() - firstListenAt >= PORT_FALLBACK_GRACE_MS;
      if (actual.length > 0 && (externallyBlocked.length > 0 || (graceExpired && !ownedAll))) {
        const conflicts = await this.describePortConflicts(declared, actual, listeners, record);
        return { status: "mismatch", actualPorts: actual, conflicts: conflicts };
      }
      await sleep(READY_POLL_MS);
    }
    return { status: "timeout", actualPorts: record.actualPorts };
  }

  /** 为未持有的声明端口收集占用者详情（给 port-mismatch 用）。 */
  async describePortConflicts(declared, actual, listeners, record) {
    let snapshot = null;
    try {
      snapshot = queryProcessSnapshot();
    } catch (error) {
      this.reportError("无法读取端口占用者详情", error);
    }
    const conflicts = [];
    for (const port of declared) {
      if (actual.indexOf(port) !== -1) continue;
      const entry = { port: port };
      const owners = listeners.byPort.get(port);
      if (owners !== undefined && snapshot !== null) {
        const ownerPid = [...owners][0];
        const occupant = describeOccupant(ownerPid, snapshot);
        markOccupantRelated(occupant, record.projectPath, record.cwd);
        const managed = this.findManagedRunner(ownerPid, snapshot);
        occupant.managed = managed.managed;
        if (managed.runnerCommandId !== undefined) {
          occupant.runnerCommandId = managed.runnerCommandId;
          const runnerRecord = [...this.records.values()].find((item) => item.commandId === managed.runnerCommandId);
          if (runnerRecord !== undefined) occupant.runnerTitle = runnerRecord.title;
        }
        entry.occupant = occupant;
      }
      conflicts.push(entry);
    }
    return conflicts;
  }

  /** 启动失败时终止本次 spawn 的进程树，并记录原因。 */
  async failSpawned(record, note) {
    if (typeof record.pid === "number" && Number.isFinite(record.pid) && record.pid > 0) {
      this.killProcess(record.pid, false);
      if (!(await this.waitExit(record, STOP_GRACEFUL_WAIT_MS))) this.killProcess(record.pid, true);
      await this.waitExit(record, STOP_TIMEOUT_MS);
    }
    if (record.finished !== true) {
      await this.finish(record, "failed", record.exitCode, undefined, note);
    } else {
      await appendLogLine(record.logPath, "\r\n[dsh-runner] " + note + "\r\n");
    }
  }

  effectiveCwd(command, projectPath) {
    const cwd = typeof command.cwd === "string" ? command.cwd.trim() : "";
    if (cwd !== "") return cwd;
    if (command.scope === "project") {
      const projectRoot = typeof command.projectRoot === "string" ? command.projectRoot.trim() : "";
      if (projectRoot !== "") return projectRoot;
    }
    return projectPath;
  }

  /** 启动前端口预检：任何声明端口被占时抛 port-conflict（附带占用者完整信息）。 */
  async assertPortsFree(command) {
    const ports = Array.isArray(command.ports) ? command.ports.filter((port) => Number.isInteger(port)) : [];
    if (ports.length === 0) return;
    const listeners = queryTcpListeners();
    const occupiedPorts = ports.filter((port) => listeners.byPort.has(port));
    if (occupiedPorts.length === 0) return;
    let snapshot;
    try {
      snapshot = queryProcessSnapshot();
    } catch (error) {
      throw new RunnerError(
        "internal",
        "无法识别占用端口 " + occupiedPorts.join("、") + " 的进程：" + messageOf(error),
        { ports: occupiedPorts }
      );
    }
    const conflicts = occupiedPorts.map((port) => {
      const pid = [...listeners.byPort.get(port)][0];
      const occupant = describeOccupant(pid, snapshot);
      markOccupantRelated(occupant, command.projectRoot, command.cwd);
      const managed = this.findManagedRunner(pid, snapshot);
      occupant.managed = managed.managed;
      if (managed.runnerCommandId !== undefined) {
        occupant.runnerCommandId = managed.runnerCommandId;
        const record = [...this.records.values()].find((item) => item.commandId === managed.runnerCommandId);
        if (record !== undefined) occupant.runnerTitle = record.title;
      }
      return { port: port, occupant: occupant };
    });
    const first = conflicts[0];
    const owner = occupantText(first.occupant);
    throw new RunnerError(
      "port-conflict",
      "端口 " + String(first.port) + " 已被 " + owner + " 占用"
        + (conflicts.length > 1 ? "（共 " + String(conflicts.length) + " 个端口被占用）" : ""),
      { ports: conflicts }
    );
  }

  /** 停止一个项目命令；返回前状态一定已经离开 running/stopping 并已落盘。 */
  async stop(projectPath, commandId) {
    const record = this.records.get(this.key(projectPath, commandId));
    if (!isActive(record)) return false;
    record.stopRequested = true;
    if (record.status !== "stopping") record.status = "stopping";
    if (record.ready !== null) record.ready = false;
    await this.persist();
    await this.terminate(record);
    return true;
  }

  async stopProject(projectPath) {
    const targets = [];
    for (const record of this.records.values()) {
      if (isActive(record) && samePath(record.projectPath, projectPath)) targets.push(record);
    }
    let stopped = 0;
    for (const record of targets) {
      // 用 record 自己的 projectPath 建 key，避免调用方路径写法不同导致停不掉。
      if (await this.stop(record.projectPath, record.commandId)) stopped += 1;
    }
    return stopped;
  }

  /**
   * 重启：先完整停止（含 graceful/force 两段），再重新启动。
   * - options.takeOverExternal：停止后把这条命令的外部实例（声明端口占用者 + 归属该命令的进程）
   *   一起结束，让「重启」对「外部运行中」的实例也成立：
   *   结束外部实例 -> 等端口释放 -> 由插件重新启动 -> 之后才有实时日志。
   * - 端口释放留一段等待：Windows 上监听 socket 关闭比进程退出晚一点，
   *   不等待会让紧跟着的启动误判 port-conflict。
   */
  async restart(command, projectPath, options = {}) {
    await this.init();
    await this.stop(projectPath, command.id);
    const startOptions = Object.assign({}, options);
    delete startOptions.takeOverExternal;
    if (options.takeOverExternal === true) await this.killExternalInstances(command, projectPath);
    const ports = Array.isArray(command.ports) ? command.ports.filter((port) => Number.isInteger(port)) : [];
    if (ports.length > 0) await this.waitPortsFree(ports, PORT_RELEASE_TIMEOUT_MS);
    return this.start(command, projectPath, startOptions);
  }

  /** 等声明端口从监听表里消失；超时也放行，由 start 的 assertPortsFree 给出带占用者的明确错误。 */
  async waitPortsFree(ports, timeoutMs) {
    if (!Array.isArray(ports) || ports.length === 0) return true;
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (Date.now() < deadline) {
      let listeners;
      try {
        listeners = queryTcpListeners();
      } catch (error) {
        this.reportError("无法读取端口监听表", error);
        return false;
      }
      if (!ports.some((port) => listeners.byPort.has(port))) return true;
      await sleep(150);
    }
    return true;
  }

  /** 按依赖拓扑序启动项目内所有 enabled 命令；单个失败不中断后续。 */
  async startAll(commands, projectPath) {
    await this.init();
    if (!Array.isArray(commands)) throw new RunnerError("bad-request", "startAll 需要命令列表", {});
    if (typeof projectPath !== "string" || projectPath.trim() === "") {
      throw new RunnerError("bad-request", "项目级运行需要项目路径", {});
    }
    const workspace = projectPath.trim();
    const selected = commands.filter((command) => {
      return command !== null && typeof command === "object"
        && command.enabled !== false
        && command.scope === "project"
        && commandMatchesProject(command, workspace);
    });
    const order = orderCommandsByDependencies(selected, commands);
    const started = [];
    const failed = [];
    for (const command of order) {
      try {
        await this.start(command, workspace, { commands: commands });
        started.push(command.id);
      } catch (error) {
        failed.push({
          commandId: command.id,
          title: command.title,
          code: error instanceof RunnerError ? error.code : "internal",
          message: messageOf(error),
          // 必须是 JSON 可表示的值：undefined 会让 AI Tool 的 lossless JSON 校验直接失败。
          details: error instanceof RunnerError ? error.details : {}
        });
      }
    }
    return { started: started, failed: failed, runners: this.list(workspace) };
  }

  /** 端口诊断：项目内每条命令的每个 ports 端口一项，附带占用者完整信息与托管归属。 */
  /** 端口诊断：显式 projectPath 时只看该项目；省略时覆盖所有 project 作用域命令（按各自 projectRoot 标注）。 */
  /**
   * 运行实例诊断：
   * - 每个命令最多返回一个「端口条目」，描述声明端口的监听者（托管/外部）；
   * - 再为没有监听端口、但可执行文件位于命令 cwd 下的进程返回「进程条目」（kind="process"），
   *   这样根进程已退出、端口已关闭但进程仍活的实例（如 Tauri 客户端）也能被识别。
   */
  async diagnose(commands, projectPath) {
    await this.init();
    if (!Array.isArray(commands)) throw new RunnerError("bad-request", "diagnose 需要命令列表", {});
    const scopedProjectPath = typeof projectPath === "string" && projectPath.trim() !== "" ? projectPath.trim() : undefined;
    const portTargets = [];
    const processCommands = [];
    for (const command of commands) {
      if (command === null || typeof command !== "object") continue;
      if (command.scope === "project") {
        if (scopedProjectPath !== undefined && !commandMatchesProject(command, scopedProjectPath)) continue;
        processCommands.push(command);
      }
      if (!Array.isArray(command.ports) || command.ports.length === 0) continue;
      let targetPath;
      if (command.scope === "project") {
        if (scopedProjectPath === undefined) {
          const root = typeof command.projectRoot === "string" ? command.projectRoot.trim() : "";
          if (root === "") continue;
          targetPath = root;
        } else {
          targetPath = scopedProjectPath;
        }
      } else {
        if (scopedProjectPath === undefined) continue;
        targetPath = scopedProjectPath;
      }
      portTargets.push({ command: command, projectPath: targetPath });
    }

    const listeners = queryTcpListeners();
    let snapshot;
    try {
      snapshot = queryProcessSnapshot();
    } catch (error) {
      throw new RunnerError("internal", "无法读取进程表：" + messageOf(error), {});
    }
    const managedPids = new Set();
    try {
      const tree = queryProcessTree();
      for (const record of this.records.values()) {
        if (!isActive(record) || typeof record.pid !== "number") continue;
        for (const pid of collectTreePids(record.pid, tree)) managedPids.add(pid);
      }
    } catch (error) {
      this.reportError("无法读取托管进程树，外部实例判定可能不完整", error);
    }

    const entries = [];
    const listeningIdentities = new Set();
    const portIdentities = new Set();
    for (const target of portTargets) {
      const command = target.command;
      const identity = normalizeProjectPath(target.projectPath) + "\u0000" + command.id;
      portIdentities.add(identity);
      for (const port of command.ports) {
        if (!Number.isInteger(port)) continue;
        const owners = listeners.byPort.get(port);
        const listening = owners !== undefined;
        const entry = {
          port: port,
          listening: listening,
          commandId: command.id,
          title: command.title,
          projectPath: target.projectPath
        };
        if (listening) {
          const pid = [...owners][0];
          const occupant = describeOccupant(pid, snapshot);
          markOccupantRelated(occupant, target.projectPath, command.cwd);
          const managed = this.findManagedRunner(pid, snapshot);
          occupant.managed = managed.managed;
          if (managed.runnerCommandId !== undefined) {
            occupant.runnerCommandId = managed.runnerCommandId;
            const record = [...this.records.values()].find((item) => item.commandId === managed.runnerCommandId
              && samePath(item.projectPath, target.projectPath));
            if (record !== undefined) occupant.runnerTitle = record.title;
          }
          entry.occupant = occupant;
          listeningIdentities.add(identity);
        }
        entries.push(entry);
      }
    }

    for (const bucket of attributeProjectProcesses(processCommands, snapshot, managedPids, scopedProjectPath)) {
      const identity = normalizeProjectPath(bucket.projectPath) + "\u0000" + bucket.command.id;
      if (listeningIdentities.has(identity)) continue;
      const hasManagedRunner = [...this.records.values()].some((record) => isActive(record)
        && record.commandId === bucket.command.id && samePath(record.projectPath, bucket.projectPath));
      if (hasManagedRunner) continue;
      const first = bucket.processes[0];
      const occupant = describeOccupant(first.pid, snapshot);
      markOccupantRelated(occupant, bucket.projectPath, bucket.command.cwd);
      occupant.managed = false;
      entries.push({
        commandId: bucket.command.id,
        title: bucket.command.title,
        projectPath: bucket.projectPath,
        listening: false,
        kind: "process",
        processes: bucket.processes,
        occupant: occupant
      });
    }
    return entries;
  }

  /**
   * 结束端口占用进程。
   * - expectedPid：调用方看到并确认过的 pid；若端口已换成另一个进程则抛 port-changed，避免误杀。
   * - 托管 runner 的端口不杀（managed-port），让用户去停止对应命令。
   */
  async killPort(projectPath, port, expectedPid) {
    await this.init();
    if (!Number.isInteger(port) || port < 0 || port > MAX_PORT) {
      throw new RunnerError("bad-request", "port 必须是 0–" + MAX_PORT + " 的整数", { port: port });
    }
    if (expectedPid !== undefined && expectedPid !== null && (!Number.isInteger(expectedPid) || expectedPid <= 0)) {
      throw new RunnerError("bad-request", "pid 必须是正整数", { pid: expectedPid });
    }
    const listeners = queryTcpListeners();
    const owners = listeners.byPort.get(port);
    if (owners === undefined) return { killed: false };
    const pid = [...owners][0];
    let snapshot;
    try {
      snapshot = queryProcessSnapshot();
    } catch (error) {
      throw new RunnerError("internal", "无法读取进程表：" + messageOf(error), { port: port });
    }
    const occupant = describeOccupant(pid, snapshot);
    if (Number.isInteger(expectedPid) && expectedPid !== pid) {
      throw new RunnerError(
        "port-changed",
        "端口 " + String(port) + " 现在被另一个进程占用（PID " + String(pid) + "），请重新确认",
        { port: port, pid: pid, expectedPid: expectedPid, occupant: occupant }
      );
    }
    const managed = this.findManagedRunner(pid, snapshot);
    occupant.managed = managed.managed;
    if (managed.runnerCommandId !== undefined) {
      occupant.runnerCommandId = managed.runnerCommandId;
      const record = [...this.records.values()].find((item) => item.commandId === managed.runnerCommandId);
      if (record !== undefined) occupant.runnerTitle = record.title;
    }
    if (managed.managed) {
      throw new RunnerError(
        "managed-port",
        "端口 " + String(port) + " 由托管命令「" + String(occupant.runnerTitle === undefined ? managed.runnerCommandId : occupant.runnerTitle) + "」占用，不能从端口入口结束；请先停止该命令",
        { port: port, occupant: occupant, runnerCommandId: managed.runnerCommandId }
      );
    }
    this.killProcess(pid, true);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (!queryTcpListeners().byPort.has(port)) return { killed: true, pid: pid, occupant: occupant };
      await sleep(150);
    }
    throw new RunnerError("kill-failed", "无法结束占用端口 " + String(port) + " 的进程 " + String(pid), { port: port, pid: pid, occupant: occupant });
  }

  /**
   * 一条命令当前的外部实例（不是任何托管 runner 的进程树）：
   *   1) 声明端口上的非托管监听者（带 port 的条目）；
   *   2) 可执行文件位于命令 cwd 之下、且没有声明端口的进程（Tauri 客户端这类）。
   * 返回 [{ kind: "port"|"process", port?, pid, occupant }]，按发现顺序去重。
   */
  externalInstances(command, projectPath) {
    if (command === null || command === undefined || typeof command !== "object") return [];
    let listeners;
    let snapshot;
    let tree;
    try {
      listeners = queryTcpListeners();
      snapshot = queryProcessSnapshot();
      tree = queryProcessTree();
    } catch (error) {
      throw new RunnerError("internal", "无法读取端口/进程表：" + messageOf(error), { commandId: command.id });
    }
    const managedPids = new Set();
    for (const record of this.records.values()) {
      if (!isActive(record) || typeof record.pid !== "number") continue;
      for (const pid of collectTreePids(record.pid, tree)) managedPids.add(pid);
    }
    const cwd = this.effectiveCwd(command, projectPath);
    const instances = [];
    const seen = new Set();
    const ports = Array.isArray(command.ports) ? command.ports.filter((port) => Number.isInteger(port)) : [];
    for (const port of ports) {
      const owners = listeners.byPort.get(port);
      if (owners === undefined) continue;
      for (const pid of owners) {
        if (managedPids.has(pid) || seen.has(pid)) continue;
        seen.add(pid);
        const occupant = markOccupantRelated(describeOccupant(pid, snapshot), projectPath, cwd);
        occupant.managed = false;
        instances.push({ kind: "port", port: port, pid: pid, occupant: occupant });
      }
    }
    if (command.scope === "project") {
      for (const bucket of attributeProjectProcesses([command], snapshot, managedPids, projectPath)) {
        for (const item of bucket.processes) {
          if (managedPids.has(item.pid) || seen.has(item.pid)) continue;
          seen.add(item.pid);
          const occupant = markOccupantRelated(describeOccupant(item.pid, snapshot), projectPath, cwd);
          occupant.managed = false;
          instances.push({ kind: "process", pid: item.pid, occupant: occupant });
        }
      }
    }
    return instances;
  }

  /** 结束一条命令的所有外部实例（「重启并接管」用）。返回被结束的 pid 列表。 */
  async killExternalInstances(command, projectPath) {
    let instances;
    try {
      instances = this.externalInstances(command, projectPath);
    } catch (error) {
      // 读不到端口/进程表时不能静默跳过：那样用户以为做了接管，实际还是外部实例在跑。
      throw error instanceof RunnerError ? error : new RunnerError("internal", messageOf(error), { commandId: command.id });
    }
    const killed = [];
    for (const instance of instances) {
      this.killProcess(instance.pid, true);
      killed.push(instance.pid);
    }
    if (killed.length > 0) {
      const deadline = Date.now() + PORT_RELEASE_TIMEOUT_MS;
      while (Date.now() < deadline) {
        let alive = false;
        try {
          const table = queryProcessTable(killed);
          alive = killed.some((pid) => table.has(pid));
        } catch (error) {
          this.reportError("无法校验外部实例是否退出", error);
          break;
        }
        if (!alive) break;
        await sleep(150);
      }
    }
    return killed;
  }

  /**
   * 接管外部实例：把「不是本插件启动、但确实是这条命令的实例」纳入托管。
   * - 只改归属，不结束进程：停止/重启仍由用户显式触发；
   * - pid + 创建时间落盘，Host 重启后仍能校验身份（避免 pid 复用误杀）；
   * - 外部进程的 stdout 无法回放（没有 fd 句柄），日志里追加一条说明，
   *   文件里保留此前托管运行的输出，下一次从这里「重启」后就是实时日志。
   */
  async adopt(command, projectPath, options = {}) {
    await this.init();
    if (command === null || command === undefined || typeof command !== "object") {
      throw new RunnerError("bad-request", "adopt 需要命令对象", {});
    }
    const workspace = typeof projectPath === "string" ? projectPath.trim() : "";
    if (workspace === "") throw new RunnerError("bad-request", "接管需要项目路径", {});
    const key = this.key(workspace, command.id);
    const existing = this.records.get(key);
    if (isActive(existing)) {
      return { runner: this.snapshot(existing), adopted: false, reason: "already-managed" };
    }
    const instances = this.externalInstances(command, workspace);
    if (instances.length === 0) {
      throw new RunnerError(
        "no-external-instance",
        "「" + command.title + "」没有可接管的外部实例：声明端口没被外部进程占用，也没有归属该命令的进程",
        { commandId: command.id, projectPath: workspace }
      );
    }
    const expectedPid = Number.isInteger(options.pid) ? options.pid : undefined;
    const primary = expectedPid === undefined ? instances[0] : instances.find((item) => item.pid === expectedPid);
    if (primary === undefined) {
      throw new RunnerError(
        "instance-changed",
        "要接管的外部实例（PID " + String(expectedPid) + "）已经不在了，请刷新后用新的 PID 重试",
        { commandId: command.id, pid: expectedPid, instances: instances.map((item) => ({ pid: item.pid, kind: item.kind, port: item.port })) }
      );
    }
    // 接管目标本来就已按「声明端口 / 命令 cwd」归属到这条命令，所以不再用 related 硬拦
    // （uvicorn、cargo tauri 这类命令行里不带项目路径的实例否则永远接管不了）。
    // 命令行里没有项目路径时带一条警告回去，日志里也留痕，用户能看出接管的是哪个进程。
    const related = instances.some((item) => item.occupant !== undefined && item.occupant.related === true);
    const warning = related
      ? ""
      : "该实例的命令行里没有项目路径，按「声明端口/命令目录」归属接管：" + occupantText(primary.occupant);
    const ports = Array.isArray(command.ports) ? command.ports.filter((port) => Number.isInteger(port)) : [];
    const readyPort = Number.isInteger(command.readyPort) ? command.readyPort : null;
    const cwd = this.effectiveCwd(command, workspace);
    let tree;
    try {
      tree = queryProcessTree();
    } catch (error) {
      this.reportError("无法读取进程树，接管后端口信息可能不完整", error);
      tree = new Map();
    }
    let listeners;
    try {
      listeners = queryTcpListeners();
    } catch (error) {
      this.reportError("无法读取端口监听表，接管时就绪状态未知", error);
      listeners = { byPort: new Map(), byPid: new Map() };
    }
    const createdAt = primary.occupant !== undefined && typeof primary.occupant.startedAt === "string" ? primary.occupant.startedAt : "";
    const createdMs = createdAt === "" ? Number.NaN : Date.parse(createdAt);
    const actualPorts = ports.length === 0
      ? []
      : [...treeListeningPorts(primary.pid, tree, listeners).ports].sort((left, right) => left - right);
    const record = {
      key: key,
      projectPath: workspace,
      commandId: command.id,
      title: typeof command.title === "string" && command.title !== "" ? command.title : String(command.id),
      command: typeof command.command === "string" ? command.command : "",
      cwd: cwd,
      ports: ports,
      readyPort: readyPort,
      readyTimeoutMs: Number.isInteger(command.readyTimeoutMs) ? command.readyTimeoutMs : DEFAULT_READY_TIMEOUT_MS,
      logPath: this.logPathFor(workspace, command.id),
      marker: "",
      pid: primary.pid,
      pidCreatedAt: createdAt,
      startedAt: Number.isFinite(createdMs) ? createdMs : Date.now(),
      adoptedAt: Date.now(),
      adopted: true,
      external: true,
      status: "running",
      ready: readyPort === null ? null : await canConnectAny(readyPort),
      actualPorts: actualPorts,
      exitCode: undefined,
      stopRequested: false,
      child: null,
      treePids: [...collectTreePids(primary.pid, tree)].sort((left, right) => left - right),
      finished: false
    };
    record.exited = new Promise((resolve) => {
      record.resolveExited = resolve;
    });
    this.records.set(key, record);
    const where = primary.kind === "port" ? "占用端口 " + String(primary.port) : "归属本命令 cwd";
    await appendLogLine(
      record.logPath,
      "\r\n[dsh-runner] " + new Date().toLocaleString() + " 接管外部实例：" + occupantText(primary.occupant) + "（" + where + "）\r\n"
        + (warning === "" ? "" : "[dsh-runner] 注意：" + warning + "\r\n")
        + "[dsh-runner] 该实例不是本插件启动，它的输出无法回放；下面保留此前的托管日志。\r\n"
        + "[dsh-runner] 需要实时日志时点「重启」：结束这个外部实例并由插件重新启动。\r\n"
    );
    await this.persist();
    return { runner: this.snapshot(record), adopted: true, reason: "adopted", instances: instances.length, warning: warning };
  }

  /**
   * 解除接管：只把记录移出托管，不结束进程。
   * 之后这条命令会重新显示为「外部运行中」，插件不再为它负责。
   */
  async release(projectPath, commandId) {
    await this.init();
    const record = this.records.get(this.key(projectPath, commandId));
    if (record === undefined) return false;
    if (record.external !== true) {
      throw new RunnerError(
        "not-external",
        "「" + record.title + "」是本插件启动的实例，不能解除接管；要结束它请用「停止」",
        { commandId: commandId, pid: record.pid }
      );
    }
    this.records.delete(this.key(projectPath, commandId));
    await this.persist();
    return true;
  }

  /** 外部接管实例是否还活着（pid 存在 + 创建时间一致）。读不到进程表时保守认为还活着。 */
  externalAlive(record) {
    const pid = record.pid;
    if (!Number.isInteger(pid) || pid <= 0) return false;
    let table;
    try {
      table = queryProcessTable([pid]);
    } catch (error) {
      this.reportError("无法校验外部实例状态", error);
      return true;
    }
    return isSameProcess(record, table.get(pid));
  }

  /** 等外部实例真正退出（没有 child 句柄，只能按 pid + 创建时间轮询）。 */
  async waitExternalExit(record, timeoutMs) {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (Date.now() < deadline) {
      if (!isActive(record)) return true;
      if (!this.externalAlive(record)) return true;
      await sleep(100);
    }
    return !this.externalAlive(record);
  }

  /** 监听进程 pid 是否等于某个运行中 runner 的 pid，或属于其进程树（向上找祖先）。 */
  findManagedRunner(pid, snapshot) {
    const activeByPid = new Map();
    for (const record of this.records.values()) {
      if (isActive(record) && typeof record.pid === "number") activeByPid.set(record.pid, record);
    }
    let current = pid;
    const visited = new Set();
    while (current !== undefined && !visited.has(current)) {
      visited.add(current);
      const record = activeByPid.get(current);
      if (record !== undefined) return { managed: true, runnerCommandId: record.commandId };
      const info = snapshot.get(current);
      if (info === undefined) break;
      current = info.parentPid;
      if (current === 0) break;
    }
    return { managed: false };
  }

  logPathFor(projectPath, commandId) {
    return path.join(this.logDir, projectHash(projectPath), safeFilePart(commandId) + ".log");
  }

  /** 读取日志末尾 maxBytes（UTF-8）；文件不存在返回空文本。 */
  async readLog(commandId, projectPath, maxBytes) {
    if (typeof commandId !== "string" || commandId.trim() === "") {
      throw new RunnerError("bad-request", "log 需要 commandId", {});
    }
    let limit = LOG_DEFAULT_MAX_BYTES;
    if (maxBytes !== undefined && maxBytes !== null) {
      if (!Number.isInteger(maxBytes) || maxBytes < LOG_MIN_MAX_BYTES || maxBytes > LOG_MAX_MAX_BYTES) {
        throw new RunnerError("bad-request", "maxBytes 必须是 " + LOG_MIN_MAX_BYTES + "–" + LOG_MAX_MAX_BYTES + " 的整数", { maxBytes: maxBytes });
      }
      limit = maxBytes;
    }
    const logPath = this.logPathFor(projectPath, commandId);
    let stats;
    try {
      stats = await stat(logPath);
    } catch (error) {
      if (error !== null && error !== undefined && error.code === "ENOENT") {
        return { text: "", bytes: 0, path: logPath, truncated: false };
      }
      throw new Error("读取日志失败：" + logPath + "：" + messageOf(error));
    }
    const totalBytes = stats.size;
    if (totalBytes === 0) return { text: "", bytes: 0, path: logPath, truncated: false };
    const start = Math.max(0, totalBytes - limit);
    const length = totalBytes - start;
    const handle = await openFile(logPath, "r");
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      let offset = 0;
      // 从文件中间截断时跳过被切断的 UTF-8 延续字节，避免开头出现替换字符。
      while (offset < buffer.length && (buffer[offset] & 0xc0) === 0x80) offset += 1;
      return { text: buffer.subarray(offset).toString("utf8"), bytes: totalBytes, path: logPath, truncated: totalBytes > limit };
    } finally {
      await handle.close();
    }
  }

  /** 清空日志（运行中也允许；追加 fd 是 FILE_APPEND_DATA，会从新 EOF 继续写）。 */
  async clearLog(commandId, projectPath) {
    if (typeof commandId !== "string" || commandId.trim() === "") {
      throw new RunnerError("bad-request", "log/clear 需要 commandId", {});
    }
    const logPath = this.logPathFor(projectPath, commandId);
    await mkdir(path.dirname(logPath), { recursive: true });
    await writeFile(logPath, "", "utf8");
    return { cleared: true, path: logPath };
  }

  async terminate(record) {
    const startedAt = Date.now();
    const pid = record.pid;
    if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) {
      await this.finishIfActive(record, "没有可终止的 pid，状态按已停止记录");
      return;
    }
    // 外部接管：没有 child 句柄可等，退出判定走 pid + 创建时间。
    if (record.external === true) {
      this.killProcess(pid, false);
      if (await this.waitExternalExit(record, STOP_GRACEFUL_WAIT_MS)) {
        await this.finishIfActive(record, "已结束外部实例（PID " + String(pid) + "）");
        return;
      }
      this.killProcess(pid, true);
      const externalRemaining = Math.max(0, STOP_TIMEOUT_MS - (Date.now() - startedAt));
      if (await this.waitExternalExit(record, externalRemaining)) {
        await this.finishIfActive(record, "已强制结束外部实例（PID " + String(pid) + "）");
        return;
      }
      await this.finishIfActive(record, "外部实例未在超时内确认退出，状态按已停止记录");
      return;
    }
    // 第一段：温和终止（不带 /F），给进程自己清理的机会。
    this.killProcess(pid, false);
    if (await this.waitExit(record, STOP_GRACEFUL_WAIT_MS)) {
      await this.finishIfActive(record);
      return;
    }
    // 第二段：2s 后仍活着，强制终止整棵进程树。
    this.killProcess(pid, true);
    const remaining = Math.max(0, STOP_TIMEOUT_MS - (Date.now() - startedAt));
    if (await this.waitExit(record, remaining)) {
      await this.finishIfActive(record);
      return;
    }
    await this.finishIfActive(record, "进程未在超时内确认退出，状态按已停止记录");
  }

  async finishIfActive(record, note) {
    if (!isActive(record)) return;
    await this.finish(record, "stopped", record.exitCode, undefined, note);
  }

  async waitExit(record, timeoutMs) {
    if (!isActive(record)) return true;
    if (record.exited !== undefined && record.exited !== null && typeof record.exited.then === "function") {
      await Promise.race([record.exited, sleep(timeoutMs)]);
      return !isActive(record);
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!isActive(record)) return true;
      await sleep(100);
    }
    return !isActive(record);
  }

  async finish(record, status, exitCode, signal, note) {
    if (record === undefined || record === null || record.finished === true) return;
    record.finished = true;
    record.status = status;
    record.exitCode = typeof exitCode === "number" ? exitCode : undefined;
    record.child = null;
    if (record.readyPort !== null) record.ready = false;
    const noteText = typeof note === "string" && note !== "" ? "\r\n[dsh-runner] " + note + "\r\n" : "";
    const signalText = signal === undefined || signal === null ? "" : ", signal=" + signal;
    const codeText = record.exitCode === undefined ? "unknown" : String(record.exitCode);
    await appendLogLine(record.logPath, noteText + "\r\n[dsh-runner] 进程结束（code=" + codeText + signalText + "）\r\n");
    if (typeof record.resolveExited === "function") {
      try {
        record.resolveExited();
      } catch (error) {
        this.reportError("释放退出等待失败", error);
      }
    }
    await this.persist();
    // 状态/落盘先定稿，再做残留清理（清理要查进程树，不能拖慢 stop/finish 的可见状态）。
    if (record.stopRequested !== true && (status === "failed" || status === "exited")) {
      try {
        this.killRemainingDescendants(record);
      } catch (error) {
        this.reportError("清理残留子进程失败", error);
      }
    }
  }

  /** 自然退出后清理本次启动的残留子进程（只杀本次启动后创建的，避免 pid 复用误杀）。 */
  killRemainingDescendants(record) {
    if (process.platform !== "win32") return;
    const rootPid = record.pid;
    if (!Number.isInteger(rootPid) || rootPid <= 0) return;
    let tree;
    let snapshot;
    try {
      tree = queryProcessTree();
      snapshot = queryProcessSnapshot();
    } catch (error) {
      this.reportError("无法读取进程树，跳过残留子进程清理", error);
      return;
    }
    const pids = collectTreePids(rootPid, tree);
    pids.delete(rootPid);
    for (const pid of pids) {
      const info = snapshot.get(pid);
      if (info === undefined) continue;
      const created = typeof info.createdAt === "string" ? Date.parse(info.createdAt) : Number.NaN;
      if (Number.isFinite(created) && created + 2000 < record.startedAt) continue;
      this.killProcess(pid, true);
    }
  }

  killProcess(pid, force) {
    if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) return;
    if (process.platform !== "win32") {
      try {
        process.kill(pid, force === true ? "SIGKILL" : "SIGTERM");
      } catch (error) {
        // 进程可能已退出：最终状态由 waitExit/finish 判定。
      }
      return;
    }
    const args = ["/PID", String(pid), "/T"];
    if (force === true) args.push("/F");
    try {
      spawnSync("taskkill.exe", args, { windowsHide: true, timeout: 8000 });
    } catch (error) {
      // taskkill 自身不可用时由 waitExit 的轮询结果决定最终状态。
    }
  }

  snapshot(record) {
    return {
      commandId: record.commandId,
      projectPath: record.projectPath,
      title: record.title,
      command: record.command,
      cwd: record.cwd,
      ports: Array.isArray(record.ports) ? record.ports.slice() : [],
      readyPort: record.readyPort === undefined ? null : record.readyPort,
      status: record.status,
      ready: record.ready === undefined ? null : record.ready,
      actualPorts: Array.isArray(record.actualPorts) ? record.actualPorts.slice() : [],
      treePids: Array.isArray(record.treePids) ? record.treePids.slice() : [],
      exitCode: record.exitCode === undefined ? null : record.exitCode,
      pid: record.pid === undefined ? null : record.pid,
      startedAt: Number.isFinite(record.startedAt) ? record.startedAt : Date.now(),
      logPath: record.logPath,
      logBytes: Number.isFinite(this.logBytes(record.logPath)) ? this.logBytes(record.logPath) : 0,
      adopted: record.adopted === true,
      external: record.external === true,
      pidCreatedAt: typeof record.pidCreatedAt === "string" ? record.pidCreatedAt : "",
      adoptedAt: Number.isFinite(record.adoptedAt) ? record.adoptedAt : null
    };
  }

  /** 日志字节数；读不到（文件被删/占用）按 0 处理——纯展示字段，显式忽略。 */
  logBytes(logPath) {
    try {
      return statSync(logPath).size;
    } catch (error) {
      return 0;
    }
  }

  list(projectPath) {
    const all = [...this.records.values()];
    const filtered = typeof projectPath === "string" && projectPath.trim() !== ""
      ? all.filter((record) => samePath(record.projectPath, projectPath))
      : all;
    return filtered.sort((left, right) => left.startedAt - right.startedAt).map((record) => this.snapshot(record));
  }

  /** 插件卸载/进程退出前落盘；不杀任何子进程（项目级后台任务继续运行，下次启动接管）。 */
  async shutdown() {
    await this.persist();
  }

  persist() {
    this.persistQueue = this.persistQueue
      .then(() => this.writeState())
      .catch((error) => {
        this.reportError("runner 状态持久化失败", error);
      });
    return this.persistQueue;
  }

  async writeState() {
    const runners = [];
    for (const record of this.records.values()) {
      if (!isActive(record)) continue;
      runners.push({
        key: record.key,
        projectPath: record.projectPath,
        commandId: record.commandId,
        title: record.title,
        command: record.command,
        cwd: record.cwd,
        ports: record.ports,
        readyPort: record.readyPort,
        readyTimeoutMs: record.readyTimeoutMs,
        logPath: record.logPath,
        marker: record.marker,
        pid: record.pid === undefined ? null : record.pid,
        pidCreatedAt: typeof record.pidCreatedAt === "string" ? record.pidCreatedAt : "",
        startedAt: record.startedAt,
        adopted: record.adopted === true,
        adoptedAt: Number.isFinite(record.adoptedAt) ? record.adoptedAt : null,
        external: record.external === true,
        treePids: Array.isArray(record.treePids) ? record.treePids.slice() : []
      });
    }
    const payload = JSON.stringify({
      version: STATE_VERSION,
      updatedAt: new Date().toISOString(),
      runners: runners
    }, null, 2);
    await mkdir(path.dirname(this.statePath), { recursive: true });
    const tempPath = this.statePath + "." + String(process.pid) + ".tmp";
    await writeFile(tempPath, payload, "utf8");
    await rename(tempPath, this.statePath);
  }

  reportError(message, error) {
    if (this.logger !== undefined && this.logger !== null && typeof this.logger.error === "function") {
      try {
        this.logger.error("dsh-runner: " + message, error);
        return;
      } catch (loggingError) {
        // logger 自身失败时退回 console，保证错误至少被记录一次。
      }
    }
    // eslint-disable-next-line no-console
    console.error("dsh-runner: " + message, error);
  }
}
