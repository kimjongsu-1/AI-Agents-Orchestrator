const { now } = require("../core/runtime_utils");
const { appendProjectMessage } = require("../projects/project_service");

function createRoutineScheduler({ readState, writeState }) {
  let lastDailyRoutineKey = null;

  function runDueAutomations() {
    const state = readState();
    if (!state.settings?.enableDailyRoutine) return;
    const date = new Date();
    const hour = Number(state.settings.dailyRoutineHour || 9);
    const key = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}-${hour}`;
    if (date.getHours() !== hour || lastDailyRoutineKey === key) return;
    lastDailyRoutineKey = key;

    state.projects.forEach((project) => {
      const openTasks = (project.tasks || []).filter((task) => !["완료", "거절", "중단"].includes(task.state));
      if (!openTasks.length) return;
      appendProjectMessage(state, project, {
        role: "assistant",
        author: "Routine",
        text: [
          `매일 오전 ${hour}시 미완료 작업 요약입니다.`,
          "",
          ...openTasks.slice(0, 12).map((task, index) => `${index + 1}. [${task.state}] ${task.name} — ${task.detail || "상세 없음"}`)
        ].join("\n"),
        createdAt: now()
      });
      project.status = "미완료 작업 요약 생성";
      project.updatedAt = now();
    });
    writeState(state);
  }

  function start() {
    setInterval(runDueAutomations, 60 * 1000);
    setTimeout(runDueAutomations, 3000);
  }

  return { start, runDueAutomations };
}

module.exports = { createRoutineScheduler };
