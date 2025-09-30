module.exports = {
  routes: [
    {
      method: "GET",
      path: "/inventory/by-warehouse",
      handler: "inventory.getByWarehouse",
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: "POST",
      path: "/inventory/by-warehouse",
      handler: "inventory.byWarehouse",
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: "POST",
      path: "/inventory/by-product",
      handler: "inventory.byProduct",
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: "GET",
      path: "/inventory/summary",
      handler: "inventory.getSummary",
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: "GET",
      path: "/inventory/reservations",
      handler: "inventory.getReservations",
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: "GET",
      path: "/inventory/product/:id/availability",
      handler: "inventory.getProductAvailability",
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: "GET",
      path: "/inventory/movements",
      handler: "inventory.getMovements",
      config: {
        policies: [],
        middlewares: [],
      },
    },
  ],
};
