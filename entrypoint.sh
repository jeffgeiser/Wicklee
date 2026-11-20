#!/bin/sh
# Substitute $PORT (injected by Railway) into the nginx config template,
# discover the container's DNS resolver, and exec nginx.
#
# We pass '$PORT $RESOLVER' explicitly to envsubst so that ONLY those
# variables are expanded — all nginx variables ($remote_addr, $uri,
# $scheme, $backend, etc.) are written literally to the output config
# and interpreted by nginx itself.
set -e

# Discover the DNS resolver from /etc/resolv.conf — Railway containers
# may use IPv6 (fd12::10) or IPv4 (127.0.0.11). nginx requires IPv6
# addresses in brackets: [fd12::10]. Prefer IPv4 if available, else
# bracket the first IPv6 address. Fallback to 8.8.8.8.
IPV4_NS=$(grep '^nameserver' /etc/resolv.conf | awk '{print $2}' | grep -v ':' | head -1)
if [ -n "$IPV4_NS" ]; then
  RESOLVER="$IPV4_NS"
else
  IPV6_NS=$(grep '^nameserver' /etc/resolv.conf | awk '{print $2}' | grep ':' | head -1)
  if [ -n "$IPV6_NS" ]; then
    RESOLVER="[$IPV6_NS]"
  else
    RESOLVER="127.0.0.11"  # Docker embedded DNS; avoids leaking queries to external resolvers
  fi
fi
export RESOLVER

# Backend hostname. This image is the self-hosted frontend (see
# docs/SELF_HOSTING.md and deploy/helm/wicklee); the control plane it proxies to
# is yours to run. There is no default any more: the previous fallback pointed at
# a Railway private hostname that was shut down on 2026-11-20, so an unset
# BACKEND_HOST proxied silently into nothing.
if [[ -z "${BACKEND_HOST:-}" ]]; then
  echo "entrypoint.sh: BACKEND_HOST is not set." >&2
  echo "  Set it to host:port of your control plane, e.g. wicklee-cloud:8080." >&2
  exit 1
fi
export BACKEND_HOST

envsubst '$PORT $RESOLVER $BACKEND_HOST' < /etc/nginx/conf.d/nginx.conf.template \
  > /etc/nginx/conf.d/default.conf
exec nginx -g 'daemon off;'
