const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("orchestrator", {
  openAgentLogin: (agentId) => ipcRenderer.invoke("open-agent-login", agentId),
  loadState: () => ipcRenderer.invoke("load-state"),
  createProject: (title) => ipcRenderer.invoke("create-project", title),
  selectProject: (projectId) => ipcRenderer.invoke("select-project", projectId),
  addMessage: (projectId, text) => ipcRenderer.invoke("add-message", projectId, text),
  createTask: (projectId, payload) => ipcRenderer.invoke("create-task", projectId, payload),
  updateApproval: (projectId, approvalId, action) => ipcRenderer.invoke("update-approval", projectId, approvalId, action),
  checkAgents: () => ipcRenderer.invoke("check-agents"),
  runAgentTask: (projectId, agentId, instruction) => ipcRenderer.invoke("run-agent-task", projectId, agentId, instruction),
  runMultiAgentTask: (projectId, agentIds, instruction) => ipcRenderer.invoke("run-multi-agent-task", projectId, agentIds, instruction),
  stopRun: (runId) => ipcRenderer.invoke("stop-run", runId),
  saveFinalDraft: (projectId, sourceRunIds, title) => ipcRenderer.invoke("save-final-draft", projectId, sourceRunIds, title),
  approveFinalDraft: (draftId) => ipcRenderer.invoke("approve-final-draft", draftId),
  updateProject: (projectId, patch) => ipcRenderer.invoke("update-project", projectId, patch),
  gitStatus: (projectId) => ipcRenderer.invoke("git-status", projectId),
  searchState: (query) => ipcRenderer.invoke("search-state", query),
  openDataFolder: () => ipcRenderer.invoke("open-data-folder"),
  readRunLog: (runId) => ipcRenderer.invoke("read-run-log", runId)
});
