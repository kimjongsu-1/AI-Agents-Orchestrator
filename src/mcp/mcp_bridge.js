const http = require("http");

const PROTOCOL_VERSION = "2024-11-05";

function jsonHeaders(extra = {}) {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "http://127.0.0.1",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "content-type,authorization",
    ...extra
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("request_body_too_large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, jsonHeaders());
  res.end(JSON.stringify(payload));
}

function textResult(payload) {
  return {
    content: [
      {
        type: "text",
        text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2)
      }
    ]
  };
}

function toolDefinitions() {
  return [
    {
      name: "list_projects",
      description: "AI 오케스트라에 저장된 프로젝트 목록을 조회합니다.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false
      }
    },
    {
      name: "get_project",
      description: "프로젝트의 최근 메시지, 작업, 승인 대기 항목을 조회합니다.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "조회할 프로젝트 ID" },
          recentLimit: { type: "number", description: "최근 메시지 개수", default: 12 }
        },
        required: ["projectId"],
        additionalProperties: false
      }
    },
    {
      name: "search_memory",
      description: "프로젝트 대화/작업/장기 메모리에서 키워드를 검색합니다.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "검색어" },
          projectId: { type: "string", description: "특정 프로젝트로 제한할 때 사용" },
          limit: { type: "number", description: "최대 결과 수", default: 20 }
        },
        required: ["query"],
        additionalProperties: false
      }
    },
    {
      name: "list_runs",
      description: "에이전트 실행 기록을 조회합니다.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "특정 프로젝트로 제한할 때 사용" },
          state: { type: "string", description: "완료, 실패, 진행 중, 승인 대기 등 상태 필터" },
          limit: { type: "number", description: "최대 결과 수", default: 20 }
        },
        additionalProperties: false
      }
    },
    {
      name: "usage_summary",
      description: "모델별/작업별 토큰 사용량과 로컬 LLM 절감 추정치를 조회합니다.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "특정 프로젝트로 제한할 때 사용" },
          limit: { type: "number", description: "최근 사용 이벤트 수", default: 100 }
        },
        additionalProperties: false
      }
    }
  ];
}

