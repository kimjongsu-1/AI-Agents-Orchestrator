# AI Agents Orchestrator

여러 AI CLI와 로컬 LLM을 하나의 화면에서 관리하기 위한 개인용 멀티 에이전트 오케스트라입니다.

## 왜 만들었나

Codex, Claude Code, Grok, Ollama 같은 도구를 각각 따로 쓰면 다음 문제가 생깁니다.

- 어떤 작업을 어떤 AI에게 보내야 할지 매번 사람이 판단해야 함
- 작업 결과가 터미널/대화창/파일로 흩어져 이어서 보기 어려움
- 긴 로그와 전체 파일 출력이 컨텍스트에 누적되어 토큰 비용이 커짐
- 취소/실패/부분 응답이 기록되지 않아 같은 작업을 다시 반복하게 됨

이 오케스트라는 위 문제를 줄이기 위해 “작업 분배 → 실행 → 결과 저장 → 이어하기 → 사용량 확인”을 한 화면에서 처리하는 것을 목표로 합니다.

## 핵심 방향

```text
사용자 명령
  ↓
Local LLM Router / Ollama
  ↓
작업 분배
  ↓
Provider Adapter
  ├─ Codex
  ├─ Claude Code
  ├─ Grok
  └─ Local LLM
  ↓
실행 로그·결과·사용량 저장
  ↓
프로젝트별 대화 이어하기
```

## 적용한 설계

### 1. Inference Router

사용자의 자연어 요청을 분석해서 작업을 나누고, 각 작업을 Codex / Claude / Grok 중 어디에 보낼지 결정합니다.

현재 기본 Router는 Ollama 로컬 모델입니다.

- 기본 모델: `qwen2.5-coder:7b`
- 설정 화면에서 모델명 변경 가능
- 외부 API 토큰 비용 없이 작업 분배 가능

### 2. 로컬 CLI 로그인 감지

각 CLI 상태를 앱에서 확인합니다.

- Codex: `codex login status`
- Claude Code: `claude doctor`
- Grok: `grok models`
- Ollama: `ollama list`

### 3. Provider Session Adapter 방향

각 AI마다 실행 명령이 다르지만, 오케스트라 안에서는 같은 실행 단위로 다룹니다.

```text
run(agentId, prompt, workspace)
```

이 구조로 가면 나중에 Codex, Claude, Grok, OpenRouter, Gemini 등을 추가해도 UI와 작업 저장 구조는 유지할 수 있습니다.

### 4. Transcript Store / Memory

대화, 작업, 실행 결과, 사용량을 프로젝트 단위로 저장합니다.

SQLite에는 다음 데이터가 들어갑니다.

- projects
- messages
- tasks
- runs
- usage_events
- checkpoints
- memories
- automations

### 5. MCP Bridge

외부 CLI/에이전트가 오케스트라 상태를 읽을 수 있도록 MCP JSON-RPC Bridge를 제공합니다.

기본 주소는 앱 설정 화면에서 확인할 수 있습니다.

```text
http://127.0.0.1:8765/<secret-path>
```

지원 메서드:

| MCP 메서드 | 역할 |
|---|---|
| `initialize` | MCP 클라이언트 연결 초기화 |
| `tools/list` | 오케스트라가 제공하는 도구 목록 조회 |
| `tools/call` | 프로젝트/메모리/실행기록/사용량 조회 도구 실행 |
| `ping` | 연결 상태 확인 |

제공 도구:

| 도구 | 역할 |
|---|---|
| `list_projects` | 프로젝트 목록 조회 |
| `get_project` | 특정 프로젝트의 최근 메시지, 작업, 승인 대기 항목 조회 |
| `search_memory` | 프로젝트 대화/작업/장기 메모리 검색 |
| `list_runs` | 에이전트 실행 기록 조회 |
| `usage_summary` | 모델별 토큰 사용량과 로컬 LLM 절감 추정치 조회 |

현재 Bridge는 안전을 위해 읽기 도구 중심으로 열려 있습니다. 파일 수정, 명령 실행 같은 쓰기 도구는 Permission Gate와 묶은 뒤 별도 확장합니다.

### 6. LangGraph 적용 방향

LangGraph는 화면에 직접 드러나는 기능이 아니라 내부 실행 엔진 역할로 적용합니다.

한글화 기준은 다음과 같습니다.

| LangGraph 개념 | 우리 오케스트라 표현 |
|---|---|
| Graph | 작업 흐름 |
| Node | 작업 단계 |
| State | 프로젝트 상태 |
| Checkpoint | 이어하기 저장점 |
| Interrupt | 사용자 승인 대기 |
| Resume | 승인 후 이어서 실행 |
| Store | 장기 메모리 |

즉 사용자는 LangGraph를 몰라도 됩니다. 화면에는 “요청 분석 → 작업 분배 → 실행 → 결과 정리 → 저장”으로 보이게 합니다.

## 토큰 절감 전략

핵심은 “적게 부르기”보다 “컨텍스트에 애초에 안 넣기”입니다.

### 적용 항목

