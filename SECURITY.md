# Security

## The dev server is not meant to face the internet

This matters more than a usual "report vulnerabilities here" note, so it comes
first.

`cmd/server` records traces by shelling out to `go run ./cmd/workload` **on every
request** ([`internal/tracerun/runner.go`](internal/tracerun/runner.go)). Two
consequences follow:

- the machine running it needs the Go toolchain and this module's source at
  runtime — it compiles on demand, it is not a self-contained binary;
- anyone who can reach the HTTP endpoint can make it compile and execute a
  program and spend CPU for seconds at a time.

Parameters are clamped rather than rejected (`gomaxprocs` to 1–8, `duration` to
100 ms–10 s, goroutine counts to each scenario's own range), which bounds a single
run but does not make the endpoint safe to expose. There is no authentication, no
rate limiting and no sandbox, because it is a local teaching tool.

**Do not deploy `cmd/server` on a public host.** The hosted demo does not run it:
GitHub Pages serves traces baked ahead of time in CI, with no Go behind it. That
is the intended way to publish this project.

If you want a public instance that records live traces, you are building
something different — expect to add a sandbox, request limits and a queue, and
treat the workload subprocess as untrusted-adjacent code.

## Reporting a vulnerability

Please report privately through
[GitHub Security Advisories](https://github.com/puddiy/go-scheduler-live/security/advisories/new)
rather than a public issue.

This is an educational project maintained in spare time, so please set
expectations accordingly: there is no SLA. Reports that matter most are ones
affecting people who run the project locally as documented — for example a
crafted API parameter escaping the clamps, or the workload subprocess doing
something outside its intended scope.

Reports that a publicly exposed `cmd/server` can be abused are already documented
above and are not treated as vulnerabilities.

## Supply chain

Dependencies are deliberately few: one Go module (`golang.org/x/exp`) and, on the
frontend, PixiJS with Vite, TypeScript, Vitest and Playwright as dev tooling.
Dependabot watches Go modules, npm and the Actions used in CI.
