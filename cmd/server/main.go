// Command server runs the go-scheduler-live HTTP backend: it serves the scenario list
// and, on demand, runs a scenario under tracing and returns a Timeline.
package main

import (
	"flag"
	"log"
	"net/http"

	"github.com/puddiy/go-scheduler-live/internal/api"
	"github.com/puddiy/go-scheduler-live/internal/tracerun"
)

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	flag.Parse()

	handler := api.New(tracerun.Run)

	log.Printf("go-scheduler-live server listening on %s", *addr)
	if err := http.ListenAndServe(*addr, handler); err != nil {
		log.Fatal(err)
	}
}
