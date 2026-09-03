const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

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
      resolve({ label, error, output: `${stdout || ""}${stderr || ""}`.trim() });
    });
  });
}

function classifyProbe(command, versionResult, probe) {
  const installed = Boolean(versionResult.installed);
  const output = probe?.output || "";
  const lower = output.toLowerCase();
  if (!installed) return { installed: false, ready: false, version: null, status: "not-installed", message: "CLI 설치 필요" };
  if (probe?.error?.killed || probe?.error?.signal === "SIGTERM") {
    return { installed: true, ready: false, version: versionResult.version, status: "timeout", message: "로그인 확인 지연" };
  }
  if (
    (command === "ollama" && lower.includes("name")) ||
    lower.includes("logged in using chatgpt") ||
    lower.includes("authenticated") ||
    lower.includes("auth status: logged in") ||
    lower.includes("login status: logged in") ||
    lower.includes("you are logged in with grok.com") ||
    lower.includes("no installation issues found") ||
    lower.includes("claude code doctor")
  ) {
    return { installed: true, ready: true, version: versionResult.version, status: "ready", message: "실행 가능" };
  }
  if (/payment required|spending-limit|run out of credits|billing|credit balance/i.test(output)) {
    return { installed: true, ready: false, version: versionResult.version, status: "billing-required", message: "크레딧/구독 필요" };
  }
  if (/login|sign in|not logged in|unauthorized|invalid api key|authentication/i.test(output)) {
    return { installed: true, ready: false, version: versionResult.version, status: "login-required", message: "로그인 필요" };
  }
  if (/승인이 필요|approval required|requires approval|permission required/i.test(output)) {
    return { installed: true, ready: false, version: versionResult.version, status: "approval-required", message: "승인/권한 필요" };
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

async function checkAgents() {
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
}

module.exports = {
  probeAgent,
  checkAgents
};
