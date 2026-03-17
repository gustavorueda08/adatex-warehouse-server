"use strict";

const { TAX_SERVICE, CUSTOMER_SERVICE } = require("../../../../utils/services");

/**
 * Lifecycle callbacks para el content-type Customer
 * Sincroniza automáticamente con Siigo en cada operación CRUD
 */

const formatName = require("../../../../utils/formatName");

module.exports = {
  async beforeCreate(event) {
    const { data } = event.params;
    if (data.name) {
      data.name = formatName(data.name);
    }
    if (data.lastName) {
      data.lastName = formatName(data.lastName);
    }
  },

  async beforeUpdate(event) {
    const { data } = event.params;
    if (data.name) {
      data.name = formatName(data.name);
    }
    if (data.lastName) {
      data.lastName = formatName(data.lastName);
    }
  },

  async afterCreate(event) {
    try {
      const { result, params } = event;
      const customerSiigoService = strapi.service("api::siigo.customer");

      // Si ya tiene siigoId (e.g. creado desde sync), no hacemos nada
      if (result.siigoId) {
        return;
      }

      // Intentar buscar en Siigo por identificación primero
      if (result.identification && !params.data?.skipSiigoSync) {
        const existingSiigoCustomer =
          await customerSiigoService.searchInSiigoByIdentification(
            result.identification
          );

        if (existingSiigoCustomer) {
          // Si existe, actualizamos localmente el siigoId
          await strapi.db.query(CUSTOMER_SERVICE).update({
            where: { id: result.id },
            data: { siigoId: String(existingSiigoCustomer.id) },
          });
          console.log(
            `[Customer Lifecycle] Customer ${result.id} vinculado con Siigo ID ${existingSiigoCustomer.id}`
          );
          return;
        }
      }

      // Si no existe, lo creamos en Siigo
      if (!params.data?.skipSiigoSync) {
        await customerSiigoService.createInSiigo(result.id);
      }
    } catch (error) {
      console.error(
        "[Customer Lifecycle] Error en afterCreate:",
        error.message
      );
    }
  },

  async afterUpdate(event) {
    try {
      const { result, params } = event;
      const customerSiigoService = strapi.service("api::siigo.customer");

      if (params.data?.skipSiigoSync) {
        console.log(`[Customer Lifecycle] Siigo Sync Skipped for ${result.id}`);
        return;
      }

      // Si tiene siigoId, actualizamos en Siigo
      if (result.siigoId) {
        await customerSiigoService.updateInSiigo(result.id);
      } else {
        // Si no tiene siigoId, intentamos crearlo
        await customerSiigoService.createInSiigo(result.id);
      }
    } catch (error) {
      console.error(
        "[Customer Lifecycle] Error en afterUpdate:",
        error.message
      );
    }
  },
};
