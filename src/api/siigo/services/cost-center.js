"use strict";

const logger = require("../../../utils/logger");

/**
 * Servicio para gestionar centros de costos en Siigo.
 * Los centros de costos permiten clasificar órdenes de compra por contenedor.
 *
 * Siigo API: GET/POST /v1/cost-centers
 */
module.exports = ({ strapi }) => ({
  /**
   * Lista todos los centros de costos disponibles en Siigo.
   * @returns {Promise<Array<{ id: number, code: string, name: string }>>}
   */
  async listCostCenters() {
    const authService = strapi.service("api::siigo.auth");
    const apiUrl = process.env.SIIGO_API_URL || "https://api.siigo.com";

    const response = await authService.authenticatedFetch(
      `${apiUrl}/v1/cost-centers`,
      { method: "GET" }
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `Error al listar centros de costos (${response.status}): ${errorText}`
      );
    }

    const data = await response.json();
    // Siigo puede devolver array directo o { results: [] }
    return Array.isArray(data) ? data : data?.results || [];
  },

  /**
   * Crea un nuevo centro de costos en Siigo.
   * @param {string} name - Nombre del centro de costos.
   * @param {string} [code] - Código (se usa name si no se especifica).
   * @returns {Promise<{ id: number, code: string, name: string }>}
   */
  async createCostCenter(name, code) {
    const authService = strapi.service("api::siigo.auth");
    const apiUrl = process.env.SIIGO_API_URL || "https://api.siigo.com";

    const payload = {
      name,
      code: code || name,
    };

    const response = await authService.authenticatedFetch(
      `${apiUrl}/v1/cost-centers`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      }
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `Error al crear centro de costos '${name}' (${response.status}): ${errorText}`
      );
    }

    return await response.json();
  },

  /**
   * Obtiene o crea el centro de costos para un nombre dado.
   * Útil para derivar automáticamente el centro de costos desde el containerCode.
   *
   * @param {string} name - Nombre buscado/a crear.
   * @returns {Promise<number|null>} - ID del centro de costos, o null si hubo error.
   */
  async getOrCreate(name) {
    try {
      const costCenters = await this.listCostCenters();
      const nameLower = name.toLowerCase();

      const existing = costCenters.find(
        (cc) =>
          cc.name?.toLowerCase() === nameLower ||
          cc.code?.toLowerCase() === nameLower
      );
      if (existing) {
        logger.info(`Centro de costos encontrado en Siigo: ${existing.id} (${existing.name})`);
        return existing.id;
      }

      // No existe → crear
      const created = await this.createCostCenter(name);
      logger.info(`Centro de costos creado en Siigo: ${created.id} (${name})`);
      return created.id;
    } catch (err) {
      logger.warn(`No se pudo obtener/crear centro de costos '${name}': ${err.message}`);
      return null;
    }
  },
});
