//go:build linux

package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/nicocha30/gvisor-ligolo/pkg/tcpip"
	"github.com/nicocha30/gvisor-ligolo/pkg/tcpip/adapters/gonet"
	"github.com/nicocha30/gvisor-ligolo/pkg/tcpip/header"
	"github.com/nicocha30/gvisor-ligolo/pkg/tcpip/link/fdbased"
	"github.com/nicocha30/gvisor-ligolo/pkg/tcpip/link/rawfile"
	gvistun "github.com/nicocha30/gvisor-ligolo/pkg/tcpip/link/tun"
	"github.com/nicocha30/gvisor-ligolo/pkg/tcpip/network/ipv4"
	"github.com/nicocha30/gvisor-ligolo/pkg/tcpip/stack"
	"github.com/nicocha30/gvisor-ligolo/pkg/tcpip/transport/tcp"
	"github.com/nicocha30/gvisor-ligolo/pkg/waiter"
)

type destinationDialer func(context.Context, string) (net.Conn, error)

func main() {
	mode := flag.String("mode", "", "gate mode: capture or route")
	tunName := flag.String("tun", "", "TUN interface name")
	proxyAddress := flag.String("proxy", "127.0.0.1:1080", "mitmproxy SOCKS5 address")
	routesFile := flag.String("routes-file", "/run/luanniao/routes.json", "route snapshot file")
	readyFile := flag.String("ready-file", "", "readiness file")
	connectTimeout := flag.Duration("connect-timeout", 15*time.Second, "upstream connection timeout")
	maxInflight := flag.Int("max-inflight", 1024, "maximum pending TCP handshakes")
	flag.Parse()

	if *tunName == "" || *readyFile == "" {
		log.Fatal("tun and ready-file are required")
	}
	if *maxInflight < 1 {
		log.Fatal("max-inflight must be positive")
	}
	var dial destinationDialer
	switch *mode {
	case "capture":
		dial = func(ctx context.Context, destination string) (net.Conn, error) {
			return dialSOCKS5(ctx, *proxyAddress, destination, *connectTimeout)
		}
	case "route":
		routeDialer := newRouteDialer(*routesFile, *connectTimeout, *proxyAddress)
		if _, err := routeDialer.routes.load(); err != nil {
			log.Fatal(err)
		}
		dial = routeDialer.dial
	default:
		log.Fatal("mode must be capture or route")
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	networkStack, tunFD, err := startStack(ctx, *tunName, dial, *maxInflight)
	if err != nil {
		log.Fatal(err)
	}
	defer syscall.Close(tunFD)
	defer networkStack.Destroy()
	if err := os.MkdirAll(filepath.Dir(*readyFile), 0o755); err != nil {
		log.Fatalf("create readiness directory: %v", err)
	}
	if err := writePrecreatedReadyFile(*readyFile); err != nil {
		log.Fatalf("write readiness file: %v", err)
	}
	<-ctx.Done()
}

func startStack(
	ctx context.Context,
	tunName string,
	dial destinationDialer,
	maxInflight int,
) (*stack.Stack, int, error) {
	networkStack := stack.New(stack.Options{
		NetworkProtocols:   []stack.NetworkProtocolFactory{ipv4.NewProtocol},
		TransportProtocols: []stack.TransportProtocolFactory{tcp.NewProtocol},
		HandleLocal:        false,
	})
	forwarder := tcp.NewForwarder(networkStack, 0, maxInflight, func(request *tcp.ForwarderRequest) {
		go handleTCP(ctx, request, dial)
	})
	networkStack.SetTransportProtocolHandler(tcp.ProtocolNumber, forwarder.HandlePacket)

	mtu, err := rawfile.GetMTU(tunName)
	if err != nil {
		networkStack.Destroy()
		return nil, -1, fmt.Errorf("read TUN MTU: %w", err)
	}
	tunFD, err := gvistun.Open(tunName)
	if err != nil {
		networkStack.Destroy()
		return nil, -1, fmt.Errorf("open TUN interface: %w", err)
	}
	linkEndpoint, err := fdbased.New(&fdbased.Options{FDs: []int{tunFD}, MTU: mtu})
	if err != nil {
		syscall.Close(tunFD)
		networkStack.Destroy()
		return nil, -1, fmt.Errorf("create TUN link endpoint: %w", err)
	}
	if stackError := networkStack.CreateNIC(1, linkEndpoint); stackError != nil {
		syscall.Close(tunFD)
		networkStack.Destroy()
		return nil, -1, fmt.Errorf("create TUN network interface: %s", stackError)
	}
	networkStack.SetRouteTable([]tcpip.Route{{Destination: header.IPv4EmptySubnet, NIC: 1}})
	if stackError := networkStack.SetPromiscuousMode(1, true); stackError != nil {
		syscall.Close(tunFD)
		networkStack.Destroy()
		return nil, -1, fmt.Errorf("enable promiscuous mode: %s", stackError)
	}
	if stackError := networkStack.SetSpoofing(1, true); stackError != nil {
		syscall.Close(tunFD)
		networkStack.Destroy()
		return nil, -1, fmt.Errorf("enable address spoofing: %s", stackError)
	}
	sackEnabled := tcpip.TCPSACKEnabled(false)
	if stackError := networkStack.SetTransportProtocolOption(tcp.ProtocolNumber, &sackEnabled); stackError != nil {
		syscall.Close(tunFD)
		networkStack.Destroy()
		return nil, -1, fmt.Errorf("disable TCP SACK: %s", stackError)
	}
	synCookies := tcpip.TCPAlwaysUseSynCookies(false)
	if stackError := networkStack.SetTransportProtocolOption(tcp.ProtocolNumber, &synCookies); stackError != nil {
		syscall.Close(tunFD)
		networkStack.Destroy()
		return nil, -1, fmt.Errorf("disable SYN cookies: %s", stackError)
	}
	if stackError := configureTransparentTCPTimeWait(networkStack); stackError != nil {
		syscall.Close(tunFD)
		networkStack.Destroy()
		return nil, -1, fmt.Errorf("configure transparent TCP TIME_WAIT: %s", stackError)
	}
	return networkStack, tunFD, nil
}

func handleTCP(
	ctx context.Context,
	request *tcp.ForwarderRequest,
	dial destinationDialer,
) {
	endpointID := request.ID()
	destination := net.JoinHostPort(endpointID.LocalAddress.String(), fmt.Sprint(endpointID.LocalPort))
	upstream, err := dial(ctx, destination)
	if err != nil {
		request.Complete(shouldResetTCP(err))
		return
	}
	var waitQueue waiter.Queue
	endpoint, stackError := request.CreateEndpoint(&waitQueue)
	if stackError != nil {
		upstream.Close()
		request.Complete(true)
		return
	}
	request.Complete(false)
	client := gonet.NewTCPConn(&waitQueue, endpoint)
	relay(client, upstream)
}
