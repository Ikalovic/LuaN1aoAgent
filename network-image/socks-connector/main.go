package main

import (
	"context"
	"encoding/binary"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	socksVersion       = 0x05
	noAuthentication   = 0x00
	usernamePassword   = 0x02
	noAcceptableMethod = 0xff
	connectCommand     = 0x01
	ipv4Address        = 0x01
	domainAddress      = 0x03
	ipv6Address        = 0x04
)

type upstreamConfig struct {
	address  string
	username string
	password string
	timeout  time.Duration
}

func main() {
	listenAddress := flag.String("listen", "127.0.0.1:1080", "downstream SOCKS5 listen address")
	upstreamAddress := flag.String("upstream", "", "authenticated upstream SOCKS5 address")
	username := flag.String("username", "", "upstream SOCKS5 username")
	passwordFile := flag.String("password-file", "", "file containing the upstream SOCKS5 password")
	timeout := flag.Duration("connect-timeout", 15*time.Second, "upstream handshake timeout")
	flag.Parse()

	if *upstreamAddress == "" || *username == "" || *passwordFile == "" {
		log.Fatal("upstream, username, and password-file are required")
	}
	passwordBytes, err := os.ReadFile(*passwordFile)
	if err != nil {
		log.Fatalf("read password file: %v", err)
	}
	config := upstreamConfig{
		address:  *upstreamAddress,
		username: *username,
		password: strings.TrimSuffix(strings.TrimSuffix(string(passwordBytes), "\n"), "\r"),
		timeout:  *timeout,
	}
	if err := validateCredentials(config.username, config.password); err != nil {
		log.Fatal(err)
	}
	probeContext, cancelProbe := context.WithTimeout(context.Background(), config.timeout)
	probeConnection, err := authenticateUpstream(probeContext, config)
	cancelProbe()
	if err != nil {
		log.Fatalf("authenticate upstream: %v", err)
	}
	_ = probeConnection.Close()

	listener, err := net.Listen("tcp", *listenAddress)
	if err != nil {
		log.Fatal(err)
	}
	defer listener.Close()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		_ = listener.Close()
	}()

	for {
		connection, err := listener.Accept()
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				return
			}
			log.Printf("accept downstream: %v", err)
			continue
		}
		go handleConnection(ctx, connection, config)
	}
}

func handleConnection(ctx context.Context, downstream net.Conn, config upstreamConfig) {
	defer downstream.Close()
	destination, err := acceptDownstream(downstream, config.timeout)
	if err != nil {
		return
	}
	upstream, reply, err := connectUpstream(ctx, config, destination)
	if err != nil {
		_ = writeDownstreamReply(downstream, reply)
		return
	}
	defer upstream.Close()
	if err := writeDownstreamReply(downstream, 0x00); err != nil {
		return
	}
	relayConnections(downstream, upstream)
}

func acceptDownstream(connection net.Conn, timeout time.Duration) (string, error) {
	if err := connection.SetDeadline(time.Now().Add(timeout)); err != nil {
		return "", err
	}
	header := make([]byte, 2)
	if _, err := io.ReadFull(connection, header); err != nil {
		return "", err
	}
	if header[0] != socksVersion || header[1] == 0 {
		return "", errors.New("invalid downstream SOCKS5 greeting")
	}
	methods := make([]byte, int(header[1]))
	if _, err := io.ReadFull(connection, methods); err != nil {
		return "", err
	}
	selected := byte(noAcceptableMethod)
	for _, method := range methods {
		if method == noAuthentication {
			selected = noAuthentication
			break
		}
	}
	if _, err := connection.Write([]byte{socksVersion, selected}); err != nil {
		return "", err
	}
	if selected == noAcceptableMethod {
		return "", errors.New("downstream did not offer no-authentication SOCKS5")
	}

	request := make([]byte, 4)
	if _, err := io.ReadFull(connection, request); err != nil {
		return "", err
	}
	if request[0] != socksVersion || request[1] != connectCommand || request[2] != 0x00 {
		_ = writeDownstreamReply(connection, 0x07)
		return "", errors.New("unsupported downstream SOCKS5 request")
	}
	host, err := readAddress(connection, request[3])
	if err != nil {
		_ = writeDownstreamReply(connection, 0x08)
		return "", err
	}
	portBytes := make([]byte, 2)
	if _, err := io.ReadFull(connection, portBytes); err != nil {
		return "", err
	}
	if err := connection.SetDeadline(time.Time{}); err != nil {
		return "", err
	}
	return net.JoinHostPort(host, strconv.Itoa(int(binary.BigEndian.Uint16(portBytes)))), nil
}

