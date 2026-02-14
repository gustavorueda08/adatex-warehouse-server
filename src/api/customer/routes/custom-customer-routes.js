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
      method: "POST",
      path: "/customers/sync-from-siigo",
      handler: "customer.syncFromSiigo",
      config: {
        timeout: 300000, // 5 minutos de timeout
      },
    },
    {
      method: "GET",
      path: "/customers/:customerId/invoiceable-items",
      handler: "customer.getInvoiceableItems",
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
