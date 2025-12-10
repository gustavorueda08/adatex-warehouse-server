"use strict";

/**
 * Lifecycle callbacks para el content-type Supplier
 * Sincroniza automáticamente con Siigo en cada operación CRUD
 */

const { SUPPLIER_SERVICE } = require("../../../../utils/services");
const formatName = require("../../../../utils/formatName");

module.exports = {
  async beforeCreate(event) {
    const { data } = event.params;
    if (data.name) {
      data.name = formatName(data.name);
    }
    if (data.lastname) {
      data.lastname = formatName(data.lastname);
    }
  },

  async beforeUpdate(event) {
    const { data } = event.params;
    if (data.name) {
      data.name = formatName(data.name);
    }
    if (data.lastname) {
      data.lastname = formatName(data.lastname);
    }
  },

  async afterCreate(event) {
    try {
      const { result } = event;
      const supplierSiigoService = strapi.service("api::siigo.supplier");

      // Si ya tiene siigoId (e.g. creado desde sync), no hacemos nada
      if (result.siigoId) {
        return;
      }

      // Intentar buscar en Siigo por identificación primero
      if (result.identification) {
        const existingSiigoSupplier =
          await supplierSiigoService.searchInSiigoByIdentification(
            result.identification
          );

        if (existingSiigoSupplier) {
          // Si existe, actualizamos localmente el siigoId
          await strapi.db.query(SUPPLIER_SERVICE).update({
            where: { id: result.id },
            data: { siigoId: String(existingSiigoSupplier.id) },
          });
          console.log(
            `[Supplier Lifecycle] Supplier ${result.id} vinculado con Siigo ID ${existingSiigoSupplier.id}`
          );
          return;
        }
      }

      // Si no existe, lo creamos en Siigo
      await supplierSiigoService.createInSiigo(result.id);
    } catch (error) {
      console.error(
        "[Supplier Lifecycle] Error en afterCreate:",
        error.message
      );
    }
  },

  async afterUpdate(event) {
    try {
      const { result } = event;
      const supplierSiigoService = strapi.service("api::siigo.supplier");

      // Si tiene siigoId, actualizamos en Siigo
      if (result.siigoId) {
        await supplierSiigoService.updateInSiigo(result.id);
      } else {
        // Si no tiene siigoId, intentamos crearlo
        await supplierSiigoService.createInSiigo(result.id);
      }
    } catch (error) {
      console.error(
        "[Supplier Lifecycle] Error en afterUpdate:",
        error.message
      );
    }
  },
};
