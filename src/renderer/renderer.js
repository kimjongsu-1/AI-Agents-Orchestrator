import { agentLabels } from "./modules/agent_labels.js";
import { escapeHtml, renderRichText, formatTime, formatKrw, sumUsage } from "./modules/formatters.js";
import { renderProjectList } from "./components/project_list.js";

let appState = null;
let selectedProjectId = null;
let currentView = "conversation";
let agentStatuses = {};
const pendingAgentLogins = new Set();
const agentLoginPollTimers = new Map();
let pendingRouteRefreshTimer = null;

const els = {
  projectList: document.querySelector("#project-list"),
  newProject: document.querySelector("#new-project"),
  refreshAgents: document.querySelector("#refresh-agents"),
  title: document.querySelector("#project-title"),
  status: document.querySelector("#project-status"),
  conversationView: document.querySelector("#conversation-view"),
  tasksView: document.querySelector("#tasks-view"),
  evalsView: document.querySelector("#evals-view"),
  runsView: document.querySelector("#runs-view"),
  usageView: document.querySelector("#usage-view"),
  compareView: document.querySelector("#compare-view"),
  settingsView: document.querySelector("#settings-view"),
  tabs: document.querySelectorAll(".tab"),
  controlWindow: document.querySelector("#control-window"),
  composer: document.querySelector(".composer"),
  themeToggle: document.querySelector("#theme-toggle"),
  agentSelect: document.querySelector("#agent-select"),
  agentInstruction: document.querySelector("#agent-instruction"),
  runAgent: document.querySelector("#run-agent"),
  runMultiAgent: document.querySelector("#run-multi-agent"),
  openDataFolder: document.querySelector("#open-data-folder"),
  controlCurrentTask: document.querySelector("#control-current-task"),
  controlApprovals: document.querySelector("#control-approvals"),
  controlEvals: document.querySelector("#control-evals"),
  controlAgents: document.querySelector("#control-agents"),
  newProjectModal: document.querySelector("#new-project-modal"),
  newProjectForm: document.querySelector("#new-project-form"),
  newProjectTitleInput: document.querySelector("#new-project-title-input"),
  closeNewProjectModal: document.querySelector("#close-new-project-modal"),
  cancelNewProject: document.querySelector("#cancel-new-project")
};

if (!window.orchestrator) {
  els.status.textContent = "Electron 앱에서 실행 필요";
  els.title.textContent = "AI 오케스트레이터";
  els.projectList.innerHTML = `
    <button class="project active" type="button">
      <span>브라우저 미리보기</span>
      <small>실제 기능은 Electron 앱에서 동작</small>
    </button>
  `;
  els.conversationView.innerHTML = `
    <article class="empty-state new-conversation-guide">
      <b>현재 화면은 브라우저에서 파일을 직접 연 미리보기입니다.</b>
      <p>새 대화 생성, 저장, 에이전트 로그인/실행은 Electron 앱의 백엔드 연결이 필요합니다. 실행 중인 “AI 오케스트레이터” 앱 창에서 사용해 주세요.</p>
    </article>
  `;
  els.newProject?.addEventListener("click", () => {
    window.alert("이 버튼은 Electron 앱 창에서 동작합니다. 현재는 file:// 브라우저 미리보기입니다.");
  });
  document.querySelectorAll("button:not(#new-project), input, textarea, select").forEach((element) => {
    element.disabled = true;
  });
  throw new Error("AI 오케스트레이터는 Electron 앱에서 실행해야 합니다.");
}

function getSelectedProject() {
  if (!appState?.projects?.length) return null;
  return appState.projects.find((project) => project.id === selectedProjectId) || appState.projects[0];
}

function renderProjects() {
  els.projectList.innerHTML = renderProjectList(appState.projects || [], selectedProjectId);
}