func connectUpstream(ctx context.Context, config upstreamConfig, destination string) (net.Conn, byte, error) {
	connection, err := authenticateUpstream(ctx, config)
	if err != nil {
		return nil, 0x02, err
	}
	fail := func(reply byte, err error) (net.Conn, byte, error) {
		_ = connection.Close()
		return nil, reply, err
	}

	connectContext, cancel := context.WithTimeout(ctx, config.timeout)
	defer cancel()
	if deadline, ok := connectContext.Deadline(); ok {
		_ = connection.SetDeadline(deadline)
	}
	host, portText, err := net.SplitHostPort(destination)
	if err != nil {
		return fail(0x01, err)
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port < 1 || port > 65535 {
		return fail(0x01, errors.New("invalid destination port"))
	}
	request := []byte{socksVersion, connectCommand, 0x00}
	if ip := net.ParseIP(host); ip != nil {
		if ipv4 := ip.To4(); ipv4 != nil {
			request = append(request, ipv4Address)
			request = append(request, ipv4...)
		} else {
			request = append(request, ipv6Address)
			request = append(request, ip.To16()...)
		}
	} else {
		if len(host) > 255 {
			return fail(0x08, errors.New("destination hostname is too long"))
		}
		request = append(request, domainAddress, byte(len(host)))
		request = append(request, host...)
	}
	portBytes := make([]byte, 2)
	binary.BigEndian.PutUint16(portBytes, uint16(port))
	request = append(request, portBytes...)
	if _, err := connection.Write(request); err != nil {
		return fail(0x01, err)
	}
	replyHeader := make([]byte, 4)
	if _, err := io.ReadFull(connection, replyHeader); err != nil {
		return fail(0x01, err)
	}
	if replyHeader[0] != socksVersion {
		return fail(0x01, errors.New("invalid upstream SOCKS5 reply"))
	}
	if err := discardAddress(connection, replyHeader[3]); err != nil {
		return fail(0x01, err)
	}
	if _, err := io.CopyN(io.Discard, connection, 2); err != nil {
		return fail(0x01, err)
	}
	if replyHeader[1] != 0x00 {
		return fail(replyHeader[1], fmt.Errorf("upstream SOCKS5 connect failed with reply 0x%02x", replyHeader[1]))
	}
	if err := connection.SetDeadline(time.Time{}); err != nil {
		return fail(0x01, err)
	}
	return connection, 0x00, nil
}

func authenticateUpstream(ctx context.Context, config upstreamConfig) (net.Conn, error) {
	connectContext, cancel := context.WithTimeout(ctx, config.timeout)
	defer cancel()
	connection, err := (&net.Dialer{}).DialContext(connectContext, "tcp", config.address)
	if err != nil {
		return nil, err
	}
	fail := func(err error) (net.Conn, error) {
		_ = connection.Close()
		return nil, err
	}
	if deadline, ok := connectContext.Deadline(); ok {
		if err := connection.SetDeadline(deadline); err != nil {
			return fail(err)
		}
	}
	if _, err := connection.Write([]byte{socksVersion, 0x01, usernamePassword}); err != nil {
		return fail(err)
	}
	method := make([]byte, 2)
	if _, err := io.ReadFull(connection, method); err != nil {
		return fail(err)
	}
	if method[0] != socksVersion || method[1] != usernamePassword {
		return fail(fmt.Errorf("upstream rejected username/password authentication: %x", method))
	}
	auth := []byte{0x01, byte(len(config.username))}
	auth = append(auth, config.username...)
	auth = append(auth, byte(len(config.password)))
	auth = append(auth, config.password...)
	if _, err := connection.Write(auth); err != nil {
		return fail(err)
	}
	authReply := make([]byte, 2)
	if _, err := io.ReadFull(connection, authReply); err != nil {
		return fail(err)
	}
	if authReply[0] != 0x01 || authReply[1] != 0x00 {
		return fail(errors.New("upstream SOCKS5 credentials were rejected"))
	}
	if err := connection.SetDeadline(time.Time{}); err != nil {
		return fail(err)
	}
	return connection, nil
}

func readAddress(connection io.Reader, addressType byte) (string, error) {
	switch addressType {
	case ipv4Address:
		value := make([]byte, net.IPv4len)
		_, err := io.ReadFull(connection, value)
		return net.IP(value).String(), err
	case ipv6Address:
		value := make([]byte, net.IPv6len)
		_, err := io.ReadFull(connection, value)
		return net.IP(value).String(), err
	case domainAddress:
		length := make([]byte, 1)
		if _, err := io.ReadFull(connection, length); err != nil {
			return "", err
		}
		value := make([]byte, int(length[0]))
		_, err := io.ReadFull(connection, value)
		return string(value), err
	default:
		return "", errors.New("unsupported SOCKS5 address type")
	}
}

func discardAddress(connection io.Reader, addressType byte) error {
	switch addressType {
	case ipv4Address:
		_, err := io.CopyN(io.Discard, connection, net.IPv4len)
		return err
	case ipv6Address:
		_, err := io.CopyN(io.Discard, connection, net.IPv6len)
		return err
	case domainAddress:
		length := make([]byte, 1)
		if _, err := io.ReadFull(connection, length); err != nil {
			return err
		}
		_, err := io.CopyN(io.Discard, connection, int64(length[0]))
		return err
	default:
		return errors.New("unsupported SOCKS5 address type")
	}
}

func writeDownstreamReply(connection io.Writer, reply byte) error {
	_, err := connection.Write([]byte{socksVersion, reply, 0x00, ipv4Address, 0, 0, 0, 0, 0, 0})
	return err
}

func validateCredentials(username string, password string) error {
	if len(username) < 1 || len(username) > 255 {
		return errors.New("SOCKS5 username must contain 1-255 bytes")
	}
	if len(password) < 1 || len(password) > 255 {
		return errors.New("SOCKS5 password must contain 1-255 bytes")
	}
	return nil
}

func relayConnections(left net.Conn, right net.Conn) {
	var waitGroup sync.WaitGroup
	waitGroup.Add(2)
	go func() {
		defer waitGroup.Done()
		_, _ = io.Copy(right, left)
		closeWrite(right)
	}()
	go func() {
		defer waitGroup.Done()
		_, _ = io.Copy(left, right)
		closeWrite(left)
	}()
	waitGroup.Wait()
}

func closeWrite(connection net.Conn) {
	if closer, ok := connection.(interface{ CloseWrite() error }); ok {
		_ = closer.CloseWrite()
	}
}
