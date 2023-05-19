import { expect, test } from '@playwright/test';
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const cookieParser = require('cookie-parser');

test('can log in with OIDC', async ({ page }) => {
  let fakeFrontend;
  try {
    console.log('Starting fake frontend proxy...');
    fakeFrontend = express();
    fakeFrontend.use(cookieParser());
    fakeFrontend.get('/', (req, res) => {
      res.send(html`
        <h1>Success!</h1>
        <div id="request-cookies">${JSON.stringify(req.cookies)}</div>
      `);
    });
    fakeFrontend.use(createProxyMiddleware('/v1', { target:'http://localhost:8383' }));
    await fakeFrontend.listen(8989);
    console.log('Setup complete.');

    await page.goto('http://localhost:8989/v1/oidc/login');
    await page.locator('input[name=login]').fill('alex');
    await page.locator('input[name=password]').fill('topsecret!!!!');
    await page.locator(`button[type=submit]`).click();
    await page.getByRole('button', { name:'Continue' }).click();

    await expect(page.locator('h1')).toHaveText('Success!');

    const requestCookies = JSON.parse(await page.locator(`div[id=request-cookies]`).textContent());

    console.log(JSON.stringify(requestCookies, null, 2));
    if(!Object.keys(requestCookies).includes('session')) throw new Error('No session cookie found!');
    if(!Object.keys(requestCookies).includes('__csrf'))  throw new Error('No CSRF cookie found!');
  } finally {
    try { fakeFrontend?.close(); } catch(err) { /* :shrug: */ }
  }
});

function html([ first, ...rest ], ...vars) {
  return (`
    <html>
      <body>
        ${first + vars.map((v, idx) => [ v, rest[idx] ]).flat().join('')}
      </body>
    </html>
  `);
}