function renderConversation(project) {
  const messages = project.messages || [];
  const approvals = (project.approvals || []).filter((approval) => approval.state === "대기");
  const emptyGuide =
    messages.length || approvals.length
      ? ""
      : `
        <article class="empty-state new-conversation-guide">
          <b>새 대화가 생성되었습니다.</b>
          <p>아래 입력창에 요청을 적거나, 하단에서 Codex · Claude · Grok 중 하나를 선택해 실행할 수 있습니다.</p>
        </article>
      `;
  els.conversationView.innerHTML = [
    emptyGuide,
    ...messages.map((message) => {
      const klass = message.role === "user" ? "user" : "assistant";
      return `
        <article class="bubble ${klass}">
          <b>${escapeHtml(message.author || message.role)} <small>${formatTime(message.createdAt)}</small></b>
          <div class="rich-text">${renderRichText(message.text)}</div>
        </article>
      `;
    }),
    ...approvals.map((approval) => `
      <article class="approval-card" data-approval-id="${escapeHtml(approval.id)}">
        <div>
          <b>${escapeHtml(approval.title)}</b>
          <p>${escapeHtml(approval.detail)}</p>
        </div>
        <div class="approval-actions">
          <button data-approval-action="approve">승인</button>
          <button data-approval-action="revise">수정 요청</button>
          <button data-approval-action="reject">거절</button>
        </div>
      </article>
    `)
  ].join("");
  els.conversationView.scrollTop = els.conversationView.scrollHeight;
}

function renderTasks(project) {
  const tasks = project.tasks || [];
  els.tasksView.innerHTML = tasks.length
    ? tasks
        .map((task) => `
          <article class="task ${task.state === "진행 중" ? "active" : ""}">
            <span>${escapeHtml(task.state)}</span>
            <b>${escapeHtml(task.name)}</b>
            <p>${escapeHtml(task.detail)} <small>${formatTime(task.createdAt)}</small></p>
          </article>
        `)
        .join("")
    : `<article class="empty-state">아직 작업이 없습니다. 메시지를 입력하거나 에이전트 실행을 눌러 작업을 만드세요.</article>`;
}

function renderEvals(project) {
  const items = project.evals?.items || [];
  const pass = items.filter((item) => item.state === "Pass").length;
  const fail = items.filter((item) => item.state === "Fail").length;
  const pending = items.filter((item) => item.state === "Pending").length;
  els.evalsView.innerHTML = `
    <article class="eval-summary">
      <div><span>현재 점수</span><strong>${project.evals?.score ?? 0}</strong></div>
      <div><span>통과</span><strong>${pass}</strong></div>
      <div><span>실패</span><strong>${fail}</strong></div>
      <div><span>대기</span><strong>${pending}</strong></div>
    </article>
    ${
      items.length
        ? items
            .map((item) => `
              <article class="eval-item ${escapeHtml(String(item.state).toLowerCase())}">
                <span>${escapeHtml(item.state)}</span>
                <b>${escapeHtml(item.name)}</b>
                <p>${escapeHtml(item.detail)}</p>
              </article>
            `)
            .join("")
        : `<article class="empty-state">아직 평가 항목이 없습니다.</article>`
    }
  `;
}

function renderRuns(project) {
  const runs = (appState.runs || []).filter((run) => run.projectId === project.id);
  const running = runs.filter((run) => run.state === "실행 중" || run.state === "대기").length;
  const approval = runs.filter((run) => run.state === "승인 대기").length;
  const failed = runs.filter((run) => run.state === "실패").length;
  const done = runs.filter((run) => run.state === "완료").length;
  els.runsView.innerHTML = runs.length
    ? `
        <section class="run-status-summary">
          <div><span>진행 중</span><strong>${running}</strong></div>
          <div><span>승인 대기</span><strong>${approval}</strong></div>
          <div><span>완료</span><strong>${done}</strong></div>
          <div><span>실패</span><strong>${failed}</strong></div>
        </section>
        ${runs
          .map((run) => `
          <article class="run-card" data-run-id="${escapeHtml(run.id)}">
            <div>
              <b>${escapeHtml(agentLabels[run.agentId] || run.agentId)}</b>
              <span>${escapeHtml(run.state)}${run.partial ? " · partial" : ""} · ${formatTime(run.createdAt)}</span>
            </div>
            <p>${escapeHtml(run.instruction || "현재 프로젝트 검토")}</p>
            <small>${escapeHtml(run.promptFile || "")}</small>
            <details>
              <summary>${run.state === "실행 중" || run.state === "대기" ? "실시간 로그 보기" : "결과 로그 보기"}</summary>
              <div class="rich-text run-output">${renderRichText(run.output || "아직 결과가 회수되지 않았습니다.")}</div>
            </details>
            <menu>
              ${run.state === "실행 중" ? `<button data-stop-run="${escapeHtml(run.id)}">중단</button>` : ""}
              <button data-select-final="${escapeHtml(run.id)}">최종안 후보 선택</button>
            </menu>
          </article>
        `)
          .join("")}
      `
    : `<article class="empty-state">아직 실행 로그가 없습니다.</article>`;
}

