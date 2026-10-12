# Architecture

How a click on **Run** becomes a world of gophers, and which parts of that world
are real trace data.

## The pipeline

```
cmd/workload            separate process, runtime/trace, binary trace on stdout
      │ bytes
      ▼
internal/tracerun       run → bytes           (owns os/exec, nothing else)
      ▼
internal/traceparse     x/exp/trace → events  (the only package that imports it)
      ▼
internal/timeline       domain model + JSON DTO
      ▼
internal/api            HTTP handlers, clamping, cache
      ▼
web/                    Vite + TypeScript + PixiJS
```

Each arrow is a package boundary, and each boundary exists so the stage on
either side can be tested alone.

## Why the workload runs in a subprocess

Tracing in-process would record the server's own goroutines alongside the
scenario, and `GOMAXPROCS` could not vary per run. So `cmd/workload` is a
separate binary invoked per request:

- it writes **only the binary trace to stdout** — every log, error and
  diagnostic goes to stderr, because anything else on stdout corrupts the
  trace stream;
- `GOMAXPROCS` is a `-gomaxprocs` flag applied via `runtime.GOMAXPROCS` before
  `trace.Start`, not a scenario parameter: it is a property of the runtime, not
  of the workload;
- the workload self-limits via `-duration`, so a killed `go run` cannot leave a
  scenario spinning.

`tracerun.Run` invokes it through its **import path** rather than a relative
`./path`, so the server works from any directory inside the module.

Consequence worth knowing: the backend needs the Go toolchain and the module
source at runtime — it compiles the workload on demand. That is fine for a
local teaching tool, and it is the reason the dev server must not be exposed
publicly: it would compile and run code on request for anyone who can reach it.

## Package boundaries

| Package | Knows about | Deliberately does not know |
|---|---|---|
| `scenarios` | concurrency only | tracing, HTTP, the frontend |
| `tracerun` | `os/exec`, the workload binary | trace format |
| `traceparse` | `golang.org/x/exp/trace` | HTTP, scenarios |
| `timeline` | the domain model and its JSON shape | how events were obtained |
| `api` | HTTP, clamping, caching | how a trace is produced |

`api` receives a `TraceRunner` function as a dependency instead of importing
`tracerun`, so its tests run against a fake with no subprocess at all.
Timelines are cached under a `sync.Mutex`, keyed
`scenario|gomaxprocs|goroutines|duration`.

## The DTO

`timeline.Event` carries `gid`, `pid` and `mid` as `int64`, using **`-1` for
"no such resource"** — and none of them are `omitempty`, because `gid 0`,
`pid 0` and `M0` are all valid identities. Dropping a zero would silently
reassign an event to nothing.

`web/src/model/timeline.ts` mirrors this DTO by hand. It is the one place where
Go and TypeScript must agree; change one and change the other.

## HTTP API

- `GET /api/scenarios` → `[]scenarios.ScenarioInfo`
- `GET /api/run?scenario=&gomaxprocs=&goroutines=&duration=` → `timeline.Timeline`
- `POST /api/trace` (body: raw bytes of a `.trace` file) → `timeline.Timeline`

An unknown scenario is a `404`. Every other `/api/run` parameter is **clamped,
never rejected**: `gomaxprocs` to `[1, 8]`, `duration` to `[100ms, 10s]`, and
`goroutines` to the scenario's own `ParamSpec`. The upper bound on `gomaxprocs`
is a UI constraint (eight isometric stations fit the world), not a Go one.

`/api/trace` has no clamping to fall back on — an arbitrary uploaded trace is
**rejected outright** once it exceeds a limit, because there is no parameter to
adjust on the caller's behalf the way `gomaxprocs` or `duration` can be. Limits
(`internal/api/trace.go`):

| Limit | Value | Error `code` | HTTP status |
|---|---:|---|---:|
| body size | 16 MB | `too_big` | 413 |
| max events | 200,000 | `too_dense` | 400 |
| max observed Ps | 8 (`maxProcs`, same constant as `/api/run`'s `gomaxprocs` clamp) | `too_many_procs` | 400 |
| not a valid trace | — | `not_a_trace` | 400 |
| unreadable / malformed body | — | `unreadable` | 400 |

Unlike scenario runs, uploads are **never cached**: a scenario run's cache key
is `scenario|gomaxprocs|goroutines|duration`, but arbitrary uploaded bytes have
no equivalent natural key — hashing the whole body just to save a parse that
only happens once per upload isn't worth the complexity (see the comment on
`handleTraceUpload` in `internal/api/trace.go`).

