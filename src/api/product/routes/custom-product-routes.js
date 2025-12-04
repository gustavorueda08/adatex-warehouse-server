module.exports = {
  routes: [
    {
      path: "/products/sync-from-siigo",
      method: "GET",
      handler: "product.syncFromSiigo",
    },
    {
      path: "/products/bulk-upsert",
      method: "POST",
      handler: "product.bulkUpsert",
    },
    {
      method: "GET",
      path: "/products/inventory",
      handler: "product.findWithInventory",
      config: {
        policies: [],
        middlewares: [],
      },
    },
  ],
};
