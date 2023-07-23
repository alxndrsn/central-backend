// Copyright 2023 ODK Central Developers
// See the NOTICE file at the top-level directory of this distribution and at
// https://github.com/getodk/central-backend/blob/master/NOTICE.
// This file is part of ODK Central. It is subject to the license terms in
// the LICENSE file found in the top-level directory of this distribution and at
// https://www.apache.org/licenses/LICENSE-2.0. No part of ODK Central,
// including this file, may be copied, modified, propagated, or distributed
// except according to the terms contained in the LICENSE file.
/* eslint-disable */ // FIXME re-enable lint here

module.exports = globalSetup;

// globalSetup() returns globalTeardown()
// See: https://playwright.dev/docs/test-global-setup-teardown#configure-globalsetup-and-globalteardown
async function globalSetup() {
  const fakeFrontend = await startFakeFrontend();
  return function globalTeardown() {
    fakeFrontend.close();
  }
}

const express = require('express');
const cookieParser = require('cookie-parser');
const { createProxyMiddleware } = require('http-proxy-middleware');

const { port, frontendUrl } = require('./config.js');
const backendUrl = 'http://localhost:8383';

async function startFakeFrontend() {
  console.log('Starting fake frontend proxy...');
  const fakeFrontend = express();
  fakeFrontend.use(cookieParser());
  fakeFrontend.get('/', (req, res) => {
    console.log('fakeFrontend :: request headers:', req.headers);
    res.send(html`
      <h1>Success!</h1>
      <div id="request-cookies">${JSON.stringify(req.cookies)}</div>
    `);
  });
  fakeFrontend.use(createProxyMiddleware('/v1', { target:backendUrl }));

  if(frontendUrl.startsWith('http://')) {
    return fakeFrontend.listen(port);
  } else {
    const fs = require('node:fs');
    const https = require('node:https');
    const key  = fs.readFileSync('../certs/odk-central.example.org-key.pem', 'utf8');
    const cert = fs.readFileSync('../certs/odk-central.example.org.pem', 'utf8');
    const httpsServer = https.createServer({ key, cert }, fakeFrontend);
    await httpsServer.listen(port);
    return httpsServer;
  }
}

function html([ first, ...rest ], ...vars) {
  return (`
    <html>
      <body>
        ${first + vars.map((v, idx) => [ v, rest[idx] ]).flat().join('')}
      </body>
    </html>
  `);
}