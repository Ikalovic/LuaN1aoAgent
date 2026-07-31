//go:build linux

package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net"
	"net/netip"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
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
	mode := flag.String("mode", "", "gate mode: unified")
	tunName := flag.String("tun", "", "TUN interface name")
	routesFile := flag.String("routes-file", "/run/luanniao/routes.json", "route snapshot file")
	directBroker := flag.String("direct-broker", "", "authenticated host egress broker address")
	directBrokerToken := flag.String("direct-broker-token", "", "authenticated host egress broker token")
	localDirectHost := flag.String("local-direct-host", "", "Docker host alias resolved for local target access")
	denyCIDRs := flag.String("deny-cidrs", "", "comma-separated protected IPv4 networks")
	allowCIDRs := flag.String("allow-cidrs", "", "comma-separated authorized direct IPv4 networks")
	allowDomainResolved := flag.Bool("allow-domain-resolved", false, "accept destinations admitted by the kernel domain scope guard")
	localDenyPorts := flag.String("local-direct-deny-ports", "", "comma-separated protected host ports")
	readyFile := flag.String("ready-file", "", "readiness file")
	connectTimeout := flag.Duration("connect-timeout", 15*time.Second, "upstream connection timeout")
	maxInflight := flag.Int("max-inflight", 1024, "maximum pending TCP handshakes")
	epochFile := flag.String("epoch-file", "/run/luanniao/epoch.json", "active capture epoch file")
	captureStatus := flag.String("capture-status", "/run/luanniao/capture/status.json", "capture status file")
	caCert := flag.String("ca-cert", "/traffic/ca/mitmproxy-ca-cert.pem", "public MITM CA certificate")
	caKey := flag.String("ca-key", "/traffic/ca/luanniao-ca-key.pem", "private MITM CA key")
	runRef := flag.String("run-ref", "", "run reference attached to captured flows")
	taskRef := flag.String("task-ref", "", "task reference attached to captured flows")
	flag.Parse()

	if *tunName == "" || *readyFile == "" || *directBroker == "" || *directBrokerToken == "" {
		log.Fatal("tun, ready-file, direct-broker, and direct-broker-token are required")
	}
	if *maxInflight < 1 {
		log.Fatal("max-inflight must be positive")
	}
	if *mode != "unified" {
		log.Fatal("mode must be unified")
	}
	routeDialer := newRouteDialer(*routesFile, *connectTimeout)
	routeDialer.brokerAddress = *directBroker
	routeDialer.brokerToken = *directBrokerToken
	routeDialer.localDirect = make(map[netip.Addr]struct{})
	routeDialer.localDenyPorts = make(map[uint16]struct{})
	routeDialer.allowDomainResolved = *allowDomainResolved
	for _, raw := range strings.Split(*localDenyPorts, ",") {
		if strings.TrimSpace(raw) == "" {
			continue
		}
		port, err := strconv.Atoi(strings.TrimSpace(raw))
		if err != nil || port < 1 || port > 65535 {
			log.Fatalf("invalid local direct deny port %q", raw)
		}
		routeDialer.localDenyPorts[uint16(port)] = struct{}{}
	}
	for _, raw := range strings.Split(*denyCIDRs, ",") {
		if strings.TrimSpace(raw) == "" {
			continue
		}
		prefix, err := netip.ParsePrefix(strings.TrimSpace(raw))
		if err != nil || !prefix.Addr().Is4() {
			log.Fatalf("invalid denied IPv4 CIDR %q", raw)
		}
		routeDialer.denyPrefixes = append(routeDialer.denyPrefixes, prefix.Masked())
	}
	for _, raw := range strings.Split(*allowCIDRs, ",") {
		if strings.TrimSpace(raw) == "" {
			continue
		}
		prefix, err := netip.ParsePrefix(strings.TrimSpace(raw))
		if err != nil || !prefix.Addr().Is4() {
			log.Fatalf("invalid allowed IPv4 CIDR %q", raw)
		}
		routeDialer.allowPrefixes = append(routeDialer.allowPrefixes, prefix.Masked())
	}
	if len(routeDialer.allowPrefixes) == 0 && !routeDialer.allowDomainResolved {
		log.Fatal("at least one allowed IPv4 CIDR or domain rule is required")
	}
	if *localDirectHost != "" {
		addresses, err := net.LookupIP(*localDirectHost)
		if err != nil {
			log.Fatalf("resolve local direct host: %v", err)
		}
		for _, address := range addresses {
			if parsed, ok := netip.AddrFromSlice(address); ok && parsed.Unmap().Is4() {
				routeDialer.localDirect[parsed.Unmap()] = struct{}{}
			}
		}
	}
	if _, err := routeDialer.routes.load(); err != nil {
		log.Fatal(err)
	}
	authority, err := loadOrCreateCertificateAuthority(*caCert, *caKey)
	if err != nil {
		log.Fatal(err)
	}
	capture, err := newCaptureWriter(*epochFile, *captureStatus)
	if err != nil {
		log.Fatal(err)
	}
	bodyLimit, err := positiveEnvironmentInt64("LUANNIAO_CAPTURE_BYTES", protocolCaptureLimit)
	if err != nil {
		log.Fatal(err)
	}
	replayContextPath := ""
	if os.Getenv("LUANNIAO_TRUSTED_REPLAY") == "1" {
		replayContextPath = os.Getenv("LUANNIAO_REPLAY_CONTEXT")
		if replayContextPath == "" {
			replayContextPath = "/run/luanniao-replay-pending.json"
		}
	}
	gateway := &protocolGateway{
		dialer: routeDialer, authority: authority, capture: capture,
		runRef: *runRef, taskRef: *taskRef, bodyLimit: int(bodyLimit), replayContextPath: replayContextPath,
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	networkStack, tunFD, err := startStackWithHandler(ctx, *tunName, gateway.handleTCP, *maxInflight)
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
	return startStackWithHandler(ctx, tunName, func(ctx context.Context, request *tcp.ForwarderRequest) {
		handleTCP(ctx, request, dial)
	}, maxInflight)
}

func startStackWithHandler(
	ctx context.Context,
	tunName string,
	handler func(context.Context, *tcp.ForwarderRequest),
	maxInflight int,
) (*stack.Stack, int, error) {
	networkStack := stack.New(stack.Options{
		NetworkProtocols:   []stack.NetworkProtocolFactory{ipv4.NewProtocol},
		TransportProtocols: []stack.TransportProtocolFactory{tcp.NewProtocol},
		HandleLocal:        false,
	})
	forwarder := tcp.NewForwarder(networkStack, 0, maxInflight, func(request *tcp.ForwarderRequest) {
		go handler(ctx, request)
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
