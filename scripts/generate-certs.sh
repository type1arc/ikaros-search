#!/usr/bin/env bash
set -e

CERTS_DIR="$(cd "$(dirname "$0")/.." && pwd)/certs"
mkdir -p "$CERTS_DIR"

if [ -f "$CERTS_DIR/key.pem" ] && [ -f "$CERTS_DIR/cert.pem" ]; then
  echo "Certificates already exist in $CERTS_DIR"
  echo "Remove them first if you want to regenerate."
  exit 0
fi

echo "Generating self-signed TLS certificates..."
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$CERTS_DIR/key.pem" \
  -out "$CERTS_DIR/cert.pem" \
  -days 365 \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"

echo "Certificates generated in $CERTS_DIR/"
echo "  key.pem  - Private key"
echo "  cert.pem - Certificate"
echo ""
echo "To run with HTTPS:"
echo "  SSL_KEY_FILE=certs/key.pem SSL_CERT_FILE=certs/cert.pem node server.js"
