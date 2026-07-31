package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestProtocolGatewayCapturesHTTPOnArbitraryPort(t *testing.T) {
	root := t.TempDir()
	epochPath := filepath.Join(root, "epoch.json")
	statusPath := filepath.Join(root, "status.json")
	flowPath := filepath.Join(root, "epoch.mitm")
	epoch := map[string]any{"active": true, "epochRef": "epoch:test", "flowFile": flowPath}
	payload, _ := json.Marshal(epoch)
	if err := os.WriteFile(epochPath, payload, 0o600); err != nil {
		t.Fatal(err)
	}
	capture, err := newCaptureWriter(epochPath, statusPath)
	if err != nil {
		t.Fatal(err)
	}
	gateway := &protocolGateway{capture: capture, runRef: "run:test", taskRef: "task:test"}
	client, gatewayClient := net.Pipe()
	gatewayUpstream, target := net.Pipe()
	done := make(chan error, 1)
	go func() {
		done <- gateway.serve(context.Background(), gatewayClient, &dialedUpstream{connection: gatewayUpstream}, "192.0.2.10:31337")
	}()
	go func() {
		defer target.Close()
		request, readError := http.ReadRequest(bufio.NewReader(target))
		if readError != nil {
			return
		}
		_, _ = io.Copy(io.Discard, request.Body)
		_ = request.Body.Close()
		response := &http.Response{
			StatusCode: http.StatusCreated,
			Status:     "201 Created",
			Proto:      "HTTP/1.1",
			ProtoMajor: 1,
			ProtoMinor: 1,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader("captured-response")),
			Close:      true,
		}
		response.Header.Set("Content-Type", "text/plain")
		_ = response.Write(target)
	}()
	if _, err := io.WriteString(client, "POST /probe HTTP/1.1\r\nHost: arbitrary.test:31337\r\nContent-Length: 4\r\nConnection: close\r\n\r\nbody"); err != nil {
		t.Fatal(err)
	}
	response, err := io.ReadAll(client)
	if err != nil {
		t.Fatal(err)
	}
	_ = client.Close()
	if !strings.Contains(string(response), "201 Created") || !strings.Contains(string(response), "captured-response") {
		t.Fatalf("response = %q", response)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("protocol gateway did not finish")
	}
	line, err := os.ReadFile(flowPath)
	if err != nil {
		t.Fatal(err)
	}
	var flow capturedHTTPFlow
	if err := json.Unmarshal(line, &flow); err != nil {
		t.Fatal(err)
	}
	if flow.Method != "POST" || flow.Status != 201 || flow.URL != "http://arbitrary.test:31337/probe" {
		t.Fatalf("captured flow = %#v", flow)
	}
	if flow.RequestObservedBytes != 4 || flow.ResponseObservedBytes != int64(len("captured-response")) {
		t.Fatalf("captured body sizes = %d/%d", flow.RequestObservedBytes, flow.ResponseObservedBytes)
	}
}

func TestProtocolDetectionLeavesUnknownTCPUntouched(t *testing.T) {
	if looksLikeHTTP([]byte("SSH-2.0-OpenSSH")) || looksLikeTLS([]byte("SSH-2.0-OpenSSH")) {
		t.Fatal("SSH banner was classified as HTTP or TLS")
	}
	if !looksLikeHTTP([]byte("GET / HTTP/1.1\r\n")) {
		t.Fatal("HTTP request was not detected")
	}
	if !looksLikeTLS([]byte{0x16, 0x03, 0x03, 0x00}) {
		t.Fatal("TLS ClientHello was not detected")
	}
}

