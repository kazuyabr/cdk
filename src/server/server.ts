import chalk from 'chalk';
import * as express from 'express';
import { merge } from 'lodash';

import { isHttpableError, NotInteractiveError } from './errors';
import { DeclarationError } from './metadata/error';
import { EvilSniffer } from './metadata/evilsniffer';
import { GrantCancelledError } from './profile';
import { Project } from './project';
import { Bundler } from './publish/bundler';
import { Uploader } from './publish/uploader';
import { Fetcher, writeFile } from './util';

type RouteHandler = (req: express.Request, res: express.Response) => Promise<object | void>;

function route(handler: RouteHandler) {
  return (req: express.Request, res: express.Response) => {
    Promise.resolve(handler(req, res))
      .then(data => {
        if (res.headersSent) {
          return;
        }

        if (!data) {
          res.status(204).send();
          return;
        }

        res.json(data);
      })
      .catch(err => {
        if (isHttpableError(err)) {
          res.status(err.statusCode()).json({
            name: err.constructor.name,
            message: err.message,
            stack: err.stack,
            metadata: err.metadata ? err.metadata() : undefined,
          });
        } else {
          const contents = err.stack || err.message || String(err);
          console.error(chalk.red(`Error in ${req.method} ${req.path}:\n${contents}`));
          res.status(500).send(contents);
        }
      });
  };
}

/**
 * This file contains the parent dev server run using `miix serve`. This has
 * endpoints for saving environment/profile settings as well as making calls
 * out to the Mixer API on behalf of the logged in user.
 */
export function createApp(project: Project): express.Express {
  const app = express();

  app.use(require('body-parser').json());

  function requireAuth(fn: RouteHandler): RouteHandler {
    return async (req, res) => {
      if (await project.profile.hasAuthenticated()) {
        return fn(req, res);
      }

      res.status(401).send();
    };
  }

  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    next();
  });

  app.get(
    '/connect-participant',
    route(
      requireAuth(async req => {
        const udata = await project.profile.user();
        const joinRes = await new Fetcher()
          .with(await project.profile.tokens())
          .json('get', `/interactive/${Number(req.query.channelID) || udata.channel}`);

        if (joinRes.status === 404 || joinRes.status === 400) {
          throw new NotInteractiveError(); // remap
        }

        if (joinRes.status !== 200) {
          throw new Error(
            `Unexpected status code ${joinRes.status} from ${joinRes.url}: ${await joinRes.text()}`,
          );
        }

        return await joinRes.json();
      }),
    ),
  );

  let grantingCode: string | undefined;
  app.get(
    '/login',
    route(async () => {
      if (await project.profile.hasAuthenticated()) {
        grantingCode = undefined;
        return await project.profile.user();
      }
      if (grantingCode) {
        return { code: grantingCode };
      }

      return new Promise(resolve => {
        project.profile
          .grant({
            prompt: code => {
              grantingCode = code;
              resolve(code);
            },
            isCancelled: () => grantingCode !== undefined, // don't retry forever
          })
          .catch(err => {
            if (err instanceof GrantCancelledError) {
              grantingCode = undefined;
            } else {
              throw err;
            }
          });
      }).then(code => ({ code }));
    }),
  );

  app.get(
    '/interactive-versions',
    route(
      requireAuth(async (_req, res) => {
        const user = await project.profile.user();
        const fetcher = new Fetcher().with(await project.profile.tokens());

        let output: object[] = [];
        for (let page = 0; true; page++) {
          // tslint:disable-line
          const next = await fetcher.json(
            'get',
            `/interactive/games/owned?user=${user.id}&page=${page}`,
          );
          const contents = await next.json();
          if (!contents.length) {
            break;
          }

          output = output.concat(contents);
        }

        res.json(output);
      }),
    ),
  );

  app.get(
    '/ensure-no-eval',
    route(async () => {
      try {
        await new EvilSniffer().compile(project.baseDir());
      } catch (e) {
        return { hasEval: e instanceof DeclarationError };
      }

      return { hasEval: false };
    }),
  );

  app.get('/metadata', route(async () => project.packageConfig()));

  app.post(
    '/modify-package',
    route(async req => {
      const packageJson = await project.packageJson();
      merge(packageJson, req.body);
      await writeFile(project.baseDir('package.json'), JSON.stringify(packageJson, null, 2));
    }),
  );

  app.post(
    '/update-interactive-version/:versionId',
    route(
      requireAuth(async (req, res) => {
        const body = { ...req.body, controlVersion: '2.0' };
        const updateRes = await new Fetcher()
          .with(await project.profile.tokens())
          .json('put', `/interactive/versions/${req.params.versionId}`, body);

        res.status(updateRes.status).json(await updateRes.json());
      }),
    ),
  );

  app.post(
    '/start-version-upload/:versionId',
    route(
      requireAuth(async req => {
        const fetcher = new Fetcher().with(await project.profile.tokens());
        const config = await project.packageConfig();
        const output = await new Bundler(project).bundle();

        await new Uploader(fetcher, project).upload(output.filename);
        await fetcher.json('put', `/interactive/versions/${req.params.versionId}`, {
          bundle: `${config.name}_${config.version}`,
        });
      }),
    ),
  );

  return app;
}