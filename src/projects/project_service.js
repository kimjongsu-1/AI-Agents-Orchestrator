const providers = require("../providers/provider_adapters");
const { uid, now } = require("../core/runtime_utils");

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

function agentLabel(agentId) {
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

function addApprovalForRun(state, project, run, reason) {
  const approval = {
    id: uid("approval"),
    runId: run.id,
    title: `${agentLabel(run.agentId)} 실행 승인 필요`,
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

function createProject(state, title) {
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
    workspacePath: state.settings.workspacePath,
    autoRoutedMessageIds: []
  };
  state.projects.unshift(project);
  state.selectedProjectId = project.id;
  return project;
}

function hydrateRunOutputsForUi(state, fs) {
  (state.runs || []).forEach((run) => {
    if (!run.logFile || !fs.existsSync(run.logFile)) return;
    if (run.output && !["실행 중", "대기"].includes(run.state)) return;
    const log = fs.readFileSync(run.logFile, "utf8").trim();
    if (log) run.output = log.slice(-12000);
  });
  return state;
}

function searchState(state, query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return [];
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
  return items;
}

module.exports = {
  findProject,
  appendProjectMessage,
  agentLabel,
  upsertEval,
  addApprovalForRun,
  createProject,
  hydrateRunOutputsForUi,
  searchState
};
