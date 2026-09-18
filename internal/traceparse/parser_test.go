package traceparse

import (
	"os"
	"testing"

	exptrace "golang.org/x/exp/trace"

	"github.com/puddiy/go-scheduler-live/internal/timeline"
)

// TestParseGolden parses a committed real trace and checks invariants rather
// than exact counts/timestamps, so it stays green if the trace is regenerated.
func TestParseGolden(t *testing.T) {
	f, err := os.Open("testdata/workstealing.trace")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()

	events, err := Parse(f)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if len(events) == 0 {
		t.Fatal("Parse returned no events")
	}

	// The reader yields events in time order; Parse must preserve that.
	for i := 1; i < len(events); i++ {
		if events[i].T < events[i-1].T {
			t.Fatalf("events not time-ordered at index %d: %d < %d", i, events[i].T, events[i-1].T)
		}
	}
	if last := events[len(events)-1].T; last <= 0 {
		t.Errorf("last event time = %d, want > 0", last)
	}

	// The workload spawned 50 worker goroutines; each is created, runs, exits.
	counts := map[timeline.EventType]int{}
	distinctG := map[int64]struct{}{}
	for _, e := range events {
		counts[e.Type]++
		if e.GID != timeline.NoResource {
			distinctG[e.GID] = struct{}{}
		}
	}
	for _, want := range []struct {
		typ timeline.EventType
		min int
	}{
		{timeline.EventGCreate, 50},
		{timeline.EventGRunStart, 50},
		{timeline.EventGExit, 50},
	} {
		if counts[want.typ] < want.min {
			t.Errorf("event %q: got %d, want >= %d", want.typ, counts[want.typ], want.min)
		}
	}
	if len(distinctG) < 50 {
		t.Errorf("distinct goroutines = %d, want >= 50", len(distinctG))
	}

	// M (OS thread) ids come from each event's executing context. Execution
	// events must carry a real mid; resource-less range/metric events must not.
	distinctM := map[int64]struct{}{}
	for i, e := range events {
		switch e.Type {
		case timeline.EventGRunStart, timeline.EventGSyscallEnter,
			timeline.EventGSyscallExit, timeline.EventPStart:
			if e.MID < 0 {
				t.Fatalf("event %d (%s): MID = %d, want >= 0", i, e.Type, e.MID)
			}
			distinctM[e.MID] = struct{}{}
		case timeline.EventGCRangeBegin, timeline.EventGCRangeEnd, timeline.EventMetric:
			if e.MID != timeline.NoResource {
				t.Fatalf("event %d (%s): MID = %d, want NoResource", i, e.Type, e.MID)
			}
		}
	}
	if len(distinctM) < 2 {
		t.Errorf("distinct Ms on execution events = %d, want >= 2", len(distinctM))
	}
}

// TestParseAndBuildReal exercises the full parse -> build pipeline on the real
// trace and reports how much work-stealing the heuristic reconstructs.
func TestParseAndBuildReal(t *testing.T) {
	f, err := os.Open("testdata/workstealing.trace")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()

	events, err := Parse(f)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}

	tl := timeline.Build(events, 4, "workstealing")
	if tl.Meta.NumProcs != 4 {
		t.Errorf("NumProcs = %d, want 4", tl.Meta.NumProcs)
	}

	stolen := 0
	for _, e := range tl.Events {
		if e.Type == timeline.EventGRunStart && e.Stolen {
			stolen++
		}
	}
	t.Logf("real trace: events=%d goroutines=%d stolenRunStarts=%d",
		len(tl.Events), len(tl.Meta.Goroutines), stolen)
	if stolen == 0 {
		t.Error("expected reconstructed steals on a 50-goroutine / 4-P trace, got 0")
	}
}

func TestGoEventType(t *testing.T) {
	tests := []struct {
		name     string
		from, to exptrace.GoState
		wantType timeline.EventType
		wantOK   bool
	}{
		{"create", exptrace.GoNotExist, exptrace.GoRunnable, timeline.EventGCreate, true},
		{"run start", exptrace.GoRunnable, exptrace.GoRunning, timeline.EventGRunStart, true},
		{"run start from undetermined", exptrace.GoUndetermined, exptrace.GoRunning, timeline.EventGRunStart, true},
		{"syscall enter", exptrace.GoRunning, exptrace.GoSyscall, timeline.EventGSyscallEnter, true},
		{"syscall exit", exptrace.GoSyscall, exptrace.GoRunning, timeline.EventGSyscallExit, true},
		{"block", exptrace.GoRunning, exptrace.GoWaiting, timeline.EventGBlock, true},
		{"unblock", exptrace.GoWaiting, exptrace.GoRunnable, timeline.EventGUnblock, true},
		{"syscall to runnable", exptrace.GoSyscall, exptrace.GoRunnable, timeline.EventGUnblock, true},
		{"run stop", exptrace.GoRunning, exptrace.GoRunnable, timeline.EventGRunStop, true},
		{"exit", exptrace.GoRunning, exptrace.GoNotExist, timeline.EventGExit, true},
		{"uninteresting", exptrace.GoRunnable, exptrace.GoRunnable, "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotType, gotOK := goEventType(tt.from, tt.to)
			if gotType != tt.wantType || gotOK != tt.wantOK {
				t.Errorf("goEventType(%v, %v) = (%q, %v), want (%q, %v)",
					tt.from, tt.to, gotType, gotOK, tt.wantType, tt.wantOK)
			}
		})
	}
}

func TestProcEventType(t *testing.T) {
	tests := []struct {
		name     string
		from, to exptrace.ProcState
		wantType timeline.EventType
		wantOK   bool
	}{
		{"start", exptrace.ProcIdle, exptrace.ProcRunning, timeline.EventPStart, true},
		{"start from undetermined", exptrace.ProcUndetermined, exptrace.ProcRunning, timeline.EventPStart, true},
		{"stop", exptrace.ProcRunning, exptrace.ProcIdle, timeline.EventPStop, true},
		{"undetermined to idle ignored", exptrace.ProcUndetermined, exptrace.ProcIdle, "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotType, gotOK := procEventType(tt.from, tt.to)
			if gotType != tt.wantType || gotOK != tt.wantOK {
				t.Errorf("procEventType(%v, %v) = (%q, %v), want (%q, %v)",
					tt.from, tt.to, gotType, gotOK, tt.wantType, tt.wantOK)
			}
		})
	}
}
