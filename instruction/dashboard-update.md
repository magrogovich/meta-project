Update the Dashboard of the existing, working Arocall codebase. Do not rewrite from scratch and do not break working features. Keep the existing tech stack and chart library. Before changing anything, inspect the current dashboard code, API routes, data model and seed script, and give me a short plan listing the files, endpoints and tables you will change. The goal is a dashboard that a call center QA manager can trust and act on, replacing the current one, which shows thin or empty charts, contradictory numbers and no context.

## 1. Bugs to fix first
- Charts render with zero or near-zero height (bars appear as thin lines). Fix the sizing so charts always have an explicit height and render at any data size.
- The trend chart has no axes, labels or tooltips. Add them.
- Default the date range to the last 30 days, compared against the previous 30 days. All "vs previous period" comparisons depend on this. When the user picks a custom range, compare against the immediately preceding period of equal length.
- Contradiction: "Critical failures: 0" while the compliance criterion failed twice. Verify how must-pass is determined. A call counts as a critical failure if ANY criterion flagged must-pass failed on that call. Ensure compliance-type criteria are flagged must-pass in the seed data and in criteria generation, and that the dashboard uses the same definition everywhere.
- Coverage mixes two unrelated things. Coverage means ONLY: analyzed calls divided by calls recorded (uploaded) in the period. "Agents online" is removed from this card and shown only in Needs attention / Employees.
- Empty-data rule: never show 0 for "no data". Show "—" and a short explanation.

## 2. Settings (Settings > Quality targets, admin only)
- Team QA score target (default 80).
- Pass threshold for a call (default 70).
- Score drop alert threshold in points (default 10) and repeated-failure count (default 3).
These feed the dashboard and the existing "needs coaching" rules.

## 3. Dashboard layout (top to bottom)
Filter bar: date range, department, language (applies to everything below). Show the active comparison period in small text.

Row 1: six KPI cards. Each shows the value, the change vs the previous period (colored arrow, points or percent), and a small sparkline where noted:
1. QA score: average call score, target marker, sparkline.
2. Pass rate: % of analyzed calls with score >= pass threshold.
3. Critical failure rate: % of analyzed calls with a must-pass failure, plus the absolute count.
4. Customer sentiment: % of calls where end sentiment is neutral or positive, labeled "AI estimate".
5. Resolution rate: % of calls where the issue was resolved (excluding "unclear"), labeled "AI estimate".
6. Coverage: analyzed / recorded calls, with a small note "typical manual QA reviews 1-2% of calls".
Secondary small line inside cards where useful: calls analyzed (QA score card), average handle time (Pass rate card).
Every card has a tooltip explaining exactly how it is calculated. Clicking a card navigates to the Calls page with matching filters applied.

Row 2: Needs attention. A list ranked by severity, with a colored severity badge per item, each with one click to open the evidence and, where relevant, a "Start coaching" action:
- Critical: a call failed a must-pass criterion (link to the call).
- Warning: an agent dropped more than the threshold vs the previous period; an agent failed the same criterion N times in a row; the customer asked for a supervisor; an employee requested a human evaluator in an AI coaching session.
- Info: a desktop agent is offline; a call failed processing.
Show the 8 most severe, with a "View all" link. Empty state: "Nothing needs your attention."

Row 3: two charts side by side.
- Score trend: team average per day (or per week when the range exceeds 60 days) as a line, a dashed horizontal line at the target, call volume as faint bars behind it on a secondary axis, labeled axes, tooltip with date, average score and number of calls. If fewer than 3 data points exist, show a friendly "Not enough data yet" message instead of a misleading line.
- Criteria performance: horizontal bars of pass rate per criterion, sorted worst first, each with the change vs the previous period and the number of calls evaluated. Clicking a bar opens the Calls page filtered to calls that failed that criterion.

Row 4: Agent x criteria heatmap (the centerpiece).
- Rows are employees, columns are criteria, cells are colored by pass rate (clear red to green scale with a legend), with the cell showing the percentage on hover. Final columns: overall score and trend arrow. Sort by overall score ascending by default; sortable.
- Clicking a cell opens the Calls page filtered by that employee and that criterion failed.
- Cells with fewer than 3 evaluated calls are shown gray with "low data".
- Horizontal scroll on small screens.

