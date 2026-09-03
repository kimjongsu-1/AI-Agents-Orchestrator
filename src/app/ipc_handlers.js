const fs = require("fs");
const { execFile } = require("child_process");
const { ipcMain, shell } = require("electron");
const providers = require("../providers/provider_adapters");
const permissionGate = require("../security/permission_gate");
const { uid, now, compactText, quoteForAppleScript } = require("../core/runtime_utils");
const { recordCheckpoint, rememberProjectEvent, searchMemory } = require("../memory/memory_service");
const { findProject, appendProjectMessage, agentLabel, createProject, addApprovalForRun, searchState } = require("../projects/project_service");
const { checkAgents } = require("../providers/probe_service");

function registerIpcHandlers({ store, routerService, runService }) {
  const { readState, writeState, ensureDataFile, dataDir } = store;

  function terminalCommandForAgent(agentId) {
    return providers.terminalCommandForAgent(agentId, "/Users/h2o/Documents/AgentMuitle");
  }

  ipcMain.handle("open-agent-login", async (_event, agentId) => {
    const shellCommand = terminalCommandForAgent(agentId);
    if (!shellCommand) return { ok: false, message: "알 수 없는 에이전트입니다." };
    if (process.platform !== "darwin") return { ok: false, message: "현재 로그인 터미널 열기는 macOS Terminal 기준으로 연결되어 있습니다." };

    const script = `tell application "Terminal"
    activate
    do script "${quoteForAppleScript(shellCommand)}"
  end tell`;

    return new Promise((resolve) => {
      execFile("osascript", ["-e", script], (error) => {
        if (error) resolve({ ok: false, message: error.message });
        else resolve({ ok: true, message: "로그인 터미널을 열었습니다." });
      });
    });
  });

  ipcMain.handle("load-state", async () => runService.readStateAndRoutePending());

  ipcMain.handle("create-project", async (_event, title) => {
    const state = readState();
    createProject(state, title);
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
    const cleanText = String(text || "").trim();
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
      shouldAutoRun: routerService.shouldAutoRunFromMessage(cleanText)
    });
    project.status = routerService.shouldAutoRunFromMessage(cleanText) ? "Router AI 작업 분배 중" : "요청 작성됨";
    project.updatedAt = now();
    writeState(state);

    if (routerService.shouldAutoRunFromMessage(cleanText)) {
      setImmediate(() => {
        runService.routeMessageToRuns(project.id, message.id).catch((error) => {
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
    return { state: readState(), message, autoRuns: [], autoRunsPending: routerService.shouldAutoRunFromMessage(cleanText) };
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
    if (runToStart) runService.startAgentRun(runToStart);
    return readState();
  });

  ipcMain.handle("check-agents", async () => checkAgents());

  ipcMain.handle("run-agent-task", async (_event, projectId, agentId, instruction) => {
    const state = readState();
    const project = findProject(state, projectId);
    const { run, shellCommand } = runService.createManualRun(state, project, agentId, instruction);
    const reason = permissionGate.approvalReason(instruction);
    if (state.settings?.requireApprovalForRiskyRuns && reason) {
      addApprovalForRun(state, project, run, reason);
      appendProjectMessage(state, project, {
        role: "assistant",
        author: "Permission Gate",
        text: `${agentLabel(agentId)} 작업은 승인 후 실행됩니다.\n${reason}`
      });
    }
    project.updatedAt = now();
    writeState(state);

    if (!shellCommand) return { ok: false, state, run };
    if (run.state === "승인 대기") return { ok: true, state: readState(), run };
    runService.startAgentRun(run);
    return { ok: true, state: readState(), run };
  });

  ipcMain.handle("open-data-folder", async () => {
    ensureDataFile();
    await shell.openPath(dataDir);
    return { ok: true, path: dataDir };
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
      const { run, shellCommand } = runService.createRunRecord(state, project, agentId, instruction, `${agentLabel(agentId)} 병렬 실행`);
      const reason = permissionGate.approvalReason(instruction);
      if (state.settings?.requireApprovalForRiskyRuns && reason) {
        addApprovalForRun(state, project, run, reason);
        appendProjectMessage(state, project, {
          role: "assistant",
          author: "Permission Gate",
          text: `${agentLabel(agentId)} 병렬 작업은 승인 후 실행됩니다.\n${reason}`
        });
        project.status = "사용자 승인 대기";
      } else {
        project.status = "멀티 에이전트 실행 중";
      }
      writeState(state);
      if (shellCommand && run.state !== "승인 대기") runService.startAgentRun(run);
      created.push(run);
    }
    return { ok: true, state: readState(), runs: created };
  });

  ipcMain.handle("stop-run", async (_event, runId) => {
    const run = runService.stopRun(runId);
    return { ok: Boolean(run), state: readState(), run };
  });

  ipcMain.handle("save-final-draft", async (_event, projectId, sourceRunIds, title) => {
    const state = readState();
    const project = findProject(state, projectId);
    const runs = (sourceRunIds || []).map((runId) => state.runs.find((run) => run.id === runId)).filter(Boolean);
    const body = runs.map((run) => {
      const output = run.output || (fs.existsSync(run.logFile) ? fs.readFileSync(run.logFile, "utf8") : "");
      return `## ${agentLabel(run.agentId)}\n\n${output.trim()}`;
    }).join("\n\n---\n\n");
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
    appendProjectMessage(state, project, { role: "assistant", author: "Final", text: draft.body.slice(0, 8000) });
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
        resolve({ ok: !error, cwd, output: stdout.trim() || stderr.trim() || (error ? error.message : "변경 사항 없음") });
      });
    });
  });

  ipcMain.handle("search-state", async (_event, query) => {
    const state = readState();
    return { ok: true, items: [...searchState(state, query), ...searchMemory(state, query)] };
  });
}

module.exports = { registerIpcHandlers };
