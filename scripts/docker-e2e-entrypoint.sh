#!/bin/sh
set -eu

mkdir -p /tmp/reference-product-e2e/test-results /tmp/reference-product-e2e/playwright-report
sh ./scripts/import-browser-ca.sh /root/.pki/nssdb /https/rootCA.pem
node ./scripts/wait-for-e2e-targets.mjs

if [ "$#" -gt 0 ]; then
  exec npm run test:e2e:container -- "$@"
fi

exec npm run test:e2e:container
