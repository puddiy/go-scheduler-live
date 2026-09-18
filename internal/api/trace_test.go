package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/puddiy/go-scheduler-live/internal/timeline"
)

func TestTraceUploadHappyPath(t *testing.T) {
	srv := httptest.NewServer(New(nil)) // runner unused by this endpoint
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/api/trace", "application/octet-stream", strings.NewReader(string(goldenTrace(t))))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	var tl timeline.Timeline
	if err := json.NewDecoder(resp.Body).Decode(&tl); err != nil {
		t.Fatal(err)
	}
	if tl.Meta.Scenario != "custom" {
		t.Errorf("Scenario = %q, want custom", tl.Meta.Scenario)
	}
	if tl.Meta.NumProcs <= 0 {
		t.Errorf("NumProcs = %d, want > 0", tl.Meta.NumProcs)
	}
}

func TestTraceUploadGarbageBytes(t *testing.T) {
	srv := httptest.NewServer(New(nil))
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/api/trace", "application/octet-stream", strings.NewReader("this is not a trace file, just garbage bytes"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
	var body map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body["code"] != "unreadable" {
		t.Errorf("code = %v, want unreadable", body["code"])
	}
}

func TestTraceUploadEmptyBody(t *testing.T) {
	srv := httptest.NewServer(New(nil))
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/api/trace", "application/octet-stream", strings.NewReader(""))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
	var body map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	// Whichever branch an empty body actually hits (Parse's own error, or
	// buildUpload's empty-events check) - both are valid "empty" outcomes.
	code, _ := body["code"].(string)
	if code != "unreadable" && code != "not_a_trace" {
		t.Errorf("code = %v, want unreadable or not_a_trace", body["code"])
	}
}

func TestTraceUploadTooBig(t *testing.T) {
	srv := httptest.NewServer(New(nil))
	defer srv.Close()

	oversized := strings.Repeat("x", maxUploadBytes+1)
	resp, err := http.Post(srv.URL+"/api/trace", "application/octet-stream", strings.NewReader(oversized))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", resp.StatusCode)
	}
	var body map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body["code"] != "too_big" {
		t.Errorf("code = %v, want too_big", body["code"])
	}
}

func TestBuildUpload(t *testing.T) {
	t.Run("empty events", func(t *testing.T) {
		_, err := buildUpload(nil, 100)
		if err != errNotATrace {
			t.Errorf("err = %v, want errNotATrace", err)
		}
	})

	t.Run("too dense", func(t *testing.T) {
		events := []timeline.Event{
			{PID: 0}, {PID: 0}, {PID: 0},
		}
		_, err := buildUpload(events, 2)
		if err != errTooDense {
			t.Errorf("err = %v, want errTooDense", err)
		}
	})

	t.Run("no proc activity", func(t *testing.T) {
		events := []timeline.Event{
			{PID: timeline.NoResource}, {PID: timeline.NoResource},
		}
		_, err := buildUpload(events, 100)
		if err != errNoProcs {
			t.Errorf("err = %v, want errNoProcs", err)
		}
	})

	t.Run("too many procs", func(t *testing.T) {
		events := []timeline.Event{
			{PID: 0}, {PID: 8},
		}
		_, err := buildUpload(events, 100)
		want := errTooManyProcs{N: 9}
		if err != want {
			t.Errorf("err = %v, want %v", err, want)
		}
	})

	t.Run("normal small set", func(t *testing.T) {
		events := []timeline.Event{
			{PID: 0}, {PID: 1}, {PID: 2}, {PID: 3},
		}
		tl, err := buildUpload(events, 100)
		if err != nil {
			t.Fatalf("buildUpload: %v", err)
		}
		if tl.Meta.Scenario != "custom" {
			t.Errorf("Scenario = %q, want custom", tl.Meta.Scenario)
		}
		if tl.Meta.NumProcs != 4 {
			t.Errorf("NumProcs = %d, want 4", tl.Meta.NumProcs)
		}
	})
}
