"use strict";

/**
 * Rutas de Siigo
 */

module.exports = {
  routes: [
    // ============================================
    // INVOICES (existentes)
    // ============================================
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

    // ============================================
    // CUSTOMERS
    // ============================================
    {
      method: "GET",
      path: "/siigo/customers",
      handler: "siigo.listCustomersFromSiigo",
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: "GET",
      path: "/siigo/customers/:siigoId/sync",
      handler: "siigo.syncCustomerFromSiigo",
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: "POST",
      path: "/siigo/customers/:id/push",
      handler: "siigo.syncCustomerToSiigo",
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: "POST",
      path: "/siigo/customers/:id/create",
      handler: "siigo.createCustomerInSiigo",
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: "PUT",
      path: "/siigo/customers/:id/update",
      handler: "siigo.updateCustomerInSiigo",
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: "DELETE",
      path: "/siigo/customers/:id/delete",
      handler: "siigo.deleteCustomerInSiigo",
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: "POST",
      path: "/siigo/customers/sync-all",
      handler: "siigo.syncAllCustomers",
      config: {
        policies: [],
        middlewares: [],
      },
    },

    // ============================================
    // SUPPLIERS
    // ============================================
    {
      method: "GET",
      path: "/siigo/suppliers",
      handler: "siigo.listSuppliersFromSiigo",
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: "GET",
      path: "/siigo/suppliers/:siigoId/sync",
      handler: "siigo.syncSupplierFromSiigo",
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: "POST",
      path: "/siigo/suppliers/:id/push",
      handler: "siigo.syncSupplierToSiigo",
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: "POST",
      path: "/siigo/suppliers/:id/create",
      handler: "siigo.createSupplierInSiigo",
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: "PUT",
      path: "/siigo/suppliers/:id/update",
      handler: "siigo.updateSupplierInSiigo",
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: "DELETE",
      path: "/siigo/suppliers/:id/delete",
      handler: "siigo.deleteSupplierInSiigo",
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: "POST",
      path: "/siigo/suppliers/sync-all",
      handler: "siigo.syncAllSuppliers",
      config: {
        policies: [],
        middlewares: [],
      },
    },

    // ============================================
    // PRODUCTS
    // ============================================
    {
      method: "GET",
      path: "/siigo/products",
      handler: "siigo.listProductsFromSiigo",
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: "GET",
      path: "/siigo/products/:siigoId/sync",
      handler: "siigo.syncProductFromSiigo",
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: "POST",
      path: "/siigo/products/:id/push",
      handler: "siigo.syncProductToSiigo",
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: "POST",
      path: "/siigo/products/:id/create",
      handler: "siigo.createProductInSiigo",
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: "PUT",
      path: "/siigo/products/:id/update",
      handler: "siigo.updateProductInSiigo",
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: "DELETE",
      path: "/siigo/products/:id/delete",
      handler: "siigo.deleteProductInSiigo",
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: "POST",
      path: "/siigo/products/sync-all",
      handler: "siigo.syncAllProducts",
      config: {
        policies: [],
        middlewares: [],
      },
    },

    // ============================================
    // SELLERS
    // ============================================
    {
      method: "GET",
      path: "/siigo/sellers",
      handler: "siigo.listSellersFromSiigo",
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: "GET",
      path: "/siigo/sellers/:sellerId",
      handler: "siigo.getSeller",
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: "POST",
      path: "/siigo/sellers/sync-all",
      handler: "siigo.syncAllSellers",
      config: {
        policies: [],
        middlewares: [],
      },
    },

    // ============================================
    // TAXES
    // ============================================
    {
      method: "GET",
      path: "/siigo/taxes",
      handler: "siigo.listTaxesFromSiigo",
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: "POST",
      path: "/siigo/taxes/sync-all",
      handler: "siigo.syncAllTaxes",
      config: {
        policies: [],
        middlewares: [],
      },
    },
  ],
};
