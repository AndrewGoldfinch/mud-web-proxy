# mud-web-proxy

### What is this?

[Bun](https://bun.sh/) / TypeScript microserver which provides a secure websocket (`wss://`) to telnet (`telnet://`) proxy for [MUD](https://en.wikipedia.org/wiki/MUD) / MUSH / MOO game servers, supporting all major data interchange and interactive text protocols. To connect and play a game, you will need to run in your web page a web client capable to connect through `wss` to this proxy, like [`mud-web-client`](https://github.com/maldorne/mud-web-client).

### History

This project is a fork of [MUDPortal-Web-App](https://github.com/plamzi/MUDPortal-Web-App), made by [@plamzi](https://github.com/plamzi), creator of [mudportal.com](http://www.mudportal.com/). The original project had the code of both the client and proxy-server apps, and was outdated and did not support secure connections (`wss://` instead of `ws://`), so I decided to fork it in 2020, separate in different projects and update them. But kudos to [@plamzi](https://github.com/plamzi), who is the original author.

In 2025, I've ported the project to use ES modules.

### Motivation

In modern browsers, web-pages served through `https://` are not allowed to open connections to non-secure locations, so an `https://`-served web could not include a web client which opens a connection using `ws://`. Modifications were needed to allow secure connections.

## Features

- MCCP compression support (zlib)
- MXP protocol support built into the client
- MSDP protocol support
- GMCP / ATCP protocol support (JSON) with sample uses in multiple existing plugins
- 256-color support, including background colors
- Unicode font support and UTF-8 negotiation
- To avoid abuse, default installation only allows connection to an specific server, although it can be configured to connect to any server sent by the client as an argument.

## Installation

```bash
git clone https://github.com/maldorne/mud-web-proxy
bun install

# Development (run TypeScript directly)
bun dev

# Production (compile first, then run)
bun run build
bun start
```

You need to have your certificates available to use wsproxy. If you start the proxy without certificates, you'll see something like this:

```bash
$ bun dev
Could not find cert and/or privkey files, exiting.
```

You need to have available both files in the same directory as the proxy, like this:

```bash
$ ls
cert.pem  chat.json  dist/  docs/  LICENSE.md  package.json  privkey.pem  README.md  src/  tsconfig.json  wsproxy.ts
```

where `cert.pem` and `privkey.pem` will be links to the real files, something like:

```bash
cert.pem -> /etc/letsencrypt/live/...somewhere.../cert.pem
privkey.pem -> /etc/letsencrypt/live/...somewhere.../privkey.pem
```

How to install the certificates is beyond the scope of this project, but you could use [Certbot](https://certbot.eff.org/pages/about). You can find installation instructions for every operating system there, or look for instructions for your specific OS in any search engine with something like `How to install certbot for let's encrypt in <your operating system>`.

## Configuration

In `wsproxy.ts` you can change the following options:

```typescript
  /* this websocket proxy port */
  ws_port: 6200,
  /* default telnet host */
  tn_host: 'muds.maldorne.org',
  /* default telnet/target port */
  tn_port: 5010,
  /* enable additional debugging */
  debug: false,
  /* use node zlib (different from mccp) - you want this turned off unless your server can't do MCCP and your client can inflate data */
  compress: true,
  /* set to false while server is shutting down */
  open: true,
```

These settings can also be overridden via environment variables:

| Variable      | Description                          | Default              |
| ------------- | ------------------------------------ | -------------------- |
| `WS_PORT`     | WebSocket proxy port                 | `6200`               |
| `TN_HOST`     | Default telnet host                  | `muds.maldorne.org`  |
| `TN_PORT`     | Default telnet port                  | `5010`               |
| `DISABLE_TLS` | Set to `1` to disable TLS (dev mode) | _(TLS enabled)_      |

Probably you will only have to change:

- `tn_host` (or `TN_HOST`) with your hostname (Note that `localhost` or `127.0.0.1` don't seem to work: [see conversation here](https://github.com/maldorne/mud-web-proxy/issues/5#issuecomment-866464161), although it has not been tested in deep).
- `tn_port` (or `TN_PORT`) with the port where the mud is running.
