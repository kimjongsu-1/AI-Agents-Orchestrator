function requiresApproval(instruction = "") {
  const text = String(instruction || "").toLowerCase();
  return /삭제|지워|초기화|reset|remove|delete|drop|배포|deploy|push|권한|결제|운영|production|상용|실제 서버|파일쓰기|write|수정|고쳐|구현|적용/.test(text);
}

function approvalReason(instruction = "") {
  if (!requiresApproval(instruction)) return "";
  return "파일 수정/삭제/배포/운영 영향 가능성이 있는 작업이라 실행 전 승인이 필요합니다.";
}

module.exports = { requiresApproval, approvalReason };
