package tracerun

import (
	"bytes"
	"context"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/puddiy/go-scheduler-live/internal/timeline"
	"github.com/puddiy/go-scheduler-live/internal/traceparse"
)

// TestRunProducesParsableTrace runs the full pipeline: subprocess workload ->
// raw trace -> parse -> build. It compiles and runs the workload, so it is
// skipped under -short.
func TestRunProducesParsableTrace(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping: compiles and runs the workload subprocess")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	raw, err := Run(ctx, Request{
		Scenario:   "workstealing",
		GOMAXPROCS: 2,
		Goroutines: 20,
		Duration:   2 * time.Second,
	})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}

	events, err := traceparse.Parse(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	tl := timeline.Build(events, 2, "workstealing")

	if tl.Meta.NumProcs != 2 {
		t.Errorf("NumProcs = %d, want 2", tl.Meta.NumProcs)
	}
	if len(tl.Meta.Goroutines) < 20 {
		t.Errorf("goroutines = %d, want >= 20", len(tl.Meta.Goroutines))
	}
	t.Logf("subprocess trace: %d bytes, %d events, %d goroutines",
		len(raw), len(tl.Events), len(tl.Meta.Goroutines))
}

// TestScenarioEvents runs each non-default scenario as a subprocess and checks
// it produces the events it exists to demonstrate. Skipped under -short.
func TestScenarioEvents(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping: compiles and runs workload subprocesses")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()

	parse := func(t *testing.T, req Request) []timeline.Event {
		t.Helper()
		raw, err := Run(ctx, req)
		if err != nil {
			t.Fatalf("Run: %v", err)
		}
		ev, err := traceparse.Parse(bytes.NewReader(raw))
		if err != nil {
			t.Fatalf("Parse: %v", err)
		}
		return ev
	}

	t.Run("pingpong blocks and unblocks on channels", func(t *testing.T) {
		ev := parse(t, Request{Scenario: "pingpong", GOMAXPROCS: 4, Goroutines: 24, Duration: 500 * time.Millisecond})
		var blocks, unblocks int
		for _, e := range ev {
			switch e.Type {
			case timeline.EventGBlock:
				blocks++
			case timeline.EventGUnblock:
				unblocks++
			}
		}
		if blocks == 0 || unblocks == 0 {
			t.Errorf("want channel blocks and unblocks, got block=%d unblock=%d", blocks, unblocks)
		}
	})

	// The whole M feature hangs on this: raw syscall.Read must bypass the
	// netpoller (real g_syscall_enter events) and sysmon must hand the blocked
	// M's P to another M (a P started by >= 2 distinct Ms).
	t.Run("syscalls blocks in real syscalls and hands P to another M", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("syscalls scenario is unix-only (syscall.Pipe)")
		}
		ev := parse(t, Request{Scenario: "syscalls", GOMAXPROCS: 4, Goroutines: 8, Duration: 600 * time.Millisecond})
		enters := 0
		midsPerP := map[int64]map[int64]struct{}{}
		for _, e := range ev {
			switch e.Type {
			case timeline.EventGSyscallEnter:
				enters++
			case timeline.EventPStart:
				if e.MID >= 0 {
					if midsPerP[e.PID] == nil {
						midsPerP[e.PID] = map[int64]struct{}{}
					}
					midsPerP[e.PID][e.MID] = struct{}{}
				}
			}
		}
		if enters < 5 {
			t.Errorf("g_syscall_enter events = %d, want >= 5 (reads are going through the netpoller?)", enters)
		}
		maxMs := 0
		for _, ms := range midsPerP {
			maxMs = max(maxMs, len(ms))
		}
		if maxMs < 2 {
			t.Errorf("no P was started by two distinct Ms — syscall handoff not observed")
		}
		t.Logf("syscalls: %d events, %d syscall enters, max distinct Ms per P = %d", len(ev), enters, maxMs)
	})

	t.Run("mutex parks contenders with a sync reason", func(t *testing.T) {
		ev := parse(t, Request{Scenario: "mutex", GOMAXPROCS: 4, Goroutines: 12, Duration: 600 * time.Millisecond})
		syncBlocks := 0
		for _, e := range ev {
			if e.Type == timeline.EventGBlock {
				r := strings.ToLower(e.Reason)
				if strings.Contains(r, "sync") || strings.Contains(r, "mutex") {
					syncBlocks++
				}
			}
		}
		if syncBlocks < 20 {
			t.Errorf("sync-reason blocks = %d, want >= 20 (contention not visible?)", syncBlocks)
		}
		t.Logf("mutex: %d events, %d sync blocks", len(ev), syncBlocks)
	})

	t.Run("leak leaves goroutines parked forever on channels", func(t *testing.T) {
		const n = 24
		ev := parse(t, Request{Scenario: "leak", GOMAXPROCS: 4, Goroutines: n, Duration: 900 * time.Millisecond})
		// A leaked goroutine's LAST event is a chan-reason block: it parked and
		// never came back.
		last := map[int64]timeline.Event{}
		for _, e := range ev {
			if e.GID >= 0 {
				last[e.GID] = e
			}
		}
		leaked := 0
		for _, e := range last {
			if e.Type == timeline.EventGBlock && strings.Contains(strings.ToLower(e.Reason), "chan") {
				leaked++
			}
		}
		if leaked < n/2 {
			t.Errorf("goroutines parked forever on channels = %d, want >= %d", leaked, n/2)
		}
		t.Logf("leak: %d events, %d goroutines left parked", len(ev), leaked)
	})

	t.Run("gcpressure triggers GC mark phases and heap metrics", func(t *testing.T) {
		ev := parse(t, Request{Scenario: "gcpressure", GOMAXPROCS: 4, Goroutines: 20, Duration: 700 * time.Millisecond})
		var gcMark, metrics int
		for _, e := range ev {
			if e.Type == timeline.EventGCRangeBegin && strings.Contains(e.Name, "mark phase") {
				gcMark++
			}
			if e.Type == timeline.EventMetric {
				metrics++
			}
		}
		if gcMark == 0 {
			t.Errorf("want GC mark-phase ranges, got 0")
		}
		if metrics == 0 {
			t.Errorf("want heap metric samples, got 0")
		}
	})
}