function renderUsage(project) {
  const events = (appState.usageEvents || []).filter((event) => event.projectId === project.id);
  const routerEvents = events.filter((event) => event.usageType === "router");
  const localEvents = events.filter((event) => event.isLocal);
  const externalEvents = events.filter((event) => !event.isLocal);
  const byProvider = {};
  events.forEach((event) => {
    const key = event.provider || event.agentId || "unknown";
    byProvider[key] = byProvider[key] || {
      provider: key,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      actualCostKrw: 0,
      savedCostKrw: 0
    };
    byProvider[key].calls += Number(event.callCount || 1);
    byProvider[key].inputTokens += Number(event.inputTokens || 0);
    byProvider[key].outputTokens += Number(event.outputTokens || 0);
    byProvider[key].actualCostKrw += Number(event.actualCostKrw || 0);
    byProvider[key].savedCostKrw += Number(event.savedCostKrw || 0);
  });

  els.usageView.innerHTML = `
    <section class="usage-summary-grid">
      <article>
        <span>외부 AI 예상 비용</span>
        <strong>${formatKrw(sumUsage(externalEvents, "actualCostKrw"))}</strong>
        <small>CLI가 실제 usage를 주지 않는 경우 추정값</small>
      </article>
      <article>
        <span>Local LLM 대체 처리량</span>
        <strong>${formatKrw(sumUsage(localEvents, "cloudEquivalentCostKrw"))}</strong>
        <small>외부 Router로 보냈을 때의 기준 비용</small>
      </article>
      <article>
        <span>절감 추정액</span>
        <strong>${formatKrw(sumUsage(events, "savedCostKrw"))}</strong>
        <small>Ollama/규칙 처리로 과금되지 않은 금액</small>
      </article>
      <article>
        <span>Router 호출</span>
        <strong>${routerEvents.length.toLocaleString("ko-KR")}회</strong>
        <small>작업 분배 전용 사용량</small>
      </article>
    </section>
    <section class="usage-card">
      <h2>모델별 사용량</h2>
      <div class="rich-table-wrap">
        <table>
          <thead>
            <tr>
              <th>모델/Provider</th>
              <th>호출</th>
              <th>입력 토큰</th>
              <th>출력 토큰</th>
              <th>실제/추정 비용</th>
              <th>절감 추정</th>
            </tr>
          </thead>
          <tbody>
            ${
              Object.values(byProvider).length
                ? Object.values(byProvider)
                    .map((row) => `
                      <tr>
                        <td>${escapeHtml(agentLabels[row.provider] || row.provider)}</td>
                        <td>${row.calls.toLocaleString("ko-KR")}</td>
                        <td>${Math.round(row.inputTokens).toLocaleString("ko-KR")}</td>
                        <td>${Math.round(row.outputTokens).toLocaleString("ko-KR")}</td>
                        <td>${formatKrw(row.actualCostKrw)}</td>
                        <td>${formatKrw(row.savedCostKrw)}</td>
                      </tr>
                    `)
                    .join("")
                : `<tr><td colspan="6">아직 사용량 기록이 없습니다.</td></tr>`
            }
          </tbody>
        </table>
      </div>
    </section>
    <section class="usage-card">
      <h2>작업 분배 사용량</h2>
      ${
        routerEvents.length
          ? routerEvents
              .slice(0, 12)
              .map((event) => `
                <article class="usage-event">
                  <b>${escapeHtml(agentLabels[event.provider] || event.provider)} · ${escapeHtml(event.model || "")}</b>
                  <span>${formatTime(event.createdAt)}</span>
                  <p>입력 ${Number(event.inputTokens || 0).toLocaleString("ko-KR")} / 출력 ${Number(event.outputTokens || 0).toLocaleString("ko-KR")} tokens · 절감 ${formatKrw(event.savedCostKrw)}</p>
                  <small>${escapeHtml(event.note || "")}</small>
                </article>
              `)
              .join("")
          : `<article class="empty-state">아직 Router 사용량이 없습니다.</article>`
      }
    </section>
  `;
}

