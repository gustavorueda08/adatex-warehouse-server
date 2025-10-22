"use strict";

const { SUPPLIER_SERVICE } = require("../../../utils/services");
const { siigoFetch } = require("../utils/siigoFetch");

/**
 * Servicio de sincronización bidireccional de Suppliers con Siigo
 * Los suppliers en Siigo son customers con type="Supplier"
 */

module.exports = ({ strapi }) => ({
  /**
   * Trae un supplier desde Siigo y lo crea/actualiza localmente
   * @param {String} siigoId - ID del supplier en Siigo
   * @returns {Object} - Supplier local creado/actualizado
   */
  async syncFromSiigo(siigoId) {
    try {
      console.log(`Sincronizando supplier ${siigoId} desde Siigo...`);

      const testMode = process.env.SIIGO_TEST_MODE === "true";
      let siigoSupplier;

      if (testMode) {
        console.log("[TEST MODE] Simulando consulta de supplier desde Siigo");
        siigoSupplier = {
          id: siigoId,
          type: "Supplier",
          person_type: "Company",
          id_type: "31",
          identification: "800123456",
          name: ["Test Supplier SA"],
          active: true,
          contacts: [{ email: "supplier@example.com" }],
          address: {
            address: "Calle Supplier 123",
            city: { country_code: "Co", state_code: "19", city_code: "001" },
          },
        };
      } else {
        const authService = strapi.service("api::siigo.auth");
        const headers = await authService.getAuthHeaders();
        const apiUrl = process.env.SIIGO_API_URL || "https://api.siigo.com";

        const response = await siigoFetch(`${apiUrl}/v1/customers/${siigoId}`, {
          method: "GET",
          headers,
        });

        if (!response.ok) {
          throw new Error(
            `Error HTTP ${response.status}: ${response.statusText}`
          );
        }

        siigoSupplier = await response.json();
      }

      // Mapear a formato local
      const mapperService = strapi.service("api::siigo.mapper");
      const supplierData = await mapperService.mapSiigoToSupplier(
        siigoSupplier
      );

      // Buscar si ya existe localmente usando db.query para evitar disparar lifecycles
      const existingSuppliers = await strapi.db.query(SUPPLIER_SERVICE).findMany({
        where: { siigoId: String(siigoId) },
        limit: 1,
      });

      let localSupplier;

      if (existingSuppliers && existingSuppliers.length > 0) {
        localSupplier = await strapi.db.query(SUPPLIER_SERVICE).update({
          where: { id: existingSuppliers[0].id },
          data: supplierData,
        });
        console.log(`Supplier ${siigoId} actualizado localmente`);
      } else {
        localSupplier = await strapi.db.query(SUPPLIER_SERVICE).create({
          data: supplierData,
        });
        console.log(`Supplier ${siigoId} creado localmente`);
      }

      return localSupplier;
    } catch (error) {
      console.error(
        `Error al sincronizar supplier ${siigoId} desde Siigo:`,
        error.message
      );
      throw new Error(
        `Error al sincronizar supplier desde Siigo: ${error.message}`
      );
    }
  },

  /**
   * Envía un supplier local a Siigo
   * @param {Number} supplierId - ID del supplier local
   * @returns {Object} - Resultado de la sincronización
   */
  async syncToSiigo(supplierId) {
    try {
      const supplier = await strapi.entityService.findOne(
        SUPPLIER_SERVICE,
        supplierId
      );

      if (!supplier) {
        throw new Error(`Supplier ${supplierId} no encontrado`);
      }

      if (supplier.siigoId) {
        return await this.updateInSiigo(supplierId);
      } else {
        return await this.createInSiigo(supplierId);
      }
    } catch (error) {
      throw new Error(
        `Error al sincronizar supplier hacia Siigo: ${error.message}`
      );
    }
  },

  async createInSiigo(supplierId) {
    try {
      const supplier = await strapi.entityService.findOne(
        SUPPLIER_SERVICE,
        supplierId
      );

      if (!supplier || supplier.siigoId) {
        throw new Error(
          supplier
            ? `Supplier ya tiene siigoId`
            : `Supplier ${supplierId} no encontrado`
        );
      }

      const mapperService = strapi.service("api::siigo.mapper");
      const siigoSupplierData = await mapperService.mapSupplierToSiigo(
        supplier
      );

      const testMode = process.env.SIIGO_TEST_MODE === "true";
      let siigoSupplier;

      if (testMode) {
        siigoSupplier = { id: "TEST-" + Date.now(), ...siigoSupplierData };
      } else {
        const authService = strapi.service("api::siigo.auth");
        const headers = await authService.getAuthHeaders();
        const apiUrl = process.env.SIIGO_API_URL || "https://api.siigo.com";

        const response = await siigoFetch(`${apiUrl}/v1/customers`, {
          method: "POST",
          headers,
          body: JSON.stringify(siigoSupplierData),
        });

        if (!response.ok) {
          const errorData = await response.text();
          console.error("Error de Siigo:", errorData);
          throw new Error(`Error HTTP ${response.status}`);
        }

        siigoSupplier = await response.json();
      }

      // Actualizar siigoId local usando db.query para evitar problemas de transacción
      await strapi.db.query(SUPPLIER_SERVICE).update({
        where: { id: supplierId },
        data: { siigoId: String(siigoSupplier.id) },
      });

      return {
        success: true,
        supplierId,
        siigoId: siigoSupplier.id,
        supplier: siigoSupplier,
      };
    } catch (error) {
      throw new Error(`Error al crear supplier en Siigo: ${error.message}`);
    }
  },

  async updateInSiigo(supplierId) {
    try {
      const supplier = await strapi.entityService.findOne(
        SUPPLIER_SERVICE,
        supplierId
      );

      if (!supplier || !supplier.siigoId) {
        throw new Error(
          supplier
            ? `Supplier no tiene siigoId`
            : `Supplier ${supplierId} no encontrado`
        );
      }

      const mapperService = strapi.service("api::siigo.mapper");
      const siigoSupplierData = await mapperService.mapSupplierToSiigo(
        supplier
      );

      const testMode = process.env.SIIGO_TEST_MODE === "true";
      let siigoSupplier;

      if (testMode) {
        siigoSupplier = { id: supplier.siigoId, ...siigoSupplierData };
      } else {
        const authService = strapi.service("api::siigo.auth");
        const headers = await authService.getAuthHeaders();
        const apiUrl = process.env.SIIGO_API_URL || "https://api.siigo.com";

        const response = await siigoFetch(
          `${apiUrl}/v1/customers/${supplier.siigoId}`,
          {
            method: "PUT",
            headers,
            body: JSON.stringify(siigoSupplierData),
          }
        );

        if (!response.ok) {
          const errorData = await response.text();
          console.error("Error de Siigo:", errorData);
          throw new Error(`Error HTTP ${response.status}`);
        }

        siigoSupplier = await response.json();
      }

      return {
        success: true,
        supplierId,
        siigoId: supplier.siigoId,
        supplier: siigoSupplier,
      };
    } catch (error) {
      throw new Error(
        `Error al actualizar supplier en Siigo: ${error.message}`
      );
    }
  },

  async deleteInSiigo(supplierId) {
    try {
      const supplier = await strapi.entityService.findOne(
        SUPPLIER_SERVICE,
        supplierId
      );

      if (!supplier || !supplier.siigoId) {
        throw new Error(
          supplier
            ? `Supplier no tiene siigoId`
            : `Supplier ${supplierId} no encontrado`
        );
      }

      const testMode = process.env.SIIGO_TEST_MODE === "true";

      if (!testMode) {
        const authService = strapi.service("api::siigo.auth");
        const headers = await authService.getAuthHeaders();
        const apiUrl = process.env.SIIGO_API_URL || "https://api.siigo.com";

        const response = await siigoFetch(
          `${apiUrl}/v1/customers/${supplier.siigoId}`,
          {
            method: "PUT",
            headers,
            body: JSON.stringify({ active: false }),
          }
        );

        if (!response.ok) {
          throw new Error(`Error HTTP ${response.status}`);
        }
      }

      // Actualizar estado local usando db.query para evitar problemas de transacción
      await strapi.db.query(SUPPLIER_SERVICE).update({
        where: { id: supplierId },
        data: { isActive: false },
      });

      return {
        success: true,
        supplierId,
        siigoId: supplier.siigoId,
        message: "Supplier marcado como inactivo",
      };
    } catch (error) {
      throw new Error(
        `Error al eliminar supplier en Siigo: ${error.message}`
      );
    }
  },

  async listFromSiigo(options = {}) {
    try {
      const { page = 1, pageSize = 100 } = options;

      const testMode = process.env.SIIGO_TEST_MODE === "true";

      if (testMode) {
        return [
          {
            id: "TEST-S001",
            type: "Supplier",
            identification: "800123456",
            name: ["Test Supplier 1 SA"],
            active: true,
          },
        ];
      }

      const authService = strapi.service("api::siigo.auth");
      const headers = await authService.getAuthHeaders();
      const apiUrl = process.env.SIIGO_API_URL || "https://api.siigo.com";

      const response = await siigoFetch(
        `${apiUrl}/v1/customers?type=Supplier&page=${page}&page_size=${pageSize}`,
        {
          method: "GET",
          headers,
        }
      );

      if (!response.ok) {
        throw new Error(`Error HTTP ${response.status}`);
      }

      const data = await response.json();
      return data.results || data;
    } catch (error) {
      throw new Error(
        `Error al listar suppliers desde Siigo: ${error.message}`
      );
    }
  },

  async syncAllFromSiigo() {
    try {
      console.log("Sincronizando suppliers desde Siigo...");

      let allSuppliers = [];
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const suppliers = await this.listFromSiigo({ page, pageSize: 100 });
        if (suppliers && suppliers.length > 0) {
          allSuppliers = allSuppliers.concat(suppliers);
          page++;
          if (suppliers.length < 100) hasMore = false;
        } else {
          hasMore = false;
        }
      }

      let created = 0;
      let updated = 0;
      let failed = 0;

      for (const siigoSupplier of allSuppliers) {
        try {
          const existing = await strapi.entityService.findMany(
            SUPPLIER_SERVICE,
            {
              filters: { siigoId: String(siigoSupplier.id) },
              limit: 1,
            }
          );

          await this.syncFromSiigo(siigoSupplier.id);
          existing && existing.length > 0 ? updated++ : created++;
        } catch (error) {
          failed++;
        }
      }

      return {
        success: true,
        created,
        updated,
        failed,
        total: allSuppliers.length,
        message: `Creados: ${created}, Actualizados: ${updated}, Fallidos: ${failed}`,
      };
    } catch (error) {
      throw new Error(
        `Error en sincronización masiva de suppliers: ${error.message}`
      );
    }
  },

  async syncAllToSiigo() {
    try {
      const localSuppliers = await strapi.entityService.findMany(
        SUPPLIER_SERVICE
      );

      let created = 0;
      let updated = 0;
      let failed = 0;

      for (const supplier of localSuppliers) {
        try {
          await this.syncToSiigo(supplier.id);
          supplier.siigoId ? updated++ : created++;
        } catch (error) {
          failed++;
        }
      }

      return {
        success: true,
        created,
        updated,
        failed,
        total: localSuppliers.length,
        message: `Creados: ${created}, Actualizados: ${updated}, Fallidos: ${failed}`,
      };
    } catch (error) {
      throw new Error(
        `Error en sincronización masiva hacia Siigo: ${error.message}`
      );
    }
  },
});
