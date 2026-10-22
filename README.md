# LabPulse

LabPulse shows a coding-lab instructor, live, which students are stuck and on what.

Students work in a browser editor that runs their Python tests **on their own laptop**. After each run, only a tiny signal is sent: which exercise, how many tests passed, and the type of error (with names and values stripped). The instructor's dashboard groups students who hit the same mistake, so one hint helps the whole group, and you watch the group shrink as they fix it. When the lab ends, a report shows which exercise lost the class, the top errors, and how long students were stuck.

This is the demo-ready core of the MVP: gateway, live dashboard, browser student editor (Monaco + Pyodide), error grouping, stuck detection, broadcast hints, exercise progress, post-lab report, projector mode and the privacy view. The VS Code extension comes next and will reuse the same server and signal format.

---

## Run it (Windows + Docker Desktop)

1. **Start Docker Desktop** and wait until it says it's running.
2. Open a terminal (PowerShell) in this folder.
3. **Tell LabPulse the address students will type.** Copy `.env.example` to `.env`:

   ```powershell
   copy .env.example .env
   ```

   Then run `ipconfig`, find the **IPv4 Address** of your Wi-Fi or Ethernet adapter (for example `192.168.1.20`), and put it in `.env`:

   ```
   PUBLIC_URL=http://192.168.1.20:8080
   ```

   You can skip this step if you're only trying it on your own machine.
4. **Start everything:**

   ```powershell
   docker compose up --build
   ```

   The first build takes a few minutes. When the log shows `Server listening`, it's ready.
5. Open **http://localhost:8080/teach**, create an instructor account and click **Open the lab**.
6. Put the join screen on the projector. Students open the address shown (`192.168.1.20:8080`) and type the 6-character code.

To stop: `Ctrl+C`, or `docker compose down`. Your labs and reports are kept in a Docker volume (`docker compose down -v` deletes them).

**If students can't connect:** they must be on the same network as your laptop, and Windows Firewall must allow incoming connections on port 8080. The first time Docker publishes the port, Windows usually asks; if you dismissed it, allow "Docker Desktop Backend" in *Windows Security → Firewall → Allow an app through firewall*.

**Putting it online** (a public `https://` address students can reach from anywhere): see [DEPLOY.md](DEPLOY.md).

---

## Try the 5-minute demo

1. Open a lab with **Python Warm-up** and set *Flag a student as stuck after* to **2 minutes**.
2. Let a few people join (or open several private browser windows yourself).
3. Everyone does exercise 1, then runs exercise 2 **without changing it**. Its starter code has a planted bug: `quantity + " x " + ...` raises `TypeError`.
4. The dashboard shows *"Mixing types that don't go together"* with everyone stuck on it in one group.
5. Click **Send a hint to all N**. The suggested hint is already filled in. As students fix it, the dots fill in blue and the count drops: `9 → 2`.
6. Wait 2 minutes: anyone without a passing run appears under **Needs help**.
7. Click **End lab** to open the report: which exercise lost the class, the top errors, time stuck and how many students each hint reached.
8. Show students **What's shared** in the editor: the exact messages their browser sent.

Turn on **Hide names** before projecting the dashboard. Names become *Student 1, Student 2…* on the dashboard and in the report.

---

## Exercises

Exercises live in `exercises/`, one folder per exercise set. The starter set is `exercises/python-warmup/`; change it or add your own. Changes apply to the **next** lab you open (no rebuild or restart needed). A lab that's already running keeps the version it started with, so its report stays accurate.

```
exercises/
  my-lab/
    lab.json
    01-first-exercise/
      prompt.md      what students read (Markdown)
      starter.py     the code they start with
      tests.py       the tests (required)
      hints.json     optional suggested hints for the instructor
```

**lab.json**

```json
{
  "title": "Loops and lists",
  "description": "Shown when you pick the set.",
  "exercises": [
    { "id": "sum-list", "title": "Sum a list", "dir": "01-first-exercise" }
  ]
}
```

`id` must be letters, digits, `-` or `_`, unique within the set. The folder name (`my-lab`) is the set's id.

**tests.py**: plain functions named `test_…`, using `assert` with a helpful message. Import what you test from `solution` (that's the student's code):

```python
from solution import total

def test_simple():
    result = total([1, 2, 3])
    assert result == 6, f"total([1, 2, 3]) should be 6, got {result!r}"
```

Tests run in the order they're written. Write the failure message for students: it's what they see. Only the Python standard library is available. `input()` is disabled (tests call functions directly) and a run is stopped after 6 seconds, so infinite loops can't freeze a laptop.