// TestSchedulerInvariants verifies the normalized event stream respects core
// scheduler truths on every scenario: at most GOMAXPROCS goroutines run at once,
// a P runs at most one goroutine, and no goroutine "starts" while already
// running. This is the model's faithfulness guard. Skipped under -short.
func TestSchedulerInvariants(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping: compiles and runs workload subprocesses")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()

	const procs = 4
	scens := []string{"workstealing", "pingpong", "gcpressure", "mutex", "leak"}
	if runtime.GOOS != "windows" {
		scens = append(scens, "syscalls")
	}
	for _, sc := range scens {
		t.Run(sc, func(t *testing.T) {
			raw, err := Run(ctx, Request{Scenario: sc, GOMAXPROCS: procs, Goroutines: 30, Duration: 600 * time.Millisecond})
			if err != nil {
				t.Fatalf("Run: %v", err)
			}
			events, err := traceparse.Parse(bytes.NewReader(raw))
			if err != nil {
				t.Fatalf("Parse: %v", err)
			}

			running := map[int64]int64{}  // gid -> pid
			occupant := map[int64]int64{} // pid -> gid
			// M bindings mirror the frontend rule table: an M binds to a G only
			// on own-execution events, unbinds when the G stops/blocks/exits or
			// becomes runnable. mBusy is the reverse index for "one G per M".
			gToM := map[int64]int64{}   // gid -> mid
			mBusy := map[int64]int64{}  // mid -> gid
			pOwner := map[int64]int64{} // pid -> mid
			bindM := func(e timeline.Event) {
				if e.MID < 0 {
					return
				}
				if g, ok := mBusy[e.MID]; ok && g != e.GID {
					t.Fatalf("M%d carries G%d and G%d at once at t=%d", e.MID, g, e.GID, e.T)
				}
				gToM[e.GID] = e.MID
				mBusy[e.MID] = e.GID
			}
			unbindM := func(gid int64) {
				if mid, ok := gToM[gid]; ok {
					delete(gToM, gid)
					if mBusy[mid] == gid {
						delete(mBusy, mid)
					}
				}
			}
			maxRunning := 0
			for _, e := range events {
				switch e.Type {
				case timeline.EventGRunStart, timeline.EventGSyscallExit:
					if _, ok := running[e.GID]; ok {
						t.Fatalf("G%d started while already running at t=%d", e.GID, e.T)
					}
					if occ, ok := occupant[e.PID]; ok && occ != e.GID {
						t.Fatalf("P%d already runs G%d when G%d started at t=%d", e.PID, occ, e.GID, e.T)
					}
					if e.Type == timeline.EventGSyscallExit {
						// The M that entered the syscall is the one that returns.
						if mid, ok := gToM[e.GID]; ok && e.MID >= 0 && mid != e.MID {
							t.Fatalf("G%d entered syscall on M%d but exited on M%d at t=%d", e.GID, mid, e.MID, e.T)
						}
					}
					if own, ok := pOwner[e.PID]; ok && e.MID >= 0 && own != e.MID {
						t.Fatalf("G%d starts on P%d/M%d but P%d is owned by M%d at t=%d", e.GID, e.PID, e.MID, e.PID, own, e.T)
					}
					running[e.GID] = e.PID
					occupant[e.PID] = e.GID
					bindM(e)
					if e.MID >= 0 && e.PID >= 0 {
						pOwner[e.PID] = e.MID
					}
				case timeline.EventGSyscallEnter:
					if pid, ok := running[e.GID]; ok {
						delete(running, e.GID)
						if occupant[pid] == e.GID {
							delete(occupant, pid)
						}
					}
					// The M blocks in the kernel together with its G: binding stays.
					bindM(e)
				case timeline.EventGRunStop, timeline.EventGBlock, timeline.EventGExit:
					if pid, ok := running[e.GID]; ok {
						delete(running, e.GID)
						if occupant[pid] == e.GID {
							delete(occupant, pid)
						}
					}
					unbindM(e.GID)
				case timeline.EventGUnblock:
					// Covers syscall->runnable too (the G's own M parks). e.MID here
					// is the UNBLOCKER's M — unbind the target G, never bind.
					unbindM(e.GID)
				case timeline.EventPStart:
					if e.MID >= 0 {
						pOwner[e.PID] = e.MID
					}
				case timeline.EventPStop:
					// On a steal e.MID is the stealer's M; just drop ownership.
					delete(pOwner, e.PID)
				}
				if n := len(running); n > maxRunning {
					maxRunning = n
				}
				if len(running) > procs {
					t.Fatalf("%d goroutines running at once > GOMAXPROCS=%d at t=%d", len(running), procs, e.T)
				}
			}
			t.Logf("%s: %d events, peak concurrent running = %d / %d", sc, len(events), maxRunning, procs)
		})
	}
}

func TestRunRejectsEmptyScenario(t *testing.T) {
	if _, err := Run(context.Background(), Request{}); err == nil {
		t.Fatal("expected error for empty scenario")
	}
}
