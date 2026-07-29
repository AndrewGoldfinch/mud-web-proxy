/* global module, process */

module.exports = {
  apps: [
    {
      name: 'mud-web-proxy',
      script: 'dist/wsproxy.js',
      interpreter: 'node',
      node_args: '--env-file=.env.production',
      // Deployment paths are not recorded in this public repo (MWP-76).
      // Defaults to the invoking directory; the deploy runbook cds there.
      cwd: process.env.ECOSYSTEM_CWD || process.cwd(),
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
      },
    },
  ],
};
