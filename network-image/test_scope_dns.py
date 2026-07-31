import struct
import unittest
from unittest.mock import patch

from scope_dns import ScopeDnsProxy, answer_ipv4_addresses, domain_allowed


def query(name: str) -> bytes:
    labels = b"".join(bytes([len(label)]) + label.encode() for label in name.split("."))
    return struct.pack("!HHHHHH", 7, 0x0100, 1, 0, 0, 0) + labels + b"\x00\x00\x01\x00\x01"


def cname_response(request: bytes) -> bytes:
    question = request[12:]
    cname = b"\x03www\x01a\x06shifen\x03com\x00"
    answer1 = b"\xc0\x0c" + struct.pack("!HHIH", 5, 1, 60, len(cname)) + cname
    answer2 = b"\xc0\x2b" + struct.pack("!HHIH", 1, 1, 20, 4) + bytes([183, 2, 172, 177])
    return request[:2] + struct.pack("!HHHHH", 0x8180, 1, 2, 0, 0) + question + answer1 + answer2


class ScopeDnsTest(unittest.TestCase):
    def test_exact_and_wildcard_domain_matching(self) -> None:
        patterns = ("example.com", "*.baidu.com")
        self.assertTrue(domain_allowed("example.com", patterns))
        self.assertFalse(domain_allowed("www.example.com", patterns))
        self.assertTrue(domain_allowed("www.baidu.com", patterns))
        self.assertTrue(domain_allowed("a.b.baidu.com", patterns))
        self.assertFalse(domain_allowed("baidu.com", patterns))

    def test_collects_final_ipv4_address_from_cname_chain(self) -> None:
        request = query("www.baidu.com")
        self.assertEqual(answer_ipv4_addresses(cname_response(request)), [("183.2.172.177", 20)])

    def test_authorizes_answers_before_returning_allowed_response(self) -> None:
        request = query("www.baidu.com")
        response = cname_response(request)
        calls: list[tuple[str, int]] = []
        proxy = object.__new__(ScopeDnsProxy)
        proxy.domains = ("*.baidu.com",)
        proxy.authorize_address = lambda address, ttl: calls.append((address, ttl))
        proxy.upstream = ("127.0.0.11", 53)
        with patch("scope_dns.forward_dns", return_value=response):
            self.assertEqual(proxy.resolve(request), response)
        self.assertEqual(calls, [("183.2.172.177", 20)])

    def test_returns_servfail_when_address_authorization_fails(self) -> None:
        request = query("www.baidu.com")
        proxy = object.__new__(ScopeDnsProxy)
        proxy.domains = ("*.baidu.com",)
        proxy.authorize_address = lambda _address, _ttl: (_ for _ in ()).throw(OSError("nft failed"))
        proxy.upstream = ("127.0.0.11", 53)
        with patch("scope_dns.forward_dns", return_value=cname_response(request)):
            response = proxy.resolve(request)
        self.assertEqual(struct.unpack_from("!H", response, 2)[0] & 0xF, 2)

    def test_returns_servfail_for_mismatched_upstream_response(self) -> None:
        request = query("www.baidu.com")
        response = bytearray(cname_response(request))
        response[1] ^= 1
        proxy = object.__new__(ScopeDnsProxy)
        proxy.domains = ("*.baidu.com",)
        proxy.authorize_address = lambda _address, _ttl: None
        proxy.upstream = ("127.0.0.11", 53)
        proxy.allow_unmatched = False
        with patch("scope_dns.forward_dns", return_value=bytes(response)):
            result = proxy.resolve(request)
        self.assertEqual(struct.unpack_from("!H", result, 2)[0] & 0xF, 2)

    def test_refuses_out_of_scope_query_without_forwarding(self) -> None:
        request = query("baidu.com")
        proxy = object.__new__(ScopeDnsProxy)
        proxy.domains = ("*.baidu.com",)
        proxy.authorize_address = lambda _address, _ttl: None
        proxy.upstream = ("127.0.0.11", 53)
        proxy.allow_unmatched = False
        with patch("scope_dns.forward_dns") as forward:
            response = proxy.resolve(request)
        forward.assert_not_called()
        self.assertEqual(struct.unpack_from("!H", response, 2)[0] & 0xF, 5)

    def test_cidr_mode_forwards_unmatched_dns_without_dynamic_authorization(self) -> None:
        request = query("example.com")
        response = cname_response(request)
        calls: list[tuple[str, int]] = []
        proxy = object.__new__(ScopeDnsProxy)
        proxy.domains = ()
        proxy.authorize_address = lambda address, ttl: calls.append((address, ttl))
        proxy.upstream = ("127.0.0.11", 53)
        proxy.allow_unmatched = True
        with patch("scope_dns.forward_dns", return_value=response):
            self.assertEqual(proxy.resolve(request), response)
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