Row 5: two blocks.
- Agents table: name, score, change vs previous period, calls, critical failures, weakest criterion, last coaching date. Sortable on every column. This replaces Top improvers and Biggest declines (sort by change instead). Rows link to the employee profile.
- Conversation metrics: team average with the outlier agents highlighted for: talk-to-listen ratio, dead air %, interruptions per call, average handle time, speaking pace (words per minute). Each metric shows a short explanation tooltip.

Remove from the Dashboard: the score distribution histogram (move it to the Analytics page and show the median next to the average), and the old Top improvers / Biggest declines blocks. Do not build the coaching impact section or call-reason breakdown now.

## 4. New data the pipeline must produce
Extend the existing AI analysis output schema (keep structured JSON with schema validation). Each of the following must include a verbatim transcript quote and timestamp as evidence, verified by the existing evidence-quote check:
- customer_sentiment_start and customer_sentiment_end: one of negative / neutral / positive.
- issue_resolved: yes / no / unclear.
- customer_requested_supervisor: boolean.
Show these in Call Detail with their evidence, labeled "AI estimate".

Computed in code from the two audio channels and transcript timestamps, never by the LLM:
- Talk-to-listen ratio (agent speaking time divided by customer speaking time).
- Dead air % (time where neither side speaks, excluding gaps shorter than 2 seconds, divided by call duration).
- Interruptions per call (agent starts speaking while the customer is speaking, with more than 0.5 seconds of overlap).
- Average handle time (call duration).
- Words per minute for the agent (transcript words divided by agent speaking time).
Store them on the Call record. For calls analyzed before this update, offer a "Re-run analysis" bulk action (or a backfill script) and show "—" until done.

## 5. Backend
- Create dedicated dashboard endpoints, each accepting date range, comparison period, department and language, strictly scoped to the organization: summary KPIs with deltas and sparkline series, needs-attention list, score trend series, criteria pass rates, heatmap data, agents table, conversation metrics.
- Aggregate in SQL (or the existing query layer), not in the frontend. Add indexes if queries are slow. Cache for a short time (for example 60 seconds) if easy.
- Return the metric definitions together with the values so the tooltips stay in sync with the code.

## 6. Seed data (important for a meaningful demo)
Update the seed script to produce: 5 employees across 2 departments and 2-3 languages; about 60 calls spread over the last 60 days (so both the current and previous periods have data); one employee who clearly improves, one who clearly declines, one consistently strong, one weak on one specific criterion (for example empathy), and one average. Include at least 3 calls with must-pass (compliance) failures, a mix of sentiment and resolution outcomes, a few supervisor requests, a couple of failed-processing calls, and realistic conversation metrics. Make the heatmap show a clear pattern and the trend chart show a visible story.

## 7. UI quality
- Consistent colors: one green / amber / red scale used for scores, deltas and the heatmap. A score is "good" at or above target, "ok" between pass threshold and target, "bad" below the pass threshold.
- Loading skeletons, error states with retry, and meaningful empty states on every block.
- Responsive layout (cards wrap, tables scroll horizontally).
- Everything shown must be traceable: any number leads to the calls behind it within one or two clicks.

## 8. Tests
- KPI calculations (pass rate, critical failure rate, coverage, sentiment and resolution rates, deltas with a zero previous value, no-data cases).
- Critical failure definition (must-pass flag on any failed criterion).
- Conversation metrics from synthetic two-channel timelines (talk ratio, dead air, interruptions).
- Heatmap aggregation including the low-data rule.
- Organization isolation on every new endpoint.

## 9. Build order (each phase must run before moving on, with the commands to test it)
1. Bug fixes, quality target settings, default date range, new seed data.
2. KPI endpoints and cards, severity-ranked Needs attention.
3. Score trend and criteria performance charts.
4. Agent x criteria heatmap and merged agents table.
5. New AI fields (sentiment, resolution, supervisor request) and computed conversation metrics, Call Detail updates, backfill, conversation metrics block.
6. Move the histogram to Analytics, README and walkthrough updates.

Definition of done: with the seeded demo data, the dashboard shows meaningful deltas against the previous period, a trend with a target line, a heatmap with a visible weak spot, a ranked attention list, and every number links to its underlying calls.