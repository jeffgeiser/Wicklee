#!/bin/sh
# Substitute $PORT (injected by Railway) into the nginx config template,
# then exec nginx.
#
# We pass '$PORT' explicitly to envsubst so that ONLY the $PORT variable is
# expanded — all nginx variables ($remote_addr, $uri, $scheme, etc.) are
# written literally to the output config and interpreted by nginx itself.
set -e
envsubst '$PORT' < /etc/nginx/conf.d/nginx.conf.template \
  > /etc/nginx/conf.d/default.conf
exec nginx -g 'daemon off;'
