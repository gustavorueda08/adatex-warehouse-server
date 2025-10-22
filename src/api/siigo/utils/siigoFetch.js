"use strict";

const rateLimiter = require("./rateLimiter");

/**
 * Wrapper para fetch que maneja rate limiting y retry automático para la API de Siigo
 *
 * Características:
 * - Integración automática con el rate limiter
 * - Retry automático con exponential backoff para errores 429
 * - Logging de peticiones
 * - Manejo de errores HTTP
 */

/**
 * Función auxiliar para esperar un tiempo determinado
 * @param {number} ms - Milisegundos a esperar
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wrapper de fetch que respeta el rate limit de Siigo y maneja retries
 *
 * @param {string} url - URL a la que hacer la petición
 * @param {Object} options - Opciones de fetch
 * @param {Object} retryConfig - Configuración de retry
 * @param {number} retryConfig.attempt - Intento actual (uso interno)
 * @returns {Promise<Response>} Response de fetch
 */
async function siigoFetch(url, options = {}, retryConfig = {}) {
  const {
    attempt = 0,
    maxAttempts = parseInt(process.env.SIIGO_RETRY_ATTEMPTS || "3"),
    baseDelay = parseInt(process.env.SIIGO_RETRY_DELAY_MS || "2000"),
    maxDelay = parseInt(process.env.SIIGO_MAX_RETRY_DELAY_MS || "30000"),
  } = retryConfig;

  try {
    // Ejecutar la petición respetando el rate limit
    const response = await rateLimiter.execute(async () => {
      // Log de la petición (solo en desarrollo o cuando esté activado)
      const method = options.method || "GET";
      if (process.env.NODE_ENV === "development" || process.env.SIIGO_LOG_REQUESTS === "true") {
        const stats = rateLimiter.getStats();
        console.log(
          `[Siigo API] ${method} ${url} ` +
          `(${stats.requestsInWindow}/${stats.maxRequests} req/min - ${stats.utilizationPercent}%)`
        );
      }

      return await fetch(url, options);
    });

    // Si la respuesta es 429 (Too Many Requests), intentar retry
    if (response.status === 429) {
      if (attempt < maxAttempts) {
        // Calcular delay con exponential backoff
        const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);

        console.warn(
          `[Siigo API] Error 429 (Too Many Requests) en ${url}. ` +
          `Reintento ${attempt + 1}/${maxAttempts} en ${delay}ms...`
        );

        // Esperar antes de reintentar
        await sleep(delay);

        // Reintentar recursivamente
        return await siigoFetch(url, options, {
          ...retryConfig,
          attempt: attempt + 1,
        });
      } else {
        // Se agotaron los reintentos
        const errorText = await response.text();
        throw new Error(
          `Error HTTP 429: Too Many Requests. ` +
          `Se agotaron los ${maxAttempts} intentos. ` +
          `Detalles: ${errorText}`
        );
      }
    }

    // Si hay otros errores HTTP (400, 500, etc.), no hacer retry automático
    // El código que llama a siigoFetch puede manejar estos errores
    return response;
  } catch (error) {
    // Si es un error de red o timeout, intentar retry
    if (
      (error.name === "TypeError" || error.name === "FetchError") &&
      attempt < maxAttempts
    ) {
      const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);

      console.warn(
        `[Siigo API] Error de red en ${url}: ${error.message}. ` +
        `Reintento ${attempt + 1}/${maxAttempts} en ${delay}ms...`
      );

      await sleep(delay);

      return await siigoFetch(url, options, {
        ...retryConfig,
        attempt: attempt + 1,
      });
    }

    // Si no es retryable o se agotaron los intentos, propagar el error
    throw error;
  }
}

/**
 * Versión de siigoFetch que automáticamente lanza error si response.ok es false
 * Útil para simplificar el código que no necesita manejar errores HTTP específicos
 *
 * @param {string} url - URL a la que hacer la petición
 * @param {Object} options - Opciones de fetch
 * @returns {Promise<Response>} Response de fetch (solo si es exitosa)
 */
async function siigoFetchOrThrow(url, options = {}) {
  const response = await siigoFetch(url, options);

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new Error(
      `Error HTTP ${response.status}: ${response.statusText}. Detalles: ${errorText}`
    );
  }

  return response;
}

/**
 * Obtiene estadísticas del rate limiter
 * Útil para debugging y monitoreo
 *
 * @returns {Object} Estadísticas del rate limiter
 */
function getSiigoRateLimitStats() {
  return rateLimiter.getStats();
}

/**
 * Resetea el rate limiter
 * Útil para testing
 */
function resetSiigoRateLimit() {
  rateLimiter.reset();
}

module.exports = {
  siigoFetch,
  siigoFetchOrThrow,
  getSiigoRateLimitStats,
  resetSiigoRateLimit,
};
