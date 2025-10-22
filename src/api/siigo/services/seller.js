"use strict";

const { siigoFetch } = require("../utils/siigoFetch");

/**
 * Servicio de consulta de Sellers (Users) desde Siigo
 * Los sellers son usuarios del sistema Siigo y solo se pueden consultar (no crear/actualizar)
 */

module.exports = ({ strapi }) => ({
  /**
   * Lista todos los sellers/users desde Siigo
   * @returns {Array} - Array de sellers de Siigo
   */
  async listFromSiigo() {
    try {
      console.log("Listando sellers desde Siigo...");

      const testMode = process.env.SIIGO_TEST_MODE === "true";

      if (testMode) {
        console.log("[TEST MODE] Simulando listado de sellers desde Siigo");
        return [
          {
            id: 629,
            identification: "12345678",
            first_name: "Juan",
            last_name: "Pérez",
            email: "juan.perez@example.com",
            active: true,
          },
          {
            id: 630,
            identification: "87654321",
            first_name: "María",
            last_name: "García",
            email: "maria.garcia@example.com",
            active: true,
          },
        ];
      }

      const authService = strapi.service("api::siigo.auth");
      const headers = await authService.getAuthHeaders();
      const apiUrl = process.env.SIIGO_API_URL || "https://api.siigo.com";

      const response = await siigoFetch(`${apiUrl}/v1/users`, {
        method: "GET",
        headers,
      });

      if (!response.ok) {
        throw new Error(
          `Error HTTP ${response.status}: ${response.statusText}`
        );
      }

      const sellers = await response.json();
      console.log(`${sellers.length} sellers obtenidos desde Siigo`);

      return sellers;
    } catch (error) {
      console.error("Error al listar sellers desde Siigo:", error.message);
      throw new Error(`Error al consultar sellers en Siigo: ${error.message}`);
    }
  },

  /**
   * Obtiene un seller específico desde Siigo
   * @param {Number} sellerId - ID del seller en Siigo
   * @returns {Object} - Seller encontrado
   */
  async getFromSiigo(sellerId) {
    try {
      console.log(`Obteniendo seller ${sellerId} desde Siigo...`);

      const testMode = process.env.SIIGO_TEST_MODE === "true";

      if (testMode) {
        console.log("[TEST MODE] Simulando consulta de seller desde Siigo");
        return {
          id: sellerId,
          identification: "12345678",
          first_name: "Juan",
          last_name: "Pérez",
          email: "juan.perez@example.com",
          active: true,
        };
      }

      const authService = strapi.service("api::siigo.auth");
      const headers = await authService.getAuthHeaders();
      const apiUrl = process.env.SIIGO_API_URL || "https://api.siigo.com";

      const response = await siigoFetch(`${apiUrl}/v1/users/${sellerId}`, {
        method: "GET",
        headers,
      });

      if (!response.ok) {
        throw new Error(
          `Error HTTP ${response.status}: ${response.statusText}`
        );
      }

      const seller = await response.json();
      console.log(`Seller ${sellerId} obtenido desde Siigo`);

      return seller;
    } catch (error) {
      console.error(
        `Error al obtener seller ${sellerId} desde Siigo:`,
        error.message
      );
      throw new Error(
        `Error al consultar seller en Siigo: ${error.message}`
      );
    }
  },

  /**
   * Sincroniza sellers de Siigo como users en Strapi
   * Crea/actualiza users en la tabla de users de Strapi basados en sellers de Siigo
   * @returns {Object} - Resumen de la sincronización
   */
  async syncAllToLocal() {
    try {
      console.log(
        "Iniciando sincronización de sellers desde Siigo a users locales..."
      );

      const sellers = await this.listFromSiigo();

      if (!sellers || sellers.length === 0) {
        return {
          success: true,
          created: 0,
          updated: 0,
          skipped: 0,
          total: 0,
          message: "No se encontraron sellers en Siigo",
        };
      }

      let created = 0;
      let updated = 0;
      let skipped = 0;

      for (const seller of sellers) {
        try {
          // Buscar si ya existe un user con el email del seller
          const existingUsers = await strapi.entityService.findMany(
            "plugin::users-permissions.user",
            {
              filters: { email: seller.email },
              limit: 1,
            }
          );

          const userData = {
            username:
              seller.email ||
              `${seller.first_name}.${seller.last_name}`.toLowerCase(),
            email: seller.email,
            firstName: seller.first_name,
            lastName: seller.last_name,
            siigoSellerId: String(seller.id),
            confirmed: true,
            blocked: !seller.active,
          };

          if (existingUsers && existingUsers.length > 0) {
            // Verificar si hay cambios
            const existingUser = existingUsers[0];
            const hasChanges =
              existingUser.firstName !== userData.firstName ||
              existingUser.lastName !== userData.lastName ||
              existingUser.blocked !== userData.blocked;

            if (hasChanges) {
              await strapi.entityService.update(
                "plugin::users-permissions.user",
                existingUser.id,
                { data: userData }
              );
              updated++;
              console.log(
                `User actualizado: ${userData.firstName} ${userData.lastName}`
              );
            } else {
              skipped++;
            }
          } else {
            // Crear nuevo user
            // Necesita role y password para crear
            const defaultRole = await strapi.entityService.findMany(
              "plugin::users-permissions.role",
              {
                filters: { type: "authenticated" },
                limit: 1,
              }
            );

            if (defaultRole && defaultRole.length > 0) {
              userData.role = defaultRole[0].id;
              userData.password = Math.random().toString(36).slice(-12); // Password temporal

              await strapi.entityService.create(
                "plugin::users-permissions.user",
                { data: userData }
              );
              created++;
              console.log(
                `User creado: ${userData.firstName} ${userData.lastName}`
              );
            } else {
              console.warn(
                `No se pudo crear user para seller ${seller.id}: role no encontrado`
              );
              skipped++;
            }
          }
        } catch (error) {
          console.error(
            `Error al sincronizar seller ${seller.id}:`,
            error.message
          );
          skipped++;
        }
      }

      const result = {
        success: true,
        created,
        updated,
        skipped,
        total: sellers.length,
        message: `Sincronización completada. Creados: ${created}, Actualizados: ${updated}, Sin cambios: ${skipped}`,
      };

      console.log(result.message);
      return result;
    } catch (error) {
      console.error(
        "Error al sincronizar sellers desde Siigo:",
        error.message
      );
      throw new Error(`Error en sincronización de sellers: ${error.message}`);
    }
  },

  /**
   * Obtiene un seller ID válido para usar en facturas
   * Si se proporciona un sellerId, lo valida. Si no, usa el configurado en .env
   * @param {Number} sellerId - ID del seller (opcional)
   * @returns {Number} - ID del seller validado
   */
  async getValidSellerId(sellerId = null) {
    try {
      // Si no se proporciona sellerId, usar el del .env
      const finalSellerId =
        sellerId || parseInt(process.env.SIIGO_SELLER_ID || "0");

      if (!finalSellerId) {
        throw new Error(
          "No se proporcionó sellerId y SIIGO_SELLER_ID no está configurado"
        );
      }

      // En modo test, no validar
      const testMode = process.env.SIIGO_TEST_MODE === "true";
      if (testMode) {
        return finalSellerId;
      }

      // Validar que el seller existe en Siigo
      try {
        await this.getFromSiigo(finalSellerId);
        return finalSellerId;
      } catch (error) {
        throw new Error(
          `Seller ID ${finalSellerId} no es válido en Siigo: ${error.message}`
        );
      }
    } catch (error) {
      console.error("Error al validar seller ID:", error.message);
      throw new Error(`Error al validar seller ID: ${error.message}`);
    }
  },
});
