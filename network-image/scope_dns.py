from __future__ import annotations

import ipaddress
import socket
import socketserver
import struct
import threading
from typing import Callable


AuthorizeAddress = Callable[[str, int], None]


class ScopeDnsProxy:
    def __init__(self, listen_address: str, domains: list[str], authorize_address: AuthorizeAddress,
                 upstream: tuple[str, int] = ("127.0.0.11", 53), allow_unmatched: bool = False) -> None:
        self.domains = tuple(domains)
        self.authorize_address = authorize_address
        self.upstream = upstream
        self.allow_unmatched = allow_unmatched
        self.udp = _ThreadingUdpServer((listen_address, 53), _UdpHandler)
        self.tcp = _ThreadingTcpServer((listen_address, 53), _TcpHandler)
        self.udp.proxy = self
        self.tcp.proxy = self
        self.threads: list[threading.Thread] = []

    def start(self) -> None:
        for server in (self.udp, self.tcp):
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            self.threads.append(thread)

    def is_alive(self) -> bool:
        return len(self.threads) == 2 and all(thread.is_alive() for thread in self.threads)

    def close(self) -> None:
        for server in (self.udp, self.tcp):
            server.shutdown()
            server.server_close()
        for thread in self.threads:
            thread.join(timeout=2)

    def resolve(self, request: bytes, tcp: bool = False) -> bytes:
        try:
            question, _ = dns_question(request)
        except ValueError:
            return dns_error_response(request, 1)
        matched_domain = domain_allowed(question, self.domains)
        if not matched_domain and not self.allow_unmatched:
            return dns_error_response(request, 5)
        try:
            response = forward_dns(request, self.upstream, tcp)
            if len(response) < 2 or response[:2] != request[:2]:
                raise ValueError("DNS response transaction ID mismatch")
            if matched_domain:
                for address, ttl in answer_ipv4_addresses(response):
                    self.authorize_address(address, max(1, min(ttl, 300)))
            return response
        except (OSError, ValueError):
            return dns_error_response(request, 2)


def domain_allowed(name: str, patterns: tuple[str, ...]) -> bool:
    normalized = name.rstrip(".").lower()
    for pattern in patterns:
        if pattern.startswith("*."):
            suffix = pattern[2:]
            if normalized != suffix and normalized.endswith(f".{suffix}"):
                return True
        elif normalized == pattern:
            return True
    return False


def dns_question(packet: bytes) -> tuple[str, int]:
    if len(packet) < 12 or struct.unpack_from("!H", packet, 4)[0] != 1:
        raise ValueError("DNS request must contain one question")
    labels: list[str] = []
    offset = 12
    while True:
        if offset >= len(packet):
            raise ValueError("truncated DNS question")
        length = packet[offset]
        offset += 1
        if length == 0:
            break
        if length > 63 or offset + length > len(packet):
            raise ValueError("invalid DNS label")
        labels.append(packet[offset:offset + length].decode("ascii"))
        offset += length
    if not labels or offset + 4 > len(packet):
        raise ValueError("invalid DNS question")
    return ".".join(labels).lower(), offset + 4


def answer_ipv4_addresses(packet: bytes) -> list[tuple[str, int]]:
    if len(packet) < 12:
        raise ValueError("truncated DNS response")
    question_count, answer_count = struct.unpack_from("!HH", packet, 4)
    offset = 12
    for _ in range(question_count):
        offset = skip_dns_name(packet, offset)
        if offset + 4 > len(packet):
            raise ValueError("truncated DNS question")
        offset += 4
    addresses: list[tuple[str, int]] = []
    for _ in range(answer_count):
        offset = skip_dns_name(packet, offset)
        if offset + 10 > len(packet):
            raise ValueError("truncated DNS answer")
        record_type, record_class, ttl, length = struct.unpack_from("!HHIH", packet, offset)
        offset += 10
        if offset + length > len(packet):
            raise ValueError("truncated DNS record")
        if record_type == 1 and record_class == 1 and length == 4:
            addresses.append((str(ipaddress.IPv4Address(packet[offset:offset + 4])), ttl))
        offset += length
    return addresses


def skip_dns_name(packet: bytes, offset: int) -> int:
    while True:
        if offset >= len(packet):
            raise ValueError("truncated DNS name")
        length = packet[offset]
        if length & 0xC0 == 0xC0:
            if offset + 2 > len(packet):
                raise ValueError("truncated DNS pointer")
            return offset + 2
        offset += 1
        if length == 0:
            return offset
        if length > 63 or offset + length > len(packet):
            raise ValueError("invalid DNS name")
        offset += length


def dns_error_response(request: bytes, code: int) -> bytes:
    try:
        _, question_end = dns_question(request)
        request_flags = struct.unpack_from("!H", request, 2)[0]
        flags = 0x8000 | (request_flags & 0x7900) | 0x0080 | (code & 0xF)
        return request[:2] + struct.pack("!HHHHH", flags, 1, 0, 0, 0) + request[12:question_end]
    except (ValueError, struct.error):
        identifier = request[:2].ljust(2, b"\x00")
        return identifier + struct.pack("!HHHHH", 0x8080 | (code & 0xF), 0, 0, 0, 0)


def forward_dns(request: bytes, upstream: tuple[str, int], tcp: bool) -> bytes:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM if tcp else socket.SOCK_DGRAM) as connection:
        connection.settimeout(5)
        if tcp:
            connection.connect(upstream)
            connection.sendall(struct.pack("!H", len(request)) + request)
            length = struct.unpack("!H", read_exact(connection, 2))[0]
            return read_exact(connection, length)
        connection.sendto(request, upstream)
        return connection.recv(65535)


def read_exact(connection: socket.socket, length: int) -> bytes:
    chunks: list[bytes] = []
    remaining = length
    while remaining:
        chunk = connection.recv(remaining)
        if not chunk:
            raise OSError("unexpected DNS TCP EOF")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


class _ThreadingUdpServer(socketserver.ThreadingMixIn, socketserver.UDPServer):
    daemon_threads = True
    allow_reuse_address = True
    proxy: ScopeDnsProxy


class _ThreadingTcpServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    allow_reuse_address = True
    proxy: ScopeDnsProxy


class _UdpHandler(socketserver.BaseRequestHandler):
    def handle(self) -> None:
        request, connection = self.request
        connection.sendto(self.server.proxy.resolve(request), self.client_address)


class _TcpHandler(socketserver.BaseRequestHandler):
    def handle(self) -> None:
        length = struct.unpack("!H", read_exact(self.request, 2))[0]
        response = self.server.proxy.resolve(read_exact(self.request, length), tcp=True)
        self.request.sendall(struct.pack("!H", len(response)) + response)
