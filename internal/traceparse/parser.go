// Package traceparse converts a raw Go execution trace into the normalized
// timeline domain model. It is the ONLY package that depends on
// golang.org/x/exp/trace; everything downstream works with timeline.Event.
//
// Parse returns events in trace order. Assembling the final Timeline (metadata,
// sorting, work-stealing reconstruction) is timeline.Build's job.
package traceparse

import (
	"fmt"
	"io"
	"strings"

	exptrace "golang.org/x/exp/trace"

	"github.com/puddiy/go-scheduler-live/internal/timeline"
)

// Heap metric names forwarded to the frontend, discovered from real traces.
// Note: "live heap" is the memory-classes objects metric, not /gc/heap/live.
const (
	metricHeapGoal = "/gc/heap/goal:bytes"
	metricHeapLive = "/memory/classes/heap/objects:bytes"

	// metricMinGapNs is the minimum trace-time gap between kept samples of the
	// same metric (downsampling for a smooth-enough heap bar).
	metricMinGapNs = 2_000_000
)

// Parse reads an execution trace from r and returns the normalized events.
func Parse(r io.Reader) ([]timeline.Event, error) {
	tr, err := exptrace.NewReader(r)
	if err != nil {
		return nil, fmt.Errorf("creating trace reader: %w", err)
	}

	var (
		events     []timeline.Event
		haveT0     bool
		t0         exptrace.Time
		lastMetric = map[string]int64{} // last emitted time per metric, for downsampling
	)

	// rel converts an absolute trace time to ns since the first event seen.
	rel := func(t exptrace.Time) int64 {
		if !haveT0 {
			t0, haveT0 = t, true
		}
		return int64(t.Sub(t0))
	}

	for {
		ev, err := tr.ReadEvent()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("reading trace event: %w", err)
		}

		switch ev.Kind() {
		case exptrace.EventStateTransition:
			if e, ok := mapTransition(ev, rel); ok {
				events = append(events, e)
			}
		case exptrace.EventRangeBegin:
			if keepRange(ev.Range().Name) {
				events = append(events, rangeEvent(timeline.EventGCRangeBegin, ev, rel))
			}
		case exptrace.EventRangeEnd:
			if keepRange(ev.Range().Name) {
				events = append(events, rangeEvent(timeline.EventGCRangeEnd, ev, rel))
			}
		case exptrace.EventMetric:
			if e, ok := metricEvent(ev, rel); ok {
				// Downsample: the heap metric is emitted thousands of times under
				// allocation pressure; one sample per metricMinGapNs is plenty for
				// a smooth heap bar.
				if last, seen := lastMetric[e.Name]; !seen || e.T-last >= metricMinGapNs {
					lastMetric[e.Name] = e.T
					events = append(events, e)
				}
			}
		}
	}

	return events, nil
}

// keepRange selects the GC ranges worth visualizing — concurrent mark phases
// and stop-the-world pauses — and drops the high-frequency noise (incremental
// sweep, mark assist) that would otherwise flood the timeline.
func keepRange(name string) bool {
	return strings.Contains(name, "stop-the-world") || strings.Contains(name, "mark phase")
}

func rangeEvent(typ timeline.EventType, ev exptrace.Event, rel func(exptrace.Time) int64) timeline.Event {
	return timeline.Event{
		T:    rel(ev.Time()),
		Type: typ,
		GID:  timeline.NoResource,
		PID:  timeline.NoResource,
		MID:  timeline.NoResource,
		Name: ev.Range().Name,
	}
}

func metricEvent(ev exptrace.Event, rel func(exptrace.Time) int64) (timeline.Event, bool) {
	m := ev.Metric()
	if m.Name != metricHeapGoal && m.Name != metricHeapLive {
		return timeline.Event{}, false
	}
	if m.Value.Kind() != exptrace.ValueUint64 {
		return timeline.Event{}, false
	}
	return timeline.Event{
		T:     rel(ev.Time()),
		Type:  timeline.EventMetric,
		GID:   timeline.NoResource,
		PID:   timeline.NoResource,
		MID:   timeline.NoResource,
		Name:  m.Name,
		Value: m.Value.Uint64(),
	}, true
}

