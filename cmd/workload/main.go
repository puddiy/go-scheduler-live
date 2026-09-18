// Command workload runs a named concurrency scenario under the Go execution
// tracer and writes the raw trace to stdout.
//
// Nothing else may be written to stdout: the trace is a binary stream and any
// stray output would corrupt it. All diagnostics go to stderr.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"runtime"
	"runtime/trace"
	"time"

	"github.com/puddiy/go-scheduler-live/internal/scenarios"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "workload:", err)
		os.Exit(1)
	}
}

func run() error {
	name := flag.String("scenario", "", "scenario name to run")
	goroutines := flag.Int("goroutines", 50, "number of goroutines to spawn")
	procs := flag.Int("gomaxprocs", 0, "GOMAXPROCS to use; 0 keeps the runtime default")
	duration := flag.Duration("duration", 2*time.Second, "max wall-clock time before the scenario is cancelled")
	flag.Parse()

	if *name == "" {
		return errors.New("missing required flag -scenario")
	}
	sc, err := scenarios.Get(*name)
	if err != nil {
		return err
	}
	// Set GOMAXPROCS before tracing starts so the trace reflects the intended
	// number of Ps from its first event.
	if *procs > 0 {
		runtime.GOMAXPROCS(*procs)
	}

	ctx := context.Background()
	if *duration > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, *duration)
		defer cancel()
	}

	if err := trace.Start(os.Stdout); err != nil {
		return fmt.Errorf("starting trace: %w", err)
	}
	defer trace.Stop()

	if err := sc.Run(ctx, scenarios.Params{Goroutines: *goroutines, Duration: *duration}); err != nil {
		return fmt.Errorf("running scenario %q: %w", *name, err)
	}
	return nil
}