func TestProtocolGatewayMitmsHTTPSOnArbitraryPort(t *testing.T) {
	root := t.TempDir()
	certPath := filepath.Join(root, "ca.pem")
	keyPath := filepath.Join(root, "ca-key.pem")
	authority, err := loadOrCreateCertificateAuthority(certPath, keyPath)
	if err != nil {
		t.Fatal(err)
	}
	targetCertificate, err := authority.certificateFor("target.test")
	if err != nil {
		t.Fatal(err)
	}
	epochPath := filepath.Join(root, "epoch.json")
	statusPath := filepath.Join(root, "status.json")
	flowPath := filepath.Join(root, "https.mitm")
	payload, _ := json.Marshal(map[string]any{"active": true, "epochRef": "epoch:https", "flowFile": flowPath})
	if err := os.WriteFile(epochPath, payload, 0o600); err != nil {
		t.Fatal(err)
	}
	capture, err := newCaptureWriter(epochPath, statusPath)
	if err != nil {
		t.Fatal(err)
	}
	gateway := &protocolGateway{authority: authority, capture: capture, runRef: "run:test", taskRef: "task:test"}
	client, gatewayClient := net.Pipe()
	gatewayUpstream, target := net.Pipe()
	done := make(chan error, 1)
	go func() {
		done <- gateway.serve(context.Background(), gatewayClient, &dialedUpstream{connection: gatewayUpstream}, "192.0.2.10:31338")
	}()
	go func() {
		server := tls.Server(target, &tls.Config{Certificates: []tls.Certificate{*targetCertificate}})
		defer server.Close()
		request, readError := http.ReadRequest(bufio.NewReader(server))
		if readError != nil {
			return
		}
		_ = request.Body.Close()
		response := &http.Response{
			StatusCode: 200, Status: "200 OK", Proto: "HTTP/1.1", ProtoMajor: 1, ProtoMinor: 1,
			Header: make(http.Header), Body: io.NopCloser(strings.NewReader("decrypted")), Close: true,
		}
		_ = response.Write(server)
	}()
	caPEM, err := os.ReadFile(certPath)
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(caPEM) {
		t.Fatal("failed to trust gateway CA")
	}
	secured := tls.Client(client, &tls.Config{RootCAs: roots, ServerName: "target.test", NextProtos: []string{"http/1.1"}})
	if err := secured.Handshake(); err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(secured, "GET /secure HTTP/1.1\r\nHost: target.test:31338\r\nConnection: close\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	response, err := io.ReadAll(secured)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(response), "decrypted") {
		t.Fatalf("HTTPS response = %q", response)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("HTTPS gateway did not finish")
	}
	line, err := os.ReadFile(flowPath)
	if err != nil {
		t.Fatal(err)
	}
	var flow capturedHTTPFlow
	if err := json.Unmarshal(line, &flow); err != nil {
		t.Fatal(err)
	}
	if flow.Scheme != "https" || flow.URL != "https://target.test:31338/secure" || flow.Status != 200 {
		t.Fatalf("HTTPS flow = %#v", flow)
	}
}

func TestProtocolGatewayRelaysHTTP1BytesUnchanged(t *testing.T) {
	gateway := &protocolGateway{taskRef: "task:test"}
	client, gatewayClient := tcpConnectionPair(t)
	gatewayUpstream, target := tcpConnectionPair(t)
	done := make(chan error, 1)
	go func() {
		done <- gateway.serve(context.Background(), gatewayClient, &dialedUpstream{connection: gatewayUpstream}, "192.0.2.20:4567")
	}()

	request := "GET /<?php_error_log_payload?> HTTP/1.1\r\nhOsT: raw.test:4567\r\nX-First: one\r\nx-DuPe: alpha\r\nX-Dupe: beta\r\nX-Last: three\r\nConnection: close\r\n\r\n"
	response := "HTTP/1.1 299 Strange Status\r\nx-Origin-First: A\r\nX-Repeat: one\r\nx-repeat: two\r\nContent-Length: 4\r\nConnection: close\r\n\r\nBODY"
	targetRequest := make(chan []byte, 1)
	go func() {
		reader := bufio.NewReader(target)
		received, readErr := reader.ReadString('\n')
		if readErr == nil {
			for !strings.HasSuffix(received, "\r\n\r\n") {
				line, err := reader.ReadString('\n')
				received += line
				if err != nil {
					break
				}
			}
		}
		targetRequest <- []byte(received)
		_, _ = io.WriteString(target, response)
		_ = target.CloseWrite()
	}()

	if _, err := io.WriteString(client, request); err != nil {
		t.Fatal(err)
	}
	_ = client.CloseWrite()
	receivedResponse, err := io.ReadAll(client)
	if err != nil {
		t.Fatal(err)
	}
	if received := string(<-targetRequest); received != request {
		t.Fatalf("origin request changed\nreceived: %q\nexpected: %q", received, request)
	}
	if string(receivedResponse) != response {
		t.Fatalf("client response changed\nreceived: %q\nexpected: %q", receivedResponse, response)
	}
	awaitGateway(t, done)
}

