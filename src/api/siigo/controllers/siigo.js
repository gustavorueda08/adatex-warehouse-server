"use strict";

/**
 * Controlador de Siigo
 */

module.exports = {
  /**
   * Crea una factura en Siigo para una orden específica
   * POST /api/siigo/create-invoice/:orderId
   */
  async createInvoice(ctx) {
    try {
      const { orderId } = ctx.params;

      if (!orderId) {
        return ctx.badRequest("El ID de la orden es requerido");
      }

      const invoiceService = strapi.service("api::siigo.invoice");
      const result = await invoiceService.createInvoiceForOrder(
        parseInt(orderId)
      );

      ctx.send({
        success: true,
        message: "Factura creada exitosamente en Siigo",
        data: result,
      });
    } catch (error) {
      console.error("Error en createInvoice:", error.message);
      ctx.throw(500, error.message);
    }
  },

  /**
   * Consulta una factura en Siigo
   * GET /api/siigo/invoice/:siigoId
   */
  async getInvoice(ctx) {
    try {
      const { siigoId } = ctx.params;

      if (!siigoId) {
        return ctx.badRequest("El ID de Siigo es requerido");
      }

      const invoiceService = strapi.service("api::siigo.invoice");
      const invoice = await invoiceService.getInvoice(siigoId);

      ctx.send({
        success: true,
        data: invoice,
      });
    } catch (error) {
      console.error("Error en getInvoice:", error.message);
      ctx.throw(500, error.message);
    }
  },

  /**
   * Procesa todas las órdenes completadas pendientes de facturación
   * POST /api/siigo/process-completed-orders
   */
  async processCompletedOrders(ctx) {
    try {
      const invoiceService = strapi.service("api::siigo.invoice");
      const result = await invoiceService.processCompletedOrders();

      ctx.send({
        success: true,
        message: `Procesamiento completado. ${result.successful} exitosas, ${result.failed} fallidas`,
        data: result,
      });
    } catch (error) {
      console.error("Error en processCompletedOrders:", error.message);
      ctx.throw(500, error.message);
    }
  },

  /**
   * Valida si una orden puede facturarse
   * GET /api/siigo/validate-order/:orderId
   */
  async validateOrder(ctx) {
    try {
      const { orderId } = ctx.params;

      if (!orderId) {
        return ctx.badRequest("El ID de la orden es requerido");
      }

      const { ORDER_SERVICE } = require("../../../utils/services");
      const order = await strapi.entityService.findOne(
        ORDER_SERVICE,
        parseInt(orderId),
        {
          populate: [
            "customerForInvoice",
            "orderProducts",
            "orderProducts.product",
          ],
        }
      );

      if (!order) {
        return ctx.notFound("Orden no encontrada");
      }

      const mapperService = strapi.service("api::siigo.mapper");
      const validation = await mapperService.validateOrderForInvoicing(order);

      ctx.send({
        success: true,
        data: {
          orderId: order.id,
          orderCode: order.code,
          canInvoice: validation.valid,
          errors: validation.errors,
        },
      });
    } catch (error) {
      console.error("Error en validateOrder:", error.message);
      ctx.throw(500, error.message);
    }
  },

  /**
   * Obtiene el estado del token de autenticación
   * GET /api/siigo/auth-status
   */
  async getAuthStatus(ctx) {
    try {
      const authService = strapi.service("api::siigo.auth");

      // Intentar obtener token
      try {
        await authService.getAccessToken();
        ctx.send({
          success: true,
          authenticated: true,
          message: "Token de Siigo válido",
        });
      } catch (error) {
        ctx.send({
          success: false,
          authenticated: false,
          message: error.message,
        });
      }
    } catch (error) {
      console.error("Error en getAuthStatus:", error.message);
      ctx.throw(500, error.message);
    }
  },

  // ============================================
  // CUSTOMERS
  // ============================================

  async syncCustomerFromSiigo(ctx) {
    try {
      const { siigoId } = ctx.params;
      const customerService = strapi.service("api::siigo.customer");
      const result = await customerService.syncFromSiigo(siigoId);

      ctx.send({
        success: true,
        message: "Customer sincronizado desde Siigo",
        data: result,
      });
    } catch (error) {
      ctx.throw(500, error.message);
    }
  },

  async syncCustomerToSiigo(ctx) {
    try {
      const { id } = ctx.params;
      const customerService = strapi.service("api::siigo.customer");
      const result = await customerService.syncToSiigo(parseInt(id));

      ctx.send({
        success: true,
        message: "Customer sincronizado hacia Siigo",
        data: result,
      });
    } catch (error) {
      ctx.throw(500, error.message);
    }
  },

  async createCustomerInSiigo(ctx) {
    try {
      const { id } = ctx.params;
      const customerService = strapi.service("api::siigo.customer");
      const result = await customerService.createInSiigo(parseInt(id));

      ctx.send(result);
    } catch (error) {
      ctx.throw(500, error.message);
    }
  },

  async updateCustomerInSiigo(ctx) {
    try {
      const { id } = ctx.params;
      const customerService = strapi.service("api::siigo.customer");
      const result = await customerService.updateInSiigo(parseInt(id));

      ctx.send(result);
    } catch (error) {
      ctx.throw(500, error.message);
    }
  },

  async deleteCustomerInSiigo(ctx) {
    try {
      const { id } = ctx.params;
      const customerService = strapi.service("api::siigo.customer");
      const result = await customerService.deleteInSiigo(parseInt(id));

      ctx.send(result);
    } catch (error) {
      ctx.throw(500, error.message);
    }
  },

  async listCustomersFromSiigo(ctx) {
    try {
      const { page, pageSize } = ctx.query;
      const customerService = strapi.service("api::siigo.customer");
      const result = await customerService.listFromSiigo({
        page: parseInt(page) || 1,
        pageSize: parseInt(pageSize) || 100,
      });

      ctx.send({
        success: true,
        data: result,
        total: result.length,
      });
    } catch (error) {
      ctx.throw(500, error.message);
    }
  },

  async syncAllCustomers(ctx) {
    try {
      const { direction } = ctx.request.body || {};
      const customerService = strapi.service("api::siigo.customer");

      let result;
      if (direction === "toSiigo") {
        result = await customerService.syncAllToSiigo();
      } else {
        result = await customerService.syncAllFromSiigo();
      }

      ctx.send(result);
    } catch (error) {
      ctx.throw(500, error.message);
    }
  },

  // ============================================
  // SUPPLIERS
  // ============================================

  async syncSupplierFromSiigo(ctx) {
    try {
      const { siigoId } = ctx.params;
      const supplierService = strapi.service("api::siigo.supplier");
      const result = await supplierService.syncFromSiigo(siigoId);

      ctx.send({
        success: true,
        message: "Supplier sincronizado desde Siigo",
        data: result,
      });
    } catch (error) {
      ctx.throw(500, error.message);
    }
  },

  async syncSupplierToSiigo(ctx) {
    try {
      const { id } = ctx.params;
      const supplierService = strapi.service("api::siigo.supplier");
      const result = await supplierService.syncToSiigo(parseInt(id));

      ctx.send({
        success: true,
        message: "Supplier sincronizado hacia Siigo",
        data: result,
      });
    } catch (error) {
      ctx.throw(500, error.message);
    }
  },

  async createSupplierInSiigo(ctx) {
    try {
      const { id } = ctx.params;
      const supplierService = strapi.service("api::siigo.supplier");
      const result = await supplierService.createInSiigo(parseInt(id));

      ctx.send(result);
    } catch (error) {
      ctx.throw(500, error.message);
    }
  },

  async updateSupplierInSiigo(ctx) {
    try {
      const { id } = ctx.params;
      const supplierService = strapi.service("api::siigo.supplier");
      const result = await supplierService.updateInSiigo(parseInt(id));

      ctx.send(result);
    } catch (error) {
      ctx.throw(500, error.message);
    }
  },

  async deleteSupplierInSiigo(ctx) {
    try {
      const { id } = ctx.params;
      const supplierService = strapi.service("api::siigo.supplier");
      const result = await supplierService.deleteInSiigo(parseInt(id));

      ctx.send(result);
    } catch (error) {
      ctx.throw(500, error.message);
    }
  },

  async listSuppliersFromSiigo(ctx) {
    try {
      const { page, pageSize } = ctx.query;
      const supplierService = strapi.service("api::siigo.supplier");
      const result = await supplierService.listFromSiigo({
        page: parseInt(page) || 1,
        pageSize: parseInt(pageSize) || 100,
      });

      ctx.send({
        success: true,
        data: result,
        total: result.length,
      });
    } catch (error) {
      ctx.throw(500, error.message);
    }
  },

  async syncAllSuppliers(ctx) {
    try {
      const { direction } = ctx.request.body || {};
      const supplierService = strapi.service("api::siigo.supplier");

      let result;
      if (direction === "toSiigo") {
        result = await supplierService.syncAllToSiigo();
      } else {
        result = await supplierService.syncAllFromSiigo();
      }

      ctx.send(result);
    } catch (error) {
      ctx.throw(500, error.message);
    }
  },

  // ============================================
  // PRODUCTS
  // ============================================

  async syncProductFromSiigo(ctx) {
    try {
      const { siigoId } = ctx.params;
      const productService = strapi.service("api::siigo.product");
      const result = await productService.syncFromSiigo(siigoId);

      ctx.send({
        success: true,
        message: "Product sincronizado desde Siigo",
        data: result,
      });
    } catch (error) {
      ctx.throw(500, error.message);
    }
  },

  async syncProductToSiigo(ctx) {
    try {
      const { id } = ctx.params;
      const productService = strapi.service("api::siigo.product");
      const result = await productService.syncToSiigo(parseInt(id));

      ctx.send({
        success: true,
        message: "Product sincronizado hacia Siigo",
        data: result,
      });
    } catch (error) {
      ctx.throw(500, error.message);
    }
  },

  async createProductInSiigo(ctx) {
    try {
      const { id } = ctx.params;
      const productService = strapi.service("api::siigo.product");
      const result = await productService.createInSiigo(parseInt(id));

      ctx.send(result);
    } catch (error) {
      ctx.throw(500, error.message);
    }
  },

  async updateProductInSiigo(ctx) {
    try {
      const { id } = ctx.params;
      const productService = strapi.service("api::siigo.product");
      const result = await productService.updateInSiigo(parseInt(id));

      ctx.send(result);
    } catch (error) {
      ctx.throw(500, error.message);
    }
  },

  async deleteProductInSiigo(ctx) {
    try {
      const { id } = ctx.params;
      const productService = strapi.service("api::siigo.product");
      const result = await productService.deleteInSiigo(parseInt(id));

      ctx.send(result);
    } catch (error) {
      ctx.throw(500, error.message);
    }
  },

  async listProductsFromSiigo(ctx) {
    try {
      const { page, pageSize } = ctx.query;
      const productService = strapi.service("api::siigo.product");
      const result = await productService.listFromSiigo({
        page: parseInt(page) || 1,
        pageSize: parseInt(pageSize) || 100,
      });

      ctx.send({
        success: true,
        data: result,
        total: result.length,
      });
    } catch (error) {
      ctx.throw(500, error.message);
    }
  },

  async syncAllProducts(ctx) {
    try {
      const { direction } = ctx.request.body || {};
      const productService = strapi.service("api::siigo.product");

      let result;
      if (direction === "toSiigo") {
        result = await productService.syncAllToSiigo();
      } else {
        result = await productService.syncAllFromSiigo();
      }

      ctx.send(result);
    } catch (error) {
      ctx.throw(500, error.message);
    }
  },

  // ============================================
  // SELLERS
  // ============================================

  async listSellersFromSiigo(ctx) {
    try {
      const sellerService = strapi.service("api::siigo.seller");
      const result = await sellerService.listFromSiigo();

      ctx.send({
        success: true,
        data: result,
        total: result.length,
      });
    } catch (error) {
      ctx.throw(500, error.message);
    }
  },

  async getSeller(ctx) {
    try {
      const { sellerId } = ctx.params;
      const sellerService = strapi.service("api::siigo.seller");
      const result = await sellerService.getFromSiigo(parseInt(sellerId));

      ctx.send({
        success: true,
        data: result,
      });
    } catch (error) {
      ctx.throw(500, error.message);
    }
  },

  async syncAllSellers(ctx) {
    try {
      const sellerService = strapi.service("api::siigo.seller");
      const result = await sellerService.syncAllToLocal();

      ctx.send(result);
    } catch (error) {
      ctx.throw(500, error.message);
    }
  },

  // ============================================
  // TAXES
  // ============================================

  async listTaxesFromSiigo(ctx) {
    try {
      const taxService = strapi.service("api::siigo.tax");
      const result = await taxService.listFromSiigo();

      ctx.send({
        success: true,
        data: result,
        total: result.length,
      });
    } catch (error) {
      ctx.throw(500, error.message);
    }
  },

  async syncAllTaxes(ctx) {
    try {
      const taxService = strapi.service("api::siigo.tax");
      const result = await taxService.syncAllFromSiigo();

      ctx.send(result);
    } catch (error) {
      ctx.throw(500, error.message);
    }
  },
};
