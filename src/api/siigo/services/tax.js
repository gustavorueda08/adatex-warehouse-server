"use strict";

const { TAX_SERVICE } = require("../../../utils/services");
const { siigoFetch } = require("../utils/siigoFetch");

/**
 * Servicio de sincronización de impuestos (Taxes) con Siigo
 */

module.exports = ({ strapi }) => ({
  /**
   * Lista todos los impuestos desde Siigo
   * @returns {Array} - Array de taxes de Siigo
   */
  async listFromSiigo() {
    try {
      const testMode = process.env.SIIGO_TEST_MODE === "true";

      if (testMode) {
        console.log("[TEST MODE] Simulando listado de taxes desde Siigo");
        return [
          {
            id: 13156,
            name: "IVA 19%",
            type: "IVA",
            percentage: 19,
            active: true,
          },
          {
            id: 13157,
            name: "IVA 5%",
            type: "IVA",
            percentage: 5,
            active: true,
          },
          {
            id: 13158,
            name: "IVA 0%",
            type: "IVA",
            percentage: 0,
            active: true,
          },
        ];
      }

      const authService = strapi.service("api::siigo.auth");
      const headers = await authService.getAuthHeaders();
      const apiUrl = process.env.SIIGO_API_URL || "https://api.siigo.com";

      const response = await siigoFetch(`${apiUrl}/v1/taxes`, {
        method: "GET",
        headers,
      });

      if (!response.ok) {
        throw new Error(
          `Error HTTP ${response.status}: ${response.statusText}`
        );
      }

      const taxes = await response.json();
      console.log(`${taxes.length} taxes obtenidos desde Siigo`);

      return taxes;
    } catch (error) {
      console.error("Error al listar taxes desde Siigo:", error.message);
      throw new Error(`Error al consultar taxes en Siigo: ${error.message}`);
    }
  },

  /**
   * Sincroniza todos los taxes desde Siigo a la base de datos local
   * @returns {Object} - Resumen de la sincronización
   */
  async syncAllFromSiigo() {
    try {
      console.log("Iniciando sincronización de taxes desde Siigo...");

      const siigoTaxes = await this.listFromSiigo();

      if (!siigoTaxes || siigoTaxes.length === 0) {
        return {
          success: true,
          created: 0,
          updated: 0,
          skipped: 0,
          total: 0,
          message: "No se encontraron taxes en Siigo",
        };
      }

      let created = 0;
      let updated = 0;
      let skipped = 0;

      for (const siigoTax of siigoTaxes) {
        try {
          // Buscar si ya existe un tax con este siigoCode
          const existingTaxes = await strapi.entityService.findMany(
            TAX_SERVICE,
            {
              filters: { siigoCode: String(siigoTax.id) },
              limit: 1,
            }
          );

          const mapperService = strapi.service("api::siigo.mapper");
          const taxData = mapperService.mapSiigoToTax(siigoTax);

          if (existingTaxes && existingTaxes.length > 0) {
            // Actualizar tax existente
            const existingTax = existingTaxes[0];

            // Verificar si hay cambios
            const hasChanges =
              existingTax.name !== taxData.name ||
              parseFloat(existingTax.amount) !== parseFloat(taxData.amount);

            if (hasChanges) {
              await strapi.entityService.update(
                TAX_SERVICE,
                existingTax.id,
                {
                  data: taxData,
                }
              );
              updated++;
              console.log(`Tax actualizado: ${taxData.name}`);
            } else {
              skipped++;
            }
          } else {
            // Crear nuevo tax
            await strapi.entityService.create(TAX_SERVICE, {
              data: taxData,
            });
            created++;
            console.log(`Tax creado: ${taxData.name}`);
          }
        } catch (error) {
          console.error(
            `Error al sincronizar tax ${siigoTax.name}:`,
            error.message
          );
        }
      }

      const result = {
        success: true,
        created,
        updated,
        skipped,
        total: siigoTaxes.length,
        message: `Sincronización completada. Creados: ${created}, Actualizados: ${updated}, Sin cambios: ${skipped}`,
      };

      console.log(result.message);
      return result;
    } catch (error) {
      console.error(
        "Error al sincronizar taxes desde Siigo:",
        error.message
      );
      throw new Error(`Error en sincronización de taxes: ${error.message}`);
    }
  },

  /**
   * Obtiene un tax local por su siigoCode
   * @param {String} siigoCode - Código de Siigo del tax
   * @returns {Object} - Tax encontrado
   */
  async getLocalBySiigoCode(siigoCode) {
    try {
      const taxes = await strapi.entityService.findMany(TAX_SERVICE, {
        filters: { siigoCode: String(siigoCode) },
        limit: 1,
      });

      return taxes && taxes.length > 0 ? taxes[0] : null;
    } catch (error) {
      console.error(
        `Error al buscar tax con siigoCode ${siigoCode}:`,
        error.message
      );
      return null;
    }
  },

  /**
   * Mapea un array de tax IDs de Siigo a tax IDs locales
   * @param {Array} siigoTaxIds - Array de IDs de taxes de Siigo
   * @returns {Array} - Array de IDs de taxes locales
   */
  async mapSiigoTaxIdsToLocal(siigoTaxIds) {
    try {
      if (!siigoTaxIds || siigoTaxIds.length === 0) {
        return [];
      }

      const localTaxIds = [];

      for (const siigoTaxId of siigoTaxIds) {
        const localTax = await this.getLocalBySiigoCode(String(siigoTaxId));
        if (localTax) {
          localTaxIds.push(localTax.id);
        }
      }

      return localTaxIds;
    } catch (error) {
      console.error(
        "Error al mapear siigoTaxIds a local:",
        error.message
      );
      return [];
    }
  },

  /**
   * Mapea un array de tax IDs locales a tax IDs de Siigo
   * @param {Array} localTaxIds - Array de IDs de taxes locales
   * @returns {Array} - Array de IDs de taxes de Siigo
   */
  async mapLocalTaxIdsToSiigo(localTaxIds) {
    try {
      if (!localTaxIds || localTaxIds.length === 0) {
        return [];
      }

      const taxes = await strapi.entityService.findMany(TAX_SERVICE, {
        filters: { id: { $in: localTaxIds } },
        fields: ["id", "siigoCode"],
      });

      return taxes
        .filter((tax) => tax.siigoCode)
        .map((tax) => parseInt(tax.siigoCode));
    } catch (error) {
      console.error(
        "Error al mapear localTaxIds a Siigo:",
        error.message
      );
      return [];
    }
  },
});
