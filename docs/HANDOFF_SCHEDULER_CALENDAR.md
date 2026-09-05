# Handoff — Scheduler calendar views (month / week)

Written 2026-09-05. Everything here is either measured or read out of the code;
where something is a judgement call it says so, and where it is undecided it
says who has to decide it.

---

## 1. What the user asked for, in their words

> "if a user gets an email that says on 10-15-2026 we have a safety meeting at
> 10am it would allow it to be added to the calendar. month view would only show
> days that had things on them and the user can click on the day and it would
> show the current day scheduler. same with the week one — it can show a few
> things on the day with a short title or a notification icon like how the
> workspace shows when things are done and have a number on them showing how
> many reminders or events are on that day."

So: **month and week views for the Scheduler**, month showing only days that
have something, clicking a day drilling into the existing day view, and week
showing a few short titles per day with a count badge.

The user then agreed to the one design point raised against it (§4):

> "we should make them distinguishable. for date events I like them that a great
> improvement"

**That agreement is the mandate for §5 — the data-model change is approved in
principle, the details are not.**

---

## 2. The sample to look at first

`docs/ui-samples/scheduler-calendar.html` — open it in a browser.

It renders two month grids of **the same month with the same tasks**. The only
difference is whether recurring automation gets a mark per run or collapses to
one muted line. It also shows the week view and the day drill-in.

It uses Anodex's real theme tokens (copied from
`src/renderer/styles/themes/midnight.css` and `light.css`), matching the other
samples in `docs/ui-samples/`. Verified in both themes with no horizontal
overflow.

Two layout bugs were fixed while building it, both worth knowing because they
will recur in the real implementation:

- Grid items default to `min-width: auto`, so a day label wider than its column
  pushes the whole track out and the panel overflows its container. Every day
  cell needs `min-width: 0`.
- Two month grids side by side gives each day about 65px, which truncates every
  label and makes both halves look equally bad — hiding the very difference the
  comparison exists to show. Seven columns of readable labels need the full
  width.

---

## 3. What the Scheduler is today

Read these before changing anything:

| file                                                | what it is                                          |
| --------------------------------------------------- | --------------------------------------------------- |
| `src/shared/scheduledTask.types.ts`                 | `ScheduledTask`, `TaskRecurrence`                   |
| `src/shared/parseWhen.ts`                           | natural language → recurrence; `describeRecurrence` |
| `src/main/scheduler/SchedulerService.ts`            | the tick loop that fires tasks                      |
| `src/main/scheduler/SchedulerStore.ts`              | persistence                                         |
| `src/main/tools/schedulerTools.ts`                  | `create_scheduled_task`, `delete_scheduled_task`    |
| `src/renderer/features/scheduler/SchedulerView.tsx` | the surface                                         |
| `src/renderer/features/scheduler/TodayStrip.tsx`    | **the existing day view**                           |
| `src/renderer/features/scheduler/todayTimeline.ts`  | builds the day's marks                              |
| `scripts/scheduler-verify.mjs`                      | the only test that proves firing                    |

### The data model

```ts
type RecurrenceType = 'once' | 'daily' | 'weekly' | 'monthly' | 'interval'

interface ScheduledTask {
  id
  name
  prompt
  projectId
  recurrence
  enabledTools
  enabled
  conversationId
  createdAt
  updatedAt
  nextRunAt
  lastRunAt
  lastRunStatus
  lastRunSummary
  runs: TaskRunRecord[]
  runCount
}
```

**Every task is a job that runs `prompt` in a conversation.** There is no
notion of a calendar entry. "Reminder: meeting with James" is a task whose
prompt happens to produce a reminder. This is the crux of §4 and §5.

`todayTimeline.ts` already projects future runs and caps at
`MAX_PROJECTED_PER_TASK = 24` per task per day — evidence that density was
already a known problem at the day scale.

---

## 4. The design decision the sample exists to settle

A month grid that shows "days with things" quietly becomes "every day" the
moment one `interval` or `daily` task exists. Measured against the real cap
above: a 30-minute interval is 48 runs a day. The user's safety meeting is then
one chip among fifty.

So the views need **dated events** and **recurring automation** to be
distinguishable. The user has agreed to that.

**Do not infer the distinction from `RecurrenceType`.** It correlates but is
not the same thing, and using it will be wrong in both directions:

- "run the cleanup script once tomorrow" is `once` and is automation
- "team standup every Monday" is `weekly` and is an event

---

## 5. Proposed implementation, in order

### 5a. Make the distinction real (do this first)

Add to `ScheduledTask`:

```ts
/**
 * Whether this is something happening in the world the user wants to be
 * reminded of, or work Anodex runs on a schedule. Optional: tasks stored
 * before this existed have no answer, and `scheduledTaskKind` supplies the
 * default rather than a migration rewriting history.
 */
kind?: 'event' | 'automation'
```

Add a pure helper (suggest `src/shared/scheduledTaskKind.ts`) with tests:

```ts
export function scheduledTaskKind(task): 'event' | 'automation'
```

