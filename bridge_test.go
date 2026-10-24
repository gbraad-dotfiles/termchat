package main

import (
	"testing"
	"time"
)

// State-machine checks for the server job queue, without HTTP.
func TestBridgeQueue(t *testing.T) {
	// An abandoned pending job (its client stopped polling) is dropped and
	// does not sit in front of a live client forever.
	bridge := newBridge(bridgeOptions{Mode: "server", PendingTTL: time.Second})
	orphan := newJob("gemini", "orphan", true, false, 60)
	bridge.submit(orphan)
	time.Sleep(1200 * time.Millisecond)
	live := newJob("gemini", "live", true, false, 60)
	bridge.submit(live)

	snap := bridge.snapshot(live.ID, -1, 0)
	if snap == nil || snap.QueuedAhead != 0 {
		t.Fatalf("live snapshot = %+v", snap)
	}
	if bridge.snapshot(orphan.ID, -1, 0) != nil {
		t.Fatal("orphan was not pruned")
	}

	taken := bridge.take("gemini", 0)
	if taken == nil || taken.ID != live.ID {
		t.Fatalf("take = %+v", taken)
	}
	text := "done"
	state := "done"
	if !bridge.update(live.ID, jobUpdate{Text: &text, State: &state}) {
		t.Fatal("update returned false")
	}
	if got := bridge.snapshot(live.ID, -1, 0); got == nil || got.State != "done" {
		t.Fatalf("final snapshot = %+v", got)
	}

	// A client that keeps polling keeps its queued job alive.
	bridge = newBridge(bridgeOptions{Mode: "server", PendingTTL: time.Second})
	kept := newJob("gemini", "kept", true, false, 60)
	bridge.submit(kept)
	for i := 0; i < 4; i++ {
		time.Sleep(400 * time.Millisecond)
		if bridge.snapshot(kept.ID, -1, 0) == nil {
			t.Fatalf("kept job was pruned on poll %d", i)
		}
	}
	taken = bridge.take("gemini", 0)
	if taken == nil || taken.ID != kept.ID {
		t.Fatalf("take kept = %+v", taken)
	}
}
