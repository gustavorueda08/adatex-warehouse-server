"use strict";

const { TAX_SERVICE, CUSTOMER_SERVICE } = require("../../../../utils/services");

/**
 * Lifecycle callbacks para el content-type Customer
 * Sincroniza automáticamente con Siigo en cada operación CRUD
 */

module.exports = {
  /**
   * Hook que se ejecuta después de crear un customer
   */
  async afterCreate(event) {
    try {
      const { result } = event;

      const customerSiigoService = strapi.service("api::siigo.customer");
      let siigoCustomer = null;

      if (result.identification) {
        siigoCustomer =
          await customerSiigoService.searchInSiigoByIdentification(
            result.identification
          );
      }

      // Si no exite en Siigo, lo creamos
      if (!siigoCustomer) {
        siigoCustomer = await customerSiigoService.createInSiigo(result.id);
      }

      const taxes = await strapi.entityService.findMany(TAX_SERVICE, {
        filters: { name: "IVA - 19%" },
      });

      const tax = taxes.length > 0 ? taxes[0] : null;

      // Actualizamos el customer con el SiigoId y el Tax por defecto
      await strapi.entityService.update(CUSTOMER_SERVICE, result.id, {
        data: {
          siigoId: String(siigoCustomer.id) || null,
          taxes: { connect: tax ? [tax.id] : [] },
        },
      });
    } catch (error) {
      console.error(
        "[Customer Lifecycle] Error en afterCreate:",
        error.message
      );
      // No lanzamos el error para no afectar la creación del customer
    }
  },

  /**
   * Hook que se ejecuta después de actualizar un customer
   * Actualiza solo los datos básicos del customer en Siigo (name, identification, address, etc.)
   */
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
      const customerSiigoService = strapi.service("api::siigo.customer");
      await customerSiigoService.updateInSiigo(result.id);
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
