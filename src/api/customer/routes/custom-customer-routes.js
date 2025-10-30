module.exports = {
  routes: [
    {
      path: "/customers/:customerId/consignment-balance",
      method: "GET",
      handler: "customer.getConsignmentBalance",
    },
    {
      path: "/customers/:customerId/consignment-history",
      method: "GET",
      handler: "customer.getConsignmentHistory",
    },
    {
      path: "/customers/sync-from-siigo",
      method: "GET",
      handler: "customer.syncFromSiigo",
    },
    {
      path: "/customers",
      method: "POST",
      handler: "customer.create",
    },
    {
      path: "/customers/:customerId",
      method: "PUT",
      handler: "customer.update",
    },
  ],
};
