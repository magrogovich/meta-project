import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ breaks: true });

// Markdown -> sanitized HTML (XSS-safe: scripts, event handlers and javascript: URLs stripped).
export function renderMarkdown(md: string): string {
  const raw = marked.parse(md || "") as string;
  const clean = DOMPurify.sanitize(raw, { ADD_ATTR: ["target"] });
  return clean;
}

// Minimal line diff for version history (LCS-based).
export type DiffLine = { type: "same" | "add" | "del"; text: string };
export function diffLines(a: string, b: string): DiffLine[] {
  const A = a.split("\n"), B = b.split("\n");
  const m = A.length, n = B.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (A[i] === B[j]) { out.push({ type: "same", text: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: "del", text: A[i] }); i++; }
    else { out.push({ type: "add", text: B[j] }); j++; }
  }
  while (i < m) out.push({ type: "del", text: A[i++] });
  while (j < n) out.push({ type: "add", text: B[j++] });
  return out;
}

// Assign stable section ids to rendered headings (matches backend splitSections order).
// Pseudo-sections without a heading ("Introduction"/"Document") are skipped.
export function addSectionIds(html: string, sections: { id: string; level: number; title: string }[]): string {
  const unesc = (s: string) =>
    s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
  let si = 0;
  return html.replace(/<h([1-6])>(.*?)<\/h\1>/g, (m, lvl, inner) => {
    const text = unesc(inner);
    while (si < sections.length && sections[si].title !== text) si++;
    if (si < sections.length && Number(lvl) === sections[si].level) {
      const id = sections[si].id;
      si++;
      return `<h${lvl} id="sec-${id}">${inner}</h${lvl}>`;
    }
    return m;
  });
}
