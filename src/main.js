const { app, BrowserWindow, ipcMain, nativeTheme } = require("electron");
const { execFile, spawn, spawnSync } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const providers = require("./providers/provider_adapters");
const { ConsoleGraphRuntime } = require("./engine/langgraph_runtime");
const permissionGate = require("./security/permission_gate");
const { parseActualUsage } = require("./usage/usage_parser");
const { startMcpBridge: createMcpBridgeServer } = require("./mcp/mcp_bridge");

app.setName("AI 오케스트레이터");

const DATA_DIR = path.join(app.getPath("userData"), "data");
const DATA_FILE = path.join(DATA_DIR, "orchestrator.json");
const SQLITE_FILE = path.join(DATA_DIR, "orchestrator.sqlite3");
const SQLITE_SYNC_SCRIPT = path.join(__dirname, "storage", "sqlite_store.py");

const DEFAULT_STATE = {
  version: 1,
  selectedProjectId: "project-orchestrator",
  settings: {
    workspacePath: "/Users/h2o/Documents/AgentMuitle",
    defaultAgents: ["codex", "claude"],
    maxRecentMessages: 16,
    routerAgent: "ollama",
    localRouterModel: "qwen2.5-coder:7b",
    enablePreScope: true,
    enableOutputFiltering: true,
    enableUsageTracking: true,
    requireApprovalForRiskyRuns: true,
    enableDailyRoutine: true,
    dailyRoutineHour: 9
  },
  projects: [
    {
      id: "project-orchestrator",
      title: "AI 오케스트레이터 개발",
      status: "MVP 구현 중",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [
        {
          id: "msg-welcome-user",
          role: "user",
          author: "사용자",
          text: "여러 AI를 한 화면에서 관리하고 작업을 분배하는 오케스트레이터를 만들고 싶어.",
          createdAt: new Date().toISOString()
        },
        {
          id: "msg-welcome-assistant",
          role: "assistant",
          author: "Codex",
          text: "프로젝트/대화/작업을 저장하고, 에이전트 상태와 실행 준비를 관리하는 MVP부터 구축합니다.",
          createdAt: new Date().toISOString()
        }
      ],
      tasks: [
        {
          id: "task-state",
          state: "완료",
          name: "저장소 구조 구성",
          detail: "프로젝트, 메시지, 작업을 로컬 JSON DB에 저장",
          createdAt: new Date().toISOString()
        },
        {
          id: "task-agent",
          state: "진행 중",
          name: "에이전트 연결 준비",
          detail: "Codex, Claude, Grok 실행 가능 여부 확인 및 터미널 실행 연결",
          createdAt: new Date().toISOString()
        },
        {
          id: "task-run",
          state: "대기",
          name: "작업 실행 로그",
          detail: "선택한 에이전트로 작업 실행 요청과 결과 로그를 누적",
          createdAt: new Date().toISOString()
        }
      ],
      approvals: [
        {
          id: "approval-agent-run",
          title: "에이전트 실행 연결",
          detail: "선택한 에이전트에게 현재 프로젝트 문맥과 사용자 요청을 전달합니다.",
          state: "대기",
          createdAt: new Date().toISOString()
        }
      ],
      evals: {
        score: 58,
        items: [
          { state: "Pass", name: "로컬 UI 실행", detail: "Electron 앱 실행 가능" },
          { state: "Pass", name: "데이터 저장", detail: "대화/작업 저장 구조 추가" },
          { state: "Pending", name: "실제 에이전트 실행", detail: "CLI 로그인 및 실행 검증 필요" }
        ]
      }
    }
  ],
  runs: [],
  usageEvents: [],
  checkpoints: [],
  memories: [],
  automations: [],
  mcpBridge: {
    enabled: true,
    port: 8765,
    secretPath: ""
  },
  finalDrafts: []
};

const runningProcesses = new Map();
const activeRunRequests = new Map();
let mcpBridgeServer = null;
let lastDailyRoutineKey = null;

function ensureDataFile() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(DEFAULT_STATE, null, 2), "utf8");
  }
}

function readState() {
  ensureDataFile();
  try {
    return migrateState(JSON.parse(fs.readFileSync(DATA_FILE, "utf8")));
  } catch (_error) {
    const backup = `${DATA_FILE}.${Date.now()}.broken`;
    fs.copyFileSync(DATA_FILE, backup);
    fs.writeFileSync(DATA_FILE, JSON.stringify(DEFAULT_STATE, null, 2), "utf8");
    return structuredClone(DEFAULT_STATE);
  }
}

function migrateState(state) {
  state.version = state.version || 1;
  state.settings = {
    ...DEFAULT_STATE.settings,
    ...(state.settings || {})
  };
  state.projects = state.projects || [];
  state.runs = state.runs || [];
  state.usageEvents = state.usageEvents || [];
  state.checkpoints = state.checkpoints || [];
  state.memories = state.memories || [];
  state.automations = state.automations || [];
  state.mcpBridge = {
    ...DEFAULT_STATE.mcpBridge,
    ...(state.mcpBridge || {})
  };
  state.finalDrafts = state.finalDrafts || [];
  state.projects.forEach((project) => {
    project.messages = project.messages || [];
    project.tasks = project.tasks || [];
    project.approvals = project.approvals || [];
    project.evals = project.evals || { score: 0, items: [] };
    project.workspacePath = project.workspacePath || state.settings.workspacePath;
    project.autoRoutedMessageIds = project.autoRoutedMessageIds || [];
  });
  return state;
}

function writeState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), "utf8");
  syncSqliteStore();
  return state;
}

function syncSqliteStore() {
  if (!fs.existsSync(SQLITE_SYNC_SCRIPT)) return;
  const python = process.env.PYTHON || "/usr/bin/python3";
  try {
    spawnSync(python, [SQLITE_SYNC_SCRIPT, "sync", DATA_FILE, SQLITE_FILE], {
      timeout: 8000,
      stdio: "ignore"
    });
  } catch (_error) {
    // SQLite 동기화 실패가 앱 실행 자체를 막으면 안 된다. JSON 저장은 원본 저장소로 유지한다.
  }
}

function now() {
  return new Date().toISOString();
}

