const { compactText } = require("../core/runtime_utils");
const { buildContextProjection, buildWorkerHandoff, runPreScope } = require("../router/context_projection");

function createPrompt({ project, instruction, state, runs }) {
  const maxMessages = Number(project.maxRecentMessages || state.settings.maxRecentMessages || 16);
  const projection = buildContextProjection(project, instruction);
  const scope = runPreScope({ project, instruction, settings: state.settings });
  const handoff = buildWorkerHandoff(project, instruction, runs);

  return [
    "## Static execution rules",
    "이 블록은 캐시가 잘 붙도록 작업 중 변경하지 않는 정적 규칙이다.",
    "- 한국어로 답한다.",
    "- 사용자가 직접 언급하지 않은 제품명/회사명/도메인명을 추론해 추가하지 않는다.",
    "- 긴 로그와 전체 파일 덤프를 피하고 필요한 근거만 짧게 인용한다.",
    "",
    `# Project: ${project.title}`,
    "",
    `- Status: ${project.status || "대기"}`,
    `- Workspace: ${project.workspacePath || state.settings.workspacePath}`,
    "",
    "## Context projection",
    "전체 대화 전문을 반복해서 읽지 말고 아래 투영된 상태를 우선 기준으로 판단한다.",
    JSON.stringify(projection, null, 2),
    "",
    "## Worker handoff projection",
    "다른 에이전트 결과 전문을 다시 읽지 말고 아래 인계 요약을 우선 사용한다.",
    JSON.stringify(handoff, null, 2),
    "",
    "## Recent conversation, capped",
    ...project.messages.slice(-maxMessages).map((message) => `- ${message.author}: ${compactText(message.text, 700)}`),
    "",
    "## Current tasks",
    ...(project.tasks || []).slice(-12).map((task) => `- [${task.state}] ${task.name}: ${task.detail}`),
    "",
    "## Pre-scope result",
    scope
      ? [
          `- cwd: ${scope.cwd}`,
          `- keywords: ${scope.keywords.join(", ")}`,
          `- candidate files: ${scope.files.length ? scope.files.join(", ") : "없음"}`,
          "- 이 후보는 시작점일 뿐이다. 부족하면 직접 추가 탐색해도 된다.",
          "",
          ...scope.excerpts.slice(0, 12).map((line) => `  - ${line}`)
        ].join("\n")
      : "- 사전 스코핑 결과 없음",
    "",
    "## User instruction",
    instruction || "현재 프로젝트를 검토하고 다음 작업을 제안해줘.",
    "",
    "## Token saving rules",
    "- 긴 로그/빌드 출력/테스트 출력은 실행 시점에 scripts 래퍼나 파이프로 잘라 원본이 컨텍스트에 들어오지 않게 한다.",
    "- 오류만 남기지 말고 성공 신호와 첫 번째 원인 오류를 함께 남긴다.",
    "- 파일을 찾을 때는 rg 결과와 후보 파일을 먼저 사용하되, 후보가 부족하면 추가 탐색한다.",
    "- 편집 후 확인이 필요하면 파일 전체 재읽기보다 ./scripts/agent-check.sh <파일> 또는 관련 테스트/린트를 우선 실행한다.",
    "- git diff는 전체 출력보다 변경 파일과 핵심 hunk 중심으로 요약한다.",
    "- 같은 파일·같은 목적의 연속 작업이면 컨텍스트를 유지하고, 다음 작업에 쓸 정보가 30% 미만이면 새 실행으로 분리한다.",
    "- 다른 에이전트에게 넘길 때는 전체 출력이 아니라 did/artifacts/blocked/next 형태의 인계 요약만 넘긴다.",
    "",
    "## Required output",
    "한국어로 결과, 판단 근거, 다음 작업을 간결하게 정리해줘.",
    "사용자가 직접 언급하지 않은 제품명/사업 도메인명은 추론해서 넣지 말고, '기존 코어', '보유 기술', '현재 시스템'처럼 중립적으로 표현해줘."
  ].join("\n");
}

module.exports = { createPrompt };
