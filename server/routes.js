import { ApolloServer } from 'apollo-server-express';
import config from 'config';
import expressLimiter from 'express-limiter';
import { get, pick } from 'lodash';
import multer from 'multer';
import redis from 'redis';

import * as connectedAccounts from './controllers/connectedAccounts';
import helloworks from './controllers/helloworks';
import uploadImage from './controllers/images';
import * as email from './controllers/services/email';
import * as transferwise from './controllers/transferwise';
import * as users from './controllers/users';
import { paypalWebhook, privacyWebhook, stripeWebhook, transferwiseWebhook } from './controllers/webhooks';
import { getGraphqlCacheKey } from './graphql/cache';
import graphqlSchemaV1 from './graphql/v1/schema';
import graphqlSchemaV2 from './graphql/v2/schema';
import cache from './lib/cache';
import logger from './lib/logger';
import { SentryGraphQLPlugin } from './lib/sentry';
import { parseToBoolean } from './lib/utils';
import * as authentication from './middleware/authentication';
import errorHandler from './middleware/error_handler';
import * as params from './middleware/params';
import required from './middleware/required_param';
import sanitizer from './middleware/sanitizer';
import * as paypal from './paymentProviders/paypal/payment';
import alipay from './paymentProviders/stripe/alipay';

const upload = multer();

const noCache = (req, res, next) => {
  res.set('Cache-Control', 'no-cache');
  next();
};

