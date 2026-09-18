// Package api exposes the backend over HTTP: it lists scenarios and turns a run
// request into a normalized Timeline (run the workload, parse the trace, build
// the model). It depends on a TraceRunner rather than on tracerun directly, so
// it can be tested without spawning a subprocess.
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/puddiy/go-scheduler-live/internal/scenarios"
	"github.com/puddiy/go-scheduler-live/internal/timeline"
	"github.com/puddiy/go-scheduler-live/internal/traceparse"
	"github.com/puddiy/go-scheduler-live/internal/tracerun"
)

// TraceRunner runs a workload and returns the raw execution-trace bytes.
// tracerun.Run satisfies this; tests supply a fake.
type TraceRunner func(ctx context.Context, req tracerun.Request) ([]byte, error)

// Clamp bounds for run parameters. maxProcs is a UI constraint, not a Go one:
// GOMAXPROCS can be hundreds, but the isometric scene has a fixed row of P-stations
// (see web/src/scene/iso.ts stationPositions), so we cap it to keep the world legible.
const (
	minProcs        = 1
	maxProcs        = 8
	defaultProcs    = 4
	minDuration     = 100 * time.Millisecond
	maxDuration     = 10 * time.Second
	defaultDuration = 2 * time.Second
)

type server struct {
	run TraceRunner

	mu    sync.Mutex
	cache map[string]timeline.Timeline
}

// New returns an http.Handler serving the API, using run to execute workloads.
func New(run TraceRunner) http.Handler {
	s := &server{run: run, cache: make(map[string]timeline.Timeline)}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/scenarios", s.handleScenarios)
	mux.HandleFunc("GET /api/run", s.handleRun)
	mux.HandleFunc("POST /api/trace", s.handleTraceUpload)
	return mux
}

func (s *server) handleScenarios(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, scenarios.All())
}

func (s *server) handleRun(w http.ResponseWriter, r *http.Request) {
	req, err := parseRunRequest(r)
	if err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, scenarios.ErrNotFound) {
			status = http.StatusNotFound
		}
		writeError(w, status, err)
		return
	}

	key := cacheKey(req)
	if tl, ok := s.cached(key); ok {
		writeJSON(w, http.StatusOK, tl)
		return
	}

	raw, err := s.run(r.Context(), req)
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("running scenario: %w", err))
		return
	}
	events, err := traceparse.Parse(bytes.NewReader(raw))
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("parsing trace: %w", err))
		return
	}
	tl := timeline.Build(events, req.GOMAXPROCS, req.Scenario)

	s.store(key, tl)
	writeJSON(w, http.StatusOK, tl)
}

// parseRunRequest validates and clamps query parameters into a tracerun.Request.
// Out-of-range values are clamped (not rejected); only a missing or unknown
// scenario is an error.
func parseRunRequest(r *http.Request) (tracerun.Request, error) {
	q := r.URL.Query()
	name := q.Get("scenario")
	if name == "" {
		return tracerun.Request{}, fmt.Errorf("missing scenario parameter")
	}
	sc, err := scenarios.Get(name)
	if err != nil {
		return tracerun.Request{}, err
	}

	return tracerun.Request{
		Scenario:   name,
		GOMAXPROCS: clampInt(q.Get("gomaxprocs"), defaultProcs, minProcs, maxProcs),
		Goroutines: clampGoroutines(q.Get("goroutines"), sc.Describe()),
		Duration:   clampDuration(q.Get("duration"), defaultDuration, minDuration, maxDuration),
	}, nil
}

func clampInt(s string, def, lo, hi int) int {
	v, err := strconv.Atoi(s)
	if err != nil {
		v = def
	}
	return min(max(v, lo), hi)
}

// clampGoroutines clamps to the scenario's own "goroutines" ParamSpec when it
// declares one, so each scenario controls its sane range.
func clampGoroutines(s string, info scenarios.ScenarioInfo) int {
	lo, hi, def := 1, 200, 50
	for _, p := range info.Params {
		if p.Name == "goroutines" {
			lo, hi, def = p.Min, p.Max, p.Default
			break
		}
	}
	v, err := strconv.Atoi(s)
	if err != nil {
		v = def
	}
	return min(max(v, lo), hi)
}

func clampDuration(s string, def, lo, hi time.Duration) time.Duration {
	v, err := time.ParseDuration(s)
	if err != nil {
		v = def
	}
	return min(max(v, lo), hi)
}

func cacheKey(req tracerun.Request) string {
	return fmt.Sprintf("%s|%d|%d|%s", req.Scenario, req.GOMAXPROCS, req.Goroutines, req.Duration)
}

func (s *server) cached(key string) (timeline.Timeline, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tl, ok := s.cache[key]
	return tl, ok
}

func (s *server) store(key string, tl timeline.Timeline) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cache[key] = tl
}

// writeJSON encodes into a buffer first so a marshal failure can still return a
// clean 500 instead of a half-written body with a 200 status.
func writeJSON(w http.ResponseWriter, status int, v any) {
	var buf bytes.Buffer
	if err := json.NewEncoder(&buf).Encode(v); err != nil {
		http.Error(w, `{"error":"encoding response"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(buf.Bytes())
}

func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error()})
}
