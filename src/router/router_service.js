const fs = require("fs");
const http = require("http");
const path = require("path");
const { execFile } = require("child_process");
const providers = require("../providers/provider_adapters");
const { ConsoleGraphRuntime } = require("../engine/langgraph_runtime");
const { uid, compactText, safeJsonParse } = require("../core/runtime_utils");
const { estimateTokens, recordUsageEvent } = require("../usage/usage_tracker");
const { recordCheckpoint } = require("../memory/memory_service");
const { buildContextProjection } = require("./context_projection");

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

    request.on("timeout", () => request.destroy(new Error("Ollama Router 응답 시간 초과")));
    request.on("error", reject);
    request.write(payload);
    request.end();
  });
}

function createRouterService({ readState, writeState, dataDir, agentLabel }) {
  function routerCommandForAgent(agentId, promptFile) {
    return providers.routerCommandForAgent(agentId, promptFile) || providers.routerCommandForAgent("codex", promptFile);
  }

  function runRouterCli(routerAgent, prompt) {
    return new Promise((resolve, reject) => {
      const routerDir = path.join(dataDir, "router");
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
      "- 범위가 넓은 코드 탐색 요청은 구현 작업과 분리해 '탐색 위임' 작업을 먼저 만든다.",
      "- 사용자가 직접 말하지 않은 회사명, 제품명, 도메인명, 기술명은 절대 새로 만들지 않는다.",
      "- 출력은 설명 없이 JSON만 반환한다.",
      "",
      "JSON 형식:",
      '{"shouldRun":true,"reason":"분배 판단 이유 한 문장","tasks":[{"agentId":"codex|claude|grok","taskName":"짧은 작업명","instruction":"에이전트에게 전달할 구체적 지시"}]}',
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
      if (!validation.ok) throw new Error(`Router JSON 검증 실패: ${validation.errors.join(", ")}`);
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
      .addNode("작업분배", async () => {
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

  return {
    shouldAutoRunFromMessage,
    fallbackPlannedRunsFromMessage,
    plannedRunsFromMessage,
    createRoutingGraph,
    compactText,
    agentLabel
  };
}

module.exports = {
  createRouterService,
  shouldAutoRunFromMessage,
  fallbackPlannedRunsFromMessage,
  callOllamaGenerate
};
