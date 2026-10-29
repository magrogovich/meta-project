Apply the following updates to the existing, working Arocall codebase (a call center QA platform: a desktop agent records calls, AI transcribes and scores them, a dashboard shows results, and AI coaching sessions run with employees). Do not rewrite from scratch and do not break working features. Keep the existing tech stack. Before changing anything, inspect the codebase and give me a short plan listing the files, routes and tables you will change. Then work through the phases in section 9.

## 1. Goal
The current dashboard is cluttered: everything lives on one page. Restructure the app into separate pages with a clean sidebar, make the dashboard answer one question ("What needs my attention right now?"), improve the add-employee flow, make session keys revealable, and replace the QA Scorecards feature with a Markdown-based Guidelines system.

## 2. Sidebar navigation
Left sidebar, in order: Dashboard, Calls, Employees, Coaching, Guidelines, Analytics (simple placeholder page marked "coming soon"), and at the bottom Settings and Help/Walkthrough. Highlight the active item. Collapsible on small screens. Use the product name "Arocall" in the logo, page titles, emails and README.

## 3. Dashboard
Top filter bar (date range, department, language) applying to everything below. Then:
- Six KPI cards, each with change vs previous period: Calls analyzed; Average score; Critical failures (calls failing a must-pass criterion); Employees needing coaching; Coverage (% of calls recorded and analyzed, plus number of desktop agents online); Coaching follow-through (% of action items completed).
- "Needs attention" list (the most prominent block), each item linking to the relevant page: employees whose score dropped sharply; calls with critical failures; AI coaching sessions where the employee requested a human evaluator; calls that failed processing; desktop agents offline.
- Charts: team score trend over time (optionally split by department); most-failed criteria (bar chart); score distribution (histogram).
- Two small lists: top improvers and biggest declines.
- Recent calls: only the latest 5, with a "View all" link to the Calls page.
Remove from the dashboard: the Add Employee button, the QA scorecard button, the full employee list, and the "score by employee" chart (move that to Analytics).
Everywhere an employee has no analyzed calls, show "—" or "No data yet", never 0.

## 4. Employees page
- Table (with optional card view), search and filters (department, language, status). Columns: photo + name, department, languages, score, trend arrow, calls this period, last call, desktop agent status (online / offline / never connected), coaching status.
- "Add employee" opens a slide-over wizard, not an inline form:
  Step 1 Details: name, photo upload, department as a dropdown with "create new", languages as a multi-select with chips (English, French, German, Spanish).
  Step 2 Connect the desktop agent: show the employee's session key in a password-style field (masked by default, eye icon to reveal/hide, copy button with "Copied" feedback), a "Download installer" button, and short install instructions. Add an "Email setup instructions" option.
  Step 3 Done: the employee appears in the list with status "Waiting for first call".
- CSV import for adding many employees (name, department, languages), generating a key for each.
- Departments are managed entities (create/rename in Settings or inline).

## 5. Session keys (NO expiry, NO one-time display)
- Each employee has one persistent session key. Admins can view it at any time (evaluators cannot reveal it) on the employee's Agent tab and in the wizard: masked by default, eye icon to reveal, copy button.
- Because it must be revealable, store it ENCRYPTED (AES-256-GCM with a master key from an environment variable, ready to be swapped for a KMS), not hashed. For agent authentication, look the key up via a deterministic keyed hash (HMAC) stored alongside the ciphertext.
- Log every reveal and copy in the audit log (who, when, which employee). Rate-limit reveal requests.
- Provide "Regenerate key" with a confirmation dialog explaining that the old key stops working immediately, and "Revoke key". The desktop agent must show a clear error state when its key is revoked.
- The key only grants upload rights for that one employee's calls. It must not grant any read access.
- Update the desktop agent setup flow, README and walkthrough to match.

## 6. Employee profile
Compact header: photo, name, department, languages, overall score, trend. One primary button, "Start AI coaching"; everything else goes in a "More" menu. Tabs:
- Overview: score trend, AI-generated strengths and weaknesses, criteria breakdown for this employee.
- Calls: call table with filters (date range, language, score range). Row click opens the existing Call Detail page.
- Coaching: memos (generate, edit, export PDF), past AI sessions, action items with status. "Focus topics" moves into the Start AI coaching dialog.
- Agent: key (masked / reveal / copy / regenerate / revoke), device status, last seen, agent version.

## 7. Calls page and Coaching page
Calls: global table (employee, date, duration, language, score, flags, status). Filters: date, employee, department, language, score range, "critical failures only", "failed processing". Pagination and sorting. Row click opens Call Detail.
Coaching: four tabs: Needs coaching (a queue showing the reason per employee, e.g. "score fell 12 points" or "failed compliance 3 times", with buttons to generate a memo or start an AI session), Memos, AI sessions, Action items. The "needs coaching" rules (score threshold, drop percentage, repeated critical failures) are configurable in Settings and reused by the dashboard card.

