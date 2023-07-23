const appRoot = require('app-root-path');
const { mergeRight } = require('ramda');
const { sql } = require('slonik');
const { readdirSync } = require('fs');
const { join } = require('path');
const request = require('supertest');
// eslint-disable-next-line import/no-dynamic-require
const { task } = require(appRoot + '/lib/task/task');

// knex things.
const config = require('config');
// eslint-disable-next-line import/no-dynamic-require
const { connect } = require(appRoot + '/lib/model/migrate');

// slonik connection pool
// eslint-disable-next-line import/no-dynamic-require
const { slonikPool } = require(appRoot + '/lib/external/slonik');
const db = slonikPool(config.get('test.database'));

// set up our mailer.
const env = config.get('default.env');
// eslint-disable-next-line import/no-dynamic-require
const { mailer } = require(appRoot + '/lib/external/mail');
const mailConfig = config.get('test.email');
const mail = mailer(mergeRight(mailConfig, env));
if (mailConfig.transport !== 'json')
  // eslint-disable-next-line no-console
  console.error('WARNING: some tests will not work except with a JSON email transport configuration.');

// set up our xlsform-api mock.
// eslint-disable-next-line import/no-dynamic-require
const xlsform = require(appRoot + '/test/util/xlsform');

// set up our sentry mock.
// eslint-disable-next-line import/no-dynamic-require
const Sentry = require(appRoot + '/lib/external/sentry').init();

// set up our bcrypt module; possibly mock or not based on params.
const _bcrypt = (process.env.BCRYPT === 'no')
  ? require('../util/bcrypt-mock')
  : require('bcrypt');
// eslint-disable-next-line import/no-dynamic-require
const bcrypt = require(appRoot + '/lib/util/crypto').password(_bcrypt);

// set up our enketo mock.
// eslint-disable-next-line import/no-dynamic-require
const { reset: resetEnketo, ...enketo } = require(appRoot + '/test/util/enketo');
beforeEach(resetEnketo);

// set up odk analytics mock.
// eslint-disable-next-line import/no-dynamic-require
const { ODKAnalytics } = require(appRoot + '/test/util/odk-analytics-mock');
const odkAnalytics = new ODKAnalytics();

// set up mock context
const context = { query: {}, transitoryData: new Map(), headers: [] };

// application things.
// eslint-disable-next-line import/no-dynamic-require
const { withDefaults } = require(appRoot + '/lib/model/container');
// eslint-disable-next-line import/no-dynamic-require
const service = require(appRoot + '/lib/http/service');

// get all our fixture scripts, and set up a function that runs them all.
const fixtures = readdirSync(appRoot + '/test/integration/fixtures')
  .filter((name) => /^\d\d-[a-z-_]+\.js$/i.test(name))
  .map((name) => join(appRoot.toString(), '/test/integration/fixtures', /^([^.]+)\.js$/i.exec(name)[1]))
  .sort()
  .map(require);
// eslint-disable-next-line no-confusing-arrow
const populate = (container, [ head, ...tail ] = fixtures) =>
  (tail.length === 0) ? head(container) : head(container).then(() => populate(container, tail));

// set up the database at the very beginning of the suite; wipe the database,
// run the standard migrations, then run the fixture scripts to populate our
// test data.
//
// this hook won't run if `test-unit` is called, as this directory is skipped
// in that case.
const initialize = async () => {
  const migrator = connect(config.get('test.database'));
  try {
    await migrator.raw('drop owned by current_user');
    await migrator.migrate.latest({ directory: appRoot + '/lib/model/migrations' });
  } finally {
    await migrator.destroy();
  }

  return withDefaults({ db, bcrypt, context }).transacting(populate);
};

// eslint-disable-next-line func-names, space-before-function-paren
before(function() {
  this.timeout(0);
  return initialize();
});

let mustReinitAfter;
beforeEach(() => {
  // eslint-disable-next-line keyword-spacing
  if(mustReinitAfter) throw new Error(`Failed to reinitalize after previous test: '${mustReinitAfter}'.  You may need to increase your mocha timeout.`);
});
// eslint-disable-next-line func-names, space-before-function-paren
afterEach(async function() {
  this.timeout(0);
  if (mustReinitAfter) {
    await initialize();
    mustReinitAfter = false;
  }
});

// augments a supertest object with a `.login(user, cb)` method, where user may be the
// name of a fixture user or an object with email/password. the user will be logged
// in and the following single request will be performed as that user.
//
// a proxy is used so that the auth header is injected at the appropriate spot
// after the next method call.
const authProxy = (token) => ({
  get(target, name) {
    const method = target[name];
    if (method == null) return undefined;

    return (...args) => method.apply(target, args).set('Authorization', `Bearer ${token}`);
  }
});
// eslint-disable-next-line no-shadow
const augment = (service) => {
  // eslint-disable-next-line no-param-reassign
  service.login = async (userOrUsers, test = undefined) => {
    const users = Array.isArray(userOrUsers) ? userOrUsers : [userOrUsers];
    const tokens = await Promise.all(users.map(async (user) => {
      if(process.env.TEST_AUTH === 'oidc') {
        const token = await oidcAuthFor(service, user);
        return token;
      } else {
        const credentials = (typeof user === 'string')
          ? { email: `${user}@getodk.org`, password: user }
          : user;
        const { body } = await service.post('/v1/sessions')
          .send(credentials)
          .expect(200);
        return body.token;
      }
    }));
    const proxies = tokens.map((token) => new Proxy(service, authProxy(token)));
    return test != null
      ? test(...proxies)
      : (Array.isArray(userOrUsers) ? proxies : proxies[0]);
  };
  return service;
};