## Scenarios

Registered in `init()` into a global map; a duplicate name panics at startup,
because that is a programming error and should be loud.

| Order | Name | Teaches |
|---:|---|---|
| 0 | `workstealing` | CPU scheduling across Ps; queue membership and steals remain unknown |
| 1 | `pingpong` | a ring of goroutines passing tokens; most wait on `chan receive` |
| 2 | `syscalls` | blocking syscall on M; recorded P release and handoff (unix only) |
| 3 | `gcpressure` | allocation drives GC cycles: concurrent mark plus stop-the-world |
| 4 | `mutexhot` | one `sync.Mutex` serializes N workers regardless of P count |
| 5 | `leak` | goroutines block forever on a channel nobody writes to |

`syscalls` is `//go:build unix`; on Windows five scenarios register instead of six.

Adding a scenario is the cheapest way to contribute: one file, a `Register` call
in `init()`, and a test asserting the events it is supposed to produce.

## Frontend layers

```
model/timeline.ts   hand-written mirror of the Go DTO
      ▼
api.ts              fetch, or read the baked matrix when VITE_STATIC=1
      ▼
player/             pure stateAt(t) → WorldState, plus Player (virtual clock)
      ▼
scene/              PixiJS isometric world: gophers, P stations, M carriers
      ▼
ui/                 DOM chrome, event log, assumptions panel, i18n
      ▼
controls.ts / main.ts
```

`player/` is pure and fully unit-tested; the canvas is not. Anything that can
be a pure function — state folding, GC summary, layout, causality rows,
viewport math, share codec, i18n — lives outside the renderer on purpose.

Playback time: `1x` replays the whole run in about 90 seconds of wall time
(`BASE_WALL_MS`), normalized to trace duration. The time axis shows the recorded duration. G and M positions change atomically
at state transitions; poses are decorative. Pause stops the animation clock.

### Reading `mid`

`exptrace.Event.Thread()` is the M of the **executing context**, which is not
always the M you want. On `g_unblock` and `g_create` it is the M of the waker or
creator, not of the target goroutine; on a `p_stop` caused by `ProcSteal` it is
the M of the thief. So the frontend binds `mid` only on own-execution events —
`g_status` (Running/Syscall), `g_run_start`, `g_syscall_enter`,
`g_syscall_exit`, `p_start` — and releases G bindings when G becomes Runnable/Waiting/Dead.
Creator and waker identities use `Event.Goroutine()` directly; old timelines
without `actorGid` fall back to observed Running context. The binding table lives in `stateAt` under vitest,
and the same invariants are mirrored in Go by `TestSchedulerInvariants`.

## Recorded facts and unobservable internals

The always-visible **Assumptions** disclosure states the boundary. This project
uses an ordinary Go runtime; it does not instrument scheduler queues.

| Shown from trace | Unknown or decorative |
|---|---|
| All observed G states, including initial snapshots | Local/global queue membership, runnext, individual steals |
| P/M bindings on own-execution events | Parked M lifecycle, unrecorded context |
| Recorded creator/waker G context (`actorGid`) | Actor unknown when the trace context is absent |
| Complete mark phases and runtime STW intervals | Missing range boundaries; no fabricated GC cycle completion |
| Allocated-object heap bytes / soft GC goal | Heap tiles and GC robot are a visual scale |
| GOMAXPROCS metric and changes | Older payloads without it give a P-count lower bound |
| Syscall state and P release/acquisition events | P-stop initiator and next owner are not inferred |

`g_status` records the first observed state, rather than inventing a creation or
run start. An initially observed state has an unknown start; log durations are
lower bounds (`≥`) until a real transition is recorded. `gc_range_active` likewise
seeds an already active range without claiming its true beginning. Complete
mark phases alone contribute to the mark counter. Runtime STW need not be GC.

`trace_end` preserves the last raw event timestamp even when filtering drops
that event. Heap metrics retain at most one sample per name per 2 ms;
GOMAXPROCS samples are never downsampled. Zero metric values survive JSON.
`meta.numProcs` reserves space for the largest observed P ID or GOMAXPROCS;
`world.gomaxprocs` is the value at the playhead. Retired stations are inactive.

