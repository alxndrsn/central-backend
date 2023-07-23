// Copyright 2018 ODK Central Developers
// See the NOTICE file at the top-level directory of this distribution and at
// https://github.com/getodk/central-backend/blob/master/NOTICE.
// This file is part of ODK Central. It is subject to the license terms in
// the LICENSE file found in the top-level directory of this distribution and at
// https://www.apache.org/licenses/LICENSE-2.0. No part of ODK Central,
// including this file, may be copied, modified, propagated, or distributed
// except according to the terms contained in the LICENSE file.
/* eslint-disable */

const config = require('config');
const { isBlank, isPresent, noop, without } = require('../util/util');
const { isTrue } = require('../util/http');
const Problem = require('../util/problem');
const { QueryOptions } = require('../util/db');
const { reject, getOrReject } = require('../util/promise');

// TODO use req.protocol?
const HTTPS_ENABLED = config.get('default.env.domain').startsWith('https://');

// TODO add some thoughts about why __Host is important in prod but impossible in dev
const SESSION_COOKIE = HTTPS_ENABLED ? '__Host-session' : 'session';

// injects an empty/anonymous auth object into the request context.
const emptyAuthInjector = ({ Auth }, context) => context.with({ auth: Auth.by(null) });

// if one of (Bearer|Basic|Cookie) credentials are provided in the correct conditions
// then authHandler injects the appropriate auth information to the context
// given the appropriate credentials. if credentials are given but don't match a
// session or user, aborts the request with a 401.
//
// otherwise, nothing is done. n.b. this means you must use the emptyAuthInjector
// in conjunction with this function!
//
// TODO?: repetitive, but deduping it makes it even harder to understand.
const authHandler = ({ Sessions, Users, Auth, bcrypt }, context) => {
  console.log('authHandler()', 'ENTRY');

  const authBySessionToken = (token, onFailure = noop) => Sessions.getByBearerToken(token)
    .then((session) => {
      console.log('authHandler()', 'authBySessionToken()', 'session:', session);
      if (!session.isDefined()) return onFailure();
      return context.with({ auth: Auth.by(session.get()) });
    });

  const authHeader = context.headers.authorization;

  // If a field key is provided, we use it first and foremost. We used to go the
  // other way around with this, but especially with Public Links it has become
  // more sensible to resolve collisions by prioritizing field keys.
  if (context.fieldKey.isDefined()) {
    // Picks up field keys from the url.
    // We always reject with 403 for field keys rather than 401 as we do with the
    // other auth mechanisms. In an ideal world, we would do 401 here as well. But
    // a lot of the ecosystem tools will prompt the user for credentials if you do
    // this, even if you don't issue an auth challenge. So we 403 as a close-enough.
    //
    // In addition to rejecting with 403 if the token is invalid, we also reject if
    // the token does not belong to a field key, as only field keys may be used in
    // this manner. (TODO: we should not explain in-situ for security reasons, but we
    // should explain /somewhere/.)

    const key = context.fieldKey.get();
    if (!/^[a-z0-9!$]{64}$/i.test(key)) return console.log('HI1') || reject(Problem.user.authenticationFailed());

    return Sessions.getByBearerToken(key)
      .then(getOrReject(Problem.user.insufficientRights()))
      .then((session) => {
        if ((session.actor.type !== 'field_key') && (session.actor.type !== 'public_link'))
          return reject(Problem.user.insufficientRights());
        return context.with({ auth: Auth.by(session) });
      });

  // Standard Bearer token auth:
  } else if (isPresent(authHeader) && authHeader.startsWith('Bearer ')) {
    // auth by the bearer token we found:
    console.log('authHandler()', 'authHeader:', authHeader);
    return authBySessionToken(authHeader.substring(7), () => console.log('HI2') || reject(Problem.user.authenticationFailed()));

  // Basic Auth, which is allowed over HTTPS only:
  } else if (isPresent(authHeader) && authHeader.startsWith('Basic ')) {
    // REVIEW: do web users still have legitimate reasons for accessing using BasicAuth?

    // fail the request unless we are under HTTPS.
    // this logic does mean that if we are not under nginx it is possible to fool the server.
    // but it is the user's prerogative to undertake this bypass, so their security is in their hands.
    if ((context.protocol !== 'https') && (context.headers['x-forwarded-proto'] !== 'https'))
      return reject(console.log('HI3') || Problem.user.httpsOnly());

    // we have to use a regex rather than .split(':') in case the password contains :s.
    const plainCredentials = Buffer.from(authHeader.substring(6), 'base64').toString('utf8');
    const match = /^([^:]+):(.+)$/.exec(plainCredentials);
    if (match == null) return reject(console.log('HI4') || Problem.user.authenticationFailed());
    const [ , email, password ] = match;

    // actually do our verification.
    // TODO: email existence timing attack on whether bcrypt runs or not.
    return Users.getByEmail(email)
      .then(getOrReject(console.log('HI5') || Problem.user.authenticationFailed()))
      .then((user) => bcrypt.verify(password, user.password)
        .then((verified) => {
          if (verified === true)
            return context.with({ auth: Auth.by(user.actor) });

          return reject(console.log('HI6') || Problem.user.authenticationFailed());
        }));

  // Authorization header supplied, but in an unrecognised format:
  } else if (isPresent(authHeader)) {
    return reject(console.log('HI7') || Problem.user.authenticationFailed());

  // Cookie Auth, which is more relaxed about not doing anything on failures.
  // but if the method is anything but GET we will need to check the CSRF token.
  } else if (context.headers.cookie != null) {
    console.log('preprocessors :: protocol:', context.headers.protocol);
    console.log('preprocessors :: x-forwarded-proto:', context.headers['x-forwarded-proto']);
    console.log('preprocessors :: cookies:', context.headers.cookie);

    // fail the request unless we are under HTTPS.
    if ((context.protocol !== 'https') && (context.headers['x-forwarded-proto'] !== 'https'))
      return;

    // otherwise get the cookie contents.
    //const token = /session=([^;]+)(?:;|$)/.exec(context.headers.cookie);
    console.log(context);
    const token = context.cookies[SESSION_COOKIE];
    console.log('preprocessors :: token:', token);
    if (token == null)
      return;

    // actually try to authenticate with it. no Problem on failure. short circuit
    // out if we have a GET or HEAD request.
    const maybeSession = authBySessionToken(decodeURIComponent(token));
    console.log('preprocessors :: maybeSession:', maybeSession);
    if ((context.method === 'GET') || (context.method === 'HEAD')) return maybeSession;

    // if non-GET run authentication as usual but we'll have to check CSRF afterwards.
    return maybeSession.then((cxt) => { // we have to use cxt rather than context for the linter
      console.log('preprocessors :: cxt?.auth:', cxt?.auth);

      // if authentication failed anyway, just do nothing.
      if ((cxt == null) || !cxt.auth.session.isDefined()) return;

      // if csrf missing or mismatch; fail outright.
      const csrf = cxt.body.__csrf;
      if (isBlank(csrf) || (cxt.auth.session.get().csrf !== decodeURIComponent(csrf)))
        return reject(console.log('HI8') || Problem.user.authenticationFailed());

      // delete the token off the body so it doesn't mess with downstream
      // payload expectations.
      return cxt.with({ body: without([ '__csrf' ], cxt.body) });
    });
  }
};

// translates some simple things into specific context parameters.
const queryOptionsHandler = (_, context) => {
  const { headers, query } = context;
  const options = {};

  // set extended metadata:
  const extendedMeta = headers['x-extended-metadata'];
  if (isTrue(extendedMeta)) options.extended = true;

  // parse in paging parameters:
  if (query.offset != null) options.offset = parseInt(query.offset, 10);
  if (Number.isNaN(options.offset))
    return reject(Problem.user.invalidDataTypeOfParameter({ field: 'offset', expected: 'integer' }));
  if (query.limit != null) options.limit = parseInt(query.limit, 10);
  if (Number.isNaN(options.limit))
    return reject(Problem.user.invalidDataTypeOfParameter({ field: 'limit', expected: 'integer' }));

  // add an inert reference to all passed params:
  options.argData = query;

  return context.with({ queryOptions: new QueryOptions(options), transitoryData: new Map() });
};


module.exports = { emptyAuthInjector, authHandler, queryOptionsHandler };

