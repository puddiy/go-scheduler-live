// Package timeline is the domain model the frontend consumes: a virtual-clock
// ordered list of normalized scheduler/GC events plus run metadata. It is the
// JSON contract between the backend and the (future) PixiJS player, and it knows
// nothing about how traces are produced or parsed.
package timeline

// EventType enumerates the normalized animation events.
type EventType string

const (
	EventGStatus       EventType = "g_status"
	EventGCRangeActive EventType = "gc_range_active"
	EventTraceEnd      EventType = "trace_end"
	EventGCreate       EventType = "g_create"
	EventGRunStart     EventType = "g_run_start"
	EventGRunStop      EventType = "g_run_stop"
	EventGBlock        EventType = "g_block"
	EventGUnblock      EventType = "g_unblock"
	EventGSyscallEnter EventType = "g_syscall_enter"
	EventGSyscallExit  EventType = "g_syscall_exit"
	EventGExit         EventType = "g_exit"
	EventPStart        EventType = "p_start"
	EventPStop         EventType = "p_stop"
	EventGCRangeBegin  EventType = "gc_range_begin"
	EventGCRangeEnd    EventType = "gc_range_end"
	EventMetric        EventType = "metric"
)

// NoResource marks Event.GID / Event.PID / Event.MID when the field does not
// apply. We use -1 (not omitempty) because goroutine 0, proc 0 and thread M0
// are all valid IDs and would be wrongly dropped by omitempty.
const NoResource int64 = -1

// Event is one normalized point on the timeline.
//
// MID is the OS thread (M) of the *executing context* that emitted the event,
// verbatim from the trace. Careful: on g_unblock/g_create it is the
// unblocker's/creator's M (not the target goroutine's), and on a p_stop caused
// by a steal it is the stealer's M. Consumers must bind an M to a G/P only on
// own-execution events (g_run_start, g_syscall_enter/exit, p_start).
type Event struct {
	T        int64     `json:"t"`                  // ns since the first trace event
	Type     EventType `json:"type"`               //
	GID      int64     `json:"gid"`                // goroutine id, or NoResource
	PID      int64     `json:"pid"`                // proc id, or NoResource
	MID      int64     `json:"mid"`                // executing OS-thread id, or NoResource
	ActorGID *int64    `json:"actorGid,omitempty"` // executing G for create/unblock; -1 means unknown
	State    string    `json:"state,omitempty"`    // g_status or non-runnable create: observed G state
	Initial  bool      `json:"initial,omitempty"`  // first observed resource state, not an acquisition
	Reason   string    `json:"reason,omitempty"`
	Name     string    `json:"name,omitempty"` // range / metric name
	Value    uint64    `json:"value"`          // metric value
	Stolen   bool      `json:"stolen,omitempty"`
}

// Meta describes the run as a whole.
type Meta struct {
	Scenario   string  `json:"scenario"`
	NumProcs   int     `json:"numProcs"`
	DurationNs int64   `json:"durationNs"`
	Goroutines []int64 `json:"goroutines"`
}

// Timeline is the full payload sent to the frontend.
type Timeline struct {
	Meta   Meta    `json:"meta"`
	Events []Event `json:"events"`
}
