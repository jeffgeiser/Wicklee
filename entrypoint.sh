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
    RESOLVER="8.8.8.8"
  fi
fi
export RESOLVER

envsubst '$PORT $RESOLVER' < /etc/nginx/conf.d/nginx.conf.template \
  > /etc/nginx/conf.d/default.conf
exec nginx -g 'daemon off;'
