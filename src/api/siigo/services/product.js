"use strict";

const logger = require("../../../utils/logger");
const { PRODUCT_SERVICE } = require("../../../utils/services");
const productCategories = require("../../../utils/productCategories");
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
      logger.info(`Sincronizando product ${siigoId} desde Siigo...`);

      // Marcar en el contexto que estamos sincronizando desde Siigo para evitar bucles en lifecycles
      const ctx = strapi.requestContext.get();
      if (ctx) {
        ctx.state = ctx.state || {};
        ctx.state.isSyncingFromSiigo = true;
      }

      const testMode = process.env.SIIGO_TEST_MODE === "true";
      let siigoProduct;

      if (testMode) {
        logger.info("[TEST MODE] Simulando consulta de product desde Siigo");
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
        const apiUrl = process.env.SIIGO_API_URL || "https://api.siigo.com";

        const response = await authService.authenticatedFetch(
          `${apiUrl}/v1/products/${siigoId}`,
          {
            method: "GET",
          },
        );

        if (!response.ok) {
          throw new Error(
            `Error HTTP ${response.status}: ${response.statusText}`,
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
        logger.info(`Product ${siigoId} actualizado localmente`);
      } else {
        localProduct = await strapi.db.query(PRODUCT_SERVICE).create({
          data: productData,
        });
        logger.info(`Product ${siigoId} creado localmente`);
      }

      return localProduct;
    } catch (error) {
      console.error(
        `Error al sincronizar product ${siigoId} desde Siigo:`,
        error.message,
      );
      throw new Error(
        `Error al sincronizar product desde Siigo: ${error.message}`,
      );
    }
  },

  async searchInSiigoByCode(code) {
    try {
      const sanitizedCode = code
        ? String(code)
            .toUpperCase()
            .trim()
            .replace(/[\s]+/g, "-")
            .replace(/[^\w-]/g, "")
        : code;
      logger.info(`Buscando product en Siigo por code: ${sanitizedCode}...`);

      const testMode = process.env.SIIGO_TEST_MODE === "true";

      if (testMode) {
        logger.info("[TEST MODE] Simulando búsqueda de product en Siigo");
        return null;
      }

      const authService = strapi.service("api::siigo.auth");
      const apiUrl = process.env.SIIGO_API_URL || "https://api.siigo.com";

      let page = 1;
      const pageSize = 100;
      let hasMore = true;

      while (hasMore) {
        const url = `${apiUrl}/v1/products?code=${encodeURIComponent(sanitizedCode)}&page=${page}&page_size=${pageSize}`;
        const response = await authService.authenticatedFetch(
          url,
          {
            method: "GET",
          },
        );

        if (!response.ok) {
          throw new Error(
            `Error HTTP ${response.status}: ${response.statusText}`,
          );
        }

        const data = await response.json();
        const products = data.results || data;

        logger.debug(`[Siigo Search Debug] Result for ${sanitizedCode}:`, JSON.stringify(data, null, 2));

        if (Array.isArray(products) && products.length > 0) {
          const found = products.find((product) => {
            const siigoCodeRaw = String(product.code || "");
            const siigoCodeSanitized = siigoCodeRaw
              .toUpperCase()
              .trim()
              .replace(/[\s]+/g, "-")
              .replace(/[^\w-]/g, "");

            return (
              siigoCodeSanitized === sanitizedCode ||
              siigoCodeRaw === String(code || "") ||
              siigoCodeRaw.toUpperCase() === String(code || "").toUpperCase()
            );
          });

          if (found) {
            logger.info(`Product encontrado en Siigo con ID: ${found.id}`);
            return found;
          }
        } else if (products && products.code != null) {
          const siigoCodeRaw = String(products.code || "");
          const siigoCodeSanitized = siigoCodeRaw
            .toUpperCase()
            .trim()
            .replace(/[\s]+/g, "-")
            .replace(/[^\w-]/g, "");

          if (
            siigoCodeSanitized === sanitizedCode ||
            siigoCodeRaw === String(code || "") ||
            siigoCodeRaw.toUpperCase() === String(code || "").toUpperCase()
          ) {
            logger.info(`Product encontrado en Siigo con ID: ${products.id}`);
            return products;
          }
        }

        const pagination = data.pagination || {};
        const totalResults = pagination.total_results;
        const currentPage = pagination.page || page;
        const responsePageSize = pagination.page_size || pageSize;

        if (totalResults) {
          hasMore = currentPage * responsePageSize < totalResults;
        } else {
          hasMore =
            Array.isArray(products) && products.length === responsePageSize;
        }

        page++;
      }

      logger.info(`Product con code ${code} no encontrado en Siigo`);
      return null;
    } catch (error) {
      console.error(
        `Error al buscar product por code ${code} en Siigo:`,
        error.message,
      );
      return null;
    }
  },

  /**
   * Envía un product local a Siigo
   * @param {Number} productId - ID del product local
   * @returns {Object} - Resultado de la sincronización
   */
  async syncToSiigo(productId) {
    try {
      logger.info(`Sincronizando product ${productId} hacia Siigo...`);

      const product = await strapi.entityService.findOne(
        PRODUCT_SERVICE,
        productId,
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
        error.message,
      );
      throw new Error(
        `Error al sincronizar product hacia Siigo: ${error.message}`,
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
      logger.info(`Creando product ${productId} en Siigo...`);

      const product = await strapi.entityService.findOne(
        PRODUCT_SERVICE,
        productId,
      );

      if (!product) {
        throw new Error(`Product ${productId} no encontrado`);
      }

      if (product.siigoId) {
        throw new Error(
          `Product ${productId} ya tiene siigoId: ${product.siigoId}`,
        );
      }

      // Mapear a formato Siigo
      const mapperService = strapi.service("api::siigo.mapper");
      const siigoProductData = await mapperService.mapProductToSiigo(product);

      const testMode = process.env.SIIGO_TEST_MODE === "true";
      let siigoProduct;

      if (testMode) {
        logger.info("[TEST MODE] Simulando creación de product en Siigo");
        siigoProduct = {
          id: "TEST-" + Date.now(),
          ...siigoProductData,
        };
      } else {
        const authService = strapi.service("api::siigo.auth");
        const apiUrl = process.env.SIIGO_API_URL || "https://api.siigo.com";

        const response = await authService.authenticatedFetch(
          `${apiUrl}/v1/products`,
          {
            method: "POST",
            body: JSON.stringify(siigoProductData),
          },
        );

        if (!response.ok) {
          const errorData = await response.text();
          console.error("Error de Siigo:", errorData);
          throw new Error(
            `Error HTTP ${response.status}: ${response.statusText}`,
          );
        }

        siigoProduct = await response.json();
      }

      // Actualizar siigoId local usando db.query para evitar problemas de transacción
      await strapi.db.query(PRODUCT_SERVICE).update({
        where: { id: productId },
        data: { siigoId: String(siigoProduct.id) },
      });

      logger.info(
        `Product ${productId} creado en Siigo con ID: ${siigoProduct.id}`,
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
        error.message,
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
      logger.info(`Actualizando product ${productId} en Siigo...`);

      const product = await strapi.entityService.findOne(
        PRODUCT_SERVICE,
        productId,
      );

      if (!product) {
        throw new Error(`Product ${productId} no encontrado`);
      }

      if (!product.siigoId) {
        throw new Error(
          `Product ${productId} no tiene siigoId. Use createInSiigo en su lugar.`,
        );
      }

      // Mapear a formato Siigo
      const mapperService = strapi.service("api::siigo.mapper");
      const siigoProductData = await mapperService.mapProductToSiigo(product);

      const testMode = process.env.SIIGO_TEST_MODE === "true";
      let siigoProduct;

      if (testMode) {
        logger.info("[TEST MODE] Simulando actualización de product en Siigo");
        siigoProduct = {
          id: product.siigoId,
          ...siigoProductData,
        };
      } else {
        const authService = strapi.service("api::siigo.auth");
        const apiUrl = process.env.SIIGO_API_URL || "https://api.siigo.com";

        const response = await authService.authenticatedFetch(
          `${apiUrl}/v1/products/${product.siigoId}`,
          {
            method: "PUT",
            body: JSON.stringify(siigoProductData),
          },
        );

        if (!response.ok) {
          const errorData = await response.text();
          console.error("Error de Siigo:", errorData);
          throw new Error(
            `Error HTTP ${response.status}: ${response.statusText}`,
          );
        }

        siigoProduct = await response.json();
      }

      logger.info(
        `Product ${productId} actualizado en Siigo ID: ${product.siigoId}`,
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
        error.message,
      );
      throw new Error(`Error al actualizar product en Siigo: ${error.message}`);
    }
  },

  /**
   * Elimina un product en Siigo (marca como inactivo)
   * @param {Number} productId - ID del product local
   * @returns {Object} - Resultado de la operación
   */
  async deleteInSiigo(productId) {
    try {
      logger.info(`Eliminando product ${productId} en Siigo...`);

      const product = await strapi.entityService.findOne(
        PRODUCT_SERVICE,
        productId,
      );

      if (!product) {
        throw new Error(`Product ${productId} no encontrado`);
      }

      if (!product.siigoId) {
        throw new Error(
          `Product ${productId} no tiene siigoId, no hay nada que eliminar en Siigo`,
        );
      }

      const testMode = process.env.SIIGO_TEST_MODE === "true";

      if (testMode) {
        logger.info("[TEST MODE] Simulando eliminación de product en Siigo");
      } else {
        // Siigo no permite DELETE, se marca como inactivo
        const authService = strapi.service("api::siigo.auth");
        const apiUrl = process.env.SIIGO_API_URL || "https://api.siigo.com";

        const response = await authService.authenticatedFetch(
          `${apiUrl}/v1/products/${product.siigoId}`,
          {
            method: "PUT",
            body: JSON.stringify({ active: false }),
          },
        );

        if (!response.ok) {
          const errorData = await response.text();
          console.error("Error de Siigo:", errorData);
          throw new Error(
            `Error HTTP ${response.status}: ${response.statusText}`,
          );
        }
      }

      // Actualizar estado local usando db.query para evitar problemas de transacción
      await strapi.db.query(PRODUCT_SERVICE).update({
        where: { id: productId },
        data: { isActive: false },
      });

      logger.info(
        `Product ${productId} marcado como inactivo en Siigo ID: ${product.siigoId}`,
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
        error.message,
      );
      throw new Error(`Error al eliminar product en Siigo: ${error.message}`);
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

      logger.info(
        `Listando products desde Siigo (página ${page}, ${pageSize} por página)...`,
      );

      const testMode = process.env.SIIGO_TEST_MODE === "true";

      if (testMode) {
        logger.info("[TEST MODE] Simulando listado de products desde Siigo");
        return [
          {
            id: "TEST-P001",
            code: "PROD-001",
            name: "Test Product 1",
            type: "Product",
            active: true,
            account_group: { id: productCategories[0]?.id },
          },
          {
            id: "TEST-P002",
            code: "PROD-002",
            name: "Test Product 2",
            type: "Product",
            active: true,
            account_group: { id: productCategories[1]?.id },
          },
        ];
      }

      const authService = strapi.service("api::siigo.auth");
      const apiUrl = process.env.SIIGO_API_URL || "https://api.siigo.com";

      const response = await authService.authenticatedFetch(
        `${apiUrl}/v1/products?page=${page}&page_size=${pageSize}`,
        {
          method: "GET",
        },
      );

      if (!response.ok) {
        throw new Error(
          `Error HTTP ${response.status}: ${response.statusText}`,
        );
      }

      const data = await response.json();
      const products = data.results || data;

      logger.info(`${products.length} products obtenidos desde Siigo`);

      return products;
    } catch (error) {
      console.error("Error al listar products desde Siigo:", error.message);
      throw new Error(`Error al listar products desde Siigo: ${error.message}`);
    }
  },

  /**
   * Sincroniza todos los products desde Siigo a la base de datos local
   * @returns {Object} - Resumen de la sincronización
   */
  async syncAllFromSiigo() {
    try {
      logger.info("Iniciando sincronización masiva de products desde Siigo...");

      const allowedCategoryIds = new Set(
        productCategories.map((category) => String(category.id)),
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
          const accountGroupId = siigoProduct?.account_group?.id;
          if (!allowedCategoryIds.has(String(accountGroupId))) {
            logger.info(
              `Product ${siigoProduct.id} omitido por account_group.id no permitido (${accountGroupId})`,
            );
            skipped++;
            continue;
          }

          const existing = await strapi.entityService.findMany(
            PRODUCT_SERVICE,
            {
              filters: { siigoId: String(siigoProduct.id) },
              limit: 1,
            },
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
            error.message,
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
        total: created + updated + skipped + failed,
        message: `Sincronización completada. Creados: ${created}, Actualizados: ${updated}, Saltados: ${skipped}, Fallidos: ${failed}`,
      };

      logger.info(result.message);
      return result;
    } catch (error) {
      console.error(
        "Error al sincronizar products desde Siigo:",
        error.message,
      );
      throw new Error(
        `Error en sincronización masiva de products: ${error.message}`,
      );
    }
  },

  /**
   * Sincroniza todos los products locales hacia Siigo
   * @returns {Object} - Resumen de la sincronización
   */
  async syncAllToSiigo() {
    try {
      logger.info("Iniciando sincronización masiva de products hacia Siigo...");

      const localProducts = await strapi.entityService.findMany(
        PRODUCT_SERVICE,
        {},
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
            error.message,
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

      logger.info(result.message);
      return result;
    } catch (error) {
      console.error(
        "Error al sincronizar products hacia Siigo:",
        error.message,
      );
      throw new Error(
        `Error en sincronización masiva hacia Siigo: ${error.message}`,
      );
    }
  },
});