////////////////////////////////////////////////////////////////////////////////
// FINAL TEST WRAPPERS


const baseContainer = withDefaults({ db, mail, env, xlsform, bcrypt, enketo, Sentry, odkAnalytics, context });

// called to get a service context per request. we do some work to hijack the
// transaction system so that each test runs in a single transaction that then
// gets rolled back for a clean slate on the next test.
const testService = (test) => () => new Promise((resolve, reject) => {
  baseContainer.transacting((container) => {
    const rollback = (f) => (x) => container.run(sql`rollback`).then(() => f(x));
    return test(augment(request(service(container))), container).then(rollback(resolve), rollback(reject));
  });//.catch(Promise.resolve.bind(Promise)); // TODO/SL probably restore
});

// for some tests we explicitly need to make concurrent requests, in which case
// the transaction butchering we do for testService will not work. for these cases,
// we offer testServiceFullTrx:
// eslint-disable-next-line space-before-function-paren, func-names
const testServiceFullTrx = (test) => function() {
  mustReinitAfter = this.test.fullTitle();
  return test(augment(request(service(baseContainer))), baseContainer);
};

// for some tests we just want a container, without any of the webservice stuffs between.
// this is that, with the same transaction trickery as a normal test.
const testContainer = (test) => () => new Promise((resolve, reject) => {
  baseContainer.transacting((container) => {
    const rollback = (f) => (x) => container.run(sql`rollback`).then(() => f(x));
    return test(container).then(rollback(resolve), rollback(reject));
  });//.catch(Promise.resolve.bind(Promise));
});

// complete the square of options:
// eslint-disable-next-line space-before-function-paren, func-names
const testContainerFullTrx = (test) => function() {
  mustReinitAfter = this.test.fullTitle();
  return test(baseContainer);
};

// called to get a container context per task. ditto all // from testService.
// here instead our weird hijack work involves injecting our own constructed
// container into the task context so it just picks it up and uses it.
const testTask = (test) => () => new Promise((resolve, reject) => {
  baseContainer.transacting((container) => {
    task._container = container.with({ task: true });
    const rollback = (f) => (x) => {
      delete task._container;
      return container.run(sql`rollback`).then(() => f(x));
    };
    return test(task._container).then(rollback(resolve), rollback(reject));
  });//.catch(Promise.resolve.bind(Promise));
});

async function oidcAuthFor(service, user) {
  const makeFetchCookie = require('fetch-cookie');
  try {
    const res1 = await service.get('/v1/oidc/login');

    // custom cookie jar probably not important, but we will need these cookies
    // for the final redirect
    const cookieJar = new makeFetchCookie.toughCookie.CookieJar();
    res1.headers['set-cookie'].forEach(cookieString => {
      cookieJar.setCookie(cookieString, 'http://localhost:8383/v1/oidc/login');
    });
    console.log(cookieJar);

    console.log(res1.headers);
    const location1 = res1.headers.location;
    console.log({ location1 });

    const fetchC = makeFetchCookie(fetch, cookieJar);
    const res2 = await fetchC(location1);
    if(res2.status !== 200) throw new Error('Non-200 response');

    const location2 = await formActionFrom(res2);
    console.log({ location2 });

    // TODO try replacing with FormData
    const body = require('querystring').encode({
      prompt: 'login',
      login: user,
      password: 'topSecret123',
    });
    console.log(body);
    const res3 = await fetchC(location2, {
      method: 'POST', 
      headers: { 'Content-Type':'application/x-www-form-urlencoded' },
      body,
    });
    console.log('res3:', res3.headers);

    const location3 = await formActionFrom(res3);
    const body2 = require('querystring').encode({ prompt:'consent' });
    console.log({ location3 , body2 });
    const res4 = await fetchC(location3, {
      method: 'POST', 
      headers: { 'Content-Type':'application/x-www-form-urlencoded' },
      body: body2,
      redirect: 'manual',
    });
    console.log('res4:', res4);
    console.log('res4:', await res4.text());
    if(res4.status !== 303) throw new Error('Expected 303!');

    console.log(res4.headers);
    const location4 = res4.headers.get('location');
    console.log({ location4 });
    const res5 = await fetchC(location4, { redirect:'manual' });
    console.log('res5:', res5);
    console.log('res5:', await res5.text());
    const location5 = res5.headers.get('location');
    console.log({ location5 });

    const u5 = new URL(location5);
    const servicePath = u5.pathname + u5.search;
    console.log('Requesting from service:', 'GET', servicePath);
    //const res6 = await service.get(servicePath, { headers:{ cookie:cookieJar.getCookieStringSync(location5) } });
    const res6 = await service.get(servicePath)
        .set('Cookie', cookieJar.getCookieStringSync(location5));

    const token = res6.headers['set-cookie'].find(h => h.startsWith('session=')).replace(/^session=/, '');
    console.log('token:', token);

    return token;

  } catch(err) {
    console.log('OIDC auth failed:', err);
    process.exit(1);
  }
}

async function formActionFrom(res) {
  return (await res.text()).match(/<form.*\baction="([^"]*)"/)[1];
}

module.exports = { testService, testServiceFullTrx, testContainer, testContainerFullTrx, testTask };

