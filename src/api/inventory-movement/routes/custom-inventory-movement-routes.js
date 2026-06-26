"use strict";

/**
 * Custom inventory-movement routes.
 *
 * Named `custom-...-routes.js` so it loads BEFORE the auto-generated core
 * router (`inventory-movement.js`). This guarantees `/inventory-movements/kardex`
 * is matched before the core `/inventory-movements/:id` route.
 *
 * `auth: false` mirrors the existing report routes in this project: the Next.js
 * proxy (`/api/strapi/...`) enforces the session cookie before forwarding, and
 * in production the Strapi backend is only reachable over the private network.
 */

module.exports = {
  routes: [
    {
      method: "GET",
      path: "/inventory-movements/kardex",
      handler: "inventory-movement.kardex",
      config: { auth: false, policies: [], middlewares: [] },
    },
    {
      method: "GET",
      path: "/inventory-movements/kardex/download",
      handler: "inventory-movement.downloadKardex",
      config: { auth: false, policies: [], middlewares: [] },
    },
  ],
};