function compactText(value = "", limit = 900) {
  const clean = String(value || "").replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit)}…`;
}

function findProject(state, projectId) {
  return (state.projects || []).find((project) => project.id === projectId);
}

function summarizeUsage(events) {
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostKrw: 0,
    cloudEquivalentCostKrw: 0,
    savedCostKrw: 0,
    byAgent: {}
  };
  for (const event of events) {
    const agent = event.agentId || event.provider || "unknown";
    totals.inputTokens += Number(event.inputTokens || 0);
    totals.outputTokens += Number(event.outputTokens || 0);
    totals.estimatedCostKrw += Number(event.estimatedCostKrw || 0);
    totals.cloudEquivalentCostKrw += Number(event.cloudEquivalentCostKrw || 0);
    totals.savedCostKrw += Number(event.savedCostKrw || 0);
    totals.byAgent[agent] = totals.byAgent[agent] || {
      inputTokens: 0,
      outputTokens: 0,
      callCount: 0,
      estimatedCostKrw: 0,
      savedCostKrw: 0
    };
    totals.byAgent[agent].inputTokens += Number(event.inputTokens || 0);
    totals.byAgent[agent].outputTokens += Number(event.outputTokens || 0);
    totals.byAgent[agent].callCount += Number(event.callCount || 1);
    totals.byAgent[agent].estimatedCostKrw += Number(event.estimatedCostKrw || 0);
    totals.byAgent[agent].savedCostKrw += Number(event.savedCostKrw || 0);
  }
  return totals;
}

function callTool(name, args, state) {
  const input = args || {};

  if (name === "list_projects") {
    return textResult({
      ok: true,
      projects: (state.projects || []).map((project) => ({
        id: project.id,
        title: project.title,
        status: project.status,
        updatedAt: project.updatedAt,
        taskCount: (project.tasks || []).length,
        messageCount: (project.messages || []).length
      }))
    });
  }

  if (name === "get_project") {
    const project = findProject(state, input.projectId);
    if (!project) return textResult({ ok: false, error: "project_not_found" });
    const recentLimit = Math.min(Math.max(Number(input.recentLimit || 12), 1), 50);
    return textResult({
      ok: true,
      project: {
        id: project.id,
        title: project.title,
        status: project.status,
        workspacePath: project.workspacePath || state.settings?.workspacePath,
        recentMessages: (project.messages || []).slice(-recentLimit).map((message) => ({
          role: message.role,
          author: message.author,
          text: compactText(message.text, 1000),
          createdAt: message.createdAt
        })),
        tasks: (project.tasks || []).map((task) => ({
          id: task.id,
          state: task.state,
          name: task.name,
          detail: compactText(task.detail, 700),
          createdAt: task.createdAt
        })),
        approvals: (project.approvals || []).filter((approval) => approval.state === "대기")
      }
    });
  }

  if (name === "search_memory") {
    const query = String(input.query || "").trim().toLowerCase();
    if (!query) return textResult({ ok: false, error: "query_required" });
    const limit = Math.min(Math.max(Number(input.limit || 20), 1), 100);
    const projectFilter = input.projectId ? String(input.projectId) : null;
    const items = [];

    for (const project of state.projects || []) {
      if (projectFilter && project.id !== projectFilter) continue;
      for (const message of project.messages || []) {
        if (String(message.text || "").toLowerCase().includes(query)) {
          items.push({
            type: "message",
            projectId: project.id,
            projectTitle: project.title,
            text: compactText(message.text, 1200),
            createdAt: message.createdAt
          });
        }
      }
      for (const task of project.tasks || []) {
        const haystack = `${task.name || ""} ${task.detail || ""}`.toLowerCase();
        if (haystack.includes(query)) {
          items.push({
            type: "task",
            projectId: project.id,
            projectTitle: project.title,
            text: compactText(`${task.name}: ${task.detail}`, 1200),
            createdAt: task.createdAt
          });
        }
      }
    }

    for (const memory of state.memories || []) {
      if (projectFilter && memory.projectId !== projectFilter) continue;
      if (String(memory.text || "").toLowerCase().includes(query)) {
        const project = findProject(state, memory.projectId);
        items.push({
          type: "memory",
          projectId: memory.projectId,
          projectTitle: project?.title || "전체 메모리",
          text: compactText(memory.text, 1200),
          tags: memory.tags || [],
          createdAt: memory.createdAt
        });
      }
    }

    return textResult({ ok: true, count: items.length, items: items.slice(0, limit) });
  }

  if (name === "list_runs") {
    const limit = Math.min(Math.max(Number(input.limit || 20), 1), 100);
    let runs = state.runs || [];
    if (input.projectId) runs = runs.filter((run) => run.projectId === input.projectId);
    if (input.state) runs = runs.filter((run) => run.state === input.state);
    return textResult({
      ok: true,
      runs: runs.slice(0, limit).map((run) => ({
        id: run.id,
        projectId: run.projectId,
        agentId: run.agentId,
        state: run.state,
        partial: Boolean(run.partial),
        instruction: compactText(run.instruction, 700),
        outputPreview: compactText(run.output, 900),
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        requestId: run.requestId || null
      }))
    });
  }

  if (name === "usage_summary") {
    const limit = Math.min(Math.max(Number(input.limit || 100), 1), 500);
    let events = state.usageEvents || [];
    if (input.projectId) events = events.filter((event) => event.projectId === input.projectId);
    events = events.slice(0, limit);
    return textResult({
      ok: true,
      summary: summarizeUsage(events),
      events: events.map((event) => ({
        id: event.id,
        projectId: event.projectId,
        runId: event.runId,
        agentId: event.agentId,
        usageType: event.usageType,
        provider: event.provider,
        model: event.model,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        estimatedCostKrw: event.estimatedCostKrw,
        savedCostKrw: event.savedCostKrw,
        isLocal: event.isLocal,
        createdAt: event.createdAt
      }))
    });
  }

  return textResult({ ok: false, error: "unknown_tool", name });
}

function success(id, result) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function failure(id, code, message, data = undefined) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id: id ?? null, error };
}

function handleRpc(payload, state) {
  const id = payload?.id ?? null;
  const method = payload?.method;
  const params = payload?.params || {};

  if (method === "initialize") {
    return success(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        tools: {
          listChanged: false
        }
      },
      serverInfo: {
        name: "AI Orchestrator MCP Bridge",
        version: String(state.version || 1)
      }
    });
  }

  if (method === "notifications/initialized") {
    return null;
  }

  if (method === "tools/list") {
    return success(id, { tools: toolDefinitions() });
  }

  if (method === "tools/call") {
    const name = params.name;
    const args = params.arguments || {};
    if (!name) return failure(id, -32602, "tool name is required");
    return success(id, callTool(name, args, state));
  }

  if (method === "ping") {
    return success(id, {});
  }

  return failure(id, -32601, `Method not found: ${method}`);
}

function startMcpBridge(options) {
  const {
    readState,
    writeState,
    uid,
    onError = () => {}
  } = options;
  let state = readState();
  if (!state.mcpBridge?.enabled) return null;

  const secretPath = state.mcpBridge.secretPath || `/mcp-${uid("secret")}`;
  state.mcpBridge.secretPath = secretPath;
  writeState(state);

  const server = http.createServer(async (req, res) => {
    const current = readState();
    const port = current.mcpBridge?.port || 8765;
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204, jsonHeaders());
      res.end();
      return;
    }

    if (!url.pathname.startsWith(secretPath)) {
      sendJson(res, 404, { ok: false, error: "not_found" });
      return;
    }

    const route = url.pathname.slice(secretPath.length) || "/";

    if (req.method === "GET") {
      if (route === "/" || route === "/health") {
        sendJson(res, 200, {
          ok: true,
          name: "AI Orchestrator MCP Bridge",
          protocolVersion: PROTOCOL_VERSION,
          jsonRpcEndpoint: secretPath,
          toolsEndpoint: `${secretPath}/tools`
        });
        return;
      }
      if (route === "/tools") {
        sendJson(res, 200, { ok: true, tools: toolDefinitions() });
        return;
      }
      if (route === "/projects") {
        sendJson(res, 200, JSON.parse(callTool("list_projects", {}, current).content[0].text));
        return;
      }
      if (route === "/usage") {
        sendJson(res, 200, JSON.parse(callTool("usage_summary", { limit: 100 }, current).content[0].text));
        return;
      }
      sendJson(res, 404, { ok: false, error: "unknown_route" });
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: "method_not_allowed" });
      return;
    }

    try {
      const raw = await readBody(req);
      const parsed = JSON.parse(raw || "{}");
      const requests = Array.isArray(parsed) ? parsed : [parsed];
      const responses = requests
        .map((request) => handleRpc(request, current))
        .filter(Boolean);
      if (!responses.length) {
        res.writeHead(204, jsonHeaders());
        res.end();
        return;
      }
      sendJson(res, 200, Array.isArray(parsed) ? responses : responses[0]);
    } catch (error) {
      sendJson(res, 400, failure(null, -32700, "Parse error", String(error?.message || error)));
    }
  });

  server.on("error", (error) => onError(error));
  server.listen(state.mcpBridge.port, "127.0.0.1");
  return server;
}

module.exports = {
  startMcpBridge,
  toolDefinitions,
  handleRpc
};
