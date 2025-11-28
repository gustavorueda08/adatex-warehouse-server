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
  ],
};
