package main

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"testing"
	"time"

	"github.com/nicocha30/gvisor-ligolo/pkg/tcpip"
	"github.com/nicocha30/gvisor-ligolo/pkg/tcpip/stack"
	"github.com/nicocha30/gvisor-ligolo/pkg/tcpip/transport/tcp"
)

func TestTransparentTCPTimeWaitMatchesLocalPortReuse(t *testing.T) {
	networkStack := stack.New(stack.Options{
		TransportProtocols: []stack.TransportProtocolFactory{tcp.NewProtocol},
	})
	defer networkStack.Destroy()
	if stackError := configureTransparentTCPTimeWait(networkStack); stackError != nil {
		t.Fatal(stackError)
	}
	var configured tcpip.TCPTimeWaitTimeoutOption
	if stackError := networkStack.TransportProtocolOption(tcp.ProtocolNumber, &configured); stackError != nil {
		t.Fatal(stackError)
	}
	if got := time.Duration(configured); got != transparentTCPTimeWaitTimeout {
		t.Fatalf("TCP TIME_WAIT timeout = %s, want %s", got, transparentTCPTimeWaitTimeout)
	}
}

func TestSOCKSHandshakeWaitsForSuccessfulTargetReply(t *testing.T) {
	connection, requests, closeServer := startSOCKSServer(0x00)
	defer closeServer()
	if err := socksHandshake(connection, "192.0.2.10:443"); err != nil {
		t.Fatal(err)
	}
	request := <-requests
	if got := net.IP(request[4:8]).String(); got != "192.0.2.10" {
		t.Fatalf("destination IP = %s", got)
	}
	if got := binary.BigEndian.Uint16(request[8:10]); got != 443 {
		t.Fatalf("destination port = %d", got)
	}
}

func TestSOCKSHandshakeReturnsTypedTargetFailure(t *testing.T) {
	connection, _, closeServer := startSOCKSServer(0x05)
	defer closeServer()
	err := socksHandshake(connection, "192.0.2.10:22")
	replyError, ok := err.(*socksReplyError)
	if !ok || replyError.code != 0x05 {
		t.Fatalf("error = %#v", err)
	}
}

func TestTCPResetOnlyForDefinitiveDialFailure(t *testing.T) {
	for _, err := range []error{
		&socksReplyError{code: 0x04},
		io.EOF,
		errors.New("route snapshot invalid"),
	} {
		if !shouldResetTCP(err) {
			t.Fatalf("definitive failure should reset the client TCP connection: %v", err)
		}
	}
	for _, err := range []error{
		context.DeadlineExceeded,
		context.Canceled,
		&net.DNSError{IsTimeout: true},
	} {
		if shouldResetTCP(err) {
			t.Fatalf("timeout or cancellation should preserve timeout semantics: %v", err)
		}
	}
}

func startSOCKSServer(replyCode byte) (net.Conn, <-chan []byte, func()) {
	client, server := net.Pipe()
	requests := make(chan []byte, 1)
	go func() {
		defer server.Close()
		greeting := make([]byte, 3)
		if _, readError := io.ReadFull(server, greeting); readError != nil {
			return
		}
		_, _ = server.Write([]byte{0x05, 0x00})
		request := make([]byte, 10)
		if _, readError := io.ReadFull(server, request); readError != nil {
			return
		}
		requests <- request
		_, _ = server.Write([]byte{0x05, replyCode, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
	}()
	return client, requests, func() { _ = client.Close() }
}
