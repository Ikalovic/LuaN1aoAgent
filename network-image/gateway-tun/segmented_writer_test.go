package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestCaptureSegmentsRotateAndRetainExactRecordCount(t *testing.T) {
	path := filepath.Join(t.TempDir(), "epoch.mitm")
	segments, err := loadCaptureSegments(path, 5, 2)
	if err != nil {
		t.Fatal(err)
	}
	for _, payload := range [][]byte{[]byte("aaa\n"), []byte("bbb\n"), []byte("ccc\n")} {
		if err := segments.append(payload); err != nil {
			t.Fatal(err)
		}
	}
	active, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(active) != "ccc\n" {
		t.Fatalf("active segment = %q", active)
	}
	parts := segments.parts()
	if len(parts) != 1 || parts[0].records != 1 {
		t.Fatalf("retained parts = %#v", parts)
	}
	var manifest captureQuotaManifest
	payload, err := os.ReadFile(path + ".quota.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(payload, &manifest); err != nil {
		t.Fatal(err)
	}
	if !manifest.QuotaPressure || manifest.EvictedExchanges != 1 {
		t.Fatalf("quota manifest = %#v", manifest)
	}
}

func TestCaptureSegmentsResumeSequenceAndEvictionCount(t *testing.T) {
	path := filepath.Join(t.TempDir(), "epoch.mitm")
	first, err := loadCaptureSegments(path, 5, 2)
	if err != nil {
		t.Fatal(err)
	}
	for _, payload := range [][]byte{[]byte("aaa\n"), []byte("bbb\n"), []byte("ccc\n")} {
		if err := first.append(payload); err != nil {
			t.Fatal(err)
		}
	}
	second, err := loadCaptureSegments(path, 5, 2)
	if err != nil {
		t.Fatal(err)
	}
	if second.nextSequence != 3 || second.evictedRecords != 1 {
		t.Fatalf("resumed state = %#v", second)
	}
}
