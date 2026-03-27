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
# may use IPv6 (fd12::10) or IPv4 (127.0.0.11). nginx's resolver
# directive chokes on bare IPv6 (colons parsed as port separator),
# so we prefer the first IPv4 nameserver. Fallback to 8.8.8.8.
RESOLVER=$(grep '^nameserver' /etc/resolv.conf | awk '{print $2}' | grep -v ':' | head -1)
RESOLVER=${RESOLVER:-8.8.8.8}
export RESOLVER

envsubst '$PORT $RESOLVER' < /etc/nginx/conf.d/nginx.conf.template \
  > /etc/nginx/conf.d/default.conf
exec nginx -g 'daemon off;'