| 기능 | 목적 |
|---|---|
| 도구 출력 절단 | 실행 시점에 파이프/래퍼로 원본 로그를 차단. 성공 신호와 첫 원인 오류는 유지 |
| 사전 스코핑 | `rg -l`, `rg -m`, `head`로 출력량을 캡하고 후보 파일/라인 주변만 제공 |
| 컨텍스트 투영 | Router뿐 아니라 에이전트 간 인계도 목표/완료/막힘/다음 작업 요약으로 전달 |
| 세션 분리 기준 | 무조건 짧게가 아니라 다음 작업에 유용한 컨텍스트가 30% 미만이면 분리 |
| 재읽기 → 검증 대체 | 파일 전체 재읽기 대신 타입체크/린트/관련 테스트로 확인 |
| 모델 급 나누기 | 분배·요약은 로컬, 구현은 Codex/Claude, 탐색은 사전 스코핑/위임 격리로 절감 |
| 위임 격리 | 탐색 작업은 별도 실행 컨텍스트에 가두고 메인에는 3줄 요약만 반환 |
| 캐시 정렬 | 정적 지침은 앞, 변동 대화/도구 출력은 뒤에 배치 |
| 계측 | 작업당 입력/출력 토큰, Router 토큰, 로컬 절감액을 기록 |

### 왜 중요한가

에이전트 컨텍스트는 누적됩니다.

예를 들어 테스트 로그 20,000토큰이 초반에 들어가고 세션이 15턴 이어지면, 그 로그는 이후 턴마다 반복되어 수십만 토큰 비용으로 커질 수 있습니다.

그래서 이 프로젝트는 다음 원칙을 기본으로 합니다.

- 긴 빌드 로그는 실행 시점에 래퍼로 자르고 원본은 에이전트 컨텍스트에 넣지 않음
- 전체 파일 목록을 무작정 읽지 않고 `rg` 결과를 제한함
- Router와 worker 간 인계에는 전체 대화가 아니라 상태 요약만 전달
- raw 로그는 파일에 저장하고, 대화창에는 절단/필터링 결과만 표시
- 편집 후에는 전체 파일 재읽기보다 `./scripts/agent-check.sh <파일>`로 검증

## 사용량 추적

로컬 LLM을 넣었을 때 비용이 얼마나 줄었는지 눈으로 확인하기 위해 `사용량` 탭을 제공합니다.

추적 항목:

- 모델별 호출 수
- 입력 토큰 추정
- 출력 토큰 추정
- Router 작업 분배 사용량
- Local LLM 대체 처리량
- 외부 API로 처리했을 때의 예상 비용
- 실제/추정 절감액

예시:

```text
Router 호출: 38회
Local LLM 처리량: 24,500 tokens
외부 API 대체 비용: 3,200원 상당
실제 Router 비용: 0원
```

## Grok Bot 기능 구현

Grok Bot reconstructed 프로젝트를 참고 적용

| 기능 | 가져올 가치 |
|---|---|
| Inference Router | 작업 분배 AI의 기반 구조 |
| 로컬 CLI 로그인 감지 | 연결 상태 오류 해결 |
| Provider Session Adapter | 모델별 실행 방식 통일 |
| Routed MCP Bridge | 추후 우리 도구를 다른 CLI에 주입 |
| Transcript Store | 프로젝트별 이어하기와 결과 보존 |
| Tool Permission Gate | 파일/명령 실행 승인 구조 |
| Usage Tracking | 비용/사용량 확인 |
| Automation/Routines | 매일 아침 미완료 작업 요약 등 |

단, Electron 디컴파일/하이브리드 빌드/복잡한 원격 Box 동기화는 현재 범위에 맞지 않아 제외

## 실행 방법

```bash
./launch.command
```

Ollama Router를 쓰려면 Ollama가 실행 중이어야 합니다.

```bash
ollama list
ollama pull qwen2.5-coder:7b
```

## 현재 구현 상태

- Electron UI
- 프로젝트 생성/전환
- Codex / Claude / Grok / Ollama 상태 확인
- Local LLM Router 설정
- 작업 자동 분배
- 실행 로그 저장
- 출력 필터링
- 사용량 탭
- JSON 저장 + SQLite 동기화
- LangGraph식 실행 그래프/체크포인트 저장 구조
- Provider Adapter 파일 분리
- Tool Permission Gate 승인/거절/수정 요청 흐름
- 부분 응답 저장
- 요청 ID 기반 중복 스트림 방지
- 취소 시 partial 저장
- Router 결과 JSON 검증/로컬 재시도
- CLI 인증 파일 기반 로그인 상태 보강
- MCP Bridge JSON-RPC 서버
- 매일 오전 미완료 작업 요약 루틴
- 탐색 위임 격리 원칙
- 프로젝트별 장기 메모리 검색
- 토큰 절감용 AGENTS.md / wrapper scripts

## 앞으로 보강할 부분

- 모델별 실제 usage API가 제공될 경우 추정값 대신 실제값 저장 범위 확대
- MCP Bridge 쓰기 도구를 Permission Gate와 연결
- LangGraph Python 공식 패키지와의 호환 Checkpointer 추가
- Permission Gate 세부 정책 UI 추가
