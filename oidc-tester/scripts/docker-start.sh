#!/bin/bash -eux

log() {
  echo "[oidc-tester] $*"
}

log "------------- ls1 ---------------"
ls -al
log "---------------1-----------------"

log "Configuring DNS..."
# N.B. configuring DNS is done at runtime because Docker prevents write access before then.
echo '127.0.0.1 fake-oidc-server.example.net' >> /etc/hosts
echo '127.0.0.1      odk-central.example.org' >> /etc/hosts

log "DNS configured."

log "Waiting for postgres to start..."
./scripts/wait-for-it.sh odk-central-oidc-tester-postgres:5432 --strict --timeout=60 -- echo '[oidc-tester] postgres is UP!'

log "Starting services..."
(cd fake-oidc-server && node index.js) &
(cd .. && make base && NODE_TLS_REJECT_UNAUTHORIZED=0 node lib/bin/run-server.js) &

log "Waiting for odk-central-backend to start..."
./scripts/wait-for-it.sh localhost:8383 --strict --timeout=60 -- echo '[oidc-tester] odk-central-backend is UP!'

log "Creating test users..." # _after_ migrations have been run
cd ..
node lib/bin/cli.js --generate-password --email alice@example.com user-create
cd -
log "Test users created."

log "Running playwright tests..."
cd playwright-tests
log "------------- ls2 ---------------"
ls -al
log "---------------2-----------------"
npx playwright test

log "Tests completed OK!"