export default app => {
  /**
   * Extract GraphQL API Key
   */
  app.use('/graphql/:version/:apiKey?', (req, res, next) => {
    req.apiKey = req.params.apiKey;
    next();
  });

  app.use('*', authentication.checkClientApp);

  app.use('*', authentication.authorizeClientApp);

  // Setup rate limiter
  if (get(config, 'redis.serverUrl')) {
    const client = redis.createClient(get(config, 'redis.serverUrl'));
    const rateLimiter = expressLimiter(
      app,
      client,
    )({
      lookup: function (req, res, opts, next) {
        if (req.clientApp) {
          opts.lookup = 'clientApp.id';
          // 100 requests / minute for registered API Key
          opts.total = 100;
          opts.expire = 1000 * 60;
        } else {
          opts.lookup = 'ip';
          // 10 requests / minute / ip for anonymous requests
          opts.total = 10;
          opts.expire = 1000 * 60;
        }
        return next();
      },
      whitelist: function (req) {
        const apiKey = req.query.api_key || req.body.api_key;
        // No limit with internal API Key
        return apiKey === config.keys.opencollective.apiKey;
      },
      onRateLimited: function (req, res) {
        let message;
        if (req.clientApp) {
          message = 'Rate limit exceeded. Contact-us to get higher limits.';
        } else {
          message = 'Rate limit exceeded. Create an API Key to get higher limits.';
        }
        res.status(429).send({ error: { message } });
      },
    });
    app.use('/graphql', rateLimiter);
  }

  /**
   * User reset password or new token flow (no jwt verification) or 2FA
   */
  app.post('/users/signin', required('user'), users.signin);
  // check JWT and update token if no 2FA, but send back 2FA JWT if there is 2FA enabled
  app.post('/users/update-token', authentication.mustBeLoggedIn, users.updateToken);
  // check the 2FA code against the token in the db to let 2FA-enabled users log in
  app.post('/users/two-factor-auth', authentication.checkTwoFactorAuthJWT, users.twoFactorAuthAndUpdateToken);

  /**
   * Moving forward, all requests will try to authenticate the user if there is a JWT token provided
   * (an error will be returned if the JWT token is invalid, if not present it will simply continue)
   */
  app.use('*', authentication.authenticateUser); // populate req.remoteUser if JWT token provided in the request

  /**
   * Parameters.
   */
  app.param('uuid', params.uuid);
  app.param('userid', params.userid);
  app.param('collectiveid', params.collectiveid);
  app.param('transactionuuid', params.transactionuuid);
  app.param('paranoidtransactionid', params.paranoidtransactionid);
  app.param('expenseid', params.expenseid);

  const isDevelopment = config.env === 'development';
  const isProduction = config.env === 'production';

  /**
   * GraphQL caching
   */
  app.use('/graphql', async (req, res, next) => {
    req.startAt = req.startAt || new Date();
    const cacheKey = getGraphqlCacheKey(req);
    const enabled = parseToBoolean(config.graphql.cache.enabled);
    if (cacheKey && enabled) {
      const fromCache = await cache.get(cacheKey);
      if (fromCache) {
        res.servedFromGraphqlCache = true;
        req.endAt = req.endAt || new Date();
        const executionTime = req.endAt - req.startAt;
        res.set('Execution-Time', executionTime);
        res.send(fromCache);
        return;
      }
      req.cacheKey = cacheKey;
    }
    next();
  });

  /* GraphQL server generic options */

  const graphqlServerOptions = {
    introspection: true,
    playground: isDevelopment,
    plugins: config.sentry?.dsn ? [SentryGraphQLPlugin] : undefined,
    // Align with behavior from express-graphql
    context: ({ req }) => {
      return req;
    },
    formatError: err => {
      logger.error(`GraphQL error: ${err.message}`);
      const extra = pick(err, ['locations', 'path']);
      if (Object.keys(extra).length) {
        logger.error(JSON.stringify(extra));
      }

      const stacktrace = get(err, 'extensions.exception.stacktrace');
      if (stacktrace) {
        logger.error(stacktrace);
      }
      return err;
    },
    formatResponse: (response, ctx) => {
      const req = ctx.context;

      if (req.cacheKey && !response?.errors) {
        cache.set(req.cacheKey, response, Number(config.graphql.cache.ttl));
      }

      req.endAt = req.endAt || new Date();
      const executionTime = req.endAt - req.startAt;
      req.res.set('Execution-Time', executionTime);
      return response;
    },
  };

  /**
   * GraphQL v1
   */
  const graphqlServerV1 = new ApolloServer({
    schema: graphqlSchemaV1,
    engine: {
      reportSchema: isProduction,
      variant: 'current',
      apiKey: get(config, 'graphql.apolloEngineAPIKey'),
    },
    ...graphqlServerOptions,
  });

  graphqlServerV1.applyMiddleware({ app, path: '/graphql/v1' });

  /**
   * GraphQL v2
   */
  const graphqlServerV2 = new ApolloServer({
    schema: graphqlSchemaV2,
    engine: {
      reportSchema: isProduction,
      variant: 'current',
      apiKey: get(config, 'graphql.apolloEngineAPIKeyV2'),
    },
    ...graphqlServerOptions,
  });

  graphqlServerV2.applyMiddleware({ app, path: '/graphql/v2' });

  /**
   * GraphQL default (v1)
   */
  graphqlServerV1.applyMiddleware({ app, path: '/graphql' });

  /**
   * Webhooks that should bypass api key check
   */
  app.post('/webhooks/stripe', stripeWebhook); // when it gets a new subscription invoice
  app.post('/webhooks/transferwise', transferwiseWebhook); // when it gets a new subscription invoice
  app.post('/webhooks/privacy', privacyWebhook); // when it gets a new subscription invoice
  app.post('/webhooks/paypal', paypalWebhook);
  app.post('/webhooks/mailgun', email.webhook); // when receiving an email
  app.get('/connected-accounts/:service/callback', noCache, authentication.authenticateServiceCallback); // oauth callback
  app.delete(
    '/connected-accounts/:service/disconnect/:collectiveId',
    noCache,
    authentication.authenticateServiceDisconnect,
  );

  app.use(sanitizer()); // note: this break /webhooks/mailgun /graphiql

  /**
   * Users.
   */
  app.get('/users/exists', required('email'), users.exists); // Checks the existence of a user based on email.

  /**
   * Separate route for uploading images to S3
   */
  app.post('/images', upload.single('file'), uploadImage);

  /**
   * Generic OAuth (ConnectedAccounts)
   */
  app.get('/connected-accounts/:service(github|transferwise)', noCache, authentication.authenticateService); // backward compatibility
  app.get(
    '/connected-accounts/:service(github|twitter|stripe|paypal|transferwise)/oauthUrl',
    noCache,
    authentication.authenticateService,
  );
  app.get(
    '/connected-accounts/:service/verify',
    noCache,
    authentication.parseJwtNoExpiryCheck,
    connectedAccounts.verify,
  );

  /* PayPal Payment Method Helpers */
  app.post('/services/paypal/create-payment', paypal.createPayment);

  /* AliPay Payment Callback */
  app.get('/services/stripe/alipay/callback', noCache, alipay.confirmOrder);

  /* TransferWise OTT Request Endpoint */
  app.post('/services/transferwise/pay-batch', noCache, transferwise.payBatch);

  /**
   * External services
   */
  app.get('/services/email/unsubscribe/:email/:slug/:type/:token', email.unsubscribe);

  /**
   * Github API - fetch all repositories using the user's access_token
   */
  app.get('/github-repositories', connectedAccounts.fetchAllRepositories); // used in Frontend by createCollective "GitHub flow"

  /**
   * Hello Works API - Helloworks hits this endpoint when a document has been completed.
   */
  app.post('/helloworks/callback', helloworks.callback);

  /**
   * Override default 404 handler to make sure to obfuscate api_key visible in URL
   */
  app.use((req, res) => res.sendStatus(404));

  /**
   * Error handler.
   */
  app.use(errorHandler);
};