function renderCompare(project) {
  const runs = (appState.runs || []).filter((run) => run.projectId === project.id && ["완료", "실패"].includes(run.state));
  const drafts = (appState.finalDrafts || []).filter((draft) => draft.projectId === project.id);
  els.compareView.innerHTML = `
    <section class="compare-toolbar">
      <button data-save-selected-final>선택 결과로 최종 초안 생성</button>
      <button data-refresh-state>새로고침</button>
    </section>
    <section class="compare-grid">
      ${
        runs.length
          ? runs
              .map((run) => `
                <article class="compare-card">
                  <label>
                    <input type="checkbox" data-final-run-check value="${escapeHtml(run.id)}" />
                    <strong>${escapeHtml(agentLabels[run.agentId] || run.agentId)}</strong>
                  </label>
                  <span>${escapeHtml(run.state)} · ${formatTime(run.finishedAt || run.updatedAt || run.createdAt)}</span>
                  <p>${escapeHtml(run.instruction || "현재 프로젝트 검토")}</p>
                  <pre>${escapeHtml((run.output || "").slice(-5000) || "결과 없음")}</pre>
                </article>
              `)
              .join("")
          : `<article class="empty-state">비교할 실행 결과가 없습니다. 먼저 에이전트를 실행하세요.</article>`
      }
    </section>
    <h2 class="section-title">최종 초안</h2>
    <section class="draft-list">
      ${
        drafts.length
          ? drafts
              .map((draft) => `
                <article class="draft-card">
                  <div>
                    <strong>${escapeHtml(draft.title)}</strong>
                    <span>${escapeHtml(draft.state)} · ${formatTime(draft.createdAt)}</span>
                  </div>
                  <pre>${escapeHtml(draft.body || "")}</pre>
                  ${draft.state !== "승인" ? `<button data-approve-draft="${escapeHtml(draft.id)}">최종 승인</button>` : ""}
                </article>
              `)
              .join("")
          : `<article class="empty-state">아직 저장된 최종 초안이 없습니다.</article>`
      }
    </section>
  `;
}