Runnable Gs occupy one unassigned area. `+N` and the runtime counts include
hidden sprites; the drawing cap is not queue capacity. A change of P cannot
prove a steal. Legacy `stolen` flags are ignored, and new timelines clear them.

STWStart precedes the last stopped P, and STWDone follows restarting Ps. The
red cue highlights the recorded range but never overrides observed G states
with a global freeze. Its visible flash lasts 320 ms; the displayed duration
uses trace time. See [the fidelity audit](fidelity-audit.md) for source references
and the regression checks.

## UI states: picking what to replay, and how

The stage the player replays into can be filled two ways, plus a third state
for how it's viewed:

- **scenario picker** — one of the curated scenarios above, run on demand via
  `GET /api/run` and cached by its parameters.
- **custom-trace upload** — a visitor's own `.trace` file, via the chip next to
  the scenario chips (hidden on the static-demo build, since there is no
  backend to upload to) and the instructions/drop-target panel in
  `web/src/ui/uploadtrace.ts`. Not cached, not shareable via the URL share
  codec — only scenario runs have a stable, reproducible parameter set to
  encode.
- **present mode** — a distraction-free fullscreen view, toggled by `F`
  (`Escape` to exit) via `web/src/ui/present.ts`. It doesn't change what's
  replayed, only what chrome is on screen while it plays: a `body.present`
  CSS rule hides the header, timeline, controls and event log, leaving the
  legend and a small auto-hiding "wand" (play/pause, seek, time, close).

## Engineering traps

Hard-won; each one cost a debugging session.

- **`x/exp/trace` must support the local Go trace format.** The header reads
  `go 1.26 trace`. If `NewReader` rejects the version, update `x/exp/trace`.
- **Pace scenarios with CPU work (`busyFor`), never `time.Sleep`.** Sleeping
  parks the goroutine as Waiting, which empties the P stations and makes the
  world look dead. Unpaced channel or allocation scenarios generate millions of
  events (a 16 MB trace in 400 ms).
- **The netpoller trap.** `os.Pipe` and `os.File` go through the poller, so the
  G parks as Waiting, the M is never blocked, and `g_syscall_enter` never
  appears. A genuinely blocking syscall — and therefore an M↔P handoff — needs
  raw `syscall.Pipe` and `syscall.Read` on a blocking fd. `time.Sleep` is a
  timer park, not a syscall either.
- **`goEventType` must cover `Syscall→Runnable`.** A goroutine that leaves a
  syscall through the Runnable state maps to `g_unblock`; miss it and the
  goroutine stays stuck in the syscall zone forever.
- **`traceparse` filters and downsamples on purpose.** Ranges are reduced to
  meaningful GC phases (`stop-the-world`, `mark phase`), dropping
  `incremental sweep` and `mark assist` noise; heap metrics keep a ≥2 ms gap
  between samples of the same name. Without this, `gcpressure` alone produces
  tens of thousands of events.
- **`stop-the-world (start trace)` is not GC.** It is an artifact of starting
  the tracer, filtered out of GC phases — otherwise the UI claims a
  stop-the-world at t=0.
- **Test fixtures cannot be named `*.out`** — that pattern is gitignored. Hence
  `internal/traceparse/testdata/workstealing.trace`.

## Testing strategy

```bash
go test ./...                     # invariants and scenario anti-regressions
cd web && npx vitest run          # pure logic
node scripts/verify-controls.mjs  # Playwright control contract (needs both servers)
node scripts/shoot.mjs            # screenshots for visual review
```

`TestSchedulerInvariants` is the backbone: across every scenario it asserts that
every normalized G transition and actor agrees with the raw trace; running G count never
exceeds `GOMAXPROCS`, that no goroutine starts twice, that P assignments never
conflict, that an M runs at most one G, and that a syscall returns on the same M.
Scenario tests are anti-regressions with real thresholds — `syscalls`, for
example, requires at least five `g_syscall_enter` events and at least two
distinct MIDs on one P.

The visual layer is verified with browser assertions and inspected screenshots: `shoot.mjs` drives
the player through `window.gmp` and writes PNGs, and `verify-controls.mjs`
asserts a contract over every interactive control. `verify-fidelity.mjs` also
checks scene positions, counters, pause, death, STW, upload focus and resizing.
