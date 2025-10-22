module.exports = {
  routes: [
    {
      path: "/suppliers/sync-from-siigo",
      method: "POST",
      handler: "supplier.syncFromSiigo",
    },
  ],
};