**hints.json** (optional): suggestions that pre-fill the hint box on the dashboard. Keys are an exception type, or `fail:` plus a test name for a wrong answer:

```json
{
  "TypeError": "Turn numbers into text with str(...) before joining them.",
  "fail:test_simple": "Return the total; don't print it."
}
```

Without a matching key, LabPulse suggests a general hint for that error type. You can always edit the hint before sending.

If a set has a mistake (bad JSON, a missing `tests.py`), it's left out of the list and the server log says why.

---

## Privacy

What leaves a student's laptop:

- The name they typed when joining
- After each run: exercise id, `pass` / `fail` / `error`, tests passed and total, the exception type, the first failing test's name, and the error message with variable names, values, paths and line numbers replaced
- Which exercise they're working on, about every 30 seconds while they type

What never leaves it: their code, their keystrokes, and what their program prints. The browser normalizes the message before sending, and the server normalizes it again and computes the grouping fingerprint itself. It never trusts the client's.

---

## How it works

```
Student browser                    Gateway (Node, stateless)            Instructor dashboard
Monaco + Pyodide in a Web Worker   Fastify + WebSockets                 React
  run tests locally   ── signal ─▶  validate, normalize, fingerprint  ─▶  rebuild room state
                                     store event in Postgres              from the event log
                      ◀── hint ───   publish on Redis channel per room ◀─ broadcast hint
```

- **Event log.** Every join, run, edit ping, hint and lab end is an event in Postgres. The gateway keeps no per-student state in memory, so you can run several gateway instances behind a load balancer; Redis pub/sub carries events between them.
- **One function for the numbers.** `buildRoomState()` and `buildReport()` in `packages/shared` turn the event log into groups, stuck flags, progress and the report. The dashboard, hint targeting and the report all use them, so the numbers always agree.
- **Error grouping.** `normalizeMessage()` strips paths, line numbers, identifiers and literal values but keeps exception types, Python type names (`'int' and 'str'`), keywords and syntax punctuation. `fingerprint()` hashes exercise + error type + normalized message (or the failing test for wrong answers).
- **Stuck detection.** A student is *stuck* when the exercise they're on has had no passing run for N minutes since their first failure, or *idle* when they've done nothing for N minutes (students who finished everything are never flagged).
- **Reliable delivery.** The browser keeps each result until the server acknowledges it and re-sends after a reconnect; the server ignores duplicates.

### Project layout

```
packages/shared   types, fingerprinting, room state, report, wire protocol (+ unit tests)
apps/gateway      Fastify server: auth, rooms, WebSockets, Postgres, Redis (+ integration tests)
apps/web          React app: join page, student editor, dashboard, report, privacy page
exercises         exercise sets (mounted into the container)
e2e               browser tests of the full demo loop (Playwright)
```

### Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PUBLIC_URL` | (empty) | Address shown on the join screen, e.g. `http://192.168.1.20:8080` |
| `DATABASE_URL` | `postgres://labpulse:labpulse@localhost:5432/labpulse` | Postgres |
| `REDIS_URL` | (empty: in-process, single server) | Redis for multi-instance pub/sub |
| `PORT` | `8080` | HTTP port |
| `EXERCISES_DIR` | `./exercises` | Where exercise sets are read from |
| `COOKIE_SECURE` | `false` | Set `true` when served over HTTPS |
| `INSTRUCTOR_SIGNUP_CODE` | (empty: anyone can sign up) | Invite code required to create an instructor account |
| `LOG_LEVEL` | `warn` | `info` logs every request; also `error`, `debug` |

---

## Development

Requires Node 20+ and Docker (for Postgres and Redis).

```powershell
npm install
docker compose up -d postgres redis
npm run dev
```

Open http://localhost:5173. The gateway restarts on changes, and the web app hot-reloads.

### Tests

```powershell
# Unit tests (no services needed): fingerprinting, stuck detection, report numbers
npm test -w @labpulse/shared

# Integration tests: two gateway instances against real Postgres + Redis
docker compose exec postgres createdb -U labpulse labpulse_test
npm test -w @labpulse/gateway

# End-to-end: real browsers, real Python, the whole demo loop (server must be running on :8080)
npx playwright install chromium
npm run e2e
```

The integration tests only run against a database whose name ends in `_test`, because they wipe its tables.

---

## Not in this build yet

- **VS Code extension**: next step. It will send the same signal over the same `/ws/student` protocol.
- **Google sign-in for instructors**: this build uses email and password (hashed with scrypt). Google SSO needs an OAuth client from your Google Cloud console.
- **AI-drafted hints**: left out on purpose for the MVP. The hint box is pre-filled from `hints.json` or a built-in explanation of the error type.
- **Languages other than Python.**
