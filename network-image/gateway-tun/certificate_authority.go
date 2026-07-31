package main

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type certificateAuthority struct {
	certificate *x509.Certificate
	privateKey  *rsa.PrivateKey
	cache       sync.Map
}

func loadOrCreateCertificateAuthority(certPath, keyPath string) (*certificateAuthority, error) {
	certPEM, certErr := os.ReadFile(certPath)
	keyPEM, keyErr := os.ReadFile(keyPath)
	if certErr == nil && keyErr == nil {
		return parseCertificateAuthority(certPEM, keyPEM)
	}
	if certErr != nil && !os.IsNotExist(certErr) {
		return nil, fmt.Errorf("read gateway CA certificate: %w", certErr)
	}
	if keyErr != nil && !os.IsNotExist(keyErr) {
		return nil, fmt.Errorf("read gateway CA key: %w", keyErr)
	}
	if err := os.MkdirAll(filepath.Dir(certPath), 0o700); err != nil {
		return nil, fmt.Errorf("create gateway CA directory: %w", err)
	}
	privateKey, err := rsa.GenerateKey(rand.Reader, 3072)
	if err != nil {
		return nil, fmt.Errorf("generate gateway CA key: %w", err)
	}
	now := time.Now().UTC()
	template := &x509.Certificate{
		SerialNumber:          randomSerial(),
		Subject:               pkix.Name{CommonName: "LuaN1ao Gateway CA", Organization: []string{"LuaN1ao"}},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.AddDate(10, 0, 0),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &privateKey.PublicKey, privateKey)
	if err != nil {
		return nil, fmt.Errorf("create gateway CA certificate: %w", err)
	}
	certPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM = pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(privateKey)})
	if err := atomicWriteFile(certPath, certPEM, 0o644); err != nil {
		return nil, err
	}
	if err := atomicWriteFile(keyPath, keyPEM, 0o600); err != nil {
		return nil, err
	}
	return parseCertificateAuthority(certPEM, keyPEM)
}

func parseCertificateAuthority(certPEM, keyPEM []byte) (*certificateAuthority, error) {
	pair, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return nil, fmt.Errorf("parse gateway CA key pair: %w", err)
	}
	certificate, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		return nil, fmt.Errorf("parse gateway CA certificate: %w", err)
	}
	privateKey, ok := pair.PrivateKey.(*rsa.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("gateway CA key must be RSA")
	}
	return &certificateAuthority{certificate: certificate, privateKey: privateKey}, nil
}

func (authority *certificateAuthority) certificateFor(host string) (*tls.Certificate, error) {
	if cached, ok := authority.cache.Load(host); ok {
		return cached.(*tls.Certificate), nil
	}
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, fmt.Errorf("generate leaf key: %w", err)
	}
	now := time.Now().UTC()
	template := &x509.Certificate{
		SerialNumber: randomSerial(),
		Subject:      pkix.Name{CommonName: host, Organization: []string{"LuaN1ao"}},
		NotBefore:    now.Add(-time.Hour),
		NotAfter:     now.Add(7 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	if address := net.ParseIP(host); address != nil {
		template.IPAddresses = []net.IP{address}
	} else {
		template.DNSNames = []string{host}
	}
	der, err := x509.CreateCertificate(rand.Reader, template, authority.certificate, &privateKey.PublicKey, authority.privateKey)
	if err != nil {
		return nil, fmt.Errorf("sign leaf certificate: %w", err)
	}
	certificate := &tls.Certificate{
		Certificate: [][]byte{der, authority.certificate.Raw},
		PrivateKey:  privateKey,
	}
	actual, _ := authority.cache.LoadOrStore(host, certificate)
	return actual.(*tls.Certificate), nil
}

func randomSerial() *big.Int {
	limit := new(big.Int).Lsh(big.NewInt(1), 128)
	serial, err := rand.Int(rand.Reader, limit)
	if err != nil {
		return big.NewInt(time.Now().UnixNano())
	}
	return serial
}

func atomicWriteFile(path string, payload []byte, mode os.FileMode) error {
	temporary := fmt.Sprintf("%s.%d.tmp", path, os.Getpid())
	if err := os.WriteFile(temporary, payload, mode); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	if err := os.Chmod(temporary, mode); err != nil {
		return fmt.Errorf("chmod %s: %w", path, err)
	}
	if err := os.Rename(temporary, path); err != nil {
		return fmt.Errorf("publish %s: %w", path, err)
	}
	return nil
}
