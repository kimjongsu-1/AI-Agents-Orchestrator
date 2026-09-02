function parseActualUsage(output = "") {
  const text = String(output || "");
  const candidates = [
    /input[_\s-]?tokens["':=\s]+(\d+).*?output[_\s-]?tokens["':=\s]+(\d+)/is,
    /prompt[_\s-]?tokens["':=\s]+(\d+).*?completion[_\s-]?tokens["':=\s]+(\d+)/is,
    /tokens?\s*[:=]\s*input\s*(\d+)\s*[,/]\s*output\s*(\d+)/is
  ];
  for (const regex of candidates) {
    const match = text.match(regex);
    if (match) {
      return {
        inputTokens: Number(match[1]),
        outputTokens: Number(match[2]),
        source: "actual-output"
      };
    }
  }
  return null;
}

module.exports = { parseActualUsage };
