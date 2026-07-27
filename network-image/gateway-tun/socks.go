package main

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"time"
)

type socksReplyError struct {
	code byte
}

func (errorValue *socksReplyError) Error() string {
	return fmt.Sprintf("SOCKS5 connect failed with reply 0x%02x", errorValue.code)
}

func shouldResetTCP(err error) bool {
	if err == nil || errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return false
	}
	var networkError net.Error
	if errors.As(err, &networkError) && networkError.Timeout() {
		return false
	}
	return true
}

func dialSOCKS5(
	ctx context.Context,
	proxyAddress string,
	destination string,
	timeout time.Duration,
) (net.Conn, error) {
	connectContext, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	proxyConnection, err := (&net.Dialer{}).DialContext(connectContext, "tcp", proxyAddress)
	if err != nil {
		return nil, err
	}
	deadline, hasDeadline := connectContext.Deadline()
	if hasDeadline {
		if err := proxyConnection.SetDeadline(deadline); err != nil {
			proxyConnection.Close()
			return nil, err
		}
	}
	if err := socksHandshake(proxyConnection, destination); err != nil {
		proxyConnection.Close()
		return nil, err
	}
	if err := proxyConnection.SetDeadline(time.Time{}); err != nil {
		proxyConnection.Close()
		return nil, err
	}
	return proxyConnection, nil
}

func socksHandshake(connection net.Conn, destination string) error {
	if _, err := connection.Write([]byte{0x05, 0x01, 0x00}); err != nil {
		return err
	}
	response := make([]byte, 2)
	if _, err := io.ReadFull(connection, response); err != nil {
		return err
	}
	if response[0] != 0x05 || response[1] != 0x00 {
		return fmt.Errorf("SOCKS5 authentication rejected: %x", response)
	}
	host, portText, err := net.SplitHostPort(destination)
	if err != nil {
		return err
	}
	port, err := net.LookupPort("tcp", portText)
	if err != nil {
		return err
	}
	ipAddress := net.ParseIP(host)
	if ipAddress == nil {
		return fmt.Errorf("SOCKS5 destination is not an IP address: %s", host)
	}
	ipv4Address := ipAddress.To4()
	if ipv4Address == nil {
		return fmt.Errorf("SOCKS5 IPv6 destination is disabled: %s", host)
	}
	request := []byte{0x05, 0x01, 0x00, 0x01}
	request = append(request, ipv4Address...)
	portBytes := make([]byte, 2)
	binary.BigEndian.PutUint16(portBytes, uint16(port))
	request = append(request, portBytes...)
	if _, err := connection.Write(request); err != nil {
		return err
	}
	headerBytes := make([]byte, 4)
	if _, err := io.ReadFull(connection, headerBytes); err != nil {
		return err
	}
	if headerBytes[0] != 0x05 {
		return fmt.Errorf("invalid SOCKS5 response version: %x", headerBytes[0])
	}
	if headerBytes[1] != 0x00 {
		return &socksReplyError{code: headerBytes[1]}
	}
	addressLength := 0
	switch headerBytes[3] {
	case 0x01:
		addressLength = net.IPv4len
	case 0x04:
		addressLength = net.IPv6len
	case 0x03:
		length := make([]byte, 1)
		if _, err := io.ReadFull(connection, length); err != nil {
			return err
		}
		addressLength = int(length[0])
	default:
		return fmt.Errorf("invalid SOCKS5 bound address type: %x", headerBytes[3])
	}
	_, err = io.CopyN(io.Discard, connection, int64(addressLength+2))
	return err
}

func relay(client net.Conn, upstream net.Conn) {
	defer client.Close()
	defer upstream.Close()
	var waitGroup sync.WaitGroup
	waitGroup.Add(2)
	go func() {
		defer waitGroup.Done()
		_, _ = io.Copy(upstream, client)
		closeWrite(upstream)
	}()
	go func() {
		defer waitGroup.Done()
		_, _ = io.Copy(client, upstream)
		closeWrite(client)
	}()
	waitGroup.Wait()
}

func closeWrite(connection net.Conn) {
	if halfCloser, ok := connection.(interface{ CloseWrite() error }); ok {
		_ = halfCloser.CloseWrite()
	}
}