func TestProtocolGatewayRelaysHTTPSPlaintextBytesUnchanged(t *testing.T) {
	root := t.TempDir()
	authority, err := loadOrCreateCertificateAuthority(filepath.Join(root, "ca.pem"), filepath.Join(root, "ca-key.pem"))
	if err != nil {
		t.Fatal(err)
	}
	targetCertificate, err := authority.certificateFor("target.test")
	if err != nil {
		t.Fatal(err)
	}
	gateway := &protocolGateway{authority: authority, taskRef: "task:test"}
	client, gatewayClient := tcpConnectionPair(t)
	gatewayUpstream, target := tcpConnectionPair(t)
	done := make(chan error, 1)
	go func() {
		done <- gateway.serve(context.Background(), gatewayClient, &dialedUpstream{connection: gatewayUpstream}, "192.0.2.21:9444")
	}()

	request := "GET /<?php_tls_payload?> HTTP/1.1\r\nhOsT: target.test:9444\r\nX-Order: first\r\nx-repeat: a\r\nX-Repeat: b\r\nConnection: close\r\n\r\n"
	response := "HTTP/1.1 200 Fine\r\nx-raw: lower\r\nX-Raw: upper\r\nContent-Length: 6\r\nConnection: close\r\n\r\nsecure"
	targetRequest := make(chan []byte, 1)
	go func() {
		server := tls.Server(target, &tls.Config{Certificates: []tls.Certificate{*targetCertificate}, NextProtos: []string{"http/1.1"}})
		defer server.Close()
		reader := bufio.NewReader(server)
		received, readErr := reader.ReadString('\n')
		if readErr == nil {
			for !strings.HasSuffix(received, "\r\n\r\n") {
				line, err := reader.ReadString('\n')
				received += line
				if err != nil {
					break
				}
			}
		}
		targetRequest <- []byte(received)
		_, _ = io.WriteString(server, response)
		_ = server.CloseWrite()
	}()

	secured := tls.Client(client, &tls.Config{InsecureSkipVerify: true, ServerName: "target.test", NextProtos: []string{"http/1.1"}})
	if err := secured.Handshake(); err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(secured, request); err != nil {
		t.Fatal(err)
	}
	_ = secured.CloseWrite()
	receivedResponse, err := io.ReadAll(secured)
	if err != nil {
		t.Fatal(err)
	}
	if received := string(<-targetRequest); received != request {
		t.Fatalf("TLS origin plaintext changed\nreceived: %q\nexpected: %q", received, request)
	}
	if string(receivedResponse) != response {
		t.Fatalf("TLS client plaintext changed\nreceived: %q\nexpected: %q", receivedResponse, response)
	}
	awaitGateway(t, done)
}

func TestProtocolGatewayRelaysUnknownTCPBytesUnchanged(t *testing.T) {
	gateway := &protocolGateway{}
	client, gatewayClient := tcpConnectionPair(t)
	gatewayUpstream, target := tcpConnectionPair(t)
	done := make(chan error, 1)
	go func() {
		done <- gateway.serve(context.Background(), gatewayClient, &dialedUpstream{connection: gatewayUpstream}, "192.0.2.22:22")
	}()
	serverPayload := []byte("SSH-2.0-TestServer\r\n\x00\xffraw-banner")
	clientPayload := []byte("SSH-2.0-TestClient\r\n\x01\xfeclient-data")
	go func() {
		_, _ = target.Write(serverPayload)
		_ = target.CloseWrite()
	}()
	if _, err := client.Write(clientPayload); err != nil {
		t.Fatal(err)
	}
	_ = client.CloseWrite()
	receivedAtClient, err := io.ReadAll(client)
	if err != nil {
		t.Fatal(err)
	}
	receivedAtTarget, err := io.ReadAll(target)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(receivedAtClient, serverPayload) || !bytes.Equal(receivedAtTarget, clientPayload) {
		t.Fatalf("unknown TCP changed: client=%q target=%q", receivedAtClient, receivedAtTarget)
	}
	awaitGateway(t, done)
}

func TestProtocolGatewayIgnoresPassiveHTTPParseFailure(t *testing.T) {
	gateway := &protocolGateway{}
	client, gatewayClient := tcpConnectionPair(t)
	gatewayUpstream, target := tcpConnectionPair(t)
	done := make(chan error, 1)
	go func() {
		done <- gateway.serve(context.Background(), gatewayClient, &dialedUpstream{connection: gatewayUpstream}, "192.0.2.23:8080")
	}()
	malformed := []byte("GET /still-forwarded HTTP/INVALID\r\nRaw-Header without-colon\r\n\r\n\x00\xff")
	reply := []byte("origin accepted malformed bytes\x00\xfe")
	targetReceived := make(chan []byte, 1)
	go func() {
		received, _ := io.ReadAll(target)
		targetReceived <- received
		_, _ = target.Write(reply)
		_ = target.CloseWrite()
	}()
	if _, err := client.Write(malformed); err != nil {
		t.Fatal(err)
	}
	_ = client.CloseWrite()
	receivedReply, err := io.ReadAll(client)
	if err != nil {
		t.Fatal(err)
	}
	if received := <-targetReceived; !bytes.Equal(received, malformed) {
		t.Fatalf("malformed HTTP changed: %q", received)
	}
	if !bytes.Equal(receivedReply, reply) {
		t.Fatalf("reply after parse failure changed: %q", receivedReply)
	}
	awaitGateway(t, done)
}

