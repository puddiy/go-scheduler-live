package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/puddiy/go-scheduler-live/internal/timeline"
	"github.com/puddiy/go-scheduler-live/internal/tracerun"
)

// fakeRunner returns committed trace bytes, so API tests never spawn a
// subprocess. It records how many times it was called (to prove caching).
type fakeRunner struct {
	raw   []byte
	calls int
}

func (f *fakeRunner) run(_ context.Context, _ tracerun.Request) ([]byte, error) {
	f.calls++
	return f.raw, nil
}

func goldenTrace(t *testing.T) []byte {
	t.Helper()
	raw, err := os.ReadFile("../traceparse/testdata/workstealing.trace")
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestScenariosEndpoint(t *testing.T) {
	srv := httptest.NewServer(New(nil)) // runner unused by this endpoint
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/api/scenarios")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	var infos []map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&infos); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, i := range infos {
		if i["id"] == "workstealing" {
			found = true
		}
	}
	if !found {
		t.Errorf("workstealing scenario not listed: %v", infos)
	}
}

func TestRunEndpointAndCache(t *testing.T) {
	fake := &fakeRunner{raw: goldenTrace(t)}
	srv := httptest.NewServer(New(fake.run))
	defer srv.Close()

	url := srv.URL + "/api/run?scenario=workstealing&gomaxprocs=4&goroutines=50"
	for range 2 { // second request must be served from cache
		resp, err := http.Get(url)
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status = %d, want 200", resp.StatusCode)
		}
		var tl timeline.Timeline
		if err := json.NewDecoder(resp.Body).Decode(&tl); err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()

		if tl.Meta.Scenario != "workstealing" {
			t.Errorf("scenario = %q, want workstealing", tl.Meta.Scenario)
		}
		if tl.Meta.NumProcs != 4 {
			t.Errorf("numProcs = %d, want 4", tl.Meta.NumProcs)
		}
		if len(tl.Events) == 0 {
			t.Error("no events in timeline")
		}
	}
	if fake.calls != 1 {
		t.Errorf("runner called %d times, want 1 (cache miss once)", fake.calls)
	}
}

func TestRunEndpointUnknownScenario(t *testing.T) {
	fake := &fakeRunner{raw: goldenTrace(t)}
	srv := httptest.NewServer(New(fake.run))
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/api/run?scenario=nope")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", resp.StatusCode)
	}
	if fake.calls != 0 {
		t.Errorf("runner called %d times, want 0", fake.calls)
	}
}

func TestParseRunRequestClamps(t *testing.T) {
	tests := []struct {
		name           string
		query          string
		wantProcs      int
		wantGoroutines int
		wantDuration   time.Duration
	}{
		{"defaults", "scenario=workstealing", defaultProcs, 50, defaultDuration},
		{"procs over max", "scenario=workstealing&gomaxprocs=99", maxProcs, 50, defaultDuration},
		{"procs under min", "scenario=workstealing&gomaxprocs=0", minProcs, 50, defaultDuration},
		{"goroutines over spec max", "scenario=workstealing&goroutines=9999", defaultProcs, 200, defaultDuration},
		{"duration over max", "scenario=workstealing&duration=1h", defaultProcs, 50, maxDuration},
		{"duration under min", "scenario=workstealing&duration=1ms", defaultProcs, 50, minDuration},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "/api/run?"+tt.query, nil)
			req, err := parseRunRequest(r)
			if err != nil {
				t.Fatalf("parseRunRequest: %v", err)
			}
			if req.GOMAXPROCS != tt.wantProcs {
				t.Errorf("GOMAXPROCS = %d, want %d", req.GOMAXPROCS, tt.wantProcs)
			}
			if req.Goroutines != tt.wantGoroutines {
				t.Errorf("Goroutines = %d, want %d", req.Goroutines, tt.wantGoroutines)
			}
			if req.Duration != tt.wantDuration {
				t.Errorf("Duration = %v, want %v", req.Duration, tt.wantDuration)
			}
		})
	}
}
