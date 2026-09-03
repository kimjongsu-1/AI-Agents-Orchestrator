# AI Agents Orchestrator Architecture

이 프로젝트는 여러 AI CLI와 로컬 LLM을 하나의 콘솔에서 관리하는 데스크톱 오케스트레이터입니다. 설계 방향은 **모듈형 레이어드 아키텍처 + Provider Adapter 패턴**입니다.

## 왜 이 구조가 필요한가

오케스트레이터는 기능이 빠르게 늘어나는 성격의 앱입니다.

- Codex / Claude / Grok / Ollama 실행 방식이 서로 다름
- 로그인 상태 확인 방식이 서로 다름
- Router, Runner, MCP Bridge, Memory, Usage Tracking이 계속 확장됨
- UI는 실행 방식보다 “프로젝트 상태와 결과”만 알아야 함

따라서 한 파일에 모든 기능을 넣으면 작은 수정도 위험해지고, 새 Provider를 추가할 때마다 UI와 실행 로직이 함께 흔들립니다.

## 목표 구조

```txt
src/
  main.js                         # Electron 앱 조립부
  app/                            # Window 생성, IPC 핸들러
  core/                           # 공통 유틸, Result/Error, 시간/ID
  providers/                      # Codex/Claude/Grok/Ollama Adapter
  router/                         # 작업 분배 Router, 프롬프트 생성, JSON 검증/재시도
  runners/                        # 실행, 스트림, 취소, partial 저장, 결과 회수
  storage/                        # JSON 저장소, SQLite 동기화, Checkpointer
  memory/                         # 프로젝트별 장기 메모리 검색/불러오기
  usage/                          # 모델별 토큰/비용 추적
  mcp/                            # MCP Bridge, 외부 CLI 도구 주입
  security/                       # Tool Permission Gate
  automation/                     # 예약 실행/Routines
  renderer/                       # Electron Renderer UI
```

## 레이어 책임

| 레이어 | 책임 |
|---|---|
| App / IPC | 화면 요청을 서비스로 전달. 비즈니스 로직을 직접 가지지 않음 |
| Router | 사용자 자연어 요청을 작업 단위로 나누고 Provider를 배정 |
| Provider Adapter | AI별 실행 명령, 로그인 확인, Router 실행 명령을 캡슐화 |
| Runner | 프로세스 실행, 로그 스트림, 취소, partial 저장, 결과 저장 |
| Storage | JSON/SQLite 저장 방식 캡슐화 |
| Memory | 프로젝트별 대화/작업/결과 검색과 장기 기억 |
| Usage | 입력/출력 토큰, Router 사용량, 로컬 LLM 절감 추정 |
| MCP | 외부 AI CLI가 오케스트레이터 상태와 도구를 사용할 수 있게 연결 |
| Security | 로컬 파일/명령 실행 전 승인 필요 여부 판단 |

## Provider Adapter 패턴

Provider는 다음 인터페이스를 기준으로 맞춥니다.

```js
{
  id: "codex",
  label: "Codex",
  command: "codex",
  loginCommand: "codex login",
  probeCommand: "codex login status",
  buildRunCommand(promptFile, workspacePath) {},
  buildRouterCommand(promptFile) {}
}
```

현재 구현 위치:

- `src/providers/provider_adapters.js`

이 구조의 장점:

- UI는 Codex/Claude/Grok 실행법을 몰라도 됨
- 새 모델 추가 시 Provider 파일만 수정하면 됨
- 로그인 상태 확인, 실행 명령, Router 명령을 한 곳에서 관리 가능
- Grok 연결 문제처럼 Provider별 이슈를 격리해서 디버깅 가능

## Router 구조

Router는 사용자의 한 문장 요청을 다음 형태로 변환합니다.

```json
{
  "shouldRun": true,
  "reason": "분배 판단 이유",
  "tasks": [
    {
      "agentId": "codex",
      "taskName": "코드 분석",
      "instruction": "구체적인 작업 지시"
    }
  ]
}
```

핵심 원칙:

- 분배/요약은 로컬 LLM 우선
- 구현/복잡한 판단은 Codex 또는 Claude
- Grok은 외부 비교/아이디어 확장 보조
- Router 결과는 JSON 검증 후 실패 시 재시도 또는 fallback

## 토큰 절감 설계

토큰 절감의 핵심은 “이미 나온 긴 출력을 요약”하는 것이 아니라, **긴 출력이 컨텍스트에 들어오기 전에 차단**하는 것입니다.

적용 항목:

| 기능 | 적용 방식 |
|---|---|
| 도구 출력 절단 | wrapper script로 테스트/빌드 로그를 실행 시점에 제한 |
| 사전 스코핑 | `rg` 결과를 파일명/라인 주변으로 제한 |
| 컨텍스트 투영 | Router와 Agent 간 인계에 전체 대화 대신 요약 상태 전달 |
| 위임 격리 | 탐색 작업을 별도 실행 컨텍스트에 가두고 메인에는 요약만 반환 |
| 세션 분리 기준 | 다음 작업에 유용한 컨텍스트가 30% 미만이면 새 세션 |
| 재읽기 대체 | 전체 파일 재읽기보다 린트/테스트/타입체크로 검증 |
| 캐시 정렬 | 정적 지침은 앞, 변동 대화/도구 출력은 뒤 |
| 계측 | 모델별 입력/출력/Router 토큰과 절감액 저장 |

## MCP Bridge

MCP Bridge는 오케스트레이터 내부 상태를 외부 CLI나 에이전트가 읽을 수 있게 하는 연결 계층입니다.

현재 구현 위치:

- `src/mcp/mcp_bridge.js`

현재는 안전을 위해 읽기 도구 중심으로 제공합니다.

- 프로젝트 목록 조회
- 프로젝트 상세 조회
- 메모리 검색
- 실행 기록 조회
- 사용량 요약

쓰기 도구는 Permission Gate와 연결한 뒤 확장하는 방향입니다.

## LangGraph 적용 방향

LangGraph는 사용자가 직접 보는 기능명이 아니라 내부 실행 흐름의 모델입니다.

| LangGraph 개념 | 우리 앱 표현 |
|---|---|
| Graph | 작업 흐름 |
| Node | 작업 단계 |
| State | 프로젝트 상태 |
| Checkpoint | 이어하기 저장점 |
| Interrupt | 사용자 승인 대기 |
| Resume | 승인 후 이어서 실행 |
| Store | 장기 메모리 |

현재 구현은 공식 LangGraph 패키지를 직접 의존하기보다, 프로젝트에 맞춘 경량 실행 런타임으로 시작합니다.

현재 구현 위치:

- `src/engine/langgraph_runtime.js`

## 리팩터링 우선순위

현재 `src/main.js`에는 기능이 많이 모여 있습니다. 다음 순서로 점진 분리합니다.

1. Provider Adapter 유지 및 고도화
2. Router 프롬프트/검증/재시도 로직 분리
3. Runner 실행/스트림/취소/partial 저장 분리
4. Storage JSON/SQLite 동기화 분리
5. Usage Tracking 저장소 분리
6. MCP Bridge와 Permission Gate 연결
7. Renderer 컴포넌트 분리

이 순서가 안전한 이유는, 화면을 크게 바꾸지 않고도 내부 책임을 하나씩 분리할 수 있기 때문입니다.
