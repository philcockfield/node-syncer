import R from "ramda";
import Promise from "bluebird";
import pm2 from "./pm2";
import prettyBytes from "pretty-bytes";
import Route from "./route";
import { promises } from "./util";
import log from "./log";

let isConnected = false;
pm2.connect().then(() => isConnected = true);



const getAppStatus = (app, processItem) => {
    return new Promise((resolve, reject) => {
        if (!app || !processItem) {
          resolve();
          return;
        }

        const status = {
            id: app.id,
            status: processItem.pm2_env.status,
            route: `${ app.route.toString() } ⇨ ${ app.port }`,
            repository: `${ app.repo.name }:${ app.branch }`,
            resources: {
              memory: prettyBytes(processItem.monit.memory),
              cpu: processItem.monit.cpu,
            }
        };

        const gettingVersion = app.version().catch(err => reject(err));
        gettingVersion.then(version => {
            status.version = {
              local: version.local,
              repository: version.remote
            };
            if (version.isDownloading) {
              status.status += `, updating to v${ version.remote }`;
              status.version.isDownloading = true;
            }
            if (version.updateRequired) { app.update({ start: true }); }
            resolve(status);
          });
    });
  };




export default (baseRoute, apps, middleware) => {
  baseRoute = Route.parse(baseRoute);
  const processNameToAppId = (name) => name.split(":")[0];
  const getApp = (id) => {
    id = processNameToAppId(id);
    return R.find(app => app.id === id, apps);
  }

  const getRunningApps = () => {
        return new Promise((resolve, reject) => {
          Promise.coroutine(function*() {
            const processes = yield pm2.apps();
            let { results } = yield promises(processes.map(item => getAppStatus(getApp(item.name), item))).catch(err => reject(err));
            results = R.reject(R.isNil)(results);
            results = R.sortBy(R.prop("id"))(results);
            resolve(results);
          })();
        });
      };

  const routeStatus = (req, res) => {
      getRunningApps()
        .then(appsStatus => res.send({ apps: appsStatus }))
        .catch(err => {
            log.error(err);
            res.status(500).send({
              error: "Failed while getting the status of running applications",
              message: err.message
            });
        });
    };



  const routeAppStatus = (req, res) => {
      Promise.coroutine(function*() {
        const id = req.params.app;
        const app = getApp(id);
        const sendFail = (err) => res.status(500).send({ message: `Failed while getting the status of the application '${ id }'.`, err: err.message });
        if (!app) {
          res.status(404).send({ error: `The application '${ id }' does not exist.` });
        } else {
          const processes = yield pm2
              .apps(item => processNameToAppId(item.name) === id)
              .catch(err => sendFail(err));

          const item = processes[0];
          const status = yield getAppStatus(getApp(item.name), item).catch(err => sendFail(err));
          res.send(status)
        }
      })();
    };


  // Register routes.
  const get = (path, handler) => {
      path = `/${ baseRoute.path + path }`;
      middleware.get(path, (req, res, next) => {
          if (isConnected) {
            const domain = req.get("host").split(":")[0];
            if (baseRoute.domain === "*" || domain === baseRoute.domain) {
              handler(req, res);
            } else {
              next();
            }
          } else {
            res.status(500).send({ isInitialized: false });
          }
        });
    };

  get(":app", routeAppStatus);
  get("", routeStatus);
};