package main

import (
	"time"

	"github.com/nicocha30/gvisor-ligolo/pkg/tcpip"
	"github.com/nicocha30/gvisor-ligolo/pkg/tcpip/stack"
	"github.com/nicocha30/gvisor-ligolo/pkg/tcpip/transport/tcp"
)

const transparentTCPTimeWaitTimeout = time.Second

func configureTransparentTCPTimeWait(networkStack *stack.Stack) tcpip.Error {
	timeWaitTimeout := tcpip.TCPTimeWaitTimeoutOption(transparentTCPTimeWaitTimeout)
	return networkStack.SetTransportProtocolOption(tcp.ProtocolNumber, &timeWaitTimeout)
}
