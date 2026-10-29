import { createHash } from "crypto";

export type GSection = { id: string; path: string; level: number; title: string; body: string; mandatory?: boolean };

export const MAX_MD_BYTES = 1 * 1024 * 1024;
const ALLOWED_EXT = [".md", ".markdown"];
const ALLOWED_MIME = ["text/markdown", "text/plain", "text/x-markdown", "application/octet-stream"];

export function hashContent(markdown: string): string {
  return createHash("sha256").update(markdown, "utf8").digest("hex");
}

// ~4 chars per token heuristic for budget checks.
export function estimateTokens(markdown: string): number {
  return Math.ceil(markdown.length / 4);
}

export function validateMarkdownUpload(file: { name: string; mime: string; size: number; buffer: Buffer }): string {
  const ext = (file.name.match(/\.[^.]+$/) || [""])[0].toLowerCase();
  if (!ALLOWED_EXT.includes(ext)) throw new Error(`Only .md / .markdown files are accepted (got "${ext || "no extension"}")`);
  if (file.mime && !ALLOWED_MIME.includes(file.mime.toLowerCase().split(";")[0].trim()))
    throw new Error(`Rejected MIME type "${file.mime}" — Markdown files only`);
  if (file.size > MAX_MD_BYTES) throw new Error(`File too large (${Math.round(file.size / 1024)} KB, limit 1024 KB)`);
  const text = file.buffer.toString("utf8");
  if (text.includes("�") && /[\x80-\xFF]/.test(file.buffer.toString("binary")))
    throw new Error("File is not valid UTF-8 text");
  if (!text.trim()) throw new Error("File is empty");
  return text;
}

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9\u00C0-\u024F\u1E00-\u1EFF]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "section";

// Split Markdown by ATX headings into sections with stable IDs + breadcrumb paths.
export function splitSections(markdown: string): GSection[] {
  const lines = markdown.split("\n");
  const sections: GSection[] = [];
  let cur: { level: number; title: string; body: string[] } | null = null;
  const stack: string[] = [];
  const seen = new Map<string, number>();
  const flush = () => {
    if (!cur) return;
    const n = (seen.get(cur.title) || 0) + 1;
    seen.set(cur.title, n);
    const id = `${slug(cur.title)}${n > 1 ? `-${n}` : ""}`;
    sections.push({ id, path: [...stack.slice(0, cur.level - 1), cur.title].join(" / "), level: cur.level, title: cur.title, body: cur.body.join("\n").trim() });
  };
  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      flush();
      const level = m[1].length, title = m[2].trim();
      stack.length = Math.min(stack.length, level - 1);
      stack[level - 1] = title;
      cur = { level, title, body: [] };
    } else if (cur) cur.body.push(line);
    else if (line.trim()) {
      cur = { level: 1, title: "Introduction", body: [line] };
      stack[0] = "Introduction";
    }
  }
  flush();
  return sections.length ? sections : [{ id: "document", path: "Document", level: 1, title: "Document", body: markdown.trim() }];
}

export const STARTER_TEMPLATE = `# Call Handling Guidelines

## Greeting
- Greet the customer within the first 30 seconds.
- State your name and the company, and offer help.

## Identification and compliance
- Verify the caller's identity before sharing account details.
- Never promise refunds, timelines, or outcomes you cannot guarantee.
- Follow consent and recording-notice policy on every call.

## Tone and empathy
- Acknowledge feelings explicitly ("I understand how frustrating this is").
- Do not interrupt. Let the customer finish before responding.

## Do's
- Summarize what was agreed before closing.
- State a clear next step with a timeline.

## Don'ts
- Don't blame the customer or other teams.
- Don't invent policy details — say you will check and follow up.

## Escalation
- Offer a supervisor or callback when the issue cannot be resolved in one call.
- Flag harassment, health, or safety concerns to a human evaluator.

## Closing
- Ask "Is there anything else I can help with today?"
- Thank the customer and close politely.
`;
