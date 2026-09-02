# AI Orchestrator Agent Rules

## 목적

이 프로젝트는 여러 AI CLI(Codex, Claude Code, Grok)와 로컬 LLM(Ollama)을 하나의 한글 오케스트라 화면에서 작업 분배, 실행, 기록, 이어하기까지 관리하기 위한 개인용 멀티 에이전트 콘솔이다.

## 토큰 절감 규칙

- 긴 로그를 받은 뒤 요약하지 말고 실행 시점에 파이프/래퍼로 절단한다.
- 오류만 남기지 말고 성공 신호와 첫 원인 오류를 함께 남긴다.
- 테스트는 가능하면 `./scripts/agent-test.sh`를 사용한다.
- 빌드는 가능하면 `./scripts/agent-build.sh`를 사용한다.
- diff 확인은 가능하면 `./scripts/agent-diff.sh`를 사용한다.
- 파일 탐색은 `rg -l`, `rg -m`, `head`로 출력량을 제한하고, 전체 디렉터리 덤프를 피한다.
- 사전 스코핑 후보는 시작점일 뿐이다. 후보 파일로 부족하면 직접 추가 탐색한다.
- 파일 수정 후 검증이 필요하면 전체 재읽기보다 `./scripts/agent-check.sh <파일>` 또는 관련 테스트/린트를 우선 실행한다.
- 같은 파일·같은 목적의 연속 작업이면 컨텍스트를 유지하고, 다음 작업에 쓸 정보가 30% 미만이면 새 실행으로 분리한다.
- 다른 에이전트에게 넘길 때는 전체 출력 대신 `did / artifacts / blocked / next` 형태의 인계 요약을 사용한다.
- 정적 지침은 앞에, 변동 대화/도구 출력은 뒤에 둬서 프롬프트 캐시가 깨지지 않게 한다.
- 사용자가 직접 언급하지 않은 제품명, 회사명, 도메인명은 새로 만들지 않는다.

## 역할 분리

- Router: 요청을 작업 단위로 나누고 적합한 실행자를 정한다.
- Provider Adapter: Codex, Claude, Grok, Ollama 실행 차이를 숨긴다.
- Transcript Store: 프로젝트별 대화, 작업, 실행 로그, 사용량을 저장한다.
- Permission Gate: 위험하거나 방향이 애매한 실행 전 사용자 승인을 받는다.
- Checkpoint: LangGraph식 중단/재개 지점을 저장한다.
- Usage Tracking: 작업당 입력/출력 토큰과 로컬 LLM 절감 추정액을 기록한다.