function uid(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function estimateTokens(text = "") {
  const compact = String(text || "").trim();
  if (!compact) return 0;
  const ascii = (compact.match(/[A-Za-z0-9_./:-]+/g) || []).join(" ").length;
  const nonAscii = compact.length - ascii;
  return Math.max(1, Math.ceil(ascii / 4 + nonAscii * 1.15));
}

const COST_BASELINE_KRW_PER_1M = {
  router_cloud_baseline_input: 200,
  router_cloud_baseline_output: 800,
  codex_input: 0,
  codex_output: 0,
  claude_input: 0,
  claude_output: 0,
  grok_input: 0,
  grok_output: 0
};

function estimateKrwCost(provider, inputTokens, outputTokens, isLocal = false, usageType = "agent_run") {
  if (isLocal) return 0;
  if (usageType === "router") {
    return ((inputTokens / 1_000_000) * COST_BASELINE_KRW_PER_1M.router_cloud_baseline_input) +
      ((outputTokens / 1_000_000) * COST_BASELINE_KRW_PER_1M.router_cloud_baseline_output);
  }
  const inputRate = COST_BASELINE_KRW_PER_1M[`${provider}_input`] || 0;
  const outputRate = COST_BASELINE_KRW_PER_1M[`${provider}_output`] || 0;
  return ((inputTokens / 1_000_000) * inputRate) + ((outputTokens / 1_000_000) * outputRate);
}

function recordUsageEvent(state, event) {
  if (!state.settings?.enableUsageTracking) return null;
  const inputTokens = Number(event.inputTokens || 0);
  const outputTokens = Number(event.outputTokens || 0);
  const isLocal = Boolean(event.isLocal);
  const provider = event.provider || event.agentId || "unknown";
  const usageType = event.usageType || "agent_run";
  const estimatedCostKrw = estimateKrwCost(provider, inputTokens, outputTokens, isLocal, usageType);
  const cloudEquivalentCostKrw = isLocal
    ? estimateKrwCost("router_cloud_baseline", inputTokens, outputTokens, false, usageType)
    : estimatedCostKrw;
  const item = {
    id: uid("usage"),
    projectId: event.projectId || null,
    runId: event.runId || null,
    agentId: event.agentId || provider,
    usageType,
    provider,
    model: event.model || null,
    inputTokens,
    outputTokens,
    callCount: Number(event.callCount || 1),
    estimatedCostKrw,
    actualCostKrw: isLocal ? 0 : estimatedCostKrw,
    cloudEquivalentCostKrw,
    savedCostKrw: Math.max(0, cloudEquivalentCostKrw - (isLocal ? 0 : estimatedCostKrw)),
    isLocal,
    note: event.note || "",
    createdAt: now()
  };
  state.usageEvents.unshift(item);
  return item;
}

function recordCheckpoint(state, projectId, nodeName, graphState, metadata = {}) {
  state.checkpoints = state.checkpoints || [];
  state.checkpoints.unshift({
    id: uid("ckpt"),
    projectId,
    threadId: projectId,
    nodeName,
    state: graphState,
    metadata,
    createdAt: now()
  });
  state.checkpoints = state.checkpoints.slice(0, 500);
}

function rememberProjectEvent(state, projectId, type, text, tags = []) {
  state.memories = state.memories || [];
  const clean = compactText(text, 1800);
  if (!clean) return null;
  const item = {
    id: uid("mem"),
    projectId,
    type,
    text: clean,
    tags,
    createdAt: now()
  };
  state.memories.unshift(item);
  state.memories = state.memories.slice(0, 1000);
  return item;
}

function createRoutingGraph(project, message) {
  return new ConsoleGraphRuntime({
    checkpoint: (nodeName, graphState, metadata) => {
      const state = readState();
      recordCheckpoint(state, project.id, `LangGraph:${nodeName}`, graphState, metadata);
      writeState(state);
    }
  })
    .addNode("요청분석", async (graphState) => ({
      state: {
        projection: buildContextProjection(project, message.text || ""),
        requestId: graphState.requestId || uid("route")
      }
    }))
    .addNode("작업분배", async (graphState) => {
      const routing = await plannedRunsFromMessage(project, message.text || "");
      return {
        state: {
          routing,
          plannedRunCount: routing.runs.length
        }
      };
    })
    .addEdge("요청분석", "작업분배");
}

function addApprovalForRun(state, project, run, reason) {
  const approval = {
    id: uid("approval"),
    runId: run.id,
    title: `${agentLabelsForMain(run.agentId)} 실행 승인 필요`,
    detail: reason || "실행 전 사용자 승인이 필요합니다.",
    state: "대기",
    createdAt: now()
  };
  project.approvals.push(approval);
  run.state = "승인 대기";
  const task = project.tasks.find((item) => item.runId === run.id);
  if (task) task.state = "승인 대기";
  return approval;
}

function findProject(state, projectId) {
  return state.projects.find((project) => project.id === projectId) || state.projects[0];
}

function appendProjectMessage(state, project, message) {
  project.messages.push({
    id: uid("msg"),
    createdAt: now(),
    ...message
  });
  project.updatedAt = now();
}

function compactText(value = "", limit = 1200) {
  const clean = String(value || "").replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit)}…`;
}

function buildContextProjection(project, currentInstruction = "") {
  const done = (project.tasks || [])
    .filter((task) => task.state === "완료")
    .slice(-6)
    .map((task) => `${task.name}`);
  const running = (project.tasks || [])
    .filter((task) => ["진행 중", "대기"].includes(task.state))
    .slice(-6)
    .map((task) => `${task.state}:${task.name}`);
  const blocked = (project.tasks || [])
    .filter((task) => ["실패", "중단"].includes(task.state))
    .slice(-4)
    .map((task) => `${task.name}`);
  const recentUserMessages = (project.messages || [])
    .filter((message) => message.role === "user")
    .slice(-4)
    .map((message) => compactText(message.text, 350));

  return {
    projectId: project.id,
    projectTitle: project.title,
    status: project.status || "대기",
    goal: recentUserMessages[0] || currentInstruction || project.title,
    currentRequest: compactText(currentInstruction, 900),
    done,
    running,
    blocked,
    recentUserMessages,
    availableAgents: ["codex", "claude", "grok"],
    rules: [
      "사용자가 직접 언급하지 않은 제품명/도메인명은 추가하지 않는다.",
      "구현 요청이 없으면 구현 작업을 만들지 않는다.",
      "작업은 1~4개로 제한한다."
    ]
  };
}

function extractArtifactPaths(text = "") {
  const matches = String(text || "").match(/(?:^|\s)(?:[./~\w가-힣 -]+\/)?[\w가-힣 .-]+\.(?:js|ts|tsx|jsx|py|md|json|html|css|kt|java|swift|xml|yml|yaml|sh)/g) || [];
  return [...new Set(matches.map((item) => item.trim()).filter(Boolean))].slice(0, 10);
}

function buildWorkerHandoff(project, currentInstruction = "") {
  const completedRuns = (readState().runs || [])
    .filter((run) => run.projectId === project.id && run.state === "완료")
    .slice(0, 5);
  return completedRuns.map((run) => {
    const output = String(run.output || "");
    const firstLines = output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 8)
      .join(" ");
    return {
      agent: run.agentId,
      did: compactText(firstLines || run.instruction || "완료된 작업", 500),
      artifacts: extractArtifactPaths(output),
      blocked: /blocked|실패|불가|확인 필요|막힘/i.test(output) ? compactText(output, 300) : null,
      next: compactText(currentInstruction, 500)
    };
  });
}

function keywordCandidates(text = "") {
  const normalized = String(text || "")
    .replace(/[^\p{L}\p{N}_./-]+/gu, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 2 && word.length <= 40);
  const stop = new Set(["그리고", "해서", "있는", "없는", "작업", "진행", "구현", "설계", "확인", "기능", "프로젝트"]);
  return [...new Set(normalized.filter((word) => !stop.has(word)))].slice(0, 10);
}

function runPreScope(project, instruction = "") {
  const state = readState();
  if (!state.settings?.enablePreScope) return null;
  const cwd = project.workspacePath || state.settings.workspacePath || process.cwd();
  if (!fs.existsSync(cwd)) return null;
  const keywords = keywordCandidates(`${project.title} ${instruction}`);
  if (!keywords.length) return null;

  const hits = [];
  const fileSet = new Set();
  for (const keyword of keywords.slice(0, 6)) {
    const fileResult = spawnSync("rg", [
      "-l",
      "--hidden",
      "--glob",
      "!node_modules/**",
      "--glob",
      "!.git/**",
      "--glob",
      "!dist/**",
      "--glob",
      "!build/**",
      keyword
    ], {
      cwd,
      encoding: "utf8",
      timeout: 3500,
      maxBuffer: 80 * 1024
    });

    String(fileResult.stdout || "")
      .split("\n")
      .filter(Boolean)
      .slice(0, 12)
      .forEach((file) => fileSet.add(file));

    const lineResult = spawnSync("rg", [
      "-n",
      "-m",
      "3",
      "--context",
      "2",
      "--hidden",
      "--glob",
      "!node_modules/**",
      "--glob",
      "!.git/**",
      "--glob",
      "!dist/**",
      "--glob",
      "!build/**",
      keyword
    ], {
      cwd,
      encoding: "utf8",
      timeout: 3500,
      maxBuffer: 120 * 1024
    });

    const lines = String(lineResult.stdout || "")
      .split("\n")
      .filter(Boolean)
      .slice(0, 10);
    lines.forEach((line) => hits.push({ keyword, line }));
    if (hits.length >= 24) break;
  }

  hits.map((hit) => hit.line.split(":")[0]).filter(Boolean).forEach((file) => fileSet.add(file));
  const files = [...fileSet].slice(0, 15);
  return {
    cwd,
    keywords,
    files,
    excerpts: hits.slice(0, 18).map((hit) => `${hit.keyword}: ${hit.line}`)
  };
}

function filterOutputForContext(output = "") {
  const text = String(output || "").replace(/\u001b\[[0-9;]*m/g, "");
  if (!text.trim()) return "";
  const lines = text.split("\n");
  const successSignals = lines.filter((line) =>
    /passed|passing|success|successful|done|completed|build successful|변경 사항 없음|성공|완료/i.test(line)
  ).slice(-8);
  const important = lines.filter((line) =>
    /error|failed|failure|exception|traceback|warning|fatal|denied|unauthorized|not found|cannot|오류|실패|경고|권한|에러/i.test(line)
  );
  const firstErrors = important.slice(0, 24);
  const lastContext = lines.slice(-40);
  const selected = important.length
    ? [
        "[success/context signals]",
        ...successSignals,
        "",
        "[first errors/warnings]",
        ...firstErrors,
        "",
        "[tail context]",
        ...lastContext
      ]
    : lines.slice(-80);
  const body = [...new Set(selected)].join("\n").trim();
  if (body.length <= 12000) return body;
  return body.slice(-12000);
}

function callOllamaGenerate(model, prompt, timeout = 45000) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model,
      prompt,
      stream: false,
      format: "json",
      options: {
        temperature: 0.1,
        num_predict: 900
      }
    });

    const request = http.request(
      {
        hostname: "127.0.0.1",
        port: 11434,
        path: "/api/generate",
        method: "POST",
        timeout,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        }
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`Ollama 응답 오류 ${response.statusCode}: ${body.slice(-800)}`));
            return;
          }
          try {
            const parsed = JSON.parse(body);
            resolve(parsed.response || "");
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    request.on("timeout", () => {
      request.destroy(new Error("Ollama Router 응답 시간 초과"));
    });
    request.on("error", reject);
    request.write(payload);
    request.end();
  });
}

function updateRun(runId, patch) {
  const state = readState();
  const run = state.runs.find((item) => item.id === runId);
  if (!run) return null;
  Object.assign(run, patch, { updatedAt: now() });
  writeState(state);
  return run;
}

function appendRunLog(run, chunk) {
  if (!chunk) return;
  fs.appendFileSync(run.logFile, chunk, "utf8");
}

function commandExists(command) {
  return new Promise((resolve) => {
    execFile("/bin/zsh", ["-lc", `command -v ${command} >/dev/null 2>&1 && ${command} --version 2>/dev/null | head -n 1`], (error, stdout) => {
      resolve({
        installed: !error,
        ready: !error,
        version: stdout.trim() || null
      });
    });
  });
}

function runProbe(label, shellCommand, timeout = 25000) {
  return new Promise((resolve) => {
    execFile("/bin/zsh", ["-lc", shellCommand], { timeout }, (error, stdout, stderr) => {
      const output = `${stdout || ""}${stderr || ""}`.trim();
      resolve({ label, error, output });
    });
  });
}

function classifyProbe(command, versionResult, probe) {
  const installed = Boolean(versionResult.installed);
  const output = probe?.output || "";
  const lower = output.toLowerCase();
  if (!installed) {
    return {
      installed: false,
      ready: false,
      version: null,
      status: "not-installed",
      message: "CLI 설치 필요"
    };
  }
  if (probe?.error?.killed || probe?.error?.signal === "SIGTERM") {
    return {
      installed: true,
      ready: false,
      version: versionResult.version,
      status: "timeout",
      message: "로그인 확인 지연"
    };
  }
  if (
    command === "ollama" && lower.includes("name") ||
    lower.includes("logged in using chatgpt") ||
    lower.includes("authenticated") ||
    lower.includes("auth status: logged in") ||
    lower.includes("login status: logged in") ||
    lower.includes("you are logged in with grok.com") ||
    lower.includes("no installation issues found") ||
    lower.includes("claude code doctor")
  ) {
    return {
      installed: true,
      ready: true,
      version: versionResult.version,
      status: "ready",
      message: "실행 가능"
    };
  }
  if (
    lower.includes("payment required") ||
    lower.includes("spending-limit") ||
    lower.includes("run out of credits") ||
    lower.includes("billing") ||
    lower.includes("credit balance")
  ) {
    return {
      installed: true,
      ready: false,
      version: versionResult.version,
      status: "billing-required",
      message: "크레딧/구독 필요"
    };
  }
  if (
    lower.includes("login") ||
    lower.includes("sign in") ||
    lower.includes("not logged in") ||
    lower.includes("unauthorized") ||
    lower.includes("invalid api key") ||
    lower.includes("authentication")
  ) {
    return {
      installed: true,
      ready: false,
      version: versionResult.version,
      status: "login-required",
      message: "로그인 필요"
    };
  }
  if (
    output.includes("승인이 필요") ||
    lower.includes("approval required") ||
    lower.includes("requires approval") ||
    lower.includes("permission required")
  ) {
    return {
      installed: true,
      ready: false,
      version: versionResult.version,
      status: "approval-required",
      message: "승인/권한 필요"
    };
  }
  return {
    installed: true,
    ready: !probe?.error,
    version: versionResult.version,
    status: probe?.error ? "probe-failed" : "ready",
    message: probe?.error ? "실행 확인 실패" : "실행 가능"
  };
}

async function probeAgent(command, probeCommand, timeout = 25000) {
  const version = await commandExists(command);
  if (!version.installed) return classifyProbe(command, version, null);
  const probe = await runProbe(command, probeCommand, timeout);
  const classified = classifyProbe(command, version, probe);
  if (!classified.ready) {
    const home = os.homedir();
    if (command === "codex" && fs.existsSync(path.join(home, ".codex", "auth.json"))) {
      return { ...classified, ready: true, status: "ready-auth-file", message: "인증 파일 확인됨" };
    }
    if (command === "claude" && (fs.existsSync(path.join(home, ".claude", ".credentials.json")) || fs.existsSync(path.join(home, ".claude.json")))) {
      return { ...classified, ready: true, status: "ready-auth-file", message: "인증 파일 확인됨" };
    }
    if (command === "grok" && fs.existsSync(path.join(home, ".grok"))) {
      return { ...classified, status: "login-check-needed", message: "설정 폴더 확인됨 · CLI 상태 재확인 필요" };
    }
  }
  return classified;
}

function startMcpBridge() {
  if (mcpBridgeServer) return;
  mcpBridgeServer = createMcpBridgeServer({
    readState,
    writeState,
    uid,
    onError: () => {
      mcpBridgeServer = null;
    }
  });
}

function startAutomationScheduler() {
  setInterval(runDueAutomations, 60 * 1000);
  setTimeout(runDueAutomations, 3000);
}

function runDueAutomations() {
  const state = readState();
  if (!state.settings?.enableDailyRoutine) return;
  const date = new Date();
  const hour = Number(state.settings.dailyRoutineHour || 9);
  const key = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}-${hour}`;
  if (date.getHours() !== hour || lastDailyRoutineKey === key) return;
  lastDailyRoutineKey = key;

  state.projects.forEach((project) => {
    const openTasks = (project.tasks || []).filter((task) => !["완료", "거절", "중단"].includes(task.state));
    if (!openTasks.length) return;
    appendProjectMessage(state, project, {
      role: "assistant",
      author: "Routine",
      text: [
        "매일 오전 미완료 작업 요약입니다.",
        "",
        ...openTasks.slice(0, 8).map((task, index) => `${index + 1}. [${task.state}] ${task.name} — ${task.detail}`)
      ].join("\n")
    });
    recordCheckpoint(state, project.id, "Automation:미완료요약", {
      openTaskCount: openTasks.length
    });
  });
  writeState(state);
}