Returning the explicit `kind` when set, otherwise defaulting `once` → `event`
and everything else → `automation`. **The default is a convenience, not the
definition** — say so in the comment, or the next person will reintroduce the
mistake §4 warns about.

### 5b. Let it be set where tasks are created

- `create_scheduled_task` in `src/main/tools/schedulerTools.ts` gains an
  optional `kind`, so chat can create an event when the user says "add the
  safety meeting on the 15th".
- The task editor (`SchedulerTaskEditor.tsx`) gains the same control.

### 5c. Show it where tasks already appear

Before building any new view, mark the distinction in the existing list and
`TodayStrip`. This gets it in front of the user, and validates the default
against their real tasks, at a fraction of the cost of a calendar.

### 5d. Then the week view

`weekly` recurrence exists and the day view **structurally cannot** show it — a
Mon/Wed/Fri task looks identical to a daily one. This is a real gap independent
of the calendar idea, and the smaller of the two builds.

### 5e. Then the month view

Only days with events get chips; automation collapses to one muted line
("2 recurring"). Clicking a day opens the existing day view unchanged — reuse
`TodayStrip`, do not build a second day renderer.

---

## 6. Open questions the user still has to answer

1. **Should an event run a prompt at all?** Today every task does. A calendar
   entry might reasonably just notify. If events still run prompts, "add the
   safety meeting" produces a model turn at 10am, which may or may not be what
   the user wants.
2. ~~**Is a monthly recurrence wanted?**~~ **Answered, and built** — see §9.
   `'monthly'` exists, so the month view now has a second reason to exist
   beyond distant `once` tasks.
3. **Where does the email → calendar flow live?** The user's example is an email
   containing a date. `parseWhen` already handles natural language, and email
   tools already exist, but nothing connects them. Is this a chat flow ("add
   that to my calendar"), or something the email surface offers directly?

---

## 9. Monthly recurrence — answered and built (2026-09-05)

Open question 2 turned out not to be a feature request. `monthly` was already
in `REPEAT_WORDS`, where it suppressed the calendar-date branch and then had no
branch of its own, so every monthly phrasing fell through to the bare-time rule:

| typed                                 | stored before                   |
| ------------------------------------- | ------------------------------- |
| `monthly at 9am`                      | `{type: once, hour: 9}`         |
| `on the 1st of every month at 9am`    | `{type: once, hour: 9}`         |
| `the last Friday of the month at 9am` | `{type: weekly, weekdays: [5]}` |

The first two dropped the repeat and the day and labelled themselves "Once at
9:00 AM". The third dropped the _month_ — `matchWeekday` claimed "friday" — and
fired four to five times more often than asked, labelled "Every Fri".

Fixed on branch `fix/monthly-recurrence` (`286fc0a`), with `dayOfMonth` and
`weekOfMonth` added to `TaskRecurrence`. Three things fell out of it:

- Bare `weekly` was the identical absence one row over, and is fixed too.
- `computeNextRunAt` ended in a bare weekly fallthrough, so an unrecognised
  type silently became a weekly rule. Both cases are now stated explicitly.
  **Anything adding to `RecurrenceType` must add a branch there** — it no
  longer inherits one.
- "every 2 months" is rejected rather than rounded down. `IntervalUnit` counts
  minutes, hours and days, and no run of days is a fixed number of months.

Not fixed, same family, still open: a bare ordinal with no month word —
"remind me on the 15th at 9am" — still falls through to the bare-time rule and
becomes a one-shot today or tomorrow. `matchCalendarDate` only recognises a day
number when a month name sits next to it.

---

## 7. How to test it

- **Unit**: `scheduledTaskKind` is pure — test the explicit value, both
  defaults, and that a stored task with no `kind` still gets one.
- **Firing is the part no unit test can prove.** Use
  `scripts/scheduler-verify.mjs`, and read its header first. It scores tasks
  created by `scripts/chat-script-scheduler.json`, so **the script must be run
  first and the app left running about three minutes** for the scheduler to
  reach them. Running the verifier alone reports 4/10 against tasks that do not
  exist. This happened on 2026-09-05 and looked exactly like a real failure.
- Always finish with `node scripts/scheduler-verify.mjs --clean`, which removes
  the test tasks and leaves the user's own alone.
- The Scheduler scored **10/10** on 2026-09-05 with this procedure followed
  correctly, including real firing of both a one-shot and an interval task, and
  the interval rescheduling itself afterwards. That is the baseline to protect.

---

## 8. Gotchas earned the hard way today

- **Run the pairing script before the verifier.** See §7. Two separate false
  readings came from this on the same afternoon: `4/10` from scoring absent
  tasks, and `3/10` from `chat-matrix` applying the _default chat rubric_ to a
  scheduler script because `--criteria` was omitted.
- **Editing `src/` restarts the app.** `electron-vite dev` reloads on change,
  which destroys any run in flight. Do not edit source while a benchmark or a
  scheduled task is being waited on.
- **Stamp the context size on every measurement.** The same agent suite scores
  6/6 at 65,536 and 1/6 at 8,192. A rating without its context is not a rating.
- **All new UI must use `theme.css` tokens and be checked in both themes.**
  The sample does this; the real implementation must too.
