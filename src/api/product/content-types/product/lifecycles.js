"use strict";

const { PRODUCT_SERVICE } = require("../../../../utils/services");

/**
 * Lifecycle callbacks para el content-type Product
 * Sincroniza automáticamente con Siigo en cada operación CRUD
 */

module.exports = {
  /**
   * Hook que se ejecuta después de crear un product
   */
  async afterCreate(event) {
    try {
      const { result } = event;
      const productService = strapi.service("api::siigo.product");

      // Si ya tiene siigoId, significa que ya está sincronizado con Siigo
      if (result.siigoId) {
        return;
      }

      // Intentar buscar en Siigo por código primero
      if (result.code) {
        const productFromSiigo = await productService.searchInSiigoByCode(
          result.code
        );

        if (productFromSiigo) {
          // Si existe, actualizamos localmente el siigoId
          await strapi.db.query(PRODUCT_SERVICE).update({
            where: { id: result.id },
            data: { siigoId: String(productFromSiigo.id) },
          });
          console.log(
            `[Product Lifecycle] Product ${result.id} vinculado con Siigo ID ${productFromSiigo.id}`
          );
          return;
        }
      } else {
        console.warn(
          `[Product ${result.id}] No tiene code, se omite búsqueda en Siigo`
        );
        return; 
      }
      // Si no existe, crear en Siigo
      await productService.createInSiigo(result.id);
    } catch (error) {
      console.error(
        "[Product Lifecycle] Error en afterCreate:",
        error.message
      );
    }
  },

  /**
   * Hook que se ejecuta después de actualizar un product
   */
  async afterUpdate(event) {
    try {
      const { result } = event;
      const productService = strapi.service("api::siigo.product");

      // Evitar bucle si la actualización viene de syncFromSiigo
      const ctx = strapi.requestContext.get();
      if (ctx?.state?.isSyncingFromSiigo) {
        return;
      }

      // Si tiene siigoId, actualizamos en Siigo
      if (result.siigoId) {
        await productService.updateInSiigo(result.id);
      } else {
        // Si no tiene siigoId, intentamos crearlo
        await productService.createInSiigo(result.id);
      }
    } catch (error) {
      console.error(
        "[Product Lifecycle] Error en afterUpdate:",
        error.message
      );
    }
  },

  /**
   * Hook que se ejecuta después de eliminar un product
   */
  async afterDelete(event) {
    try {
      const { result } = event;
      const productService = strapi.service("api::siigo.product");

      // Solo sincronizar si el product tenía siigoId
      if (result.siigoId) {
        await productService.deleteInSiigo(result.id);
      }
    } catch (error) {
      console.error(
        "[Product Lifecycle] Error en afterDelete:",
        error.message
      );
    }
  },
};
