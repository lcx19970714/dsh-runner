// Host 项目级运行器的离线验证（真实启动 powershell / node 子进程）。
//
// 0.25.0 的契约变化（本套测试就是围绕它写的）：
//   - start / restart / startAll 是**命令即返回**：只建 queued 记录并返回，不等就绪；
//   - 就绪/失败由后台 flow 推进，结果落在 record.status / record.error 上（不靠 RPC 抛异常）；
//   - 所有进程/端口探测都是异步采样（SystemProbe），Host 事件循环不被阻塞。
//
// 覆盖：
//   1) snapshot 契约字段；短命令 queued -> exited + 日志；
//   2) stop 立即落状态、重复 stop、restart 换进程；
//   3) 端口冲突 -> record.error(port-conflict) -> diagnose -> killPort -> 再启动成功；
//   4) readyPort 就绪 / 超时 / 端口降级（port-mismatch）；
//   5) dependsOn 依赖先就绪、依赖失败传导、startAll 全部入队；
//   6) env 注入与 cwd；
//   7) Host 重启接管（shutdown 不杀 -> 新实例 init 接管 -> stop）；
//   8) log 读取/清空/截断；缺失 cwd 报 spawn-failed；
//   9) 外部实例：接管 / 解除接管 / 重启并接管；
//  10) 并发：一条在启动时另一条立即返回；排队中可取消；事件循环延迟 p99 有上限。
//
// 所有测试端口都用动态空闲端口（先 listen(0) 再关闭），不碰用户正在占用的端口。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { ProjectRunnerService, RunnerError, attributeProjectProcesses } from "../host-runner.js";

const SNAPSHOT_KEYS = [
  "commandId",
  "projectPath",
  "title",
  "command",
  "cwd",
  "ports",
  "readyPort",
  "status",
  "ready",
  "actualPorts",
  "treePids",
  "exitCode",
  "pid",
  "startedAt",
  "logPath",
  "logBytes",
  "adopted",
  "external",
  "pidCreatedAt",
  "adoptedAt",
  "error"
];

