module.exports = {
  routes: [
    {
      path: "/orders",
      method: "POST",
      handler: "order.create",
    },
    {
      path: "/orders/:orderId",
      method: "PUT",
      handler: "order.update",
    },
    {
      path: "/orders/:orderId",
      method: "DELETE",
      handler: "order.delete",
    },
    {
      path: "/orders/:orderId/add",
      method: "POST",
      handler: "order.add",
    },
    {
      path: "/orders/:orderId/remove",
      method: "POST",
      handler: "order.remove",
    },
    {
      path: "/orders/:parentOrderId/invoiceable-items",
      method: "GET",
      handler: "order.getInvoiceableItems",
    },
    {
      path: "/orders/create-partial-invoice",
      method: "POST",
      handler: "order.createPartialInvoice",
    },
    {
      path: "/orders/:orderId/invoices",
      method: "GET",
      handler: "order.downloadInvoice",
    },
    {
      path: "/orders/:purchaseOrderId/nationalizable-items",
      method: "GET",
      handler: "order.getNationalizableItems",
    },
    {
      path: "/orders/:purchaseOrderId/nationalize",
      method: "POST",
      handler: "order.createNationalization",
    },
    {
      path: "/orders/:orderId/approve-credit",
      method: "POST",
      handler: "order.approveCreditOverride",
    },
    {
      path: "/orders/:orderId/credit-note",
      method: "POST",
      handler: "order.createCreditNote",
    },
    {
      path: "/orders/:orderId/credit-notes",
      method: "GET",
      handler: "order.downloadCreditNote",
    },
    {
      path: "/orders/:orderId/purchase-invoice",
      method: "POST",
      handler: "order.createPurchaseInvoice",
    },
    {
      path: "/orders/:orderId/purchase-invoice",
      method: "PUT",
      handler: "order.updatePurchaseInvoice",
    },
    {
      path: "/orders/:orderId/sale-invoice",
      method: "POST",
      handler: "order.createSaleInvoice",
    },
    {
      method: "POST",
      path: "/orders/test-email",
      handler: "order.testEmail",
      config: {
        auth: false,
      },
    },
  ],
};