function renderSettings(project) {
  const routerAgent = project.routerAgent || appState.settings?.routerAgent || "codex";
  const localRouterModel = project.localRouterModel || appState.settings?.localRouterModel || "qwen2.5-coder:7b";
  const mcp = appState.mcpBridge || {};
  els.settingsView.innerHTML = `
    <section class="settings-card">
      <h2>프로젝트 설정</h2>
      <label>프로젝트명<input id="settings-title" value="${escapeHtml(project.title)}" /></label>
      <label>상태<input id="settings-status" value="${escapeHtml(project.status || "")}" /></label>
      <label>작업 폴더<input id="settings-workspace" value="${escapeHtml(project.workspacePath || appState.settings?.workspacePath || "")}" /></label>
      <label>작업 분배 AI
        <select id="settings-router-agent">
          <option value="ollama" ${routerAgent === "ollama" ? "selected" : ""}>Local LLM / Ollama</option>
          <option value="codex" ${routerAgent === "codex" ? "selected" : ""}>Codex</option>
          <option value="claude" ${routerAgent === "claude" ? "selected" : ""}>Claude</option>
          <option value="grok" ${routerAgent === "grok" ? "selected" : ""}>Grok</option>
        </select>
      </label>
      <label>Ollama Router 모델<input id="settings-local-router-model" value="${escapeHtml(localRouterModel)}" placeholder="예: qwen2.5-coder:7b" /></label>
      <p class="settings-hint">Router/요약/분류는 로컬 LLM으로 처리해 외부 API 토큰 비용을 줄입니다. 실제 Codex/Claude 작업 사용량은 별도로 추적합니다.</p>
      <div class="settings-info-box">
        <b>LangGraph / MCP / 자동화</b>
        <p>작업 흐름은 LangGraph식 체크포인트로 저장됩니다. MCP Bridge: 127.0.0.1:${escapeHtml(mcp.port || "8765")}${escapeHtml(mcp.secretPath || "/mcp-*")}</p>
        <p>매일 오전 ${escapeHtml(appState.settings?.dailyRoutineHour || 9)}시에 미완료 작업 요약 루틴이 실행됩니다.</p>
      </div>
      <div class="settings-actions">
        <button data-save-project-settings>설정 저장</button>
        <button data-check-git-status>Git 상태 확인</button>
      </div>
      <pre id="git-status-output">Git 상태를 확인하려면 버튼을 누르세요.</pre>
    </section>
    <section class="settings-card">
      <h2>검색</h2>
      <div class="search-row">
        <input id="state-search-query" placeholder="프로젝트/대화/작업 검색" />
        <button data-search-state>검색</button>
      </div>
      <div id="state-search-results" class="search-results"></div>
    </section>
  `;
}

function renderControl(project) {
  const activeTask = (project.tasks || []).find((task) => task.state === "진행 중") || (project.tasks || [])[0];
  els.controlCurrentTask.innerHTML = activeTask
    ? `
      <div><dt>상태</dt><dd>${escapeHtml(activeTask.state)}</dd></div>
      <div><dt>작업</dt><dd>${escapeHtml(activeTask.name)}</dd></div>
      <div><dt>다음</dt><dd>${escapeHtml(activeTask.detail)}</dd></div>
    `
    : `<div><dt>상태</dt><dd>대기</dd></div>`;

  const approvals = project.approvals || [];
  els.controlApprovals.innerHTML = approvals.length
    ? approvals
        .map((approval) => `
          <div class="approval-row" data-approval-id="${escapeHtml(approval.id)}">
            <div>
              <b>${escapeHtml(approval.title)}</b>
              <span>${escapeHtml(approval.state)} · ${escapeHtml(approval.detail)}</span>
            </div>
            ${approval.state === "대기" ? `<button data-approval-action="approve">승인</button>` : ""}
          </div>
        `)
        .join("")
    : `<p class="muted">승인 대기 항목이 없습니다.</p>`;

  const items = project.evals?.items || [];
  els.controlEvals.innerHTML = `
    <div><dt>점수</dt><dd>${project.evals?.score ?? 0}</dd></div>
    <div><dt>실패</dt><dd>${items.filter((item) => item.state === "Fail").length}</dd></div>
    <div><dt>대기</dt><dd>${items.filter((item) => item.state === "Pending").length}</dd></div>
  `;

  els.controlAgents.innerHTML = Object.entries(agentLabels)
    .map(([id, label]) => {
      const status = agentStatuses[id];
      const ready = status?.ready;
      return `<p class="agent ${ready ? "ready" : "warning"}">${label} <span>${ready ? status.version || "Ready" : status?.message || "Auth/설치 확인 필요"}</span></p>`;
    })
    .join("");
}

function renderAgentButtons() {
  document.querySelectorAll("[data-agent-login]").forEach((button) => {
    const agentId = button.dataset.agentLogin;
    const status = agentStatuses[agentId];
    const connecting = pendingAgentLogins.has(agentId);
    const dot = button.querySelector(".login-dot");
    const small = button.querySelector("small");
    const delayed = status?.status === "timeout" || connecting;
    dot.classList.toggle("green", Boolean(status?.ready));
    dot.classList.toggle("yellow", delayed && !status?.ready);
    dot.classList.toggle("red", !status?.ready && !delayed);
    dot.classList.toggle("pulse", connecting);
    button.disabled = connecting;
    button.title = status?.ready ? "연결됨 · 클릭하면 상태를 다시 확인합니다." : "미연결 · 클릭하면 로그인/연결 창을 엽니다.";
    small.textContent = status?.ready ? "실행 가능" : connecting ? "로그인 확인 중..." : status?.message || "확인 필요";
  });
}