/** 启动必须「命令即返回」：这条上限就是交互丝滑的量化标准。 */
const START_RETURN_LIMIT_MS = 300;
/** 就绪等待期间事件循环延迟上限（阻塞式探测会到 300–400ms）。 */
const EVENT_LOOP_P99_LIMIT_MS = 80;

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(120);
  }
  throw new Error("等待超时：" + label);
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pidAlive(pid) {
  if (typeof pid !== "number" || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return false;
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function getFreePorts(count) {
  const ports = [];
  while (ports.length < count) {
    const port = await freePort();
    if (ports.indexOf(port) === -1) ports.push(port);
  }
  return ports;
}

function canConnect(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port, timeout: timeoutMs });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

// ── 纯函数：进程归属（不启动任何进程） ──────────────────────────────────
const attributionCommands = [
  { id: "c1", title: "客户端", scope: "project", projectRoot: "H:\\P1", cwd: "H:\\P1\\客户端", ports: [] },
  { id: "c2", title: "别的项目", scope: "project", projectRoot: "H:\\P2", cwd: "H:\\P2", ports: [] },
  { id: "g", title: "全局", scope: "global", ports: [] }
];
const attributionSnapshot = new Map([
  [100, { name: "bd-client.exe", executablePath: "H:\\P1\\客户端\\target\\debug\\bd-client.exe", commandLine: "bd-client.exe", createdAt: "", parentPid: 1 }],
  [101, { name: "node.exe", executablePath: "C:\\node\\node.exe", commandLine: "node H:\\P2\\x.js", createdAt: "", parentPid: 1 }],
  [102, { name: "managed.exe", executablePath: "H:\\P1\\客户端\\target\\debug\\managed.exe", commandLine: "", createdAt: "", parentPid: 1 }]
]);
const attributionBuckets = attributeProjectProcesses(attributionCommands, attributionSnapshot, new Set([102]), undefined);
assert.equal(attributionBuckets.length, 1, "只应归属到 cwd 下的命令，且排除托管进程");
assert.equal(attributionBuckets[0].command.id, "c1");
assert.deepEqual(attributionBuckets[0].processes.map((item) => item.pid), [100]);

const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-runner-smoke-"));
const projectRoot = path.join(dir, "project");
const depProjectRoot = path.join(dir, "project-deps");
const subDir = path.join(projectRoot, "sub");
const logDir = path.join(dir, "logs");
const statePath = path.join(dir, "runner-state.json");

await mkdir(projectRoot, { recursive: true });
await mkdir(depProjectRoot, { recursive: true });
await mkdir(subDir, { recursive: true });

// 监听端口的测试脚本：端口来自环境变量，命令用 node 启动它（形成 powershell -> node 的进程树）。
const listenScript = path.join(dir, "listen.cjs");
await writeFile(listenScript, [
  'const net = require("node:net");',
  "const port = Number(process.env.SMOKE_PORT);",
  "const server = net.createServer((socket) => socket.end());",
  'server.listen(port, "127.0.0.1");',
  "server.on(\"error\", (error) => { console.error(\"listen-failed\", error.code, port); process.exit(1); });",
  "setInterval(() => {}, 1000);"
].join("\n"), "utf8");

// 声明 1 个端口但实际监听另一个端口：用于 port-mismatch。
const fallbackScript = path.join(dir, "fallback.cjs");
await writeFile(fallbackScript, [
  'const net = require("node:net");',
  "const actual = Number(process.env.SMOKE_ACTUAL_PORT);",
  "const server = net.createServer((socket) => socket.end());",
  'server.listen(actual, "127.0.0.1");',
  "setInterval(() => {}, 1000);"
].join("\n"), "utf8");

function makeCommand(overrides = {}) {
  const command = {
    id: "smoke-cmd",
    title: "冒烟命令",
    command: "Write-Output hi",
    cwd: "",
    scope: "project",
    projectRoot: projectRoot,
    enabled: true,
    env: {},
    ports: [],
    readyPort: null,
    readyTimeoutMs: 60000,
    dependsOn: []
  };
  return Object.assign(command, overrides);
}

function createRunner() {
  return new ProjectRunnerService({
    logDir,
    statePath,
    logger: {
      error(message, error) {
        // 测试里把 Host 记录的异常打印出来，方便定位失败原因。
        console.error("[runner-logger] " + message + (error === undefined ? "" : " :: " + String(error)));
      }
    }
  });
}

/** 等一条命令落定（running / failed / stopped / exited），返回最终 snapshot。 */
async function settle(runner, commandId, timeoutMs, projectPath = projectRoot) {
  const snapshot = await runner.settle(projectPath, commandId, timeoutMs);
  assert.notEqual(snapshot, null, "命令「" + commandId + "」应有运行记录");
  return snapshot;
}

async function expectSettledStatus(runner, commandId, status, timeoutMs = 40000, projectPath = projectRoot) {
  const snapshot = await settle(runner, commandId, timeoutMs, projectPath);
  if (snapshot.status !== status) {
    const logTail = await readFile(snapshot.logPath, "utf8").then((text) => text.slice(-1200)).catch(() => "");
    assert.equal(
      snapshot.status,
      status,
      "命令「" + commandId + "」应变 " + status + "，实际 " + snapshot.status + "，exit=" + String(snapshot.exitCode)
        + (snapshot.error === null ? "" : "（" + snapshot.error.code + "：" + snapshot.error.message + "）")
        + "\n--- log tail ---\n" + logTail
    );
  }
  return snapshot;
}

let runner;
let occupant;
// 外部实例（不是插件启动的进程）：全部登记，finally 里兜底清理。
const externals = [];
try {
  runner = createRunner();
  await runner.init();

  // ── 1) 短命令：命令即返回 + 日志 + 退出状态 + snapshot 契约 ──────────────
  const shortCommand = makeCommand({
    id: "short",
    title: "短命令",
    command: "Write-Output 'hello-runner'; Write-Output ((Get-Location).Path)"
  });
  const startBegan = performance.now();
  const shortStarted = await runner.start(shortCommand, projectRoot);
  const startElapsed = performance.now() - startBegan;
  assert.ok(startElapsed < START_RETURN_LIMIT_MS, "start 必须命令即返回（实测 " + Math.round(startElapsed) + "ms）");
  assert.equal(shortStarted.status, "queued", "start 返回时状态应是 queued");
  assert.equal(shortStarted.ready, null, "没有 readyPort 时 ready 必须是 null");
  assert.equal(shortStarted.readyPort, null);
  assert.equal(shortStarted.adopted, false);
  assert.equal(shortStarted.error, null);
  assert.deepEqual(Object.keys(shortStarted).sort(), SNAPSHOT_KEYS.slice().sort(), "snapshot 字段必须与契约一致");

  const shortFinished = await waitFor(() => {
    const record = runner.list(projectRoot).find((entry) => entry.commandId === "short");
    return record !== undefined && record.status !== "queued" && record.status !== "starting" && record.status !== "running"
      ? record
      : undefined;
  }, 20000, "短命令退出");
  assert.equal(shortFinished.status, "exited");
  assert.equal(shortFinished.exitCode, 0);
  assert.ok(shortFinished.logBytes > 0, "日志应有内容");
  const shortLog = await readFile(shortFinished.logPath, "utf8");
  assert.match(shortLog, /hello-runner/);
  assert.match(shortLog, /\[dsh-runner\].*启动：短命令/);
  assert.match(shortLog, /进程结束（code=0/);
  assert.match(shortLog, new RegExp(escapeRegExp(projectRoot), "i"), "cwd 为空时应使用 projectRoot");
  assert.equal(runner.list("H:\\OtherProject").length, 0, "按项目过滤");

  // ── 2) stop 立即落状态；重复 stop；stopProject 路径归一化；restart 换进程 ──
  const longCommand = makeCommand({ id: "long", title: "长命令", command: "Start-Sleep -Seconds 30" });
  const longStarted = await runner.start(longCommand, projectRoot);
  assert.equal(longStarted.status, "queued");
  const longRunning = await expectSettledStatus(runner, "long", "running");
  const longAgain = await runner.start(longCommand, projectRoot);
  assert.equal(longAgain.pid, longRunning.pid, "已运行时再次 start 应直接返回现有 runner");
  assert.equal(await runner.stop(projectRoot, "long"), true);
  const longStopped = runner.list(projectRoot).find((entry) => entry.commandId === "long");
  assert.notEqual(longStopped.status, "running", "stop() 返回后状态必须立即不是 running");
  assert.equal(await runner.stop(projectRoot, "long"), false, "重复停止应返回 false");
  await waitFor(() => pidAlive(longRunning.pid) === false, 8000, "stop 后进程退出");

  const restartCommand = makeCommand({ id: "restart", title: "重启命令", command: "Start-Sleep -Seconds 30" });
  await runner.start(restartCommand, projectRoot);
  const restartFirst = await expectSettledStatus(runner, "restart", "running");
  await runner.restart(restartCommand, projectRoot);
  const restartSecond = await expectSettledStatus(runner, "restart", "running");
  assert.notEqual(restartSecond.pid, restartFirst.pid, "restart 必须换新进程");
  await runner.stop(projectRoot, "restart");

  // ── 3) 端口冲突：port-conflict 落到 record.error -> killPort -> 再启动成功 ─
  const [occupantPort] = await getFreePorts(1);
  occupant = spawn(process.execPath, [listenScript], {
    env: Object.assign({}, process.env, { SMOKE_PORT: String(occupantPort) }),
    windowsHide: true,
    stdio: "ignore"
  });
  await waitFor(() => canConnect(occupantPort), 15000, "外部占用进程开始监听");

  const conflictCommand = makeCommand({
    id: "conflict",
    title: "冲突命令",
    command: 'node "' + listenScript + '"',
    env: { SMOKE_PORT: String(occupantPort) },
    ports: [occupantPort],
    readyPort: occupantPort,
    readyTimeoutMs: 20000
  });
  const conflictCommands = [conflictCommand];
  const conflictQueued = await runner.start(conflictCommand, projectRoot, { commands: conflictCommands });
  assert.equal(conflictQueued.status, "queued");
  const conflictFailed = await expectSettledStatus(runner, "conflict", "failed", 30000);
  assert.equal(conflictFailed.error.code, "port-conflict", "端口被占应落成 port-conflict 错误");
  const conflictInfo = conflictFailed.error.details.ports[0];
  assert.equal(conflictInfo.port, occupantPort);
  assert.equal(conflictInfo.occupant.pid, occupant.pid, "occupant 应带占用者 pid");
  assert.equal(conflictInfo.occupant.managed, false, "外部进程不应标记为托管");
  assert.ok(typeof conflictInfo.occupant.name === "string" && conflictInfo.occupant.name !== "", "occupant 应带进程名");
  assert.ok(typeof conflictInfo.occupant.commandLine === "string" && conflictInfo.occupant.commandLine.includes("listen.cjs"));
  assert.ok(Array.isArray(conflictInfo.occupant.ancestors) && conflictInfo.occupant.ancestors.length > 0, "occupant 应带父进程链");
  assert.ok(Array.isArray(conflictInfo.occupant.children), "occupant 应带子进程列表");

  const diagnoseEntries = await runner.diagnose(conflictCommands, projectRoot);
  // diagnose 结果必须是 lossless JSON（AI Tool 的输出校验就是这么判的）。
  assert.deepEqual(JSON.parse(JSON.stringify(diagnoseEntries)), diagnoseEntries, "diagnose 结果必须是 lossless JSON");
  const occupiedEntry = diagnoseEntries.find((entry) => entry.port === occupantPort);
  assert.ok(occupiedEntry !== undefined, "diagnose 应包含该端口");
  assert.equal(occupiedEntry.listening, true);
  assert.equal(occupiedEntry.occupant.pid, occupant.pid);
  assert.equal(occupiedEntry.occupant.managed, false);
  assert.equal(occupiedEntry.commandId, "conflict");
  assert.equal(occupiedEntry.title, "冲突命令");

  // 确认后端口换了主人：expected pid 不一致时必须拒绝，避免误杀
  await assert.rejects(
    () => runner.killPort(projectRoot, occupantPort, occupant.pid + 1),
    (error) => {
      assert.equal(error.code, "port-changed");
      assert.equal(error.details.pid, occupant.pid);
      assert.equal(error.details.expectedPid, occupant.pid + 1);
      return true;
    }
  );

  const killedResult = await runner.killPort(projectRoot, occupantPort, occupant.pid);
  assert.equal(killedResult.killed, true);
  assert.equal(killedResult.pid, occupant.pid);
  assert.equal(killedResult.occupant.pid, occupant.pid);
  await waitFor(async () => !(await canConnect(occupantPort)), 8000, "killPort 后端口释放");
  const afterKillDiagnose = await runner.diagnose(conflictCommands, projectRoot);
  const releasedEntry = afterKillDiagnose.find((entry) => entry.port === occupantPort);
  assert.ok(releasedEntry !== undefined);
  assert.equal(releasedEntry.listening, false, "killPort 后 diagnose 应显示端口未监听");

  await runner.start(conflictCommand, projectRoot, { commands: conflictCommands });
  const conflictRunning = await expectSettledStatus(runner, "conflict", "running", 30000);
  assert.equal(conflictRunning.error, null, "启动成功后必须清掉上一次的错误");
  await runner.stop(projectRoot, "conflict");

  // ── 4) readyPort：running/ready；超时；端口降级 ─────────────────────────
  const [readyPort] = await getFreePorts(1);
  const readyCommand = makeCommand({
    id: "ready",
    title: "就绪服务",
    command: 'node "' + listenScript + '"',
    env: { SMOKE_PORT: String(readyPort) },
    ports: [readyPort],
    readyPort: readyPort,
    readyTimeoutMs: 30000
  });
  await runner.start(readyCommand, projectRoot);
  const readySnapshot = await expectSettledStatus(runner, "ready", "running", 40000);
  assert.equal(readySnapshot.ready, true, "readyPort 可连接后 ready 必须是 true");
  assert.deepEqual(readySnapshot.actualPorts, [readyPort]);

  const readyDiagnose = await runner.diagnose([readyCommand], projectRoot);
  const readyEntry = readyDiagnose.find((entry) => entry.port === readyPort);
  assert.equal(readyEntry.occupant.managed, true, "监听进程应属于运行中 runner 的进程树");
  assert.equal(readyEntry.occupant.runnerCommandId, "ready");

  await assert.rejects(
    () => runner.killPort(projectRoot, readyPort, readyEntry.occupant.pid),
    (error) => {
      assert.equal(error.code, "managed-port");
      assert.equal(error.details.occupant.managed, true);
      return true;
    },
    "托管端口不允许从端口入口杀掉"
  );
  await runner.stop(projectRoot, "ready");

  // 就绪超时：命令活着但从不监听声明端口
  const [timeoutPort] = await getFreePorts(1);
  const timeoutCommand = makeCommand({
    id: "timeout",
    title: "就绪超时",
    command: "Start-Sleep -Seconds 30",
    ports: [timeoutPort],
    readyPort: timeoutPort,
    readyTimeoutMs: 2500
  });
  await runner.start(timeoutCommand, projectRoot);
  const timeoutFailed = await expectSettledStatus(runner, "timeout", "failed", 30000);
  assert.equal(timeoutFailed.error.code, "ready-timeout");
  assert.ok(timeoutFailed.error.details.timeoutMs === 2500);
  await waitFor(() => pidAlive(timeoutFailed.pid) === false, 8000, "超时后必须收掉进程");

  // 端口降级：声明 A、实际监听 B -> port-mismatch，且进程被结束
  const [declaredPort, actualPort] = await getFreePorts(2);
  const mismatchCommand = makeCommand({
    id: "mismatch",
    title: "端口降级",
    command: 'node "' + fallbackScript + '"',
    env: { SMOKE_ACTUAL_PORT: String(actualPort) },
    ports: [declaredPort],
    readyPort: declaredPort,
    readyTimeoutMs: 15000
  });
  await runner.start(mismatchCommand, projectRoot);
  const mismatchFailed = await expectSettledStatus(runner, "mismatch", "failed", 30000);
  assert.equal(mismatchFailed.error.code, "port-mismatch");
  assert.deepEqual(mismatchFailed.error.details.actualPorts, [actualPort]);
  await waitFor(() => pidAlive(mismatchFailed.pid) === false, 8000, "端口降级后必须收掉进程");

  // ── 5) dependsOn：先依赖后自己；依赖失败传导；startAll 全部入队 ──────────
  const [childPort] = await getFreePorts(1);
  const dependency = makeCommand({ id: "dep", title: "依赖服务", command: "Start-Sleep -Seconds 30" });
  const dependent = makeCommand({
    id: "dependent",
    title: "依赖它的服务",
    command: 'node "' + listenScript + '"',
    env: { SMOKE_PORT: String(childPort) },
    ports: [childPort],
    readyPort: childPort,
    readyTimeoutMs: 30000,
    dependsOn: ["dep"]
  });
  const dependencySet = [dependency, dependent];
  await runner.start(dependent, projectRoot, { commands: dependencySet });
  const dependentReady = await expectSettledStatus(runner, "dependent", "running", 40000);
  assert.equal(dependentReady.status, "running");
  const depRunning = runner.list(projectRoot).find((entry) => entry.commandId === "dep");
  assert.equal(depRunning.status, "running", "依赖必须先被拉起并就绪");

  // 依赖失败：被依赖命令启动失败时，跟随者的 error 必须是 dependency-failed
  const [badPort] = await getFreePorts(1);
  const blockingExternal = spawn(process.execPath, [listenScript], {
    env: Object.assign({}, process.env, { SMOKE_PORT: String(badPort) }),
    windowsHide: true,
    stdio: "ignore"
  });
  externals.push(blockingExternal);
  await waitFor(() => canConnect(badPort), 15000, "依赖冲突用的外部进程开始监听");
  const brokenDep = makeCommand({
    id: "broken-dep",
    title: "会失败的依赖",
    command: 'node "' + listenScript + '"',
    env: { SMOKE_PORT: String(badPort) },
    ports: [badPort],
    readyPort: badPort,
    readyTimeoutMs: 15000
  });
  const brokenChild = makeCommand({
    id: "broken-child",
    title: "依赖失败者",
    command: "Write-Output never",
    dependsOn: ["broken-dep"]
  });
  await runner.start(brokenChild, projectRoot, { commands: [brokenDep, brokenChild] });
  const brokenChildFailed = await expectSettledStatus(runner, "broken-child", "failed", 40000);
  assert.equal(brokenChildFailed.error.code, "dependency-failed");
  assert.equal(brokenChildFailed.error.details.commandId, "broken-dep");
  await runner.stop(projectRoot, "broken-dep").catch(() => {});

  // 依赖环：必须在建记录前就失败，不能让两个 flow 互相死等
  const cycleA = makeCommand({ id: "cycle-a", title: "环A", command: "Write-Output a", dependsOn: ["cycle-b"] });
  const cycleB = makeCommand({ id: "cycle-b", title: "环B", command: "Write-Output b", dependsOn: ["cycle-a"] });
  await assert.rejects(
    () => runner.start(cycleA, projectRoot, { commands: [cycleA, cycleB] }),
    (error) => {
      assert.ok(error instanceof RunnerError);
      assert.equal(error.code, "dependency-failed");
      assert.match(error.message, /存在环/);
      return true;
    },
    "dependsOn 有环必须当场拒绝"
  );
  assert.equal(runner.list(projectRoot).some((entry) => entry.commandId === "cycle-a"), false, "被环拒绝的命令不应留下记录");

  // startAll：按拓扑序全部入队，立即返回
  await runner.stopProject(projectRoot);
  const allCommands = [
    makeCommand({ id: "all-a", title: "A", command: "Start-Sleep -Seconds 30" }),
    makeCommand({ id: "all-b", title: "B", command: "Start-Sleep -Seconds 30", dependsOn: ["all-a"] })
  ];
  const startAllBegan = performance.now();
  const startAllResult = await runner.startAll(allCommands, projectRoot);
  const startAllElapsed = performance.now() - startAllBegan;
  assert.ok(startAllElapsed < START_RETURN_LIMIT_MS, "startAll 必须全部入队后立即返回（实测 " + Math.round(startAllElapsed) + "ms）");
  assert.deepEqual(startAllResult.queued.slice().sort(), ["all-a", "all-b"]);
  const allSnapshot = startAllResult.runners.filter((entry) => entry.commandId === "all-a" || entry.commandId === "all-b");
  assert.equal(allSnapshot.length, 2, "两条命令都应有记录");
  assert.ok(allSnapshot.every((entry) => entry.status === "queued" || entry.status === "starting"), "startAll 返回时应处于 queued/starting");
  await expectSettledStatus(runner, "all-a", "running", 40000);
  await expectSettledStatus(runner, "all-b", "running", 40000);
  await runner.stopProject(projectRoot);

  // ── 6) env 注入与 cwd ──────────────────────────────────────────────────
  const envCommand = makeCommand({
    id: "env",
    title: "环境变量",
    command: "Write-Output ('APP_ENV=' + $env:APP_ENV); Write-Output ((Get-Location).Path)",
    cwd: subDir,
    env: { APP_ENV: "smoke-env" }
  });
  await runner.start(envCommand, projectRoot);
  const envFinished = await waitFor(() => {
    const record = runner.list(projectRoot).find((entry) => entry.commandId === "env");
    return record !== undefined && record.status !== "queued" && record.status !== "starting" && record.status !== "running"
      ? record
      : undefined;
  }, 20000, "环境变量命令退出");
  assert.equal(envFinished.exitCode, 0);
  const envLog = await readFile(envFinished.logPath, "utf8");
  assert.match(envLog, /APP_ENV=smoke-env/);
  assert.match(envLog, new RegExp(escapeRegExp(subDir), "i"), "命令必须在 cwd 下执行");
  const envDiagnose = await runner.diagnose([envCommand], subDir);
  assert.ok(Array.isArray(envDiagnose), "子目录会话也能诊断（projectRoot 覆盖）");

  // ── 7) Host 重启接管：shutdown 不杀进程，新实例校验后接管 ────────────────
  const adoptCommand = makeCommand({ id: "adopt", title: "接管命令", command: "Start-Sleep -Seconds 30" });
  await runner.start(adoptCommand, projectRoot);
  const beforeRestart = await expectSettledStatus(runner, "adopt", "running", 30000);
  await runner.shutdown();
  assert.equal(pidAlive(beforeRestart.pid), true, "shutdown 不能杀进程");

  const second = createRunner();
  await second.init();
  const adoptedList = second.list(projectRoot);
  const adoptedRecord = adoptedList.find((entry) => entry.commandId === "adopt");
  assert.ok(adoptedRecord !== undefined, "新 Host 必须接管上次的进程");
  assert.equal(adoptedRecord.status, "running");
  assert.equal(adoptedRecord.adopted, true);
  assert.equal(adoptedRecord.pid, beforeRestart.pid);
  assert.equal(await second.stop(projectRoot, "adopt"), true);
  await waitFor(() => pidAlive(beforeRestart.pid) === false, 10000, "接管后可以停止");
  await second.shutdown();
  runner = createRunner();
  await runner.init();

  // ── 8) log 读取/清空/截断；缺失 cwd 报 spawn-failed ─────────────────────
  const bigCommand = makeCommand({
    id: "big",
    title: "大日志",
    command: "1..300 | ForEach-Object { Write-Output ('line-' + $_) }"
  });
  await runner.start(bigCommand, projectRoot);
  const bigFinished = await waitFor(() => {
    const record = runner.list(projectRoot).find((entry) => entry.commandId === "big");
    return record !== undefined && record.status !== "queued" && record.status !== "starting" && record.status !== "running"
      ? record
      : undefined;
  }, 30000, "大日志命令退出");
  assert.equal(bigFinished.exitCode, 0);
  const bigTail = await runner.readLog("big", projectRoot, 1024);
  assert.equal(bigTail.truncated, true, "日志超过 maxBytes 时 truncated=true");
  assert.ok(bigTail.bytes > 1024);
  assert.match(bigTail.text, /line-300/);
  const bigFull = await runner.readLog("big", projectRoot);
  assert.equal(bigFull.truncated, false);

  await runner.clearLog("big", projectRoot);
  const clearedLog = await runner.readLog("big", projectRoot);
  assert.equal(clearedLog.text, "", "清空后日志为空");
  assert.equal(clearedLog.bytes, 0);

  const emptyLog = await runner.readLog("no-such-command", projectRoot);
  assert.equal(emptyLog.text, "");
  assert.equal(emptyLog.bytes, 0);
  assert.equal(emptyLog.truncated, false);

  await assert.rejects(
    () => runner.readLog("big", projectRoot, 10),
    (error) => error instanceof RunnerError && error.code === "bad-request",
    "maxBytes 越界应报 bad-request"
  );

  await runner.start(makeCommand({ id: "missing-cwd", title: "缺目录", command: "echo x", cwd: path.join(dir, "does-not-exist") }), projectRoot);
  const missingCwd = await expectSettledStatus(runner, "missing-cwd", "failed", 20000);
  assert.equal(missingCwd.error.code, "spawn-failed");
  assert.match(missingCwd.error.message, /工作目录不存在/);

  // ── 9) 外部实例：接管 / 解除接管 / 重启并接管 ────────────────────────────
  const [adoptExternalPort, releasePort, takeOverPort] = await getFreePorts(3);

  function spawnExternal(port) {
    const child = spawn(process.execPath, [listenScript], {
      cwd: projectRoot,
      env: Object.assign({}, process.env, { SMOKE_PORT: String(port) }),
      windowsHide: true,
      stdio: "ignore"
    });
    externals.push(child);
    return child;
  }

  const adoptExternal = spawnExternal(adoptExternalPort);
  await waitFor(() => canConnect(adoptExternalPort), 15000, "接管用外部进程开始监听");
  const adoptExternalCommand = makeCommand({
    id: "adopt-external",
    title: "外部实例",
    command: 'node "' + listenScript + '"',
    env: { SMOKE_PORT: String(adoptExternalPort) },
    ports: [adoptExternalPort],
    readyPort: adoptExternalPort,
    readyTimeoutMs: 20000
  });

  const diagnoseExternal = await runner.diagnose([adoptExternalCommand], projectRoot);
  assert.deepEqual(JSON.parse(JSON.stringify(diagnoseExternal)), diagnoseExternal, "diagnose 结果必须是 lossless JSON");
  const adoptEntry = diagnoseExternal.find((entry) => entry.port === adoptExternalPort);
  assert.ok(adoptEntry !== undefined, "diagnose 应包含外部实例占用的端口");
  assert.equal(adoptEntry.occupant.pid, adoptExternal.pid);
  assert.equal(adoptEntry.occupant.managed, false);
  for (const child of adoptEntry.occupant.children) {
    assert.equal(typeof child.pid, "number", "occupant.children[].pid 必须是数字（lossless JSON）");
  }

  // 命令行里没有项目路径（spawn 出来的 node 只有脚本路径）也要能接管，但要带 warning：
  // uvicorn / cargo tauri 这类实例的命令行确实不带项目路径，用 related 硬拦会让功能失效。
  const adoptedResult = await runner.adopt(adoptExternalCommand, projectRoot);
  assert.equal(typeof adoptedResult.warning, "string");
  assert.ok(adoptedResult.warning !== "", "命令行不含项目路径时应带 warning");
  assert.equal(adoptedResult.adopted, true);
  assert.equal(adoptedResult.runner.external, true, "接管记录必须标记 external");
  assert.equal(adoptedResult.runner.status, "running");
  assert.equal(adoptedResult.runner.pid, adoptExternal.pid);
  assert.ok(adoptedResult.runner.pidCreatedAt !== "", "接管记录必须带 pidCreatedAt 做身份校验");
  assert.equal(pidAlive(adoptExternal.pid), true, "接管不能结束进程");

  const adoptedAgain = await runner.adopt(adoptExternalCommand, projectRoot);
  assert.equal(adoptedAgain.adopted, false);
  assert.equal(adoptedAgain.reason, "already-managed");

  const diagnoseAdopted = await runner.diagnose([adoptExternalCommand], projectRoot);
  assert.equal(diagnoseAdopted.find((entry) => entry.port === adoptExternalPort).occupant.managed, true, "接管后该端口应算托管占用");

  assert.equal(await runner.stop(projectRoot, "adopt-external"), true);
  await waitFor(async () => !(await canConnect(adoptExternalPort)), 10000, "接管实例停止后端口释放");
  assert.equal(pidAlive(adoptExternal.pid), false, "停止接管实例必须真的结束外部进程");
  const adoptStopped = runner.list(projectRoot).find((entry) => entry.commandId === "adopt-external");
  assert.notEqual(adoptStopped, undefined);
  assert.equal(adoptStopped.status, "stopped");
  const adoptStoppedLog = await readFile(adoptStopped.logPath, "utf8");
  assert.match(adoptStoppedLog, /接管外部实例/, "接管时应往日志里写说明");
  assert.match(adoptStoppedLog, /输出无法回放/, "日志必须说明外部实例的输出无法回放");

  // 解除接管：不结束进程，记录消失，重新变回「外部运行中」
  const releaseExternal = spawnExternal(releasePort);
  await waitFor(() => canConnect(releasePort), 15000, "解除接管用外部进程开始监听");
  const releaseExternalCommand = makeCommand({
    id: "release-external",
    title: "解除接管",
    command: 'node "' + listenScript + '"',
    env: { SMOKE_PORT: String(releasePort) },
    ports: [releasePort],
    readyPort: releasePort,
    readyTimeoutMs: 20000
  });
  await runner.adopt(releaseExternalCommand, projectRoot);
  assert.equal(await runner.release(projectRoot, "release-external"), true);
  assert.equal(runner.list(projectRoot).some((entry) => entry.commandId === "release-external"), false, "解除接管后不再有记录");
  assert.equal(pidAlive(releaseExternal.pid), true, "解除接管不能结束进程");
  const diagnoseReleased = await runner.diagnose([releaseExternalCommand], projectRoot);
  assert.equal(diagnoseReleased.find((entry) => entry.port === releasePort).occupant.managed, false, "解除接管后该端口应重新算外部占用");

  // 重启并接管：结束外部实例 -> 等端口释放 -> 由插件托管启动
  const takeOverExternal = spawnExternal(takeOverPort);
  await waitFor(() => canConnect(takeOverPort), 15000, "重启并接管用外部进程开始监听");
  const takeOverCommand = makeCommand({
    id: "takeover",
    title: "重启并接管",
    command: 'node "' + listenScript + '"',
    env: { SMOKE_PORT: String(takeOverPort) },
    ports: [takeOverPort],
    readyPort: takeOverPort,
    readyTimeoutMs: 20000
  });
  await runner.restart(takeOverCommand, projectRoot, { commands: [takeOverCommand], takeOverExternal: true });
  const takeOverResult = await expectSettledStatus(runner, "takeover", "running", 40000);
  assert.equal(takeOverResult.external, false, "重启并接管后必须是插件自己启动的实例");
  assert.notEqual(takeOverResult.pid, takeOverExternal.pid, "重启并接管必须换成新进程");
  assert.equal(pidAlive(takeOverExternal.pid), false, "重启并接管必须结束原外部进程");
  const diagnoseTakeOver = await runner.diagnose([takeOverCommand], projectRoot);
  const takeOverEntry = diagnoseTakeOver.find((entry) => entry.port === takeOverPort);
  assert.equal(takeOverEntry.occupant.managed, true, "重启并接管后端口应由托管进程树持有");
  assert.equal(takeOverEntry.occupant.runnerCommandId, "takeover");
  await runner.stop(projectRoot, "takeover");

  await assert.rejects(
    () => runner.adopt(makeCommand({ id: "nothing", title: "没有实例", ports: [] }), projectRoot),
    (error) => error instanceof RunnerError && error.code === "no-external-instance",
    "没有外部实例时应报 no-external-instance"
  );

  // ── 10) 并发：一条在启动时另一条立即返回；排队中可取消；事件循环不阻塞 ──
  const [busyPort] = await getFreePorts(1);
  const busyCommand = makeCommand({
    id: "busy",
    title: "慢启动",
    command: "Start-Sleep -Seconds 4",
    ports: [],
    readyPort: null
  });
  await runner.start(busyCommand, projectRoot);
  const [fastPort] = await getFreePorts(1);
  const fastCommand = makeCommand({
    id: "fast",
    title: "另一条",
    command: 'node "' + listenScript + '"',
    env: { SMOKE_PORT: String(fastPort) },
    ports: [fastPort],
    readyPort: fastPort,
    readyTimeoutMs: 30000
  });
  // 前一条还在 starting/queued，第二条必须立刻返回而不是排队等它。
  const concurrentBegan = performance.now();
  await runner.start(fastCommand, projectRoot);
  const concurrentElapsed = performance.now() - concurrentBegan;
  assert.ok(concurrentElapsed < START_RETURN_LIMIT_MS, "并发启动必须互不等待（实测 " + Math.round(concurrentElapsed) + "ms）");
  const fastRunning = await expectSettledStatus(runner, "fast", "running", 40000);
  assert.equal(fastRunning.status, "running");

  // 就绪等待期间事件循环延迟：这是「整机卡住」的量化回归测试。
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  const [probePort] = await getFreePorts(1);
  const probeCommand = makeCommand({
    id: "loop-probe",
    title: "事件循环探针",
    command: 'node "' + listenScript + '"',
    env: { SMOKE_PORT: String(probePort) },
    ports: [probePort],
    readyPort: probePort,
    readyTimeoutMs: 30000
  });
  histogram.enable();
  await runner.start(probeCommand, projectRoot);
  await expectSettledStatus(runner, "loop-probe", "running", 40000);
  histogram.disable();
  const p99 = histogram.percentile(99) / 1e6;
  assert.ok(
    p99 < EVENT_LOOP_P99_LIMIT_MS,
    "就绪等待期间事件循环延迟 p99 必须 < " + EVENT_LOOP_P99_LIMIT_MS + "ms（实测 " + Math.round(p99) + "ms）"
  );

  // 启动与停止撞车：start 之后立刻 stop（重复几轮以覆盖 spawn 的 await 窗口），
  // 不能留下「状态 starting、实际没人管」的野进程。
  for (let round = 0; round < 3; round += 1) {
    const [racePort] = await getFreePorts(1);
    const raceId = "race-" + String(round);
    const raceCommand = makeCommand({
      id: raceId,
      title: "启动即停止",
      command: 'node "' + listenScript + '"',
      env: { SMOKE_PORT: String(racePort) },
      ports: [racePort],
      readyPort: racePort,
      readyTimeoutMs: 20000
    });
    await runner.start(raceCommand, projectRoot);
    await runner.stop(projectRoot, raceId);
    const raceRecord = await settle(runner, raceId, 20000);
    assert.notEqual(raceRecord.status, "starting", "停止之后不能再回到 starting（第 " + String(round + 1) + " 轮）");
    assert.notEqual(raceRecord.status, "running", "停止之后不能是 running（第 " + String(round + 1) + " 轮）");
    await sleep(700);
    assert.equal(await canConnect(racePort), false, "启动/停止撞车后不能留下占端口的进程（第 " + String(round + 1) + " 轮）");
    if (typeof raceRecord.pid === "number" && raceRecord.pid > 0) {
      await waitFor(() => pidAlive(raceRecord.pid) === false, 8000, "撞车后进程必须退出");
    }
  }

  // canSpawn 的三个失效条件（状态机不变量，防止「已停止还能被写回 starting」的回归）
  assert.equal(createRunner().canSpawn({ status: "queued", stopRequested: false, finished: false }), true, "排队中可以推进");
  assert.equal(createRunner().canSpawn({ status: "queued", stopRequested: true, finished: false }), false, "已请求停止不能再 spawn");
  assert.equal(createRunner().canSpawn({ status: "stopped", stopRequested: true, finished: true }), false, "已落定不能再 spawn");

  // 排队中取消：还没有 spawn 就被停掉，不能留下任何进程/端口
  const [cancelPort] = await getFreePorts(1);
  const slowDep = makeCommand({ id: "cancel-dep", title: "慢依赖", command: "Start-Sleep -Seconds 3" });
  const cancelChild = makeCommand({
    id: "cancel-child",
    title: "排队中取消",
    command: 'node "' + listenScript + '"',
    env: { SMOKE_PORT: String(cancelPort) },
    ports: [cancelPort],
    readyPort: cancelPort,
    readyTimeoutMs: 20000,
    dependsOn: ["cancel-dep"]
  });
  const cancelQueued = await runner.start(cancelChild, projectRoot, { commands: [slowDep, cancelChild] });
  assert.equal(cancelQueued.status, "queued", "有依赖未就绪时应处于 queued");
  await runner.stop(projectRoot, "cancel-child");
  const canceledRecord = runner.list(projectRoot).find((entry) => entry.commandId === "cancel-child");
  assert.equal(canceledRecord.status, "stopped", "排队中取消应立即落成 stopped");
  await sleep(2500);
  assert.equal(await canConnect(cancelPort), false, "取消后不能把进程拉起来");

  console.log(JSON.stringify({
    ok: true,
    ports: {
      occupant: occupantPort,
      ready: readyPort,
      timeout: timeoutPort,
      declared: declaredPort,
      actual: actualPort,
      adopt: adoptExternalPort,
      release: releasePort,
      takeOver: takeOverPort
    },
    snapshotKeys: SNAPSHOT_KEYS.length,
    startReturnMs: Math.round(startElapsed),
    eventLoopP99Ms: Math.round(p99)
  }, null, 2));
} finally {
  if (occupant !== undefined && pidAlive(occupant.pid)) {
    occupant.kill("SIGKILL");
  }
  for (const external of externals) {
    if (external !== undefined && typeof external.pid === "number" && pidAlive(external.pid)) {
      try {
        external.kill("SIGKILL");
      } catch (error) {
        console.error("[cleanup] 结束外部实例 " + String(external.pid) + " 失败：" + String(error));
      }
    }
  }
  if (runner !== undefined) {
    try {
      await runner.stopProject(projectRoot);
    } catch (error) {
      // 清理阶段的停止失败不影响已完成的断言，打印出来便于排查。
      console.error("[cleanup] stopProject(project) 失败：" + String(error));
    }
    try {
      await runner.stopProject(depProjectRoot);
    } catch (error) {
      console.error("[cleanup] stopProject(depProject) 失败：" + String(error));
    }
    await runner.shutdown();
  }
  await rm(dir, { recursive: true, force: true });
}
