// Command bake pre-records timelines for the static demo: it runs the normal
// pipeline (workload subprocess -> trace parse -> timeline build) over a small
// matrix of scenario/parameter combinations and writes the resulting JSONs
// plus an index the frontend's static mode (VITE_STATIC=1) reads instead of
// the live /api endpoints.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"

	"github.com/puddiy/go-scheduler-live/internal/scenarios"
	"github.com/puddiy/go-scheduler-live/internal/timeline"
	"github.com/puddiy/go-scheduler-live/internal/traceparse"
	"github.com/puddiy/go-scheduler-live/internal/tracerun"
)

type bakedRun struct {
	Scenario   string `json:"scenario"`
	Gomaxprocs int    `json:"gomaxprocs"`
	Goroutines int    `json:"goroutines"`
	File       string `json:"file"`
}

type index struct {
	Scenarios []scenarios.ScenarioInfo `json:"scenarios"`
	Runs      []bakedRun               `json:"runs"`
}

func main() {
	out := flag.String("out", "web/public/runs", "output directory for baked runs")
	duration := flag.Duration("duration", 2*time.Second, "per-run trace duration (matches the API default)")
	flag.Parse()

	if err := bake(*out, *duration); err != nil {
		log.Fatal(err)
	}
}

func bake(out string, duration time.Duration) error {
	if err := os.MkdirAll(out, 0o755); err != nil {
		return fmt.Errorf("creating output dir: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	idx := index{Scenarios: scenarios.All()}
	for _, info := range idx.Scenarios {
		def := 20
		for _, p := range info.Params {
			if p.Name == "goroutines" {
				def = p.Default
			}
		}
		// Every scenario gets the full GOMAXPROCS spread: in the static demo the
		// stepper cannot record a fresh trace, so a parameter with nothing baked
		// behind it silently returns the same run and reads as a broken control.
		procs := []int{1, 4, 8}
		for _, np := range procs {
			run, err := bakeOne(ctx, out, info.ID, np, def, duration)
			if err != nil {
				return fmt.Errorf("baking %s p=%d: %w", info.ID, np, err)
			}
			idx.Runs = append(idx.Runs, run)
			log.Printf("baked %s", run.File)
		}
	}

	return writeJSON(filepath.Join(out, "index.json"), idx)
}

func bakeOne(ctx context.Context, out, id string, procs, goroutines int, d time.Duration) (bakedRun, error) {
	raw, err := tracerun.Run(ctx, tracerun.Request{
		Scenario:   id,
		GOMAXPROCS: procs,
		Goroutines: goroutines,
		Duration:   d,
	})
	if err != nil {
		return bakedRun{}, fmt.Errorf("running workload: %w", err)
	}
	events, err := traceparse.Parse(bytes.NewReader(raw))
	if err != nil {
		return bakedRun{}, fmt.Errorf("parsing trace: %w", err)
	}
	tl := timeline.Build(events, procs, id)

	file := fmt.Sprintf("%s-p%d-g%d.json", id, procs, goroutines)
	if err := writeJSON(filepath.Join(out, file), tl); err != nil {
		return bakedRun{}, err
	}
	return bakedRun{Scenario: id, Gomaxprocs: procs, Goroutines: goroutines, File: file}, nil
}

func writeJSON(path string, v any) error {
	f, err := os.Create(path)
	if err != nil {
		return fmt.Errorf("creating %s: %w", path, err)
	}
	defer func() { _ = f.Close() }()
	if err := json.NewEncoder(f).Encode(v); err != nil {
		return fmt.Errorf("encoding %s: %w", path, err)
	}
	return f.Close()
}