// mapTransition turns a state-transition event into a timeline event. The bool
// is false when the transition carries nothing we visualize.
func mapTransition(ev exptrace.Event, rel func(exptrace.Time) int64) (timeline.Event, bool) {
	st := ev.StateTransition()
	switch st.Resource.Kind {
	case exptrace.ResourceGoroutine:
		from, to := st.Goroutine()
		typ, ok := goEventType(from, to)
		if !ok {
			return timeline.Event{}, false
		}
		e := timeline.Event{
			T:    rel(ev.Time()),
			Type: typ,
			GID:  int64(st.Resource.Goroutine()),
			PID:  procID(ev.Proc()),
			MID:  threadID(ev.Thread()),
		}
		if typ == timeline.EventGBlock {
			e.Reason = st.Reason
		}
		return e, true

	case exptrace.ResourceProc:
		from, to := st.Proc()
		typ, ok := procEventType(from, to)
		if !ok {
			return timeline.Event{}, false
		}
		return timeline.Event{
			T:    rel(ev.Time()),
			Type: typ,
			GID:  timeline.NoResource,
			PID:  int64(st.Resource.Proc()),
			MID:  threadID(ev.Thread()),
		}, true
	}
	return timeline.Event{}, false
}

// procID normalizes an executing-proc id: a goroutine event with no associated
// P (e.g. unblocked by the netpoller) maps to NoResource.
func procID(p exptrace.ProcID) int64 {
	if id := int64(p); id >= 0 {
		return id
	}
	return timeline.NoResource
}

// threadID normalizes an executing-thread id (NoThread maps to NoResource).
// The trace has no M lifecycle events; this is the M of the context that
// emitted the event — see the semantics note on timeline.Event.
func threadID(m exptrace.ThreadID) int64 {
	if id := int64(m); id >= 0 {
		return id
	}
	return timeline.NoResource
}

// goEventType maps a goroutine (from,to) transition to a timeline event type.
// Case order matters: more specific transitions (syscall exit) must precede the
// general "became running" case, which they would otherwise be swallowed by.
func goEventType(from, to exptrace.GoState) (timeline.EventType, bool) {
	switch {
	case from == exptrace.GoNotExist && to == exptrace.GoRunnable:
		return timeline.EventGCreate, true
	case from == exptrace.GoSyscall && to == exptrace.GoRunning:
		return timeline.EventGSyscallExit, true
	case to == exptrace.GoRunning:
		return timeline.EventGRunStart, true
	case to == exptrace.GoSyscall:
		return timeline.EventGSyscallEnter, true
	case to == exptrace.GoWaiting:
		return timeline.EventGBlock, true
	case from == exptrace.GoWaiting && to == exptrace.GoRunnable:
		return timeline.EventGUnblock, true
	case from == exptrace.GoSyscall && to == exptrace.GoRunnable:
		// Returned from a syscall but the P was taken while it was parked, so it
		// is now runnable (not running). Treated as "became runnable".
		return timeline.EventGUnblock, true
	case from == exptrace.GoRunning && to == exptrace.GoRunnable:
		return timeline.EventGRunStop, true
	case to == exptrace.GoNotExist:
		return timeline.EventGExit, true
	default:
		return "", false
	}
}

// procEventType maps a proc (from,to) transition to a timeline event type.
func procEventType(from, to exptrace.ProcState) (timeline.EventType, bool) {
	switch {
	case to == exptrace.ProcRunning:
		return timeline.EventPStart, true
	case from == exptrace.ProcRunning && to == exptrace.ProcIdle:
		return timeline.EventPStop, true
	default:
		return "", false
	}
}
