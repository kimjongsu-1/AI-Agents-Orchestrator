import { escapeHtml, formatTime } from "../modules/formatters.js";

export function renderProjectList(projects = [], selectedProjectId = "") {
  return projects
    .map((project) => {
      const active = project.id === selectedProjectId ? " active" : "";
      return `
        <button class="project${active}" data-project-id="${escapeHtml(project.id)}">
          <span>${escapeHtml(project.title)}</span>
          <small>${escapeHtml(project.status || "대기")} · ${formatTime(project.updatedAt)}</small>
        </button>
      `;
    })
    .join("");
}
