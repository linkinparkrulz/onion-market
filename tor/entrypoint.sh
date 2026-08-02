#!/bin/sh
mkdir -p /var/lib/tor/barnroom
chown -R tor:tor /var/lib/tor
chmod 700 /var/lib/tor/barnroom
exec su-exec tor tor -f /etc/tor/torrc
