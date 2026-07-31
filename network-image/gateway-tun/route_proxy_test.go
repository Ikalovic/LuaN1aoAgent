package main

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRouteStoreUsesLongestPrefix(t *testing.T) {
	store := writeRouteSnapshot(t, `{"routes":[
		{"routeRef":"route:wide","cidr":"172.31.0.0/16","prefixLength":16,"socksHost":"192.0.2.10","socksPort":22000},
		{"routeRef":"route:narrow","cidr":"172.31.4.0/24","prefixLength":24,"socksHost":"192.0.2.11","socksPort":22001}
	]}`)
	route, err := store.match("172.31.4.20:80")
	if err != nil {
		t.Fatal(err)
	}
	if route == nil || route.RouteRef != "route:narrow" {
		t.Fatalf("matched route = %#v", route)
	}
}

func TestReadyWritePreservesPythonOwnedDirectoryEntry(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tun-gate.ready")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := writePrecreatedReadyFile(path); err != nil {
		t.Fatal(err)
	}
	after, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if !os.SameFile(before, after) {
		t.Fatal("ready writer replaced the Python-owned directory entry")
	}
	payload, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(payload) != "ready\n" {
		t.Fatalf("ready payload = %q", payload)
	}
}

func TestRouteDialerChoosesDirectOrSOCKSWithoutFallback(t *testing.T) {
	store := writeRouteSnapshot(t, `{"routes":[
		{"routeRef":"route:internal","cidr":"172.31.0.0/24","prefixLength":24,"socksHost":"192.0.2.10","socksPort":22000}
	]}`)
	var directDestinations []string
	var socksDestinations []string
	dialer := &routeDialer{
		routes:         store,
		connectTimeout: time.Second,
		directDial: func(_ context.Context, _ string, destination string) (net.Conn, error) {
			directDestinations = append(directDestinations, destination)
			client, server := net.Pipe()
			go server.Close()
			return client, nil
		},
		allowPrefixes: []netip.Prefix{netip.MustParsePrefix("198.51.100.0/24")},
		socksDial: func(_ context.Context, proxy string, destination string, _ time.Duration) (net.Conn, error) {
			socksDestinations = append(socksDestinations, proxy+"->"+destination)
			return nil, errors.New("route unavailable")
		},
	}
	directConnection, err := dialer.dial(context.Background(), "198.51.100.20:443")
	if err != nil {
		t.Fatal(err)
	}
	directConnection.Close()
	if _, err := dialer.dial(context.Background(), "172.31.0.20:80"); err == nil {
		t.Fatal("routed dial unexpectedly fell back to direct")
	}
	if got := strings.Join(directDestinations, ","); got != "198.51.100.20:443" {
		t.Fatalf("direct destinations = %q", got)
	}
	if got := strings.Join(socksDestinations, ","); got != "192.0.2.10:22000->172.31.0.20:80" {
		t.Fatalf("SOCKS destinations = %q", got)
	}
}

func TestRouteStoreRejectsPartialOrInvalidSnapshots(t *testing.T) {
	for _, content := range []string{
		`{}`,
		`{"routes":null}`,
		`{"routes":[{"routeRef":"route:bad","cidr":"172.31.0.0/24","prefixLength":16,"socksHost":"192.0.2.10","socksPort":22000}]}`,
	} {
		store := writeRouteSnapshot(t, content)
		if _, err := store.match("198.51.100.20:443"); err == nil {
			t.Fatalf("invalid snapshot %s was treated as an empty direct route table", content)
		}
	}
}

func TestRouteDialerRejectsOnlyItsOwnInfrastructureEndpoints(t *testing.T) {
	store := writeRouteSnapshot(t, `{"routes":[]}`)
	var directDestinations []string
	dialer := &routeDialer{
		routes:         store,
		connectTimeout: time.Second,
		selfTargets:    []string{"127.0.0.1:1080"},
		allowPrefixes:  []netip.Prefix{netip.MustParsePrefix("198.51.100.0/24")},
		directDial: func(_ context.Context, _ string, destination string) (net.Conn, error) {
			directDestinations = append(directDestinations, destination)
			client, server := net.Pipe()
			go server.Close()
			return client, nil
		},
		socksDial: dialSOCKS5,
	}
	for _, destination := range []string{"127.0.0.1:1080", "localhost:1080"} {
		if _, err := dialer.dial(context.Background(), destination); err == nil {
			t.Fatalf("self target %s was allowed", destination)
		}
	}
	connection, err := dialer.dial(context.Background(), "198.51.100.20:1080")
	if err != nil {
		t.Fatal(err)
	}
	connection.Close()
	if got := strings.Join(directDestinations, ","); got != "198.51.100.20:1080" {
		t.Fatalf("direct destinations = %q", got)
	}
}

func TestRouteDialerRejectsProtectedNetworksAndLocalPortsBeforeDial(t *testing.T) {
	store := writeRouteSnapshot(t, `{"routes":[]}`)
	prefix := netip.MustParsePrefix("172.30.0.0/24")
	dialer := &routeDialer{
		routes: store, connectTimeout: time.Second,
		denyPrefixes:   []netip.Prefix{prefix},
		allowPrefixes:  []netip.Prefix{netip.MustParsePrefix("192.0.2.0/24")},
		localDirect:    map[netip.Addr]struct{}{netip.MustParseAddr("192.0.2.10"): {}},
		localDenyPorts: map[uint16]struct{}{8788: {}},
		directDial: func(_ context.Context, _, _ string) (net.Conn, error) {
			t.Fatal("protected destination reached the dialer")
			return nil, nil
		},
	}
	for _, destination := range []string{"172.30.0.2:22", "192.0.2.10:8788"} {
		if _, err := dialer.dial(context.Background(), destination); err == nil {
			t.Fatalf("protected destination %s was allowed", destination)
		}
	}
}

func TestRouteDialerRejectsDirectDestinationOutsideAuthorizedScope(t *testing.T) {
	dialer := &routeDialer{
		routes:        writeRouteSnapshot(t, `{"routes":[]}`),
		allowPrefixes: []netip.Prefix{netip.MustParsePrefix("198.51.100.0/24")},
		directDial: func(_ context.Context, _, _ string) (net.Conn, error) {
			t.Fatal("out-of-scope destination reached the direct dialer")
			return nil, nil
		},
	}
	if _, err := dialer.dial(context.Background(), "203.0.113.10:443"); err == nil {
		t.Fatal("out-of-scope destination was allowed")
	}
}

func TestRouteDialerAcceptsKernelGuardedDomainDestination(t *testing.T) {
	var destination string
	dialer := &routeDialer{
		routes:              writeRouteSnapshot(t, `{"routes":[]}`),
		allowDomainResolved: true,
		directDial: func(_ context.Context, _, value string) (net.Conn, error) {
			destination = value
			client, server := net.Pipe()
			go server.Close()
			return client, nil
		},
	}
	connection, err := dialer.dial(context.Background(), "203.0.113.10:443")
	if err != nil {
		t.Fatal(err)
	}
	connection.Close()
	if destination != "203.0.113.10:443" {
		t.Fatalf("destination = %q", destination)
	}
}

func writeRouteSnapshot(t *testing.T, content string) routeStore {
	t.Helper()
	path := filepath.Join(t.TempDir(), "routes.json")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return routeStore{path: path}
}
