# Contributing

Thanks for looking. This project has one rule that outranks every other
guideline here:

> **The real Go runtime is the source of truth.** If the trace does not record
> something, we do not draw it as if it did. Anything reconstructed, stylized or
> omitted belongs in the in-app **Assumptions** panel, out loud.

A change that makes the world prettier by making it less true will not be
merged. A change that makes it uglier and more honest probably will.

## Getting set up

Prerequisites: **Go 1.25+**, **Node 20+**.

```bash
go run ./cmd/server                    # terminal 1, listens on :8080
cd web && npm install && npm run dev   # terminal 2, proxies /api to :8080
```

Then open http://localhost:5173. Every **Run** records a fresh trace on your
machine — the numbers you see are yours.

You are not limited to the curated scenarios: the **custom-trace** chip next to
the scenario chips lets you replay a `.trace` file you recorded yourself, from
any program, anywhere. Record one with the standard `runtime/trace` snippet:

```go
f, _ := os.Create("mytrace.trace")
trace.Start(f)
// ... your program ...
trace.Stop()
f.Close()
```

then click the custom-trace chip in the running app and upload `mytrace.trace`.
It goes through the same `Timeline` pipeline as a curated scenario, just
without a scenario name or a cache entry — see
[`docs/architecture.md`](docs/architecture.md#http-api) for the size/density
limits it is checked against.

If :8080 is taken, move the backend and tell the proxy where it went:
`go run ./cmd/server -addr :8085` with `GMP_API_TARGET=http://localhost:8085 npm run dev`.

Before opening a pull request:

```bash
make ci                          # all of the below except the control contract
go vet ./... && go test ./...    # scheduler invariants, scenario anti-regressions
golangci-lint run ./...          # the CI gate; the tree is clean, keep it clean
cd web && npx tsc --noEmit && npx vitest run
node scripts/verify-controls.mjs # needs both servers running
```

CI runs all of it on every pull request, including the Playwright control
contract. [`docs/architecture.md`](docs/architecture.md) explains the pipeline,
the package boundaries and the traps that shaped them — worth ten minutes before
a first change.

## Three good ways in

The architecture was cut so that these three are cheap to write and cheap to
review. If you want to help and don't know where to start, start here.

### 1. Add a scenario

The highest-value contribution, and the most self-contained: one file, one
registration, one test. A scenario is a concurrency workload that teaches
something about the scheduler.

Create `internal/scenarios/yourthing.go` implementing `Scenario` — `Name`,
`Describe`, `Run` — and register it:

```go
func init() { Register(yourThing{}) }
```

Then a test asserting the events it is supposed to produce. Real thresholds, not
smoke tests: `syscalls` requires at least five `g_syscall_enter` events and at
least two distinct thread ids on one P, because that is the phenomenon it exists
to show. If your scenario cannot be told apart from another by its trace, it is
not teaching anything yet.

Two rules that are not obvious, both learned painfully:

- **Pace with CPU work (`busyFor`), never `time.Sleep`.** Sleeping parks the
  goroutine as Waiting, which empties the P stations and makes the world look
  dead. Unpaced channel or allocation scenarios produce millions of events.
- **`os.Pipe` will not give you a blocking syscall.** It goes through the
  netpoller, so the G parks and the M is never blocked. A genuine blocking
  syscall needs raw `syscall.Pipe` and `syscall.Read`.

Ideas worth having: context cancellation, a bounded worker pool, `select` with
timeout, atomics versus a mutex, a pointer-heavy versus pointer-free heap.

### 2. Add a language

The interface ships in Russian and English. Adding a third is genuinely easy,
because **the compiler checks your work**: dictionaries are typed as
`typeof RU`, so a missing string fails `tsc` instead of shipping a blank label.

Add your dictionary to [`web/src/i18n.ts`](web/src/i18n.ts), run
`npx tsc --noEmit`, and fix whatever it names. Scenario titles arrive from the
backend in Russian and are mapped by id in the same file.

### 3. Report a fidelity problem

"The world shows X, but the runtime actually does Y" is the most valuable issue
you can file, and it needs no code. Use the **Fidelity report** template. A
citation from the Go source, the runtime docs or a trace of your own is worth
more than a long argument.

Being wrong about the runtime is the one bug class this project cannot tolerate,
so these get priority.

## Conventions

- **Go**: wrap errors with `%w` and context; sentinel errors (`ErrNotFound`) for
  conditions callers branch on. Modern Go is welcome — range-over-int, builtin
  `max`, per-iteration loop variables.
- **Ignored errors are written down.** `_ = f.Close()`, not a bare call, so the
  intent is visible at the call site. The linter enforces this.
- **Language**: code, identifiers and comments in English. User-facing strings go
  through `t()` — never hardcoded in a component.
- **Pure logic is tested; pixels are not.** Anything that can be a pure function
  — state folding, layout, causality, viewport maths — lives outside the renderer
  and gets a unit test. The canvas is checked by the Playwright harnesses.
- **Commits**: short imperative subject, then a brief list of the main changes.
  Explain *why* when it is not obvious from the diff.

## Pull requests

Branch off `dev`. Keep a pull request to one idea — a scenario, a fix, a
language. Say what you changed and how you know it works; if you touched the
world, a screenshot helps.

Questions are welcome as issues. So is "I read the architecture doc and it is
wrong here" — that is a fidelity report about the documentation.
