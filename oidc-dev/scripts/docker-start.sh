#!/bin/bash -eu

log() {
  echo "[oidc-tester] $*"
}

log "Configuring DNS..."
# N.B. configuring DNS is done at runtime because Docker prevents write access before then.
echo '127.0.0.1 fake-oidc-server.example.net' >> /etc/hosts
echo '127.0.0.1      odk-central.example.org' >> /etc/hosts

log "DNS configured."

log "Waiting for postgres to start..."
wait-for-it odk-central-oidc-tester-postgres:5432 --strict --timeout=60 -- echo '[oidc-tester] postgres is UP!'

log "Starting services..."
# Catch stdout & stderr from subshells
exec 3>/dev/stdout
exec 4>/dev/stderr
(cd fake-oidc-server && node index.js 1>&3 2>&4) &
(cd .. && make base 1>&3 2>&4 && NODE_TLS_REJECT_UNAUTHORIZED=0 node lib/bin/run-server.js 1>&3 2>&4) &

log "Waiting for odk-central-backend to start..."
wait-for-it localhost:8383 --strict --timeout=60 -- echo '[oidc-tester] odk-central-backend is UP!'

log "Creating test users..." # _after_ migrations have been run
cd ..
node lib/bin/cli.js --email alice@example.com user-create
cd -
log "Test users created."

log "Running playwright tests..."
cd playwright-tests
npx playwright test

log "Tests completed OK!"
