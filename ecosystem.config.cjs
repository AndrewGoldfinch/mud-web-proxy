/* global module, process */

module.exports = {
    apps: [
      {
        name: "mud-web-proxy",
        script: "dist/wsproxy.js",
        interpreter: "node",
        node_args: "--env-file=.env.production",
        cwd: process.env.ECOSYSTEM_CWD || "/opt/mud-proxy",
        env: {
          NODE_ENV: "development",
        },
        env_production: {
          NODE_ENV: "production",
        },
      },
    ],
};