function render() {
  const project = getSelectedProject();
  if (!project) return;

  selectedProjectId = project.id;
  els.title.textContent = project.title;
  els.status.textContent = project.status || "대기";

  renderProjects();
  renderConversation(project);
  renderTasks(project);
  renderEvals(project);
  renderRuns(project);
  renderUsage(project);
  renderCompare(project);
  renderSettings(project);
  renderControl(project);
  renderAgentButtons();

  [els.conversationView, els.tasksView, els.evalsView, els.runsView, els.usageView, els.compareView, els.settingsView].forEach((view) => view.classList.add("hidden"));
  document.querySelector(`#${currentView}-view`)?.classList.remove("hidden");
}

async function refreshState() {
  appState = await window.orchestrator.loadState();
  selectedProjectId = appState.selectedProjectId;
  render();
}

async function refreshAgents() {
  if (els.refreshAgents) els.refreshAgents.classList.add("spinning");
  try {
    agentStatuses = await window.orchestrator.checkAgents();
  } finally {
    if (els.refreshAgents) els.refreshAgents.classList.remove("spinning");
    render();
  }
}

async function refreshAgentAfterLogin(agentId, maxAttempts = 24) {
  const oldTimer = agentLoginPollTimers.get(agentId);
  if (oldTimer) clearTimeout(oldTimer);

  let attempts = 0;
  const poll = async () => {
    attempts += 1;
    await refreshAgents();

    if (agentStatuses[agentId]?.ready) {
      pendingAgentLogins.delete(agentId);
      agentLoginPollTimers.delete(agentId);
      render();
      return;
    }

    if (attempts >= maxAttempts) {
      pendingAgentLogins.delete(agentId);
      agentLoginPollTimers.delete(agentId);
      render();
      return;
    }

    const timer = setTimeout(poll, 5000);
    agentLoginPollTimers.set(agentId, timer);
  };

  const timer = setTimeout(poll, 3000);
  agentLoginPollTimers.set(agentId, timer);
}

function watchRoutingProgress(maxAttempts = 30) {
  if (pendingRouteRefreshTimer) clearInterval(pendingRouteRefreshTimer);
  let attempts = 0;
  pendingRouteRefreshTimer = setInterval(async () => {
    attempts += 1;
    await refreshState();
    const project = getSelectedProject();
    const isRouting = project?.status === "Router AI 작업 분배 중";
    const hasRunning = (appState.runs || []).some((run) => run.projectId === project?.id && ["실행 중", "대기"].includes(run.state));
    if (!isRouting && !hasRunning || attempts >= maxAttempts) {
      clearInterval(pendingRouteRefreshTimer);
      pendingRouteRefreshTimer = null;
    }
  }, 2000);
}

function defaultNewProjectTitle() {
  return `새 대화 ${new Date().toLocaleString("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  })}`;
}

function openNewProjectModal() {
  els.newProjectTitleInput.value = defaultNewProjectTitle();
  els.newProjectModal.classList.remove("hidden");
  requestAnimationFrame(() => {
    els.newProjectTitleInput.focus();
    els.newProjectTitleInput.select();
  });
}

function closeNewProjectModal() {
  els.newProjectModal.classList.add("hidden");
}

async function createProjectFromModal() {
  const title = els.newProjectTitleInput.value.trim() || defaultNewProjectTitle();
  appState = await window.orchestrator.createProject(title);
  selectedProjectId = appState.selectedProjectId;
  currentView = "conversation";
  els.tabs.forEach((item) => item.classList.toggle("active", item.dataset.view === currentView));
  closeNewProjectModal();
  render();
  els.composer.querySelector("textarea")?.focus();
}

