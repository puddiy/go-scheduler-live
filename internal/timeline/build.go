package timeline

import "sort"

// Build assembles a Timeline from normalized events. It sorts events by time,
// fills metadata without inventing scheduler internals. NumProcs reserves
// capacity for the configured count, observed P IDs and recorded GOMAXPROCS.
func Build(events []Event, gomaxprocs int, scenario string) Timeline {
	sort.SliceStable(events, func(i, j int) bool { return events[i].T < events[j].T })

	// Older payloads carried a steal heuristic. Ordinary traces cannot prove
	// queue membership or a steal; never propagate that claim.
	for i := range events {
		events[i].Stolen = false
	}

	var (
		gids     []int64
		seen     = map[int64]struct{}{}
		duration int64
	)
	for _, e := range events {
		if e.T > duration {
			duration = e.T
		}
		if e.GID == NoResource {
			continue
		}
		if _, ok := seen[e.GID]; !ok {
			seen[e.GID] = struct{}{}
			gids = append(gids, e.GID)
		}
	}

	return Timeline{
		Meta: Meta{
			Scenario:   scenario,
			NumProcs:   max(gomaxprocs, ObservedProcs(events)),
			DurationNs: duration,
			Goroutines: gids,
		},
		Events: events,
	}
}

// ObservedProcs returns 1 + the highest P id that appears in the events, i.e.
// capacity needed to display every observed P and recorded GOMAXPROCS value.
// Without the metric it remains a lower bound.
func ObservedProcs(events []Event) int {
	var (
		maxPID int64 = -1
		found  bool
	)
	for _, e := range events {
		if e.Type == EventMetric && e.Name == "/sched/gomaxprocs:threads" && e.Value > 0 {
			maxPID = max(maxPID, int64(e.Value)-1)
			found = true
		}
		if e.PID == NoResource {
			continue
		}
		if !found || e.PID > maxPID {
			maxPID = e.PID
			found = true
		}
	}
	if !found {
		return 0
	}
	return int(maxPID) + 1
}
