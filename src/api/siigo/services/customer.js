"use strict";

const logger = require("../../../utils/logger");
const { CUSTOMER_SERVICE } = require("../../../utils/services");
const { siigoFetch } = require("../utils/siigoFetch");

/**
 * Servicio de sincronización bidireccional de Customers con Siigo
 */

module.exports = ({ strapi }) => ({
  /**
   * Trae un customer desde Siigo y lo crea/actualiza localmente
   * @param {String} siigoId - ID del customer en Siigo
   * @returns {Object} - Customer local creado/actualizado
   */
  async syncFromSiigo(siigoId) {
    try {
      console.log(`Sincronizando customer ${siigoId} desde Siigo...`);

      const testMode = process.env.SIIGO_TEST_MODE === "true";

      let siigoCustomer;

      if (testMode) {
        console.log("[TEST MODE] Simulando consulta de customer desde Siigo");
        siigoCustomer = {
          id: siigoId,
          type: "Customer",
          person_type: "Company",
          id_type: "31",
          identification: "900123456",
          name: ["Test Customer SA"],
          active: true,
          contacts: [
            {
              first_name: "John",
              last_name: "Doe",
              email: "test@example.com",
              phone: { number: "3001234567" },
            },
          ],
          address: {
            address: "Calle 123 #45-67",
            city: {
              country_code: "Co",
              state_code: "19",
              city_code: "001",
            },
            postal_code: "110111",
          },
          payment_terms: { days: 30 },
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

        siigoCustomer = await response.json();
      }

      // Mapear a formato local
      const mapperService = strapi.service("api::siigo.mapper");
      const customerData =
        await mapperService.mapSiigoToCustomer(siigoCustomer);

      // Buscar si ya existe localmente usando db.query para evitar disparar lifecycles
      const existingCustomers = await strapi.db.query(CUSTOMER_SERVICE).findMany({
        where: { siigoId: String(siigoId) },
        limit: 1,
      });

      let localCustomer;

      if (existingCustomers && existingCustomers.length > 0) {
        // Actualizar existente usando db.query para evitar disparar lifecycles
        localCustomer = await strapi.db.query(CUSTOMER_SERVICE).update({
          where: { id: existingCustomers[0].id },
          data: customerData,
        });
        console.log(`Customer ${siigoId} actualizado localmente`);
      } else {
        // Crear nuevo usando db.query para evitar disparar lifecycles
        localCustomer = await strapi.db.query(CUSTOMER_SERVICE).create({
          data: customerData,
        });
        console.log(`Customer ${siigoId} creado localmente`);
      }

      return localCustomer;
    } catch (error) {
      console.error(
        `Error al sincronizar customer ${siigoId} desde Siigo:`,
        error.message
      );
      throw new Error(
        `Error al sincronizar customer desde Siigo: ${error.message}`
      );
    }
  },

  /**
   * Envía un customer local a Siigo y actualiza el siigoId
   * @param {Number} customerId - ID del customer local
   * @returns {Object} - Resultado de la sincronización
   */
  async syncToSiigo(customerId) {
    try {
      console.log(`Sincronizando customer ${customerId} hacia Siigo...`);

      // Obtener customer local
      const customer = await strapi.entityService.findOne(
        CUSTOMER_SERVICE,
        customerId,
        { populate: ["taxes"] }
      );

      if (!customer) {
        throw new Error(`Customer ${customerId} no encontrado`);
      }

      // Si ya tiene siigoId, actualizar en Siigo
      if (customer.siigoId) {
        return await this.updateInSiigo(customerId);
      } else {
        // Si no tiene siigoId, crear en Siigo
        return await this.createInSiigo(customerId);
      }
    } catch (error) {
      console.error(
        `Error al sincronizar customer ${customerId} hacia Siigo:`,
        error.message
      );
      throw new Error(
        `Error al sincronizar customer hacia Siigo: ${error.message}`
      );
    }
  },

  /**
   * Crea un customer en Siigo y actualiza el siigoId local
   * @param {Number} customerId - ID del customer local
   * @returns {Object} - Customer creado en Siigo
   */
  async createInSiigo(customerId) {
    try {
      console.log(`Creando customer ${customerId} en Siigo...`);

      // Obtener customer local
      const customer = await strapi.entityService.findOne(
        CUSTOMER_SERVICE,
        customerId,
        { populate: ["taxes"] }
      );

      if (!customer) {
        throw new Error(`Customer ${customerId} no encontrado`);
      }

      if (customer.siigoId) {
        throw new Error(
          `Customer ${customerId} ya tiene siigoId: ${customer.siigoId}`
        );
      }

      // Mapear a formato Siigo
      const mapperService = strapi.service("api::siigo.mapper");
      const siigoCustomerData =
        await mapperService.mapCustomerToSiigo(customer);

      const testMode = process.env.SIIGO_TEST_MODE === "true";

      let siigoCustomer;

      if (testMode) {
        console.log("[TEST MODE] Simulando creación de customer en Siigo");
        siigoCustomer = {
          id: "TEST-" + Date.now(),
          ...siigoCustomerData,
        };
      } else {
        const authService = strapi.service("api::siigo.auth");
        const headers = await authService.getAuthHeaders();
        const apiUrl = process.env.SIIGO_API_URL || "https://api.siigo.com";

        const response = await siigoFetch(`${apiUrl}/v1/customers`, {
          method: "POST",
          headers,
          body: JSON.stringify(siigoCustomerData),
        });

        if (!response.ok) {
          const errorData = await response.text();
          console.error("Error de Siigo:", errorData);
          throw new Error(
            `Error HTTP ${response.status}: ${response.statusText}`
          );
        }

        siigoCustomer = await response.json();
      }

      // Actualizar siigoId local usando db.query para evitar problemas de transacción
      // cuando se llama desde lifecycles
      await strapi.db.query(CUSTOMER_SERVICE).update({
        where: { id: customerId },
        data: { siigoId: String(siigoCustomer.id) },
      });

      console.log(
        `Customer ${customerId} creado en Siigo con ID: ${siigoCustomer.id}`
      );

      return {
        success: true,
        customerId: customerId,
        siigoId: siigoCustomer.id,
        customer: siigoCustomer,
      };
    } catch (error) {
      console.error(
        `Error al crear customer ${customerId} en Siigo:`,
        error.message
      );
      throw new Error(`Error al crear customer en Siigo: ${error.message}`);
    }
  },

  /**
   * Actualiza un customer en Siigo
   * @param {Number} customerId - ID del customer local
   * @returns {Object} - Customer actualizado en Siigo
   */
  async updateInSiigo(customerId) {
    try {
      console.log(`Actualizando customer ${customerId} en Siigo...`);

      // Obtener customer local
      const customer = await strapi.entityService.findOne(
        CUSTOMER_SERVICE,
        customerId,
        { populate: ["taxes"] }
      );

      if (!customer) {
        throw new Error(`Customer ${customerId} no encontrado`);
      }

      if (!customer.siigoId) {
        throw new Error(
          `Customer ${customerId} no tiene siigoId. Use createInSiigo en su lugar.`
        );
      }

      // Mapear a formato Siigo
      const mapperService = strapi.service("api::siigo.mapper");
      const siigoCustomerData =
        await mapperService.mapCustomerToSiigo(customer);

      const testMode = process.env.SIIGO_TEST_MODE === "true";

      let siigoCustomer;

      if (testMode) {
        console.log("[TEST MODE] Simulando actualización de customer en Siigo");
        siigoCustomer = {
          id: customer.siigoId,
          ...siigoCustomerData,
        };
      } else {
        const authService = strapi.service("api::siigo.auth");
        const headers = await authService.getAuthHeaders();
        const apiUrl = process.env.SIIGO_API_URL || "https://api.siigo.com";

        const response = await siigoFetch(
          `${apiUrl}/v1/customers/${customer.siigoId}`,
          {
            method: "PUT",
            headers,
            body: JSON.stringify(siigoCustomerData),
          }
        );

        if (!response.ok) {
          const errorData = await response.text();
          console.error("Error de Siigo:", errorData);
          throw new Error(
            `Error HTTP ${response.status}: ${response.statusText}`
          );
        }

        siigoCustomer = await response.json();
      }

      console.log(
        `Customer ${customerId} actualizado en Siigo ID: ${customer.siigoId}`
      );

      return {
        success: true,
        customerId: customerId,
        siigoId: customer.siigoId,
        customer: siigoCustomer,
      };
    } catch (error) {
      console.error(
        `Error al actualizar customer ${customerId} en Siigo:`,
        error.message
      );
      throw new Error(
        `Error al actualizar customer en Siigo: ${error.message}`
      );
    }
  },

  /**
   * Elimina un customer en Siigo (marca como inactivo)
   * @param {Number} customerId - ID del customer local
   * @returns {Object} - Resultado de la operación
   */
  async deleteInSiigo(customerId) {
    try {
      console.log(`Eliminando customer ${customerId} en Siigo...`);

      // Obtener customer local
      const customer = await strapi.entityService.findOne(
        CUSTOMER_SERVICE,
        customerId
      );

      if (!customer) {
        throw new Error(`Customer ${customerId} no encontrado`);
      }

      if (!customer.siigoId) {
        throw new Error(
          `Customer ${customerId} no tiene siigoId, no hay nada que eliminar en Siigo`
        );
      }

      const testMode = process.env.SIIGO_TEST_MODE === "true";

      if (testMode) {
        console.log("[TEST MODE] Simulando eliminación de customer en Siigo");
      } else {
        // Siigo no permite DELETE, se marca como inactivo
        const authService = strapi.service("api::siigo.auth");
        const headers = await authService.getAuthHeaders();
        const apiUrl = process.env.SIIGO_API_URL || "https://api.siigo.com";

        const response = await siigoFetch(
          `${apiUrl}/v1/customers/${customer.siigoId}`,
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
      await strapi.db.query(CUSTOMER_SERVICE).update({
        where: { id: customerId },
        data: { isActive: false },
      });

      console.log(
        `Customer ${customerId} marcado como inactivo en Siigo ID: ${customer.siigoId}`
      );

      return {
        success: true,
        customerId: customerId,
        siigoId: customer.siigoId,
        message: "Customer marcado como inactivo en Siigo",
      };
    } catch (error) {
      console.error(
        `Error al eliminar customer ${customerId} en Siigo:`,
        error.message
      );
      throw new Error(`Error al eliminar customer en Siigo: ${error.message}`);
    }
  },

  /**
   * Busca un customer en Siigo por número de identificación
   * @param {String} identification - Número de identificación del customer
   * @returns {Object|null} - Customer de Siigo o null si no existe
   */
  async searchInSiigoByIdentification(identification) {
    try {
      console.log(`Buscando customer en Siigo por identification: ${identification}...`);

      const testMode = process.env.SIIGO_TEST_MODE === "true";

      if (testMode) {
        console.log("[TEST MODE] Simulando búsqueda de customer en Siigo");
        // Simular que no se encuentra
        return null;
      }

      const authService = strapi.service("api::siigo.auth");
      const headers = await authService.getAuthHeaders();
      const apiUrl = process.env.SIIGO_API_URL || "https://api.siigo.com";

      const response = await siigoFetch(
        `${apiUrl}/v1/customers?identification=${encodeURIComponent(identification)}`,
        {
          method: "GET",
          headers,
        }
      );

      if (!response.ok) {
        if (response.status === 404) {
          console.log(`Customer con identification ${identification} no encontrado en Siigo`);
          return null;
        }
        throw new Error(
          `Error HTTP ${response.status}: ${response.statusText}`
        );
      }

      const data = await response.json();
      const customers = data.results || data;

      // Si es un array, tomar el primer resultado
      if (Array.isArray(customers) && customers.length > 0) {
        console.log(`Customer encontrado en Siigo con ID: ${customers[0].id}`);
        return customers[0];
      } else if (!Array.isArray(customers) && customers.id) {
        console.log(`Customer encontrado en Siigo con ID: ${customers.id}`);
        return customers;
      }

      console.log(`Customer con identification ${identification} no encontrado en Siigo`);
      return null;
    } catch (error) {
      console.error(
        `Error al buscar customer por identification ${identification} en Siigo:`,
        error.message
      );
      // No lanzar error, devolver null para permitir crear el customer
      return null;
    }
  },

  /**
   * Lista todos los customers desde Siigo con paginación
   * @param {Object} options - Opciones de listado (page, pageSize)
   * @returns {Array} - Array de customers de Siigo
   */
  async listFromSiigo(options = {}) {
    try {
      const { page = 1, pageSize = 100 } = options;

      console.log(
        `Listando customers desde Siigo (página ${page}, ${pageSize} por página)...`
      );

      const testMode = process.env.SIIGO_TEST_MODE === "true";

      if (testMode) {
        console.log("[TEST MODE] Simulando listado de customers desde Siigo");
        return [
          {
            id: "TEST-001",
            type: "Customer",
            identification: "900123456",
            name: ["Test Customer 1 SA"],
            active: true,
          },
          {
            id: "TEST-002",
            type: "Customer",
            identification: "900789012",
            name: ["Test Customer 2 SA"],
            active: true,
          },
        ];
      }

      const authService = strapi.service("api::siigo.auth");
      const headers = await authService.getAuthHeaders();
      const apiUrl = process.env.SIIGO_API_URL || "https://api.siigo.com";

      const response = await siigoFetch(
        `${apiUrl}/v1/customers?page=${page}&page_size=${pageSize}`,
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
      const customers = data.results || data;

      console.log(`${customers.length} customers obtenidos desde Siigo`);

      return customers;
    } catch (error) {
      console.error("Error al listar customers desde Siigo:", error.message);
      throw new Error(
        `Error al listar customers desde Siigo: ${error.message}`
      );
    }
  },

  /**
   * Sincroniza todos los customers desde Siigo a la base de datos local
   * @returns {Object} - Resumen de la sincronización
   */
  async syncAllFromSiigo() {
    try {
      console.log(
        "Iniciando sincronización masiva de customers desde Siigo..."
      );

      let allCustomers = [];
      let page = 1;
      let hasMore = true;

      // Obtener todos los customers paginados
      while (hasMore) {
        const customers = await this.listFromSiigo({ page, pageSize: 100 });

        if (customers && customers.length > 0) {
          allCustomers = allCustomers.concat(customers);
          page++;

          // Si obtenemos menos de 100, es la última página
          if (customers.length < 100) {
            hasMore = false;
          }
        } else {
          hasMore = false;
        }
      }

      if (allCustomers.length === 0) {
        return {
          success: true,
          created: 0,
          updated: 0,
          skipped: 0,
          failed: 0,
          total: 0,
          message: "No se encontraron customers en Siigo",
        };
      }

      let created = 0;
      let updated = 0;
      let skipped = 0;
      let failed = 0;

      for (const siigoCustomer of allCustomers) {
        try {
          await this.syncFromSiigo(siigoCustomer.id);

          // Determinar si fue creado o actualizado verificando si existía antes
          const existing = await strapi.entityService.findMany(
            CUSTOMER_SERVICE,
            {
              filters: { siigoId: String(siigoCustomer.id) },
              limit: 1,
            }
          );

          if (existing && existing.length > 0) {
            updated++;
          } else {
            created++;
          }
        } catch (error) {
          console.error(
            `Error al sincronizar customer ${siigoCustomer.id}:`,
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
        total: allCustomers.length,
        message: `Sincronización completada. Creados: ${created}, Actualizados: ${updated}, Fallidos: ${failed}`,
      };

      console.log(result.message);
      return result;
    } catch (error) {
      console.error(
        "Error al sincronizar customers desde Siigo:",
        error.message
      );
      throw new Error(
        `Error en sincronización masiva de customers: ${error.message}`
      );
    }
  },

  /**
   * Sincroniza todos los customers locales hacia Siigo
   * @returns {Object} - Resumen de la sincronización
   */
  async syncAllToSiigo() {
    try {
      console.log(
        "Iniciando sincronización masiva de customers hacia Siigo..."
      );

      // Obtener todos los customers locales
      const localCustomers = await strapi.entityService.findMany(
        CUSTOMER_SERVICE,
        {
          populate: ["taxes"],
        }
      );

      if (!localCustomers || localCustomers.length === 0) {
        return {
          success: true,
          created: 0,
          updated: 0,
          skipped: 0,
          failed: 0,
          total: 0,
          message: "No hay customers locales para sincronizar",
        };
      }

      let created = 0;
      let updated = 0;
      let skipped = 0;
      let failed = 0;

      for (const customer of localCustomers) {
        try {
          const result = await this.syncToSiigo(customer.id);

          if (result.success) {
            if (customer.siigoId) {
              updated++;
            } else {
              created++;
            }
          }
        } catch (error) {
          console.error(
            `Error al sincronizar customer ${customer.id}:`,
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
        total: localCustomers.length,
        message: `Sincronización completada. Creados: ${created}, Actualizados: ${updated}, Fallidos: ${failed}`,
      };

      console.log(result.message);
      return result;
    } catch (error) {
      console.error(
        "Error al sincronizar customers hacia Siigo:",
        error.message
      );
      throw new Error(
        `Error en sincronización masiva hacia Siigo: ${error.message}`
      );
    }
  },
});
