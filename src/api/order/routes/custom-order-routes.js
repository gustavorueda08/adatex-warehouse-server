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
  ],
};
