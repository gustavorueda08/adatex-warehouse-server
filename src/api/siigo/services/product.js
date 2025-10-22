"use strict";

const { PRODUCT_SERVICE } = require("../../../utils/services");
const { siigoFetch } = require("../utils/siigoFetch");

/**
 * Servicio de sincronización bidireccional de Products con Siigo
 */

module.exports = ({ strapi }) => ({
  /**
   * Trae un product desde Siigo y lo crea/actualiza localmente
   * @param {String} siigoId - ID del product en Siigo
   * @returns {Object} - Product local creado/actualizado
   */
  async syncFromSiigo(siigoId) {
    try {
      console.log(`Sincronizando product ${siigoId} desde Siigo...`);

      const testMode = process.env.SIIGO_TEST_MODE === "true";
      let siigoProduct;

      if (testMode) {
        console.log("[TEST MODE] Simulando consulta de product desde Siigo");
        siigoProduct = {
          id: siigoId,
          code: "TEST-PROD-001",
          name: "Test Product",
          description: "Test product description",
          type: "Product",
          unit: "Unit",
          active: true,
          reference: "BARCODE-001",
          tax_classification: "Taxed",
        };
      } else {
        const authService = strapi.service("api::siigo.auth");
        const headers = await authService.getAuthHeaders();
        const apiUrl = process.env.SIIGO_API_URL || "https://api.siigo.com";

        const response = await siigoFetch(`${apiUrl}/v1/products/${siigoId}`, {
          method: "GET",
          headers,
        });

        if (!response.ok) {
          throw new Error(
            `Error HTTP ${response.status}: ${response.statusText}`
          );
        }

        siigoProduct = await response.json();
      }

      // Mapear a formato local
      const mapperService = strapi.service("api::siigo.mapper");
      const productData = await mapperService.mapSiigoToProduct(siigoProduct);

      // Buscar si ya existe localmente usando db.query para evitar disparar lifecycles
      const existingProducts = await strapi.db.query(PRODUCT_SERVICE).findMany({
        where: { siigoId: String(siigoId) },
        limit: 1,
      });

      let localProduct;

      if (existingProducts && existingProducts.length > 0) {
        localProduct = await strapi.db.query(PRODUCT_SERVICE).update({
          where: { id: existingProducts[0].id },
          data: productData,
        });
        console.log(`Product ${siigoId} actualizado localmente`);
      } else {
        localProduct = await strapi.db.query(PRODUCT_SERVICE).create({
          data: productData,
        });
        console.log(`Product ${siigoId} creado localmente`);
      }

      return localProduct;
    } catch (error) {
      console.error(
        `Error al sincronizar product ${siigoId} desde Siigo:`,
        error.message
      );
      throw new Error(
        `Error al sincronizar product desde Siigo: ${error.message}`
      );
    }
  },

  /**
   * Envía un product local a Siigo
   * @param {Number} productId - ID del product local
   * @returns {Object} - Resultado de la sincronización
   */
  async syncToSiigo(productId) {
    try {
      console.log(`Sincronizando product ${productId} hacia Siigo...`);

      const product = await strapi.entityService.findOne(
        PRODUCT_SERVICE,
        productId
      );

      if (!product) {
        throw new Error(`Product ${productId} no encontrado`);
      }

      if (product.siigoId) {
        return await this.updateInSiigo(productId);
      } else {
        return await this.createInSiigo(productId);
      }
    } catch (error) {
      console.error(
        `Error al sincronizar product ${productId} hacia Siigo:`,
        error.message
      );
      throw new Error(
        `Error al sincronizar product hacia Siigo: ${error.message}`
      );
    }
  },

  /**
   * Crea un product en Siigo y actualiza el siigoId local
   * @param {Number} productId - ID del product local
   * @returns {Object} - Product creado en Siigo
   */
  async createInSiigo(productId) {
    try {
      console.log(`Creando product ${productId} en Siigo...`);

      const product = await strapi.entityService.findOne(
        PRODUCT_SERVICE,
        productId
      );

      if (!product) {
        throw new Error(`Product ${productId} no encontrado`);
      }

      if (product.siigoId) {
        throw new Error(
          `Product ${productId} ya tiene siigoId: ${product.siigoId}`
        );
      }

      // Mapear a formato Siigo
      const mapperService = strapi.service("api::siigo.mapper");
      const siigoProductData = await mapperService.mapProductToSiigo(product);

      const testMode = process.env.SIIGO_TEST_MODE === "true";
      let siigoProduct;

      if (testMode) {
        console.log("[TEST MODE] Simulando creación de product en Siigo");
        siigoProduct = {
          id: "TEST-" + Date.now(),
          ...siigoProductData,
        };
      } else {
        const authService = strapi.service("api::siigo.auth");
        const headers = await authService.getAuthHeaders();
        const apiUrl = process.env.SIIGO_API_URL || "https://api.siigo.com";

        const response = await siigoFetch(`${apiUrl}/v1/products`, {
          method: "POST",
          headers,
          body: JSON.stringify(siigoProductData),
        });

        if (!response.ok) {
          const errorData = await response.text();
          console.error("Error de Siigo:", errorData);
          throw new Error(
            `Error HTTP ${response.status}: ${response.statusText}`
          );
        }

        siigoProduct = await response.json();
      }

      // Actualizar siigoId local usando db.query para evitar problemas de transacción
      await strapi.db.query(PRODUCT_SERVICE).update({
        where: { id: productId },
        data: { siigoId: String(siigoProduct.id) },
      });

      console.log(
        `Product ${productId} creado en Siigo con ID: ${siigoProduct.id}`
      );

      return {
        success: true,
        productId: productId,
        siigoId: siigoProduct.id,
        product: siigoProduct,
      };
    } catch (error) {
      console.error(
        `Error al crear product ${productId} en Siigo:`,
        error.message
      );
      throw new Error(`Error al crear product en Siigo: ${error.message}`);
    }
  },

  /**
   * Actualiza un product en Siigo
   * @param {Number} productId - ID del product local
   * @returns {Object} - Product actualizado en Siigo
   */
  async updateInSiigo(productId) {
    try {
      console.log(`Actualizando product ${productId} en Siigo...`);

      const product = await strapi.entityService.findOne(
        PRODUCT_SERVICE,
        productId
      );

      if (!product) {
        throw new Error(`Product ${productId} no encontrado`);
      }

      if (!product.siigoId) {
        throw new Error(
          `Product ${productId} no tiene siigoId. Use createInSiigo en su lugar.`
        );
      }

      // Mapear a formato Siigo
      const mapperService = strapi.service("api::siigo.mapper");
      const siigoProductData = await mapperService.mapProductToSiigo(product);

      const testMode = process.env.SIIGO_TEST_MODE === "true";
      let siigoProduct;

      if (testMode) {
        console.log("[TEST MODE] Simulando actualización de product en Siigo");
        siigoProduct = {
          id: product.siigoId,
          ...siigoProductData,
        };
      } else {
        const authService = strapi.service("api::siigo.auth");
        const headers = await authService.getAuthHeaders();
        const apiUrl = process.env.SIIGO_API_URL || "https://api.siigo.com";

        const response = await siigoFetch(
          `${apiUrl}/v1/products/${product.siigoId}`,
          {
            method: "PUT",
            headers,
            body: JSON.stringify(siigoProductData),
          }
        );

        if (!response.ok) {
          const errorData = await response.text();
          console.error("Error de Siigo:", errorData);
          throw new Error(
            `Error HTTP ${response.status}: ${response.statusText}`
          );
        }

        siigoProduct = await response.json();
      }

      console.log(
        `Product ${productId} actualizado en Siigo ID: ${product.siigoId}`
      );

      return {
        success: true,
        productId: productId,
        siigoId: product.siigoId,
        product: siigoProduct,
      };
    } catch (error) {
      console.error(
        `Error al actualizar product ${productId} en Siigo:`,
        error.message
      );
      throw new Error(
        `Error al actualizar product en Siigo: ${error.message}`
      );
    }
  },

  /**
   * Elimina un product en Siigo (marca como inactivo)
   * @param {Number} productId - ID del product local
   * @returns {Object} - Resultado de la operación
   */
  async deleteInSiigo(productId) {
    try {
      console.log(`Eliminando product ${productId} en Siigo...`);

      const product = await strapi.entityService.findOne(
        PRODUCT_SERVICE,
        productId
      );

      if (!product) {
        throw new Error(`Product ${productId} no encontrado`);
      }

      if (!product.siigoId) {
        throw new Error(
          `Product ${productId} no tiene siigoId, no hay nada que eliminar en Siigo`
        );
      }

      const testMode = process.env.SIIGO_TEST_MODE === "true";

      if (testMode) {
        console.log("[TEST MODE] Simulando eliminación de product en Siigo");
      } else {
        // Siigo no permite DELETE, se marca como inactivo
        const authService = strapi.service("api::siigo.auth");
        const headers = await authService.getAuthHeaders();
        const apiUrl = process.env.SIIGO_API_URL || "https://api.siigo.com";

        const response = await siigoFetch(
          `${apiUrl}/v1/products/${product.siigoId}`,
          {
            method: "PUT",
            headers,
            body: JSON.stringify({ active: false }),
          }
        );

        if (!response.ok) {
          const errorData = await response.text();
          console.error("Error de Siigo:", errorData);
          throw new Error(
            `Error HTTP ${response.status}: ${response.statusText}`
          );
        }
      }

      // Actualizar estado local usando db.query para evitar problemas de transacción
      await strapi.db.query(PRODUCT_SERVICE).update({
        where: { id: productId },
        data: { isActive: false },
      });

      console.log(
        `Product ${productId} marcado como inactivo en Siigo ID: ${product.siigoId}`
      );

      return {
        success: true,
        productId: productId,
        siigoId: product.siigoId,
        message: "Product marcado como inactivo en Siigo",
      };
    } catch (error) {
      console.error(
        `Error al eliminar product ${productId} en Siigo:`,
        error.message
      );
      throw new Error(
        `Error al eliminar product en Siigo: ${error.message}`
      );
    }
  },

  /**
   * Lista todos los products desde Siigo con paginación
   * @param {Object} options - Opciones de listado (page, pageSize)
   * @returns {Array} - Array de products de Siigo
   */
  async listFromSiigo(options = {}) {
    try {
      const { page = 1, pageSize = 100 } = options;

      console.log(
        `Listando products desde Siigo (página ${page}, ${pageSize} por página)...`
      );

      const testMode = process.env.SIIGO_TEST_MODE === "true";

      if (testMode) {
        console.log("[TEST MODE] Simulando listado de products desde Siigo");
        return [
          {
            id: "TEST-P001",
            code: "PROD-001",
            name: "Test Product 1",
            type: "Product",
            active: true,
          },
          {
            id: "TEST-P002",
            code: "PROD-002",
            name: "Test Product 2",
            type: "Product",
            active: true,
          },
        ];
      }

      const authService = strapi.service("api::siigo.auth");
      const headers = await authService.getAuthHeaders();
      const apiUrl = process.env.SIIGO_API_URL || "https://api.siigo.com";

      const response = await siigoFetch(
        `${apiUrl}/v1/products?page=${page}&page_size=${pageSize}`,
        {
          method: "GET",
          headers,
        }
      );

      if (!response.ok) {
        throw new Error(
          `Error HTTP ${response.status}: ${response.statusText}`
        );
      }

      const data = await response.json();
      const products = data.results || data;

      console.log(`${products.length} products obtenidos desde Siigo`);

      return products;
    } catch (error) {
      console.error("Error al listar products desde Siigo:", error.message);
      throw new Error(
        `Error al listar products desde Siigo: ${error.message}`
      );
    }
  },

  /**
   * Sincroniza todos los products desde Siigo a la base de datos local
   * @returns {Object} - Resumen de la sincronización
   */
  async syncAllFromSiigo() {
    try {
      console.log(
        "Iniciando sincronización masiva de products desde Siigo..."
      );

      let allProducts = [];
      let page = 1;
      let hasMore = true;

      // Obtener todos los products paginados
      while (hasMore) {
        const products = await this.listFromSiigo({ page, pageSize: 100 });

        if (products && products.length > 0) {
          allProducts = allProducts.concat(products);
          page++;

          if (products.length < 100) {
            hasMore = false;
          }
        } else {
          hasMore = false;
        }
      }

      if (allProducts.length === 0) {
        return {
          success: true,
          created: 0,
          updated: 0,
          skipped: 0,
          failed: 0,
          total: 0,
          message: "No se encontraron products en Siigo",
        };
      }

      let created = 0;
      let updated = 0;
      let skipped = 0;
      let failed = 0;

      for (const siigoProduct of allProducts) {
        try {
          const existing = await strapi.entityService.findMany(
            PRODUCT_SERVICE,
            {
              filters: { siigoId: String(siigoProduct.id) },
              limit: 1,
            }
          );

          await this.syncFromSiigo(siigoProduct.id);

          if (existing && existing.length > 0) {
            updated++;
          } else {
            created++;
          }
        } catch (error) {
          console.error(
            `Error al sincronizar product ${siigoProduct.id}:`,
            error.message
          );
          failed++;
        }
      }

      const result = {
        success: true,
        created,
        updated,
        skipped,
        failed,
        total: allProducts.length,
        message: `Sincronización completada. Creados: ${created}, Actualizados: ${updated}, Fallidos: ${failed}`,
      };

      console.log(result.message);
      return result;
    } catch (error) {
      console.error(
        "Error al sincronizar products desde Siigo:",
        error.message
      );
      throw new Error(
        `Error en sincronización masiva de products: ${error.message}`
      );
    }
  },

  /**
   * Sincroniza todos los products locales hacia Siigo
   * @returns {Object} - Resumen de la sincronización
   */
  async syncAllToSiigo() {
    try {
      console.log(
        "Iniciando sincronización masiva de products hacia Siigo..."
      );

      const localProducts = await strapi.entityService.findMany(
        PRODUCT_SERVICE,
        {}
      );

      if (!localProducts || localProducts.length === 0) {
        return {
          success: true,
          created: 0,
          updated: 0,
          skipped: 0,
          failed: 0,
          total: 0,
          message: "No hay products locales para sincronizar",
        };
      }

      let created = 0;
      let updated = 0;
      let skipped = 0;
      let failed = 0;

      for (const product of localProducts) {
        try {
          const result = await this.syncToSiigo(product.id);

          if (result.success) {
            if (product.siigoId) {
              updated++;
            } else {
              created++;
            }
          }
        } catch (error) {
          console.error(
            `Error al sincronizar product ${product.id}:`,
            error.message
          );
          failed++;
        }
      }

      const result = {
        success: true,
        created,
        updated,
        skipped,
        failed,
        total: localProducts.length,
        message: `Sincronización completada. Creados: ${created}, Actualizados: ${updated}, Fallidos: ${failed}`,
      };

      console.log(result.message);
      return result;
    } catch (error) {
      console.error(
        "Error al sincronizar products hacia Siigo:",
        error.message
      );
      throw new Error(
        `Error en sincronización masiva hacia Siigo: ${error.message}`
      );
    }
  },
});
