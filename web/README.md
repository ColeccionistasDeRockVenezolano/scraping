# Interfaz CRV

SPA administrativa React para buscar, consultar y editar el catálogo mediante la API Fastify.

## Desarrollo

En una terminal, desde la raíz:

```bash
npm run api
```

En otra:

```bash
cd web
cp .env.example .env.local
npm install
npm run dev
```

La interfaz abre en `http://127.0.0.1:5173`. `VITE_API_BASE_URL` debe apuntar a la API, por defecto `http://127.0.0.1:8080`.

Las lecturas funcionan sin credenciales. Para escribir, configura `CRV_OPERATOR_TOKEN` en la API y guarda el mismo token desde el control de operador de la interfaz.

## Verificación

```bash
npm run typecheck
npm run build
npm run qa:smoke
npm run qa:capture
```

La prueba extrema aislada se ejecuta desde la raíz con `npm run test:visual-extreme`.

## Publicación con Tailscale Funnel

El gateway `server.mjs` sirve la SPA bajo `/crv` y reenvía únicamente
`/crv/api/*` al API local. Base de datos y API permanecen en loopback.

```bash
cd web
VITE_API_BASE_URL=https://NODO.TAILNET.ts.net/crv/api npm run build:public
CRV_WEB_PORT=3120 npm run serve:public
tailscale funnel --bg --https=443 --set-path=/crv http://127.0.0.1:3120
```

En el servidor configurado para este proyecto, los servicios persistentes de
usuario son `crv-api.service` y `crv-web.service`. Comprueba su estado con
`systemctl --user status crv-api crv-web` y el enrutamiento con
`tailscale funnel status`.
