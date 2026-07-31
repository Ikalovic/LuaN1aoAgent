package main

import (
	"context"
	"encoding/hex"
	"io"
	"net"
	"testing"
	"time"
)

func TestHostBrokerDialWaitsForAuthenticatedSuccess(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	token := make([]byte, 32)
	for index := range token {
		token[index] = byte(index)
	}
	requestSeen := make(chan []byte, 1)
	go func() {
		connection, acceptErr := listener.Accept()
		if acceptErr != nil {
			return
		}
		defer connection.Close()
		request := make([]byte, 43)
		if _, readErr := io.ReadFull(connection, request); readErr != nil {
			return
		}
		requestSeen <- request
		_, _ = connection.Write([]byte{0})
		payload := make([]byte, 4)
		_, _ = io.ReadFull(connection, payload)
		_, _ = connection.Write(payload)
	}()
	connection, err := dialHostBroker(
		context.Background(), listener.Addr().String(), hex.EncodeToString(token), "192.0.2.10:31337", time.Second,
	)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	request := <-requestSeen
	if string(request[:5]) != "LNDB1" || !net.IP(request[37:41]).Equal(net.ParseIP("192.0.2.10")) {
		t.Fatalf("broker request = %x", request)
	}
	if _, err := connection.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	reply := make([]byte, 4)
	if _, err := io.ReadFull(connection, reply); err != nil || string(reply) != "ping" {
		t.Fatalf("relay reply = %q, error = %v", reply, err)
	}
}
