module.exports = {
  routes: [
    {
      path: "/products/sync-from-siigo",
      method: "POST",
      handler: "product.syncFromSiigo",
    },
  ],
};
