export function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function stripAnsi(value = "") {
  return String(value).replace(/\u001b\[[0-9;]*m/g, "");
}

export function renderInlineMarkdown(value = "") {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function isTableBlock(lines) {
  return (
    lines.length >= 2 &&
    lines.every((line) => line.trim().startsWith("|") && line.trim().endsWith("|")) &&
    lines.some((line) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line))
  );
}

function renderTable(lines) {
  const rows = lines
    .filter((line) => !/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line))
    .map((line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim()));
  if (!rows.length) return "";
  const [head, ...body] = rows;
  return `
    <div class="rich-table-wrap">
      <table>
        <thead><tr>${head.map((cell) => `<th>${renderInlineMarkdown(cell)}</th>`).join("")}</tr></thead>
        <tbody>
          ${body.map((row) => `<tr>${row.map((cell) => `<td>${renderInlineMarkdown(cell)}</td>`).join("")}</tr>`).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderList(lines, ordered = false) {
  const tag = ordered ? "ol" : "ul";
  const marker = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*•]\s+/;
  return `<${tag}>${lines.map((line) => `<li>${renderInlineMarkdown(line.replace(marker, ""))}</li>`).join("")}</${tag}>`;
}

export function renderRichText(value = "") {
  const text = stripAnsi(value).trim();
  if (!text) return `<p>내용이 없습니다.</p>`;

  const blocks = text.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  return blocks
    .map((block) => {
      const lines = block.split("\n").map((line) => line.trimEnd()).filter((line) => line.trim());
      if (!lines.length) return "";
      if (isTableBlock(lines)) return renderTable(lines);
      if (lines.every((line) => /^\s*[-*•]\s+/.test(line))) return renderList(lines);
      if (lines.every((line) => /^\s*\d+[.)]\s+/.test(line))) return renderList(lines, true);
      if (/^#{1,3}\s+/.test(lines[0]) && lines.length === 1) {
        const level = Math.min(lines[0].match(/^#+/)[0].length + 2, 5);
        return `<h${level}>${renderInlineMarkdown(lines[0].replace(/^#{1,3}\s+/, ""))}</h${level}>`;
      }
      if (/^[가-힣A-Za-z0-9 .,/()·:_-]{2,40}$/.test(lines[0]) && lines.length > 1) {
        return `<section class="rich-section"><h4>${renderInlineMarkdown(lines[0])}</h4><p>${lines.slice(1).map(renderInlineMarkdown).join("<br>")}</p></section>`;
      }
      return `<p>${lines.map(renderInlineMarkdown).join("<br>")}</p>`;
    })
    .join("");
}

export function formatTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

export function formatKrw(value = 0) {
  return `${Math.round(Number(value || 0)).toLocaleString("ko-KR")}원`;
}

export function sumUsage(events, field) {
  return events.reduce((sum, event) => sum + Number(event[field] || 0), 0);
}