els.projectList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-project-id]");
  if (!button) return;
  appState = await window.orchestrator.selectProject(button.dataset.projectId);
  selectedProjectId = appState.selectedProjectId;
  render();
});

els.newProject.addEventListener("click", async () => {
  openNewProjectModal();
});

els.closeNewProjectModal?.addEventListener("click", closeNewProjectModal);
els.cancelNewProject?.addEventListener("click", closeNewProjectModal);
els.newProjectModal?.addEventListener("click", (event) => {
  if (event.target === els.newProjectModal) closeNewProjectModal();
});
els.newProjectForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  await createProjectFromModal();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !els.newProjectModal.classList.contains("hidden")) {
    closeNewProjectModal();
  }
});

els.tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    els.tabs.forEach((item) => item.classList.remove("active"));
    tab.classList.add("active");
    currentView = tab.dataset.view;
    render();
  });
});

document.querySelector("#open-control").addEventListener("click", () => {
  els.controlWindow.classList.remove("hidden");
});

document.querySelector("#close-control").addEventListener("click", () => {
  els.controlWindow.classList.add("hidden");
});

els.themeToggle.addEventListener("click", () => {
  const isDark = document.body.classList.toggle("dark");
  els.themeToggle.setAttribute("aria-pressed", String(isDark));
  els.themeToggle.querySelector("span").textContent = isDark ? "Light" : "Dark";
});

els.composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const textarea = els.composer.querySelector("textarea");
  const submitButton = els.composer.querySelector("button[type='submit']");
  const value = textarea.value.trim();
  if (!value) return;
  const project = getSelectedProject();
  textarea.disabled = true;
  if (submitButton) submitButton.disabled = true;
  els.status.textContent = "Router AI가 작업 분배 중...";
  try {
    const result = await window.orchestrator.addMessage(project.id, value);
    appState = result.state;
    textarea.value = "";
    if (result.autoRunsPending || result.autoRuns?.length) {
      currentView = "runs";
      els.tabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.view === "runs"));
      watchRoutingProgress();
    }
  } finally {
    textarea.disabled = false;
    if (submitButton) submitButton.disabled = false;
    textarea.focus();
    render();
  }
});

document.querySelectorAll("[data-agent-login]").forEach((button) => {
  button.addEventListener("click", async () => {
    const agentId = button.dataset.agentLogin;
    const label = agentLabels[agentId] || agentId;

    await refreshAgents();

    if (agentStatuses[agentId]?.ready) {
      const project = getSelectedProject();
      await window.orchestrator.addMessage(project.id, `${label} 연결 상태: 이미 연결됨`);
      await refreshState();
      return;
    }

    pendingAgentLogins.add(agentId);
    render();

    const result = await window.orchestrator.openAgentLogin(agentId);
    const project = getSelectedProject();
    await window.orchestrator.addMessage(project.id, `${label} 로그인 연결: ${result.ok ? "로그인 창 열림 · 완료 후 자동 확인 중" : result.message}`);
    await refreshState();

    if (result.ok) {
      refreshAgentAfterLogin(agentId);
    } else {
      pendingAgentLogins.delete(agentId);
      render();
    }
  });
});

els.refreshAgents?.addEventListener("click", async () => {
  await refreshAgents();
});

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-approval-action]");
  if (!button) return;
  const approvalCard = button.closest("[data-approval-id]");
  if (!approvalCard) return;
  const project = getSelectedProject();
  appState = await window.orchestrator.updateApproval(project.id, approvalCard.dataset.approvalId, button.dataset.approvalAction);
  render();
});

els.runAgent.addEventListener("click", async () => {
  const project = getSelectedProject();
  const agentId = els.agentSelect.value;
  const instruction = els.agentInstruction.value.trim();
  const result = await window.orchestrator.runAgentTask(project.id, agentId, instruction);
  appState = result.state;
  els.agentInstruction.value = "";
  currentView = "runs";
  els.tabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.view === "runs"));
  render();
});

