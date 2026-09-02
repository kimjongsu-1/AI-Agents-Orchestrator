const path = require("path");

const AGENTS = {
  codex: {
    id: "codex",
    label: "Codex",
    command: "codex",
    loginCommand: "codex login",
    versionCommand: "codex --version",
    probeCommand: "codex login status 2>&1 | tail -n 30",
    buildRunCommand(promptFile, workspacePath) {
      const promptPath = JSON.stringify(promptFile);
      const cwdPath = JSON.stringify(workspacePath);
      return `if command -v codex >/dev/null 2>&1; then codex exec --sandbox workspace-write --ask-for-approval never -C ${cwdPath} --add-dir ${cwdPath} - < ${promptPath}; else echo 'Codex CLI를 찾지 못했습니다.'; exit 127; fi`;
    },
    buildRouterCommand(promptFile) {
      const promptPath = JSON.stringify(promptFile);
      return `if command -v codex >/dev/null 2>&1; then codex exec - < ${promptPath}; else echo 'Codex CLI를 찾지 못했습니다.'; exit 127; fi`;
    }
  },
  claude: {
    id: "claude",
    label: "Claude Code",
    command: "claude",
    loginCommand: "claude",
    versionCommand: "claude --version",
    probeCommand: "claude doctor 2>&1 | tail -n 30",
    buildRunCommand(promptFile, workspacePath) {
      const promptPath = JSON.stringify(promptFile);
      const cwdPath = JSON.stringify(workspacePath);
      return `if command -v claude >/dev/null 2>&1; then claude -p --permission-mode acceptEdits --add-dir ${cwdPath} < ${promptPath}; else echo 'Claude Code CLI를 찾지 못했습니다.'; exit 127; fi`;
    },
    buildRouterCommand(promptFile) {
      const promptPath = JSON.stringify(promptFile);
      return `if command -v claude >/dev/null 2>&1; then claude -p < ${promptPath}; else echo 'Claude Code CLI를 찾지 못했습니다.'; exit 127; fi`;
    }
  },
  grok: {
    id: "grok",
    label: "Grok",
    command: "grok",
    loginCommand: "if command -v grok >/dev/null 2>&1; then grok login --oauth || grok login || grok; else echo 'Grok CLI가 아직 설정되어 있지 않습니다.'; fi",
    versionCommand: "grok --version",
    probeCommand: "grok models 2>&1 | tail -n 30",
    buildRunCommand(promptFile, workspacePath) {
      const promptPath = JSON.stringify(promptFile);
      const cwdPath = JSON.stringify(workspacePath);
      return `if command -v grok >/dev/null 2>&1; then grok -p --permission-mode acceptEdits --cwd ${cwdPath} --output-format plain < ${promptPath}; else echo 'Grok CLI를 찾지 못했습니다.'; exit 127; fi`;
    },
    buildRouterCommand(promptFile) {
      const promptPath = JSON.stringify(promptFile);
      return `if command -v grok >/dev/null 2>&1; then grok -p --output-format plain < ${promptPath}; else echo 'Grok CLI를 찾지 못했습니다.'; exit 127; fi`;
    }
  },
  ollama: {
    id: "ollama",
    label: "Local LLM",
    command: "ollama",
    loginCommand: "ollama list; echo 'Ollama는 로컬 라우터로 사용됩니다. 필요한 모델이 없으면 ollama pull qwen2.5-coder:7b 를 실행하세요.'",
    versionCommand: "ollama --version",
    probeCommand: "ollama list 2>&1 | tail -n 30",
    buildRunCommand(promptFile, _workspacePath, model = "qwen2.5-coder:7b") {
      const promptPath = JSON.stringify(promptFile);
      return `if command -v ollama >/dev/null 2>&1; then ollama run ${JSON.stringify(model)} < ${promptPath}; else echo 'Ollama를 찾지 못했습니다.'; exit 127; fi`;
    }
  }
};

function getAgent(agentId) {
  return AGENTS[agentId] || null;
}

function agentLabel(agentId) {
  return getAgent(agentId)?.label || agentId;
}

function terminalCommandForAgent(agentId, cwd = "/Users/h2o/Documents/AgentMuitle") {
  const adapter = getAgent(agentId);
  if (!adapter) return null;
  return `cd ${JSON.stringify(path.resolve(cwd))}; ${adapter.loginCommand}; exec $SHELL -l`;
}

function runCommandForAgent(agentId, promptFile, workspacePath, options = {}) {
  const adapter = getAgent(agentId);
  if (!adapter?.buildRunCommand) return null;
  return adapter.buildRunCommand(promptFile, workspacePath || "/Users/h2o/Documents/AgentMuitle", options.model);
}

function routerCommandForAgent(agentId, promptFile) {
  const adapter = getAgent(agentId);
  if (!adapter?.buildRouterCommand) return null;
  return adapter.buildRouterCommand(promptFile);
}

module.exports = {
  AGENTS,
  getAgent,
  agentLabel,
  terminalCommandForAgent,
  runCommandForAgent,
  routerCommandForAgent
};