## 8. Guidelines (replaces "QA Scorecards"; rename everywhere in UI, routes and data model, with a migration that preserves existing data)
Purpose: companies have rules for how calls must be handled. Guidelines are Markdown documents that Arocall stores and the AI uses as the source of truth when scoring calls. Markdown ONLY: no PDF upload or conversion anywhere.

8.1 Guidelines page
- A list of guideline documents with: title, version, status (Draft / Active / Archived), last edited by, last edited date, and actions (View, Edit, Archive, Delete).
- Two prominent buttons: "Upload Markdown" and "Write guidelines". Empty state explaining both options, with a "Use a starter template" link.

8.2 Creating a document
- Upload Markdown: accept only .md / .markdown files. Validate extension, MIME type (text/markdown or text/plain), valid UTF-8 content, and a size limit (e.g. 1 MB). Reject everything else with a clear message. After upload the content opens in the editor so the user can review it before saving.
- Write guidelines: opens a blank editor with a title field, optionally prefilled with a starter template (sections for Greeting, Identification and compliance, Tone and empathy, Do's, Don'ts, Escalation, Closing).
- New documents are saved as Draft. An "Activate" button makes a document Active. Several documents can be Active at the same time.

8.3 Viewing and editing
- Document page with two modes: "Preview" (default, Markdown rendered properly with headings, lists, tables, bold/italic, code blocks and links, styled cleanly and sanitized to prevent XSS) and "Edit".
- Edit mode is a small split-pane editor: Markdown text area on the left (monospace, line numbers if easy), live rendered preview on the right (tabbed Write/Preview on mobile). A simple toolbar for heading, bold, italic, bullet list, numbered list, link and table. Title field. Save button, Cancel button, and a warning when leaving with unsaved changes. Optional autosave of the draft locally.
- Every save creates a new version (version number, timestamp, author). A "Version history" panel lists versions, shows a simple diff against the previous version, and lets an admin restore an old version (which creates a new version).
- Only admins can edit and activate; evaluators can view.

8.4 Storage and use in scoring
- Store the Markdown, content hash, version and status in the database. Split the Markdown by headings into sections with stable IDs and section paths (used for citations).
- Scoring behavior: if the total of all Active guidelines fits within a configurable token budget (default about 60k tokens), include ALL of them in full in every scoring prompt (use prompt caching if the provider supports it). Only if they exceed the budget, switch to hybrid retrieval (embeddings plus keyword search) and always include any sections marked "mandatory" (a simple toggle on a heading section). Show which mode is active on the Guidelines page.
- Every scored call stores which guideline versions were used.

8.5 Evaluation criteria (derived layer for consistent scoring)
- After a document is Active, offer "Generate evaluation criteria": the AI drafts a list of criteria (name, description, weight, must-pass flag, pass/fail guidance), each linked to the guideline section(s) it comes from. It must not invent rules that are not in the documents.
- The admin reviews and edits the criteria in a simple table, then approves. Versioned. Calls are scored against the approved criteria set, and the final score is computed in code from the weights, not by the LLM.
- Every criterion result in a call report keeps the verbatim transcript quote and timestamp as evidence AND shows the guideline section it was judged against (clickable, opens that section in the Preview).
- When a guideline is edited and re-activated, show a banner: "Criteria may be out of date. Review criteria" and offer "Re-run analysis" on a call or on a date range.

## 9. Build order (make each phase run before moving on, and give me the commands to test it)
1. New layout shell and sidebar, trimmed dashboard with KPI cards and "Needs attention".
2. Employees page, add-employee wizard, departments, persistent encrypted session keys with reveal/copy/regenerate/revoke and audit log, CSV import. Update the desktop agent auth accordingly.
3. Employee profile tabs.
4. Global Calls page.
5. Coaching page.
6. Guidelines: Markdown upload, write-your-own editor, rendered preview, versioning, storage, scoring integration, evaluation criteria generation and approval, migration from the old scorecards.
7. Settings pages (organization, team and invites, departments and languages, coaching rules, retention, audit log) and walkthrough updates, including a walkthrough step for adding guidelines.

## 10. Rules
- Keep the seeded demo data working. Adapt the seed script to the new Guidelines and criteria structure and include a sample guidelines Markdown file.
- Clean modern UI, loading, empty and error states everywhere, responsive layout.
- Strict per-organization data isolation on every new endpoint.
- Add tests for: Markdown upload validation, Markdown sanitization, guideline versioning and restore, key encryption/decryption and agent authentication with a regenerated key, weighted score calculation, evidence-quote verification.
- Update the README and .env.example (including the key-encryption master key).
- Do not leave TODO stubs in core flows; clearly label anything mocked.