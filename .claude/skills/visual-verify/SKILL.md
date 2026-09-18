---
name: visual-verify
description: Verify a UI/scene change in the running app with the Playwright harnesses in web/scripts — screenshots at trace positions and the 37-assertion control check. Use when asked whether a visual change works, to screenshot the scene, to check that buttons/controls still behave, or before claiming a frontend change is done.
---

# Visual verification

The canvas scene has no component tests worth the name — verification is
**headless Playwright against the running app**. Both servers must be up.

## 1. Start both servers

```bash
make run        # backend on :8080
make web        # Vite, proxying /api to it
```

If `:8080` is taken, name the process holding it, then move the backend:
`make run web ADDR=:8085` (use that port in the `curl` check below).

Note the port Vite actually prints — it takes the next free one (`:5173`,
`:5176`, …) and every command below needs the real value in `SHOOT_URL`.

Wait for both before shooting:

```bash
curl -s --retry 30 --retry-connrefused --retry-delay 1 --connect-timeout 2 \
  http://localhost:8080/api/scenarios -o /dev/null -w "api HTTP %{http_code}\n"
curl -s --retry 30 --retry-connrefused --retry-delay 1 --connect-timeout 2 \
  http://localhost:5176/ -o /dev/null -w "vite HTTP %{http_code}\n"
```

## 2. Screenshots of the scene

```bash
SHOOT_URL=http://localhost:5176 SHOOT_OUT=<scratchpad> SHOOT_DELAY=850 \
  node web/scripts/shoot.mjs
```

Writes one PNG per trace fraction (0.05 / 0.15 / 0.45 / 0.85). **Read the PNGs**
— that is the point of the harness. `shoot-all.mjs` covers every scenario,
`hero.mjs` produces the marketing shot.

The harness collects `console.error` and `pageerror` into an `errors` list. A
clean screenshot with a non-empty error list is a **failed** verification.

## 3. Control contract

```bash
node web/scripts/verify-controls.mjs      # expects 37/37
```

Exercises every button/affordance and asserts the resulting player and timeline
state. Anything below 37/37 is a regression — report which assertion failed, do
not re-run hoping for a different number. On a slow machine stretch the budget
with `CONTRACT_TIMEOUT_SCALE=2` rather than editing the waits.

## 4. Then the normal gate

```bash
make ci        # gofmt, vet, go test, golangci-lint, tsc --noEmit, vitest
```

## Rules

- **Never claim a visual change works without looking at a screenshot** or a
  passing control run. "The code looks right" is not verification here.
- Stop the servers when finished and say which ports were freed.
- If the trace data looks wrong, suspect the parser, not the renderer: the real
  Go runtime is the source of truth, and anything reconstructed or stylized must
  be listed in the in-app Assumptions panel.
- Don't edit `internal/traceparse/testdata/*.trace` — those are binary
  recordings of real runs, data rather than source.
