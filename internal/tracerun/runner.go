// Package tracerun runs a workload scenario in a separate process under the Go
// execution tracer and returns the raw trace bytes.
//
// Running out-of-process (rather than tracing inside the server) keeps the
// server's own goroutines out of the trace, lets each run choose its own
// GOMAXPROCS, and yields a clean, reproducible trace of just the scenario.
package tracerun

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"strconv"
	"time"
)

// workloadPkg is the import path of the workload command. Using the import path
// (not a relative ./path) makes Run work from any directory inside the module.
const workloadPkg = "github.com/puddiy/go-scheduler-live/cmd/workload"

// Request describes one workload run. A struct (rather than positional args)
// keeps the two int fields from being mixed up at call sites.
type Request struct {
	Scenario   string
	GOMAXPROCS int
	Goroutines int
	Duration   time.Duration
}

// Run compiles and runs the workload for req under tracing and returns the raw
// trace bytes. ctx bounds the whole run; cancelling it kills the subprocess.
// The workload also self-limits via its -duration flag, so a killed `go run`
// cannot leave the scenario spinning forever.
func Run(ctx context.Context, req Request) ([]byte, error) {
	if req.Scenario == "" {
		return nil, fmt.Errorf("tracerun: empty scenario")
	}

	args := []string{
		"run", workloadPkg,
		"-scenario", req.Scenario,
		"-goroutines", strconv.Itoa(req.Goroutines),
		"-gomaxprocs", strconv.Itoa(req.GOMAXPROCS),
		"-duration", req.Duration.String(),
	}

	var stdout, stderr bytes.Buffer
	cmd := exec.CommandContext(ctx, "go", args...)
	cmd.Stdout = &stdout // the binary trace stream
	cmd.Stderr = &stderr // build errors, panics, diagnostics

	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("running workload %q: %w; stderr: %s",
			req.Scenario, err, stderr.String())
	}
	if stdout.Len() == 0 {
		return nil, fmt.Errorf("workload %q produced an empty trace; stderr: %s",
			req.Scenario, stderr.String())
	}
	return stdout.Bytes(), nil
}
