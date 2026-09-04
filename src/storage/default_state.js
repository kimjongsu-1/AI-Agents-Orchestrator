function createDefaultState(now) {
  const ts = now();
  return {
    version: 1,
    selectedProjectId: "project-orchestrator",
    settings: {
      workspacePath: "/Users/h2o/Documents/AgentMuitle",
      defaultAgents: ["codex", "claude"],
      maxRecentMessages: 16,
      routerAgent: "ollama",
      localRouterModel: "qwen2.5-coder:7b",
      enablePreScope: true,
      enableOutputFiltering: true,
      enableUsageTracking: true,
      requireApprovalForRiskyRuns: false,
      enableDailyRoutine: true,
      dailyRoutineHour: 9
    },
    projects: [
      {
        id: "project-orchestrator",
        title: "AI 오케스트레이터 개발",
        status: "MVP 구현 중",
        createdAt: ts,
        updatedAt: ts,
        messages: [
          {
            id: "msg-welcome-user",
            role: "user",
            author: "사용자",
            text: "여러 AI를 한 화면에서 관리하고 작업을 분배하는 오케스트레이터를 만들고 싶어.",
            createdAt: ts
          },
          {
            id: "msg-welcome-assistant",
            role: "assistant",
            author: "Codex",
            text: "프로젝트/대화/작업을 저장하고, 에이전트 상태와 실행 준비를 관리하는 MVP부터 구축합니다.",
            createdAt: ts
          }
        ],
        tasks: [
          {
            id: "task-state",
            state: "완료",
            name: "저장소 구조 구성",
            detail: "프로젝트, 메시지, 작업을 로컬 JSON DB에 저장",
            createdAt: ts
          },
          {
            id: "task-agent",
            state: "진행 중",
            name: "에이전트 연결 준비",
            detail: "Codex, Claude, Grok 실행 가능 여부 확인 및 터미널 실행 연결",
            createdAt: ts
          },
          {
            id: "task-run",
            state: "대기",
            name: "작업 실행 로그",
            detail: "선택한 에이전트로 작업 실행 요청과 결과 로그를 누적",
            createdAt: ts
          }
        ],
        approvals: [
          {
            id: "approval-agent-run",
            title: "에이전트 실행 연결",
            detail: "선택한 에이전트에게 현재 프로젝트 문맥과 사용자 요청을 전달합니다.",
            state: "대기",
            createdAt: ts
          }
        ],
        evals: {
          score: 58,
          items: [
            { state: "Pass", name: "로컬 UI 실행", detail: "Electron 앱 실행 가능" },
            { state: "Pass", name: "데이터 저장", detail: "대화/작업 저장 구조 추가" },
            { state: "Pending", name: "실제 에이전트 실행", detail: "CLI 로그인 및 실행 검증 필요" }
          ]
        },
        workspacePath: "/Users/h2o/Documents/AgentMuitle",
        autoRoutedMessageIds: []
      }
    ],
    runs: [],
    usageEvents: [],
    checkpoints: [],
    memories: [],
    automations: [],
    mcpBridge: {
      enabled: true,
      port: 8765,
      secretPath: ""
    },
    finalDrafts: []
  };
}

module.exports = { createDefaultState };
