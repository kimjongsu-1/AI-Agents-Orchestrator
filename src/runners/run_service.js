const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const providers = require("../providers/provider_adapters");
const permissionGate = require("../security/permission_gate");
const { parseActualUsage } = require("../usage/usage_parser");
const { uid, now } = require("../core/runtime_utils");
const { estimateTokens, recordUsageEvent } = require("../usage/usage_tracker");
const { recordCheckpoint, rememberProjectEvent } = require("../memory/memory_service");
const { findProject, appendProjectMessage, agentLabel, upsertEval, addApprovalForRun, hydrateRunOutputsForUi } = require("../projects/project_service");
const { filterOutputForContext } = require("../router/context_projection");
const { createPrompt } = require("./prompt_builder");

function createRunService({ readState, writeState, dataDir, routerService }) {
  const runningProcesses = new Map();
  const activeRunRequests = new Map();

  function runCommandForAgent(agentId, promptFile, workspacePath) {
    const state = readState();
    return providers.runCommandForAgent(agentId, promptFile, workspacePath || state.settings.workspacePath, {
      model: state.settings.localRouterModel
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

  function createRunRecord(state, project, agentId, instruction, taskName) {
    const runId = uid("run");
    const runDir = path.join(dataDir, "runs", runId);
    fs.mkdirSync(runDir, { recursive: true });
    const promptFile = path.join(runDir, "prompt.md");
    const logFile = path.join(runDir, "run.log");
    fs.writeFileSync(promptFile, createPrompt({ project, instruction, state, runs: state.runs || [] }), "utf8");
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
      name: taskName || `${agentLabel(agentId)} 실행 요청`,
      detail: instruction || "현재 프로젝트 검토",
      createdAt: now()
    });

    appendProjectMessage(state, project, {
      role: "assistant",
      author: "Orchestrator",
      text: shellCommand
        ? `${agentLabel(agentId)}에게 '${taskName || "작업"}'을 전달했습니다. 결과는 실행 로그와 대화창에 자동으로 회수됩니다.`
        : `${agentLabel(agentId)} 실행 명령을 만들지 못했습니다.`
    });

    return { run, shellCommand };
  }

  function routePendingAutoRuns(state) {
    // 대화형 모드에서는 모든 새 메시지가 Router 판단 대상이다.
    // 따라서 앱 로드 시 과거 미처리 메시지를 훑어 자동 실행하면 예전 대화가 갑자기 실행될 수 있다.
    // 재시작 복구는 명시적인 실행 중 run 처리로 확장하고, 여기서는 새 입력 흐름만 사용한다.
    return [];
  }

  async function routeMessageToRuns(projectId, messageId) {
    const initialState = readState();
    const initialProject = findProject(initialState, projectId);
    const message = initialProject.messages.find((item) => item.id === messageId);
    if (!message || initialProject.autoRoutedMessageIds.includes(messageId)) return;
    if (!routerService.shouldAutoRunFromMessage(message.text || "")) return;

    const graph = routerService.createRoutingGraph(initialProject, message);
    const graphResult = await graph.run("요청분석", {
      projectId: initialProject.id,
      messageId,
      userText: message.text || ""
    });

    const state = readState();
    const project = findProject(state, projectId);
    if (!project || project.autoRoutedMessageIds.includes(messageId)) return;
    const routing = graphResult.routing || { source: "fallback", agent: null, reason: "작업 분배 결과 없음", runs: [] };
    recordCheckpoint(state, project.id, "작업분배", {
      messageId,
      routingSource: routing.source,
      routerAgent: routing.agent,
      plannedRunCount: routing.runs.length
    }, { reason: routing.reason });

    if (routing.runs.length) {
      appendProjectMessage(state, project, {
        role: "assistant",
        author: routing.source === "router" ? `Router AI (${agentLabel(routing.agent)})` : "Router Fallback",
        text: [
          routing.reason,
          "",
          ...routing.runs.map((run, index) => `${index + 1}. ${agentLabel(run.agentId)} → ${run.taskName}`)
        ].join("\n")
      });
    } else {
      appendProjectMessage(state, project, {
        role: "assistant",
        author: routing.source === "router" ? `Router AI (${agentLabel(routing.agent)})` : "Router Fallback",
        text: routing.response || routing.reason || "바로 실행할 작업은 없습니다."
      });
    }

    const autoRuns = [];
    routing.runs.forEach((plan) => {
      const created = createRunRecord(state, project, plan.agentId, plan.instruction, plan.taskName);
      const reason = permissionGate.approvalReason(plan.instruction);
      if (state.settings?.requireApprovalForRiskyRuns && reason) addApprovalForRun(state, project, created.run, reason);
      else if (created.shellCommand) autoRuns.push(created.run);
    });
    project.autoRoutedMessageIds.push(messageId);
    project.status = autoRuns.length ? "에이전트 실행 중" : "Router 응답 완료";
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
      return hydrateRunOutputsForUi(readState(), fs);
    }
    return hydrateRunOutputsForUi(state, fs);
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
    appendRunLog(run, `[orchestrator] ${agentLabel(run.agentId)} 실행 시작: ${new Date().toLocaleString("ko-KR")}\n`);
    const child = spawn("/bin/zsh", ["-lc", shellCommand], {
      cwd: run.workspacePath || process.cwd(),
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" }
    });
    runningProcesses.set(run.id, child);
    activeRunRequests.set(run.id, requestId);
    const timeoutTimer = setTimeout(() => {
      if (!runningProcesses.has(run.id)) return;
      appendRunLog(run, `\n[orchestrator] ${agentLabel(run.agentId)} 실행이 5분을 초과해 자동 중단되었습니다.\n`);
      child.kill("SIGTERM");
    }, 5 * 60 * 1000);

    const savePartial = (chunk) => {
      if (activeRunRequests.get(run.id) !== requestId) return;
      appendRunLog(run, chunk);
      const partialOutput = fs.existsSync(run.logFile) ? fs.readFileSync(run.logFile, "utf8").slice(-12000) : "";
      updateRun(run.id, { output: filterOutputForContext(partialOutput), partial: true });
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
          author: agentLabel(run.agentId),
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
          name: `${agentLabel(run.agentId)} 실행 결과`,
          detail: code === 0 ? "에이전트 출력이 앱으로 회수됨" : `실행 실패 또는 로그인 필요(exit ${code})`
        });
      }
      writeState(state);
      runningProcesses.delete(run.id);
      activeRunRequests.delete(run.id);
    });
  }

  function createManualRun(state, project, agentId, instruction) {
    return createRunRecord(state, project, agentId, instruction, `${agentLabel(agentId)} 실행 요청`);
  }

  function stopRun(runId) {
    const child = runningProcesses.get(runId);
    if (child) {
      child.kill("SIGTERM");
      runningProcesses.delete(runId);
    }
    activeRunRequests.delete(runId);
    const state = readState();
    const savedRun = state.runs.find((item) => item.id === runId);
    if (savedRun?.logFile && fs.existsSync(savedRun.logFile)) savedRun.output = filterOutputForContext(fs.readFileSync(savedRun.logFile, "utf8"));
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
    return savedRun || null;
  }

  return {
    runCommandForAgent,
    createRunRecord,
    createManualRun,
    routeMessageToRuns,
    readStateAndRoutePending,
    startAgentRun,
    stopRun,
    runningProcesses,
    activeRunRequests
  };
}

module.exports = { createRunService };
