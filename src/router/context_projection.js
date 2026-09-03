const { spawnSync } = require("child_process");
const fs = require("fs");
const { compactText } = require("../core/runtime_utils");

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

function buildWorkerHandoff(project, currentInstruction = "", runs = []) {
  const completedRuns = (runs || [])
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

function runPreScope({ project, instruction = "", settings = {} }) {
  if (!settings?.enablePreScope) return null;
  const cwd = project.workspacePath || settings.workspacePath || process.cwd();
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

    String(lineResult.stdout || "")
      .split("\n")
      .filter(Boolean)
      .slice(0, 10)
      .forEach((line) => hits.push({ keyword, line }));
    if (hits.length >= 24) break;
  }

  hits.map((hit) => hit.line.split(":")[0]).filter(Boolean).forEach((file) => fileSet.add(file));
  return {
    cwd,
    keywords,
    files: [...fileSet].slice(0, 15),
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
  const selected = important.length
    ? [
        "[success/context signals]",
        ...successSignals,
        "",
        "[first errors/warnings]",
        ...important.slice(0, 24),
        "",
        "[tail context]",
        ...lines.slice(-40)
      ]
    : lines.slice(-80);
  const body = [...new Set(selected)].join("\n").trim();
  return body.length <= 12000 ? body : body.slice(-12000);
}

module.exports = {
  buildContextProjection,
  buildWorkerHandoff,
  runPreScope,
  filterOutputForContext
};
