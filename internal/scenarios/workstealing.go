package scenarios

import (
	"context"
	"sync"
)

func init() {
	Register(workStealing{})
}

// workStealing spawns many short CPU-bound goroutines with no heap allocation,
// so the trace shows scheduling rather than GC. With GOMAXPROCS > 1 the runtime
// spreads them across Ps and idle Ps steal goroutines from busy ones — the
// behavior the workload exercises; ordinary trace cannot identify individual steals.
type workStealing struct{}

func (workStealing) Name() string { return "workstealing" }

func (workStealing) Describe() ScenarioInfo {
	return ScenarioInfo{
		ID:          "workstealing",
		Title:       "CPU-планирование",
		Description: "CPU-горутин больше, чем P. Trace показывает выполнение на разных P; состав очередей и отдельные кражи работы не записываются.",
		Order:       0,
		Params: []ParamSpec{
			{Name: "goroutines", Min: 1, Max: 200, Default: 50},
		},
	}
}

// sink keeps the compiler from eliminating the busy-loop below as dead code. It
// is written only by Run's own goroutine after the workers finish, so there is
// no data race on it.
var sink uint64 //nolint:unused // deliberate write-only sink; see the comment above

func (workStealing) Run(ctx context.Context, p Params) error {
	n := max(p.Goroutines, 1)
	results := make([]uint64, n)
	var wg sync.WaitGroup
	wg.Add(n)
	for i := range n {
		// Go 1.22+: i is a fresh variable each iteration, so capturing it in the
		// closure is safe. Each goroutine writes a distinct index — no race.
		go func() {
			defer wg.Done()
			results[i] = spin(ctx)
		}()
	}
	wg.Wait()

	for _, v := range results {
		sink += v
	}
	return nil
}

// spin runs a bounded CPU loop, checking ctx periodically so the scenario can be
// cancelled by the caller's deadline. It returns its accumulator so callers can
// keep the work observable.
func spin(ctx context.Context) uint64 {
	const (
		rounds     = 120
		inner      = 20_000
		checkEvery = 8
	)
	var x uint64 = 1
	for r := range rounds {
		for range inner {
			x = x*1664525 + 1013904223 // cheap LCG keeps the CPU busy
		}
		if r%checkEvery == 0 && ctx.Err() != nil {
			break
		}
	}
	return x
}
