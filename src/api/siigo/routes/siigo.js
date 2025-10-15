"use strict";

/**
 * Rutas de Siigo
 */

module.exports = {
  routes: [
    {
      method: "POST",
      path: "/siigo/create-invoice/:orderId",
      handler: "siigo.createInvoice",
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: "GET",
      path: "/siigo/invoice/:siigoId",
      handler: "siigo.getInvoice",
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: "POST",
      path: "/siigo/process-completed-orders",
      handler: "siigo.processCompletedOrders",
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: "GET",
      path: "/siigo/validate-order/:orderId",
      handler: "siigo.validateOrder",
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: "GET",
      path: "/siigo/auth-status",
      handler: "siigo.getAuthStatus",
      config: {
        policies: [],
        middlewares: [],
      },
    },
  ],
};