function createWindow() {
  nativeTheme.themeSource = "light";

  const win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1180,
    minHeight: 760,
    title: "AI 오케스트레이터",
    backgroundColor: "#f5f7fa",
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(() => {
  createWindow();
  startMcpBridge();
  startAutomationScheduler();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

function quoteForAppleScript(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function terminalCommandForAgent(agentId) {
  return providers.terminalCommandForAgent(agentId, "/Users/h2o/Documents/AgentMuitle");
}

function runCommandForAgent(agentId, promptFile, workspacePath) {
  const state = readState();
  return providers.runCommandForAgent(agentId, promptFile, workspacePath || state.settings.workspacePath, {
    model: state.settings.localRouterModel
  });
}

function createPrompt(project, instruction) {
  const maxMessages = Number(project.maxRecentMessages || readState().settings.maxRecentMessages || 16);
  const projection = buildContextProjection(project, instruction);
  const scope = runPreScope(project, instruction);
  const handoff = buildWorkerHandoff(project, instruction);
  return [
    "## Static execution rules",
    "이 블록은 캐시가 잘 붙도록 작업 중 변경하지 않는 정적 규칙이다.",
    "- 한국어로 답한다.",
    "- 사용자가 직접 언급하지 않은 제품명/회사명/도메인명을 추론해 추가하지 않는다.",
    "- 긴 로그와 전체 파일 덤프를 피하고 필요한 근거만 짧게 인용한다.",
    "",
    `# Project: ${project.title}`,
    "",
    `- Status: ${project.status || "대기"}`,
    `- Workspace: ${project.workspacePath || readState().settings.workspacePath}`,
    "",
    "## Context projection",
    "전체 대화 전문을 반복해서 읽지 말고 아래 투영된 상태를 우선 기준으로 판단한다.",
    JSON.stringify(projection, null, 2),
    "",
    "## Worker handoff projection",
    "다른 에이전트 결과 전문을 다시 읽지 말고 아래 인계 요약을 우선 사용한다.",
    JSON.stringify(handoff, null, 2),
    "",
    "## Recent conversation, capped",
    ...project.messages.slice(-maxMessages).map((message) => `- ${message.author}: ${compactText(message.text, 700)}`),
    "",
    "## Current tasks",
    ...(project.tasks || []).slice(-12).map((task) => `- [${task.state}] ${task.name}: ${task.detail}`),
    "",
    "## Pre-scope result",
    scope
      ? [
          `- cwd: ${scope.cwd}`,
          `- keywords: ${scope.keywords.join(", ")}`,
          `- candidate files: ${scope.files.length ? scope.files.join(", ") : "없음"}`,
          "- 이 후보는 시작점일 뿐이다. 부족하면 직접 추가 탐색해도 된다.",
          "",
          ...scope.excerpts.slice(0, 12).map((line) => `  - ${line}`)
        ].join("\n")
      : "- 사전 스코핑 결과 없음",
    "",
    "## User instruction",
    instruction || "현재 프로젝트를 검토하고 다음 작업을 제안해줘.",
    "",
    "## Token saving rules",
    "- 긴 로그/빌드 출력/테스트 출력은 실행 시점에 scripts 래퍼나 파이프로 잘라 원본이 컨텍스트에 들어오지 않게 한다.",
    "- 오류만 남기지 말고 성공 신호와 첫 번째 원인 오류를 함께 남긴다.",
    "- 파일을 찾을 때는 rg 결과와 후보 파일을 먼저 사용하되, 후보가 부족하면 추가 탐색한다.",
    "- 편집 후 확인이 필요하면 파일 전체 재읽기보다 ./scripts/agent-check.sh <파일> 또는 관련 테스트/린트를 우선 실행한다.",
    "- git diff는 전체 출력보다 변경 파일과 핵심 hunk 중심으로 요약한다.",
    "- 같은 파일·같은 목적의 연속 작업이면 컨텍스트를 유지하고, 다음 작업에 쓸 정보가 30% 미만이면 새 실행으로 분리한다.",
    "- 다른 에이전트에게 넘길 때는 전체 출력이 아니라 did/artifacts/blocked/next 형태의 인계 요약만 넘긴다.",
    "",
    "## Required output",
    "한국어로 결과, 판단 근거, 다음 작업을 간결하게 정리해줘.",
    "사용자가 직접 언급하지 않은 제품명/사업 도메인명은 추론해서 넣지 말고, '기존 코어', '보유 기술', '현재 시스템'처럼 중립적으로 표현해줘."
  ].join("\n");
}

function shouldAutoRunFromMessage(text = "") {
  return /(진행해|시작해|실행해|조사|설계|구현|테스트|개발)/.test(text);
}

function fallbackPlannedRunsFromMessage(text = "") {
  const normalized = text.replace(/\s+/g, " ").trim();
  const runs = [];

  if (/타사|경쟁|유사|시장|조사/.test(normalized)) {
    runs.push({
      agentId: "codex",
      taskName: "타사 앱 / 유사 서비스 조사",
      instruction: [
        "사용자가 요청한 주제의 타사 앱/유사 서비스 조사를 진행해줘.",
        "사용자가 요청한 맥락:",
        normalized,
        "",
        "조사 범위:",
        "- 사용자가 명시한 분야에서 필요한 기능",
        "- 타사 서비스의 핵심 화면과 기능",
        "- 사용자가 언급한 기존 코어/보유 기술을 활용했을 때 차별화 가능한 지점",
        "",
        "결과는 비개발자도 이해할 수 있게 기능 목록, 우선순위, 근거 중심으로 정리해줘."
      ].join("\n")
    });
  }

  if (/설계|구조|기획|요구사항|개발/.test(normalized)) {
    runs.push({
      agentId: "claude",
      taskName: "초기 설계",
      instruction: [
        "사용자가 요청한 제품/기능의 초기 설계를 진행해줘.",
        "사용자가 요청한 맥락:",
        normalized,
        "",
        "설계 범위:",
        "- 필요한 핵심 기능",
        "- 사용자 유형",
        "- 화면 구성 초안",
        "- 사용자가 언급한 기존 코어/보유 기술 활용 지점",
        "- 구현 단계와 테스트 항목",
        "",
        "아직 구현하지 말고, 조사 결과와 연결 가능한 설계안 중심으로 정리해줘."
      ].join("\n")
    });
  }

  if (!runs.length) {
    runs.push({
      agentId: "codex",
      taskName: "요청 분석 및 작업 계획 수립",
      instruction: normalized
    });
  }

  return runs;
}

function safeJsonParse(text = "") {
  try {
    return JSON.parse(text);
  } catch (_error) {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch (__error) {
      return null;
    }
  }
}

function routerCommandForAgent(agentId, promptFile) {
  return providers.routerCommandForAgent(agentId, promptFile) || providers.routerCommandForAgent("codex", promptFile);
}

function runRouterCli(routerAgent, prompt) {
  return new Promise((resolve, reject) => {
    const routerDir = path.join(DATA_DIR, "router");
    fs.mkdirSync(routerDir, { recursive: true });
    const promptFile = path.join(routerDir, `${uid("router")}.md`);
    fs.writeFileSync(promptFile, prompt, "utf8");
    const shellCommand = routerCommandForAgent(routerAgent, promptFile);

    execFile("/bin/zsh", ["-lc", shellCommand], { timeout: 45000 }, (error, stdout, stderr) => {
      fs.rm(promptFile, { force: true }, () => {});
      const output = `${stdout || ""}${stderr || ""}`.trim();
      if (error) {
        reject(new Error((output || error.message || "Router 실행 실패").slice(-1200)));
        return;
      }
      resolve(output);
    });
  });
}

async function callRouterAgent(project, text) {
  const routerAgent = project.routerAgent || readState().settings.routerAgent || "codex";
  const state = readState();
  const localRouterModel = project.localRouterModel || state.settings.localRouterModel || "qwen2.5-coder:7b";
  const projection = buildContextProjection(project, text);
  const prompt = [
    "너는 멀티 AI 오케스트레이터의 작업 분배 Router AI다.",
    "사용자의 자연어 요청과 프로젝트 상태 투영값만 보고 실행 가능한 작업 단위로 쪼개고, 각 작업에 가장 적합한 에이전트를 배정한다.",
    "",
    "사용 가능한 에이전트:",
    "- codex: 코드 분석/구현/테스트/웹 검색이 필요한 조사에 강함",
    "- claude: 제품 설계/문서화/요구사항 정리/UX 구조화에 강함",
    "- grok: 아이디어 확장/외부 서비스 비교/시장 조사에 강하지만 사용량 제한이 있을 수 있음",
    "",
    "분배 원칙:",
    "- 사용자가 명시한 단계가 있으면 그 순서를 유지한다.",
    "- 하나의 큰 요청은 1~4개의 작업으로 나눈다.",
    "- 구현 요청이 없으면 구현 작업은 만들지 않는다.",
    "- 조사와 설계처럼 서로 다른 성격은 분리한다.",
    "- Grok은 사용량 제한 가능성이 있으므로 필수는 아니며, 외부 조사도 Codex로 배정 가능하다.",
    "- 사용자가 직접 말하지 않은 회사명, 제품명, 도메인명, 기술명은 절대 새로 만들지 않는다.",
    "- 범위가 넓은 코드 탐색 요청은 구현 작업과 분리해 '탐색 위임' 작업을 먼저 만든다.",
    "- 탐색 위임 작업의 결과는 전체 로그가 아니라 did/artifacts/blocked/next 요약으로 인계한다.",
    "- 출력은 설명 없이 JSON만 반환한다.",
    "",
    "JSON 형식:",
    "{",
    '  "shouldRun": true,',
    '  "reason": "분배 판단 이유 한 문장",',
    '  "tasks": [',
    '    {"agentId":"codex|claude|grok","taskName":"짧은 작업명","instruction":"에이전트에게 전달할 구체적 지시"}',
    "  ]",
    "}",
    "",
    "프로젝트 상태 투영:",
    JSON.stringify(projection, null, 2)
  ].join("\n");

  const startedAt = Date.now();
  const output = routerAgent === "ollama"
    ? await callOllamaGenerate(localRouterModel, prompt)
    : await runRouterCli(routerAgent, prompt);
  const usageState = readState();
  recordUsageEvent(usageState, {
    projectId: project.id,
    agentId: routerAgent,
    usageType: "router",
    provider: routerAgent,
    model: routerAgent === "ollama" ? localRouterModel : routerAgent,
    inputTokens: estimateTokens(prompt),
    outputTokens: estimateTokens(output),
    isLocal: routerAgent === "ollama",
    note: `작업 분배 실행 · ${Date.now() - startedAt}ms`
  });
  writeState(usageState);
  return { ok: true, agent: routerAgent, raw: output, parsed: safeJsonParse(output) };
}

function normalizeRouterPlan(parsed, fallbackRuns) {
  const allowedAgents = new Set(["codex", "claude", "grok"]);
  const tasks = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
  const runs = tasks
    .map((task) => ({
      agentId: allowedAgents.has(task.agentId) ? task.agentId : "codex",
      taskName: String(task.taskName || "Router 분배 작업").trim(),
      instruction: String(task.instruction || "").trim()
    }))
    .filter((task) => task.instruction)
    .slice(0, 4);

  return runs.length ? runs : fallbackRuns;
}

function validateRouterParsed(parsed) {
  const errors = [];
  if (!parsed || typeof parsed !== "object") errors.push("JSON 객체가 아님");
  if (parsed && typeof parsed.shouldRun !== "boolean") errors.push("shouldRun boolean 누락");
  if (parsed?.shouldRun && !Array.isArray(parsed.tasks)) errors.push("tasks 배열 누락");
  if (Array.isArray(parsed?.tasks)) {
    parsed.tasks.forEach((task, index) => {
      if (!["codex", "claude", "grok"].includes(task.agentId)) errors.push(`tasks[${index}].agentId 오류`);
      if (!String(task.instruction || "").trim()) errors.push(`tasks[${index}].instruction 누락`);
    });
  }
  return { ok: errors.length === 0, errors };
}

async function repairRouterResult(project, text, badRaw, errors) {
  const state = readState();
  const localRouterModel = project.localRouterModel || state.settings.localRouterModel || "qwen2.5-coder:7b";
  const prompt = [
    "아래 Router 결과는 형식 오류가 있다. 설명 없이 올바른 JSON만 다시 작성해라.",
    "",
    "필수 형식:",
    '{"shouldRun":true,"reason":"한 문장","tasks":[{"agentId":"codex|claude|grok","taskName":"짧은 작업명","instruction":"구체적 지시"}]}',
    "",
    `오류: ${errors.join(", ")}`,
    `사용자 요청: ${text}`,
    "잘못된 출력:",
    String(badRaw || "").slice(0, 2500)
  ].join("\n");
  const output = await callOllamaGenerate(localRouterModel, prompt, 30000);
  recordUsageEvent(state, {
    projectId: project.id,
    agentId: "ollama",
    usageType: "router_retry",
    provider: "ollama",
    model: localRouterModel,
    inputTokens: estimateTokens(prompt),
    outputTokens: estimateTokens(output),
    isLocal: true,
    note: "Router 결과 검증 실패 후 로컬 재시도"
  });
  writeState(state);
  return safeJsonParse(output);
}

async function plannedRunsFromMessage(project, text = "") {
  const fallbackRuns = fallbackPlannedRunsFromMessage(text);
  try {
    const routed = await callRouterAgent(project, text);
    let parsed = routed.parsed;
    let validation = validateRouterParsed(parsed);
    if (!validation.ok) {
      parsed = await repairRouterResult(project, text, routed.raw, validation.errors);
      validation = validateRouterParsed(parsed);
    }
    if (!validation.ok) {
      throw new Error(`Router JSON 검증 실패: ${validation.errors.join(", ")}`);
    }
    if (!parsed?.shouldRun) {
      return { source: "router", agent: routed.agent, reason: parsed?.reason || "실행 작업 없음", runs: [] };
    }
    return {
      source: "router",
      agent: routed.agent,
      reason: parsed?.reason || "Router AI가 작업을 분배했습니다.",
      runs: normalizeRouterPlan(parsed, fallbackRuns)
    };
  } catch (error) {
    return {
      source: "fallback",
      agent: null,
      reason: `Router AI 사용 불가: ${error.message}. 규칙 기반으로 임시 분배했습니다.`,
      runs: fallbackRuns
    };
  }
}

function createRunRecord(state, project, agentId, instruction, taskName) {
  const runId = uid("run");
  const runDir = path.join(DATA_DIR, "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });
  const promptFile = path.join(runDir, "prompt.md");
  const logFile = path.join(runDir, "run.log");
  const prompt = createPrompt(project, instruction);
  fs.writeFileSync(promptFile, prompt, "utf8");
  fs.writeFileSync(logFile, "", "utf8");

  const shellCommand = runCommandForAgent(agentId, promptFile, project.workspacePath || state.settings.workspacePath);
  const run = {
    id: runId,
    projectId: project.id,
    agentId,
    instruction,
    promptFile,
    logFile,
    workspacePath: project.workspacePath || state.settings.workspacePath,
    state: shellCommand ? "대기" : "실패",
    createdAt: now()
  };

  state.runs.unshift(run);
  project.tasks.push({
    id: uid("task"),
    runId,
    state: shellCommand ? "진행 중" : "실패",
    name: taskName || `${agentLabelsForMain(agentId)} 실행 요청`,
    detail: instruction || "현재 프로젝트 검토",
    createdAt: now()
  });

  appendProjectMessage(state, project, {
    role: "assistant",
    author: "Orchestrator",
    text: shellCommand
      ? `${agentLabelsForMain(agentId)}에게 '${taskName || "작업"}'을 전달했습니다. 결과는 실행 로그와 대화창에 자동으로 회수됩니다.`
      : `${agentLabelsForMain(agentId)} 실행 명령을 만들지 못했습니다.`
  });

  return { run, shellCommand };
}

function createRunRecordOnly(state, project, agentId, instruction, taskName) {
  return createRunRecord(state, project, agentId, instruction, taskName);
}

function routePendingAutoRuns(state) {
  const autoRuns = [];

  state.projects.forEach((project) => {
    (project.messages || [])
      .filter((message) => message.role === "user" && !project.autoRoutedMessageIds.includes(message.id))
      .filter((message) => shouldAutoRunFromMessage(message.text || ""))
      .slice(-1)
      .forEach((message) => {
        fallbackPlannedRunsFromMessage(message.text || "").forEach((plan) => {
          const created = createRunRecord(state, project, plan.agentId, plan.instruction, plan.taskName);
          if (created.shellCommand) autoRuns.push(created.run);
        });
        project.autoRoutedMessageIds.push(message.id);
        project.status = autoRuns.length ? "에이전트 실행 중" : "작업 생성 실패";
        project.updatedAt = now();
      });
  });

  return autoRuns;
}

async function routeMessageToRuns(projectId, messageId) {
  const state = readState();
  const project = findProject(state, projectId);
  const message = project.messages.find((item) => item.id === messageId);
  if (!message || project.autoRoutedMessageIds.includes(messageId)) return;
  if (!shouldAutoRunFromMessage(message.text || "")) return;

  const autoRuns = [];
  const graph = createRoutingGraph(project, message);
  const graphResult = await graph.run("요청분석", {
    projectId: project.id,
    messageId,
    userText: message.text || ""
  });
  const routing = graphResult.routing || { source: "fallback", agent: null, reason: "작업 분배 결과 없음", runs: [] };
  recordCheckpoint(state, project.id, "작업분배", {
    messageId,
    routingSource: routing.source,
    routerAgent: routing.agent,
    plannedRunCount: routing.runs.length
  }, {
    reason: routing.reason
  });
  if (routing.runs.length) {
    appendProjectMessage(state, project, {
      role: "assistant",
      author: routing.source === "router" ? `Router AI (${agentLabelsForMain(routing.agent)})` : "Router Fallback",
      text: [
        routing.reason,
        "",
        ...routing.runs.map((run, index) => `${index + 1}. ${agentLabelsForMain(run.agentId)} → ${run.taskName}`)
      ].join("\n")
    });
  }

  routing.runs.forEach((plan) => {
    const created = createRunRecord(state, project, plan.agentId, plan.instruction, plan.taskName);
    const reason = permissionGate.approvalReason(plan.instruction);
    if (state.settings?.requireApprovalForRiskyRuns && reason) {
      addApprovalForRun(state, project, created.run, reason);
    } else if (created.shellCommand) {
      autoRuns.push(created.run);
    }
  });
  project.autoRoutedMessageIds.push(messageId);
  const pendingApproval = (project.approvals || []).some((item) => item.state === "대기");
  project.status = autoRuns.length ? "에이전트 실행 중" : pendingApproval ? "사용자 승인 대기" : "작업 생성 실패";
  project.updatedAt = now();
  rememberProjectEvent(state, project.id, "routing", routing.reason, ["router"]);
  writeState(state);
  autoRuns.forEach((run) => startAgentRun(run));
}

function readStateAndRoutePending() {
  const state = readState();
  const autoRuns = routePendingAutoRuns(state);
  if (autoRuns.length) {
    writeState(state);
    autoRuns.forEach((run) => startAgentRun(run));
    return hydrateRunOutputsForUi(readState());
  }
  return hydrateRunOutputsForUi(state);
}

function hydrateRunOutputsForUi(state) {
  (state.runs || []).forEach((run) => {
    if (!run.logFile || !fs.existsSync(run.logFile)) return;
    if (run.output && !["실행 중", "대기"].includes(run.state)) return;
    const log = fs.readFileSync(run.logFile, "utf8").trim();
    if (log) run.output = log.slice(-12000);
  });
  return state;
}

function startAgentRun(run) {
  const requestId = uid("req");
  const shellCommand = runCommandForAgent(run.agentId, run.promptFile, run.workspacePath);
  if (!shellCommand) {
    updateRun(run.id, { state: "실패", exitCode: -1, output: "알 수 없는 에이전트입니다." });
    return;
  }

  updateRun(run.id, { state: "실행 중", startedAt: now(), requestId, partial: false });
  const startState = readState();
  recordCheckpoint(startState, run.projectId, "에이전트실행시작", {
    runId: run.id,
    agentId: run.agentId,
    workspacePath: run.workspacePath
  });
  writeState(startState);
  appendRunLog(run, `[orchestrator] ${agentLabelsForMain(run.agentId)} 실행 시작: ${new Date().toLocaleString("ko-KR")}\n`);
  const child = spawn("/bin/zsh", ["-lc", shellCommand], {
    cwd: run.workspacePath || process.cwd(),
    env: {
      ...process.env,
      FORCE_COLOR: "0",
      NO_COLOR: "1"
    }
  });
  runningProcesses.set(run.id, child);
  activeRunRequests.set(run.id, requestId);
  const maxRuntimeMs = 5 * 60 * 1000;
  const timeoutTimer = setTimeout(() => {
    if (!runningProcesses.has(run.id)) return;
    appendRunLog(run, `\n[orchestrator] ${agentLabelsForMain(run.agentId)} 실행이 5분을 초과해 자동 중단되었습니다.\n`);
    child.kill("SIGTERM");
  }, maxRuntimeMs);

  const savePartial = (chunk) => {
    if (activeRunRequests.get(run.id) !== requestId) return;
    appendRunLog(run, chunk);
    const partialOutput = fs.existsSync(run.logFile) ? fs.readFileSync(run.logFile, "utf8").slice(-12000) : "";
    updateRun(run.id, {
      output: filterOutputForContext(partialOutput),
      partial: true
    });
  };
  child.stdout.on("data", (data) => savePartial(data.toString()));
  child.stderr.on("data", (data) => savePartial(data.toString()));
  child.on("error", (error) => {
    if (activeRunRequests.get(run.id) !== requestId) return;
    clearTimeout(timeoutTimer);
    appendRunLog(run, `\n[orchestrator error] ${error.message}\n`);
    updateRun(run.id, { state: "실패", error: error.message, finishedAt: now(), partial: true });
    runningProcesses.delete(run.id);
    activeRunRequests.delete(run.id);
  });
  child.on("close", (code) => {
    if (activeRunRequests.get(run.id) !== requestId) return;
    clearTimeout(timeoutTimer);
    const rawOutput = fs.existsSync(run.logFile) ? fs.readFileSync(run.logFile, "utf8").trim() : "";
    const output = readState().settings?.enableOutputFiltering ? filterOutputForContext(rawOutput) : rawOutput;
    const promptText = fs.existsSync(run.promptFile) ? fs.readFileSync(run.promptFile, "utf8") : "";
    const state = readState();
    const savedRun = state.runs.find((item) => item.id === run.id);
    const project = findProject(state, run.projectId);
    if (savedRun) {
      savedRun.state = code === 0 ? "완료" : "실패";
      savedRun.exitCode = code;
      savedRun.rawOutputBytes = Buffer.byteLength(rawOutput, "utf8");
      savedRun.output = output.slice(-20000);
      savedRun.partial = code !== 0 && Boolean(savedRun.partial);
      savedRun.finishedAt = now();
      savedRun.updatedAt = now();
    }
    recordCheckpoint(state, run.projectId, "에이전트실행완료", {
      runId: run.id,
      agentId: run.agentId,
      state: code === 0 ? "완료" : "실패",
      exitCode: code,
      outputTokens: estimateTokens(output)
    });
    const actualUsage = parseActualUsage(rawOutput);
    recordUsageEvent(state, {
      projectId: run.projectId,
      runId: run.id,
      agentId: run.agentId,
      usageType: "agent_run",
      provider: run.agentId,
      model: run.agentId,
      inputTokens: actualUsage?.inputTokens ?? estimateTokens(promptText),
      outputTokens: actualUsage?.outputTokens ?? estimateTokens(output),
      isLocal: run.agentId === "ollama",
      note: actualUsage
        ? `실제 usage 파싱: ${actualUsage.source}`
        : rawOutput.length !== output.length ? `출력 필터링 적용: ${rawOutput.length}자 → ${output.length}자` : "실행 결과 저장"
    });
    if (project) {
      appendProjectMessage(state, project, {
        role: "assistant",
        author: agentLabelsForMain(run.agentId),
        text: output ? output.slice(-6000) : `${run.agentId} 실행이 종료되었습니다. exitCode=${code}`
      });
      rememberProjectEvent(state, project.id, "agent_result", output || `${run.agentId} exitCode=${code}`, [run.agentId, "result"]);
      const hasOtherRunning = state.runs.some((item) => item.projectId === project.id && item.id !== run.id && ["실행 중", "대기"].includes(item.state));
      const hasAnyFailure = state.runs.some((item) => item.projectId === project.id && item.id !== run.id && item.state === "실패");
      project.status = hasOtherRunning ? "에이전트 실행 중" : code === 0 && !hasAnyFailure ? "에이전트 결과 도착" : "에이전트 일부 실패";
      const task = project.tasks.find((item) => item.runId === run.id);
      if (task) task.state = code === 0 ? "완료" : "실패";
      upsertEval(project, {
        state: code === 0 ? "Pass" : "Fail",
        name: `${agentLabelsForMain(run.agentId)} 실행 결과`,
        detail: code === 0 ? "에이전트 출력이 앱으로 회수됨" : `실행 실패 또는 로그인 필요(exit ${code})`
      });
    }
    writeState(state);
    runningProcesses.delete(run.id);
    activeRunRequests.delete(run.id);
  });
}

function agentLabelsForMain(agentId) {
  return providers.agentLabel(agentId);
}

function upsertEval(project, item) {
  project.evals = project.evals || { score: 0, items: [] };
  const index = project.evals.items.findIndex((old) => old.name === item.name);
  if (index >= 0) project.evals.items[index] = item;
  else project.evals.items.push(item);
  const pass = project.evals.items.filter((row) => row.state === "Pass").length;
  const fail = project.evals.items.filter((row) => row.state === "Fail").length;
  const pending = project.evals.items.filter((row) => row.state === "Pending").length;
  project.evals.score = Math.max(0, Math.min(100, 50 + pass * 12 - fail * 15 - pending * 4));
}

ipcMain.handle("open-agent-login", async (_event, agentId) => {
  const shellCommand = terminalCommandForAgent(agentId);

  if (!shellCommand) {
    return { ok: false, message: "알 수 없는 에이전트입니다." };
  }

  if (process.platform !== "darwin") {
    return { ok: false, message: "현재 로그인 터미널 열기는 macOS Terminal 기준으로 연결되어 있습니다." };
  }

  const script = `tell application "Terminal"
    activate
    do script "${quoteForAppleScript(shellCommand)}"
  end tell`;

  return new Promise((resolve) => {
    execFile("osascript", ["-e", script], (error) => {
      if (error) {
        resolve({ ok: false, message: error.message });
        return;
      }

      resolve({ ok: true, message: "로그인 터미널을 열었습니다." });
    });
  });
});

ipcMain.handle("load-state", async () => readStateAndRoutePending());

ipcMain.handle("create-project", async (_event, title) => {
  const state = readState();
  const project = {
    id: uid("project"),
    title: title?.trim() || "새 프로젝트",
    status: "대기",
    createdAt: now(),
    updatedAt: now(),
    messages: [],
    tasks: [],
    approvals: [],
    evals: { score: 0, items: [] },
    workspacePath: state.settings.workspacePath
  };
  state.projects.unshift(project);
  state.selectedProjectId = project.id;
  writeState(state);
  return state;
});

ipcMain.handle("select-project", async (_event, projectId) => {
  const state = readState();
  if (state.projects.some((project) => project.id === projectId)) {
    state.selectedProjectId = projectId;
    writeState(state);
  }
  return state;
});

ipcMain.handle("add-message", async (_event, projectId, text) => {
  const state = readState();
  const project = findProject(state, projectId);
  const cleanText = text.trim();
  const message = {
    id: uid("msg"),
    role: "user",
    author: "사용자",
    text: cleanText,
    createdAt: now()
  };
  project.messages.push(message);
  rememberProjectEvent(state, project.id, "user_message", cleanText, ["conversation"]);
  recordCheckpoint(state, project.id, "사용자요청접수", {
    messageId: message.id,
    text: compactText(cleanText, 1200),
    shouldAutoRun: shouldAutoRunFromMessage(cleanText)
  });
  project.status = "요청 작성됨";
  project.updatedAt = now();

  if (shouldAutoRunFromMessage(cleanText)) {
    project.status = "Router AI 작업 분배 중";
  }

  writeState(state);
  if (shouldAutoRunFromMessage(cleanText)) {
    setImmediate(() => {
      routeMessageToRuns(project.id, message.id).catch((error) => {
        const errorState = readState();
        const errorProject = findProject(errorState, project.id);
        appendProjectMessage(errorState, errorProject, {
          role: "assistant",
          author: "Router Error",
          text: `작업 분배 중 오류가 발생했습니다: ${error.message}`
        });
        errorProject.status = "작업 분배 실패";
        errorProject.updatedAt = now();
        writeState(errorState);
      });
    });
  }
  return { state: readState(), message, autoRuns: [], autoRunsPending: shouldAutoRunFromMessage(cleanText) };
});

ipcMain.handle("create-task", async (_event, projectId, payload) => {
  const state = readState();
  const project = findProject(state, projectId);
  project.tasks.push({
    id: uid("task"),
    state: payload?.state || "대기",
    name: payload?.name || "새 작업",
    detail: payload?.detail || "",
    createdAt: now()
  });
  project.updatedAt = now();
  writeState(state);
  return state;
});

ipcMain.handle("update-approval", async (_event, projectId, approvalId, action) => {
  const state = readState();
  const project = findProject(state, projectId);
  const approval = project.approvals.find((item) => item.id === approvalId);
  let runToStart = null;
  if (approval) {
    approval.state = action === "approve" ? "승인" : action === "reject" ? "거절" : "수정 요청";
    approval.updatedAt = now();
    if (approval.state === "승인" && approval.runId) {
      const run = state.runs.find((item) => item.id === approval.runId);
      if (run && run.state === "승인 대기") {
        run.state = "대기";
        const task = project.tasks.find((item) => item.runId === run.id);
        if (task) task.state = "진행 중";
        runToStart = run;
      }
    }
    if (["거절", "수정 요청"].includes(approval.state) && approval.runId) {
      const run = state.runs.find((item) => item.id === approval.runId);
      if (run && run.state === "승인 대기") {
        run.state = approval.state === "거절" ? "거절" : "수정 요청";
        run.finishedAt = now();
        const task = project.tasks.find((item) => item.runId === run.id);
        if (task) task.state = run.state;
      }
    }
  }
  project.messages.push({
    id: uid("msg"),
    role: "assistant",
    author: "Orchestrator",
    text: `승인 상태가 '${approval?.state || action}'로 변경되었습니다.`,
    createdAt: now()
  });
  project.status = runToStart ? "에이전트 실행 중" : project.status;
  project.updatedAt = now();
  writeState(state);
  if (runToStart) startAgentRun(runToStart);
  return readState();
});

ipcMain.handle("check-agents", async () => {
  const [codex, claude, grok, ollama] = await Promise.all([
    probeAgent("codex", "codex login status 2>&1 | tail -n 30", 10000),
    probeAgent("claude", "claude doctor 2>&1 | tail -n 30", 15000),
    probeAgent("grok", "grok models 2>&1 | tail -n 30", 15000),
    probeAgent("ollama", "ollama list 2>&1 | tail -n 30", 10000)
  ]);
  return {
    codex: { label: "Codex", ...codex },
    claude: { label: "Claude Code", ...claude },
    grok: { label: "Grok", ...grok },
    ollama: { label: "Local LLM", ...ollama }
  };
});

ipcMain.handle("run-agent-task", async (_event, projectId, agentId, instruction) => {
  const state = readState();
  const project = findProject(state, projectId);
  const { run, shellCommand } = createRunRecordOnly(state, project, agentId, instruction, `${agentLabelsForMain(agentId)} 실행 요청`);
  const reason = permissionGate.approvalReason(instruction);
  if (state.settings?.requireApprovalForRiskyRuns && reason) {
    addApprovalForRun(state, project, run, reason);
    appendProjectMessage(state, project, {
      role: "assistant",
      author: "Permission Gate",
      text: `${agentLabelsForMain(agentId)} 작업은 승인 후 실행됩니다.\n${reason}`
    });
  }
  project.updatedAt = now();
  writeState(state);

  if (!shellCommand) return { ok: false, state, run };
  if (run.state === "승인 대기") return { ok: true, state: readState(), run };
  startAgentRun(run);
  return { ok: true, state: readState(), run };
});

ipcMain.handle("open-data-folder", async () => {
  const { shell } = require("electron");
  ensureDataFile();
  await shell.openPath(DATA_DIR);
  return { ok: true, path: DATA_DIR };
});

ipcMain.handle("read-run-log", async (_event, runId) => {
  const state = readState();
  const run = state.runs.find((item) => item.id === runId);
  if (!run?.logFile || !fs.existsSync(run.logFile)) return { ok: false, log: "" };
  return { ok: true, log: fs.readFileSync(run.logFile, "utf8") };
});

ipcMain.handle("run-multi-agent-task", async (_event, projectId, agentIds, instruction) => {
  const ids = Array.isArray(agentIds) && agentIds.length ? agentIds : ["codex", "claude"];
  const created = [];
  for (const agentId of ids) {
    const state = readState();
    const project = findProject(state, projectId);
    const runId = uid("run");
    const runDir = path.join(DATA_DIR, "runs", runId);
    fs.mkdirSync(runDir, { recursive: true });
    const promptFile = path.join(runDir, "prompt.md");
    const logFile = path.join(runDir, "run.log");
    fs.writeFileSync(promptFile, createPrompt(project, instruction), "utf8");
    fs.writeFileSync(logFile, "", "utf8");
    const shellCommand = runCommandForAgent(agentId, promptFile);
    const run = {
      id: runId,
      projectId: project.id,
      agentId,
      instruction,
      promptFile,
      logFile,
      workspacePath: project.workspacePath || state.settings.workspacePath,
      state: shellCommand ? "대기" : "실패",
      createdAt: now()
    };
    state.runs.unshift(run);
    project.tasks.push({
      id: uid("task"),
      runId,
      state: shellCommand ? "진행 중" : "실패",
      name: `${agentLabelsForMain(agentId)} 병렬 실행`,
      detail: instruction || "현재 프로젝트 검토",
      createdAt: now()
    });
    appendProjectMessage(state, project, {
      role: "assistant",
      author: "Orchestrator",
      text: `${agentLabelsForMain(agentId)} 병렬 실행을 시작했습니다.`
    });
    const reason = permissionGate.approvalReason(instruction);
    if (state.settings?.requireApprovalForRiskyRuns && reason) {
      addApprovalForRun(state, project, run, reason);
      appendProjectMessage(state, project, {
        role: "assistant",
        author: "Permission Gate",
        text: `${agentLabelsForMain(agentId)} 병렬 작업은 승인 후 실행됩니다.\n${reason}`
      });
      project.status = "사용자 승인 대기";
    } else {
      project.status = "멀티 에이전트 실행 중";
    }
    writeState(state);
    if (shellCommand && run.state !== "승인 대기") startAgentRun(run);
    created.push(run);
  }
  return { ok: true, state: readState(), runs: created };
});

ipcMain.handle("stop-run", async (_event, runId) => {
  const child = runningProcesses.get(runId);
  if (child) {
    child.kill("SIGTERM");
    runningProcesses.delete(runId);
  }
  activeRunRequests.delete(runId);
  const state = readState();
  const savedRun = state.runs.find((item) => item.id === runId);
  if (savedRun?.logFile && fs.existsSync(savedRun.logFile)) {
    savedRun.output = filterOutputForContext(fs.readFileSync(savedRun.logFile, "utf8"));
  }
  if (savedRun) {
    savedRun.state = "중단";
    savedRun.partial = true;
    savedRun.finishedAt = now();
    savedRun.updatedAt = now();
    recordCheckpoint(state, savedRun.projectId, "에이전트실행중단", {
      runId,
      partial: true,
      outputTokens: estimateTokens(savedRun.output || "")
    });
  }
  writeState(state);
  const run = savedRun || null;
  return { ok: Boolean(run), state: readState(), run };
});

ipcMain.handle("save-final-draft", async (_event, projectId, sourceRunIds, title) => {
  const state = readState();
  const project = findProject(state, projectId);
  const runs = (sourceRunIds || [])
    .map((runId) => state.runs.find((run) => run.id === runId))
    .filter(Boolean);
  const body = runs
    .map((run) => {
      const output = run.output || (fs.existsSync(run.logFile) ? fs.readFileSync(run.logFile, "utf8") : "");
      return `## ${agentLabelsForMain(run.agentId)}\n\n${output.trim()}`;
    })
    .join("\n\n---\n\n");
  const draft = {
    id: uid("draft"),
    projectId: project.id,
    title: title || `최종안 ${new Date().toLocaleString("ko-KR")}`,
    sourceRunIds: runs.map((run) => run.id),
    body,
    state: "초안",
    createdAt: now()
  };
  state.finalDrafts.unshift(draft);
  appendProjectMessage(state, project, {
    role: "assistant",
    author: "Orchestrator",
    text: `선택한 ${runs.length}개 결과를 최종 초안으로 저장했습니다.`
  });
  project.status = "최종 초안 생성";
  writeState(state);
  return { ok: true, state, draft };
});

ipcMain.handle("approve-final-draft", async (_event, draftId) => {
  const state = readState();
  const draft = state.finalDrafts.find((item) => item.id === draftId);
  if (!draft) return { ok: false, state };
  draft.state = "승인";
  draft.updatedAt = now();
  const project = findProject(state, draft.projectId);
  appendProjectMessage(state, project, {
    role: "assistant",
    author: "Final",
    text: draft.body.slice(0, 8000)
  });
  project.status = "최종안 승인";
  writeState(state);
  return { ok: true, state, draft };
});

ipcMain.handle("update-project", async (_event, projectId, patch) => {
  const state = readState();
  const project = findProject(state, projectId);
  if (patch?.title !== undefined) project.title = String(patch.title).trim() || project.title;
  if (patch?.status !== undefined) project.status = String(patch.status).trim() || project.status;
  if (patch?.workspacePath !== undefined) project.workspacePath = String(patch.workspacePath).trim() || state.settings.workspacePath;
  if (patch?.routerAgent !== undefined) {
    const routerAgent = String(patch.routerAgent).trim();
    project.routerAgent = ["ollama", "codex", "claude", "grok"].includes(routerAgent) ? routerAgent : "ollama";
  }
  if (patch?.localRouterModel !== undefined) project.localRouterModel = String(patch.localRouterModel).trim() || state.settings.localRouterModel;
  project.updatedAt = now();
  writeState(state);
  return state;
});

ipcMain.handle("git-status", async (_event, projectId) => {
  const state = readState();
  const project = findProject(state, projectId);
  const cwd = project.workspacePath || state.settings.workspacePath;
  return new Promise((resolve) => {
    execFile("/bin/zsh", ["-lc", "git status --short 2>/dev/null | head -n 80"], { cwd }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        cwd,
        output: stdout.trim() || stderr.trim() || (error ? error.message : "변경 사항 없음")
      });
    });
  });
});

ipcMain.handle("search-state", async (_event, query) => {
  const state = readState();
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return { ok: true, items: [] };
  const items = [];
  for (const project of state.projects) {
    for (const message of project.messages || []) {
      if (String(message.text || "").toLowerCase().includes(needle)) {
        items.push({ type: "message", projectId: project.id, projectTitle: project.title, text: message.text, createdAt: message.createdAt });
      }
    }
    for (const task of project.tasks || []) {
      const haystack = `${task.name} ${task.detail}`.toLowerCase();
      if (haystack.includes(needle)) {
        items.push({ type: "task", projectId: project.id, projectTitle: project.title, text: `${task.name}: ${task.detail}`, createdAt: task.createdAt });
      }
    }
  }
  for (const memory of state.memories || []) {
    if (String(memory.text || "").toLowerCase().includes(needle)) {
      const project = state.projects.find((item) => item.id === memory.projectId);
      items.push({
        type: "memory",
        projectId: memory.projectId,
        projectTitle: project?.title || "전체 메모리",
        text: memory.text,
        createdAt: memory.createdAt
      });
    }
  }
  return { ok: true, items: items.slice(0, 50) };
});
