export type PiiRisk = "low" | "medium" | "high";

const highPatterns = [
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  /(api[_-]?key|secret|token|password|passwd)\s*[:=]\s*[A-Za-z0-9_\-]{8,}/gi,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
];

const mediumPatterns = [
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  /\+?\d[\d\-\s()]{8,}\d/g,
  /\b\d{3}-\d{4}\b/g,
  /(?:東京都|北海道|(?:京都|大阪)府|.{2,3}県).{2,30}(?:市|区|町|村).{1,40}/g,
];

function collect(patterns: RegExp[], text: string): string[] {
  const matches: string[] = [];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
      matches.push(match[0]);
    }
  }
  return matches;
}

export type PiiScanResult = {
  risk: PiiRisk;
  hits: string[];
};

export function scanPii(texts: string[]): PiiScanResult {
  const blob = texts.join("\n");
  const highHits = collect(highPatterns, blob);
  if (highHits.length > 0) {
    return { risk: "high", hits: highHits };
  }

  const mediumHits = collect(mediumPatterns, blob);
  if (mediumHits.length > 0) {
    return { risk: "medium", hits: mediumHits };
  }

  return { risk: "low", hits: [] };
}