els.runMultiAgent.addEventListener("click", async () => {
  const project = getSelectedProject();
  const instruction = els.agentInstruction.value.trim();
  const selected = ["codex", "claude"].filter((agentId) => agentStatuses[agentId]?.ready);
  const agentIds = selected.length ? selected : ["codex", "claude"];
  const result = await window.orchestrator.runMultiAgentTask(project.id, agentIds, instruction);
  appState = result.state;
  els.agentInstruction.value = "";
  currentView = "runs";
  els.tabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.view === "runs"));
  render();
});

els.openDataFolder.addEventListener("click", async () => {
  await window.orchestrator.openDataFolder();
});

document.addEventListener("click", async (event) => {
  const stopButton = event.target.closest("[data-stop-run]");
  if (stopButton) {
    const result = await window.orchestrator.stopRun(stopButton.dataset.stopRun);
    appState = result.state;
    render();
    return;
  }

  const selectButton = event.target.closest("[data-select-final]");
  if (selectButton) {
    currentView = "compare";
    els.tabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.view === "compare"));
    render();
    const checkbox = document.querySelector(`[data-final-run-check][value="${CSS.escape(selectButton.dataset.selectFinal)}"]`);
    if (checkbox) checkbox.checked = true;
    return;
  }

  if (event.target.closest("[data-save-selected-final]")) {
    const project = getSelectedProject();
    const selectedRuns = [...document.querySelectorAll("[data-final-run-check]:checked")].map((input) => input.value);
    if (!selectedRuns.length) {
      window.alert("최종 초안으로 만들 실행 결과를 먼저 선택해 주세요.");
      return;
    }
    const title = window.prompt("최종 초안 제목", "멀티 에이전트 병합 초안");
    const result = await window.orchestrator.saveFinalDraft(project.id, selectedRuns, title);
    appState = result.state;
    render();
    return;
  }

  const approveButton = event.target.closest("[data-approve-draft]");
  if (approveButton) {
    const result = await window.orchestrator.approveFinalDraft(approveButton.dataset.approveDraft);
    appState = result.state;
    currentView = "conversation";
    els.tabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.view === "conversation"));
    render();
    return;
  }

  if (event.target.closest("[data-save-project-settings]")) {
    const project = getSelectedProject();
    appState = await window.orchestrator.updateProject(project.id, {
      title: document.querySelector("#settings-title")?.value,
      status: document.querySelector("#settings-status")?.value,
      workspacePath: document.querySelector("#settings-workspace")?.value,
      routerAgent: document.querySelector("#settings-router-agent")?.value,
      localRouterModel: document.querySelector("#settings-local-router-model")?.value
    });
    render();
    return;
  }

  if (event.target.closest("[data-check-git-status]")) {
    const project = getSelectedProject();
    const output = document.querySelector("#git-status-output");
    output.textContent = "확인 중...";
    const result = await window.orchestrator.gitStatus(project.id);
    output.textContent = `${result.cwd}\n\n${result.output}`;
    return;
  }

  if (event.target.closest("[data-search-state]")) {
    const query = document.querySelector("#state-search-query")?.value || "";
    const box = document.querySelector("#state-search-results");
    const result = await window.orchestrator.searchState(query);
    box.innerHTML = result.items.length
      ? result.items
          .map((item) => `
            <button class="search-result" data-project-id="${escapeHtml(item.projectId)}">
              <b>${escapeHtml(item.projectTitle)} · ${escapeHtml(item.type)}</b>
              <span>${formatTime(item.createdAt)}</span>
              <p>${escapeHtml(item.text)}</p>
            </button>
          `)
          .join("")
      : `<p class="muted">검색 결과가 없습니다.</p>`;
    return;
  }

  if (event.target.closest("[data-refresh-state]")) {
    await refreshState();
  }
});

setInterval(async () => {
  if (!appState) return;
  const hasRunning = (appState.runs || []).some((run) => run.state === "실행 중" || run.state === "대기");
  if (hasRunning) await refreshState();
}, 2500);

setInterval(async () => {
  if (!appState) return;
  await refreshAgents();
}, 60000);

refreshState().then(refreshAgents);
