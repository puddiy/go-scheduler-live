package api

import (
	"errors"
	"fmt"
	"io"
	"net/http"

	"github.com/puddiy/go-scheduler-live/internal/timeline"
	"github.com/puddiy/go-scheduler-live/internal/traceparse"
)

// maxUploadBytes/maxUploadEvents bound an arbitrary uploaded trace: unlike the
// curated scenarios, we have no control over what a user drags in.
const (
	maxUploadBytes = 16 << 20 // 16 MB — already millions of events
	// maxUploadEvents is a sanity bound: real workload runs at max stress
	// (gcpressure, 10s/200 goroutines/8 procs) produce ~30,000 events, well
	// under this limit.
	maxUploadEvents = 200_000
)

var (
	errNotATrace = errors.New("not a Go execution trace")
	errTooDense  = errors.New("trace too dense")
	errNoProcs   = errors.New("trace has no P activity")
)

type errTooManyProcs struct{ N int }

func (e errTooManyProcs) Error() string {
	return fmt.Sprintf("trace uses %d Ps, this demo supports up to %d (try GOMAXPROCS=%d go run . when recording)", e.N, maxProcs, maxProcs)
}

// handleTraceUpload parses an arbitrary user-supplied Go execution trace and
// builds a Timeline from it. Uploads are never cached: unlike scenario runs
// (keyed by scenario/gomaxprocs/goroutines/duration, see cacheKey), there is
// no cache key for arbitrary uploaded bytes.
func (s *server) handleTraceUpload(w http.ResponseWriter, r *http.Request) {
	// http.MaxBytesReader caps the body without buffering it all in memory
	// first; Parse streams straight from the (capped) reader. It only trips
	// once that many bytes are actually read, though — a garbage/malformed
	// body can fail fast in Parse (a few header bytes) well under the cap, so
	// also reject upfront when Content-Length is known and already over the
	// limit (chunked bodies with no declared length still fall through to
	// MaxBytesReader tripping mid-parse on a real oversized trace).
	if r.ContentLength > maxUploadBytes {
		writeUploadError(w, http.StatusRequestEntityTooLarge, "too_big", 0, fmt.Errorf("request body of %d bytes exceeds the %d byte limit", r.ContentLength, maxUploadBytes))
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes)

	tl, err := parseTraceUpload(r.Body, maxUploadEvents)
	if err != nil {
		var maxBytesErr *http.MaxBytesError
		var tooManyProcs errTooManyProcs
		switch {
		case errors.As(err, &maxBytesErr):
			writeUploadError(w, http.StatusRequestEntityTooLarge, "too_big", 0, err)
		case errors.Is(err, errNotATrace):
			writeUploadError(w, http.StatusBadRequest, "unreadable", 0, err)
		case errors.Is(err, errTooDense):
			writeUploadError(w, http.StatusBadRequest, "too_dense", 0, err)
		case errors.As(err, &tooManyProcs):
			writeUploadError(w, http.StatusBadRequest, "too_many_procs", tooManyProcs.N, err)
		case errors.Is(err, errNoProcs):
			writeUploadError(w, http.StatusBadRequest, "not_a_trace", 0, err)
		default:
			writeUploadError(w, http.StatusBadRequest, "unreadable", 0, err)
		}
		return
	}
	writeJSON(w, http.StatusOK, tl)
}

// parseTraceUpload parses raw trace bytes and builds a Timeline, or returns
// one of the sentinel/typed errors above. maxEvents is a parameter (not the
// package constant) so tests can exercise the density limit cheaply.
func parseTraceUpload(r io.Reader, maxEvents int) (tl timeline.Timeline, err error) {
	// Malformed bytes must not panic the handler goroutine; net/http's own
	// recovery would also catch it, but this keeps the failure local and
	// mapped to our own error taxonomy instead of a generic 500.
	defer func() {
		if rec := recover(); rec != nil {
			tl = timeline.Timeline{}
			err = fmt.Errorf("%w: panic parsing trace: %v", errNotATrace, rec)
		}
	}()

	events, parseErr := traceparse.Parse(r)
	if parseErr != nil {
		// Wrap (not just annotate) parseErr too: if the underlying reader hit
		// the MaxBytesReader cap mid-parse, that *http.MaxBytesError is buried
		// inside parseErr's chain, and handleTraceUpload's errors.As needs to
		// still find it to report 413/too_big instead of 400/unreadable.
		return timeline.Timeline{}, fmt.Errorf("%w: %w", errNotATrace, parseErr)
	}
	return buildUpload(events, maxEvents)
}

// buildUpload is the pure decision tree: given already-parsed events, decide
// which limit (if any) rejects them, or build the Timeline. scenario is
// always "custom" for uploads.
func buildUpload(events []timeline.Event, maxEvents int) (timeline.Timeline, error) {
	if len(events) == 0 {
		return timeline.Timeline{}, errNotATrace
	}
	if len(events) > maxEvents {
		return timeline.Timeline{}, errTooDense
	}
	n := timeline.ObservedProcs(events)
	if n == 0 {
		return timeline.Timeline{}, errNoProcs
	}
	if n > maxProcs {
		return timeline.Timeline{}, errTooManyProcs{N: n}
	}
	return timeline.Build(events, n, "custom"), nil
}

// writeUploadError writes a richer error body than writeError:
// {"error", "code", "n"} — n is included only when non-zero.
func writeUploadError(w http.ResponseWriter, status int, code string, n int, err error) {
	body := struct {
		Error string `json:"error"`
		Code  string `json:"code"`
		N     int    `json:"n,omitempty"`
	}{
		Error: err.Error(),
		Code:  code,
		N:     n,
	}
	writeJSON(w, status, body)
}