func TestPassiveByteStreamDropDoesNotBlockOrLeakCollector(t *testing.T) {
	stream := newPassiveByteStream()
	payload := bytes.Repeat([]byte("x"), 32<<10)
	for index := 0; index < passiveHTTPQueueDepth+4; index++ {
		if count, err := stream.Write(payload); err != nil || count != len(payload) {
			t.Fatalf("passive write = %d, %v", count, err)
		}
	}
	if !stream.dropped.Load() {
		t.Fatal("passive stream did not enter dropped state")
	}
	stream.close()
	_ = stream.reader.Close()
	select {
	case <-stream.done:
	case <-time.After(time.Second):
		t.Fatal("passive stream collector did not exit")
	}
}

func TestReplayContextIsClaimedOutOfBand(t *testing.T) {
	path := filepath.Join(t.TempDir(), "pending.json")
	payload := []byte(`{"replayOf":"flow:source","taskRef":"task:source","attribution":"web-replay"}`)
	if err := os.WriteFile(path, payload, 0o600); err != nil {
		t.Fatal(err)
	}
	context := claimReplayContextForUID(path, uint32(os.Geteuid()))
	if context.ReplayOf != "flow:source" || context.TaskRef != "task:source" || context.Attribution != "web-replay" {
		t.Fatalf("claimed replay context = %#v", context)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("claimed replay context was not removed: %v", err)
	}
}

func TestCaptureWriterTracksTCPConnectionLifecycle(t *testing.T) {
	root := t.TempDir()
	epochPath := filepath.Join(root, "epoch.json")
	statusPath := filepath.Join(root, "status.json")
	epoch, _ := json.Marshal(map[string]any{
		"active": true, "epochRef": "epoch:tcp", "flowFile": filepath.Join(root, "flow.mitm"),
	})
	if err := os.WriteFile(epochPath, epoch, 0o600); err != nil {
		t.Fatal(err)
	}
	writer, err := newCaptureWriter(epochPath, statusPath)
	if err != nil {
		t.Fatal(err)
	}
	lease, err := writer.beginTCP()
	if err != nil {
		t.Fatal(err)
	}
	assertActiveTCPCount(t, statusPath, "epoch:tcp", 1)
	if err := lease.finish(); err != nil {
		t.Fatal(err)
	}
	assertActiveTCPCount(t, statusPath, "epoch:tcp", 0)
}

func assertActiveTCPCount(t *testing.T, path, epochRef string, expected int) {
	t.Helper()
	payload, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var status captureStatusFile
	if err := json.Unmarshal(payload, &status); err != nil {
		t.Fatal(err)
	}
	if actual := status.Epochs[epochRef].ActiveTCPCount; actual != expected {
		t.Fatalf("active TCP count = %d, expected %d", actual, expected)
	}
}

func tcpConnectionPair(t *testing.T) (*net.TCPConn, *net.TCPConn) {
	t.Helper()
	listener, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	accepted := make(chan *net.TCPConn, 1)
	acceptError := make(chan error, 1)
	go func() {
		connection, err := listener.AcceptTCP()
		if err != nil {
			acceptError <- err
			return
		}
		accepted <- connection
	}()
	client, err := net.DialTCP("tcp4", nil, listener.Addr().(*net.TCPAddr))
	if err != nil {
		_ = listener.Close()
		t.Fatal(err)
	}
	select {
	case server := <-accepted:
		_ = listener.Close()
		t.Cleanup(func() { client.Close() })
		t.Cleanup(func() { server.Close() })
		return client, server
	case err := <-acceptError:
		_ = listener.Close()
		client.Close()
		t.Fatal(err)
	case <-time.After(time.Second):
		_ = listener.Close()
		client.Close()
		t.Fatal("timed out accepting TCP test connection")
	}
	return nil, nil
}

func awaitGateway(t *testing.T, done <-chan error) {
	t.Helper()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("protocol gateway did not finish")
	}
}
