"use strict";

const { TAX_SERVICE, CUSTOMER_SERVICE } = require("../../../../utils/services");

/**
 * Lifecycle callbacks para el content-type Customer
 * Sincroniza automáticamente con Siigo en cada operación CRUD
 */

module.exports = {
  async afterUpdate(event) {
    try {
      const { result } = event;

      // Solo sincronizar si el customer ya tiene siigoId
      if (!result.siigoId) {
        console.log(
          `[Customer ${result.id}] No tiene siigoId, se omite sincronización`
        );
        return;
      }
      //const customerSiigoService = strapi.service("api::siigo.customer");
      //await customerSiigoService.updateInSiigo(result.id);
      return;
    } catch (error) {
      console.error(
        "[Customer Lifecycle] Error en afterUpdate:",
        error.message
      );
      // No lanzamos el error para no afectar la actualización del customer
    }
  },
};
