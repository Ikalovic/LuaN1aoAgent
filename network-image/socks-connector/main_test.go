package main

import (
	"bufio"
	"context"
	"encoding/binary"
	"io"
	"net"
	"strconv"
	"testing"
	"time"
)

func TestAuthenticatedUpstreamRelay(t *testing.T) {
	target, targetAddress := startEchoServer(t)
	defer target.Close()
	upstream, upstreamAddress := startAuthenticatedSocksServer(t, "admin", "secret")
	defer upstream.Close()

	left, right := net.Pipe()
	defer left.Close()
	defer right.Close()
	go handleConnection(context.Background(), right, upstreamConfig{
		address: upstreamAddress, username: "admin", password: "secret", timeout: 2 * time.Second,
	})

	if _, err := left.Write([]byte{0x05, 0x01, 0x00}); err != nil {
		t.Fatal(err)
	}
	method := make([]byte, 2)
	if _, err := io.ReadFull(left, method); err != nil {
		t.Fatal(err)
	}
	if method[1] != 0x00 {
		t.Fatalf("method = %x", method)
	}
	host, rawPort, _ := net.SplitHostPort(targetAddress)
	port, _ := net.LookupPort("tcp", rawPort)
	request := []byte{0x05, 0x01, 0x00, 0x01}
	request = append(request, net.ParseIP(host).To4()...)
	portBytes := make([]byte, 2)
	binary.BigEndian.PutUint16(portBytes, uint16(port))
	request = append(request, portBytes...)
	if _, err := left.Write(request); err != nil {
		t.Fatal(err)
	}
	reply := make([]byte, 10)
	if _, err := io.ReadFull(left, reply); err != nil {
		t.Fatal(err)
	}
	if reply[1] != 0x00 {
		t.Fatalf("reply = %x", reply)
	}
	if _, err := left.Write([]byte("hello\n")); err != nil {
		t.Fatal(err)
	}
	line, err := bufio.NewReader(left).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	if line != "hello\n" {
		t.Fatalf("echo = %q", line)
	}
}

func TestUpstreamRejectsWrongPassword(t *testing.T) {
	upstream, address := startAuthenticatedSocksServer(t, "admin", "secret")
	defer upstream.Close()
	connection, reply, err := connectUpstream(context.Background(), upstreamConfig{
		address: address, username: "admin", password: "wrong", timeout: time.Second,
	}, "192.0.2.1:443")
	if connection != nil || err == nil || reply != 0x02 {
		t.Fatalf("connection=%v reply=%x err=%v", connection, reply, err)
	}
}

func startEchoServer(t *testing.T) (net.Listener, string) {
	t.Helper()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer connection.Close()
				_, _ = io.Copy(connection, connection)
			}()
		}
	}()
	return listener, listener.Addr().String()
}

func startAuthenticatedSocksServer(t *testing.T, username string, password string) (net.Listener, string) {
	t.Helper()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			go serveAuthenticatedSocks(connection, username, password)
		}
	}()
	return listener, listener.Addr().String()
}

func serveAuthenticatedSocks(connection net.Conn, username string, password string) {
	defer connection.Close()
	header := make([]byte, 2)
	if _, err := io.ReadFull(connection, header); err != nil {
		return
	}
	methods := make([]byte, int(header[1]))
	if _, err := io.ReadFull(connection, methods); err != nil {
		return
	}
	_, _ = connection.Write([]byte{0x05, 0x02})
	authHeader := make([]byte, 2)
	if _, err := io.ReadFull(connection, authHeader); err != nil {
		return
	}
	user := make([]byte, int(authHeader[1]))
	if _, err := io.ReadFull(connection, user); err != nil {
		return
	}
	passwordLength := make([]byte, 1)
	if _, err := io.ReadFull(connection, passwordLength); err != nil {
		return
	}
	secret := make([]byte, int(passwordLength[0]))
	if _, err := io.ReadFull(connection, secret); err != nil {
		return
	}
	if string(user) != username || string(secret) != password {
		_, _ = connection.Write([]byte{0x01, 0x01})
		return
	}
	_, _ = connection.Write([]byte{0x01, 0x00})
	request := make([]byte, 4)
	if _, err := io.ReadFull(connection, request); err != nil {
		return
	}
	host, err := readAddress(connection, request[3])
	if err != nil {
		return
	}
	portBytes := make([]byte, 2)
	if _, err := io.ReadFull(connection, portBytes); err != nil {
		return
	}
	target, err := net.Dial("tcp", net.JoinHostPort(host, strconv.Itoa(int(binary.BigEndian.Uint16(portBytes)))))
	if err != nil {
		_, _ = connection.Write([]byte{0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
		return
	}
	defer target.Close()
	_, _ = connection.Write([]byte{0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
	relayConnections(connection, target)
}
