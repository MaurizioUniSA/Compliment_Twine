# Complement activity: analytics setup and test protocol

Files: `index-v6.html` (activity) · `Code.gs` (Google Apps Script) · this guide.

## 1. One-time setup (about 10 minutes)

1. Create a Google Sheet (any name).
2. **Extensions → Apps Script.** Delete the sample code, paste all of `Code.gs`, save.
3. In the editor choose the function **`setup`** and click **Run**. Accept every authorisation prompt.
   This creates the tabs (Sessions, MCQ Results, Answers, Time on Page, Page Views, Health, Errors) and sets the
   `student_code` / `session_id` / `event_id` columns to **Plain Text before any data arrives**.
4. **Deploy → New deployment → Web app.** Execute as **Me**, Who has access **Anyone**. Copy the `/exec` URL.
5. In `index-v6.html` set `ANALYTICS_CONFIG.SCRIPT_URL` to that URL.
6. Optional but recommended: set `ANALYTICS_CONFIG.ALLOCATED_CODES` to the list of real codes, e.g. `["02210","02211"]`.
   Any other code is then flagged `is_test = true` (session_type `unlisted`).

### Changing the script later
**Deploy → Manage deployments → pencil → Version: New version → Deploy.** Never use "New deployment": it makes a
new URL and the old one keeps serving old code. Using a new deployment was a likely cause of the day-two failure.

## 2. What is logged (tabs)

| Tab | One row per | Key fields |
|---|---|---|
| Sessions | page load (session) | student_code (text), session_type, is_test, active_seconds, wall_seconds, end_reason, last_seen_at, questions_answered, first_attempt_correct, mcq_score, mcq_completed, prev_session_id |
| Answers | every attempt at an embedded question | question_id, option_text, destination_passage, **correct**, dest_name_says_correct, signals_agree, attempt_number, first_attempt_correct |
| MCQ Results | each of the 10 retrieval questions | q_number, option_text, destination_passage, correct, score_so_far |
| Time on Page | page visit (or part of one) | passage, active_seconds, wall_seconds, segment_reason |
| Page Views | page view | passage, prev_passage, nav_type (start / link / back), view_number |
| Health | each health-check ping | received_at, source |
| Errors | each failed server-side write | where, message |

- **`correct`** is decided from the destination page the student is actually sent to (the same page that shows the
  green or red feedback box). The destination passage name is logged as well, and `signals_agree` is `TRUE` when the
  two agree.
- **`session_type`**: `student`, `test` (12345, 99999, 00000, 11111 or `#####_TEST`), `instructor` (`#####_EDUCATOR`)
  or `unlisted`. `is_test` is `TRUE` for everything except `student`.
- **Time**: `active_seconds` only counts while the tab is visible **and** there was interaction in the last 60 s.
  `wall_seconds` is raw elapsed time. Use `active_seconds` for analysis. A running total is logged every 30 s, and on
  tab hidden / close.
- **Refreshing the page** starts a new session row; `prev_session_id` links it to the one before.
- **Duplicates**: the client may re-send events (retry / page close). The server ignores repeated `event_id`s for 6 hours.
  If you ever see repeats, remove duplicates on `event_id`.

## 3. Instructor checks before every session day

1. Open the activity **with `?check=1` on the end of the address** (for example `https://your-site/?check=1`). The status is hidden from
   students, and `?check=1` reveals it. The code screen must say **"Analytics connected ✓"** (green). Red means not connected, with the
   reason (URL not set, expired deployment, authorisation page, quota). Fix before students start.
2. Optional: open `<SCRIPT_URL>?action=ping` in a browser tab. You should see `{"ok":true,"sheet_ok":true,...}` and a new row in **Health**.
3. Open the activity with `?selftest=1` on the end of the address. It clicks every option of every one of the 28
   check-questions, confirms the logged `correct` matches what the page shows, and must say **SELF-TEST PASSED ✓**
   (28 questions, 96 options, 0 failures). Nothing is sent to the Sheet.

The small status pill (bottom-right, **Analytics ✓** or **Analytics ✗ (n saved)**) is also hidden from students. It appears for test and instructor codes (`12345`, `#####_TEST`, `#####_EDUCATOR`) and whenever `?check=1` is used. If a send fails the
client retries with back-off, then keeps the events in the browser (localStorage) and sends them when the connection returns.

## 4. Test protocol before the real deployment

1. Run steps 3.1 to 3.3 at the start of **every** session day.
2. Have 2 or 3 people (not only the developer) do a full run-through, deliberately getting some questions wrong first.
   Compare their **Answers** rows (option, correct, attempt_number), **Time on Page** and **Sessions** row to what happened.
3. 24-hour test: leave the deployment untouched for 24 hours, then run 3.1 again and complete one short session. Confirm rows still arrive.
4. Instructor run: log in with `#####_EDUCATOR`, complete a session, and confirm it appears with `session_type = instructor`, `is_test = TRUE`.
5. Enter a code with a leading zero (for example `02210`), then check it is still `02210` in **Sessions**, **Answers**, **Page Views** etc.
   (Sheets should show the column as Plain Text.)
6. Outage test: turn off Wi-Fi, answer two questions, turn it back on, and check the Sheet gains those rows.
7. Close the tab mid-page. Confirm the Sessions row shows `end_reason = hidden` or `unload` and a sensible `active_seconds`.

## 5. Things to know

- Apps Script has daily execution quotas and limits on simultaneous runs. The client batches events (about 1.5 s) and
  sends a 30 s heartbeat only when something changed. If the server answers "busy" the client retries automatically.
- If a Google authorisation page is ever served instead of JSON, the health check turns red. Re-run `setup` in the editor and re-deploy as a **new version**.
- Failed server-side writes are recorded in the **Errors** tab.
